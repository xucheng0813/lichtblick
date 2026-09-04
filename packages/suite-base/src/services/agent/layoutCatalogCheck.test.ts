// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { Immutable } from "@lichtblick/suite";
import type { Topic } from "@lichtblick/suite-base/players/types";
import type { AgentSafeLayoutData } from "@lichtblick/suite-base/services/agent/layoutSchema";
import type { RosDatatypes } from "@lichtblick/suite-base/types/RosDatatypes";

import {
  checkLayoutAgainstCatalog,
  extractTopicReferences,
  formatLayoutCatalogErrors,
} from "./layoutCatalogCheck";

function makeDatatypes(): Immutable<RosDatatypes> {
  return new Map([
    [
      "s.Speed",
      {
        definitions: [
          { name: "data", type: "float64" },
          { name: "header", type: "std_msgs/Header" },
          { name: "level", type: "int32" },
          { name: "name", type: "string" },
        ],
      },
    ],
    [
      "std_msgs/Header",
      {
        definitions: [
          { name: "stamp", type: "time" },
          { name: "frame_id", type: "string" },
        ],
      },
    ],
    ["s.Foo", { definitions: [{ name: "a", type: "float64" }] }],
    ["s.Bar", { definitions: [{ name: "x", type: "float64" }] }],
  ]);
}

function makeTopics(
  entries: ReadonlyArray<{ name: string; schemaName?: string }>,
): readonly Topic[] {
  return entries.map(({ name, schemaName }) => ({ name, schemaName }));
}

const defaultTopics = makeTopics([
  { name: "/speed", schemaName: "s.Speed" },
  { name: "/imu", schemaName: "s.Speed" },
  { name: "odometry", schemaName: "s.Speed" },
  { name: "foo", schemaName: "s.Foo" },
  { name: "foo.bar", schemaName: "s.Bar" },
  { name: "/log", schemaName: "foxglove_msgs/Log" },
  { name: "/audio", schemaName: "foxglove.RawAudio" },
  { name: "/gps", schemaName: "sensor_msgs/NavSatFix" },
  { name: "/geojson", schemaName: "foxglove_msgs/GeoJSON" },
  { name: "/diag", schemaName: "diagnostic_msgs/DiagnosticArray" },
  { name: "/img", schemaName: "sensor_msgs/Image" },
  { name: "/calib", schemaName: "sensor_msgs/CameraInfo" },
]);

function makeLayoutData(
  configById: Record<string, unknown>,
  userNodes?: Record<string, unknown>,
): AgentSafeLayoutData {
  return {
    configById,
    globalVariables: {},
    playbackConfig: { speed: 1 },
    userNodes,
  } as unknown as AgentSafeLayoutData;
}

function check(
  configById: Record<string, unknown>,
  userNodes?: Record<string, unknown>,
  topics: readonly Topic[] = defaultTopics,
  datatypes: Immutable<RosDatatypes> = makeDatatypes(),
) {
  return checkLayoutAgainstCatalog(makeLayoutData(configById, userNodes), topics, datatypes);
}

describe("extractTopicReferences", () => {
  it("ignores extension panels and unknown panel types", () => {
    expect(
      extractTopicReferences("SomeExtension.Panel", "x", { path: "/nope", topic: "/nope" }),
    ).toEqual({ refs: [], warnings: [] });
    expect(extractTopicReferences("Tab", "x", { tabs: [] })).toEqual({ refs: [], warnings: [] });
  });

  it("skips Plot reference lines but keeps arithmetic expressions as references", () => {
    const { refs, warnings } = extractTopicReferences("Plot", "p", {
      paths: [
        { value: "5" },
        { value: "-3.14" },
        { value: " 100 " },
        { value: "+1" },
        { value: ".5" },
        { value: "1e3" },
        { value: "-2.5e-3" },
        { value: "100 - /speed.data" },
        { value: "100-foo" },
        { value: "/speed.data" },
      ],
    });
    expect(warnings).toEqual([]);
    expect(refs.map((ref) => ref.value)).toEqual(["100 - /speed.data", "100-foo", "/speed.data"]);
    expect(refs[0]!.terminalTypes).toBeDefined();
    expect(refs[0]!.terminalSeverity).toBe("error");
  });

  it("warns for a 3D panel whose topics are all hidden and for a missing RosOut topic", () => {
    const threeDee = extractTopicReferences("3D", "d", {
      topics: { foo: { visible: false }, "foo.bar": { visible: false } },
    });
    expect(threeDee.warnings).toEqual([
      'configById["d"].topics: no visible topics (every entry has visible: false); the panel will render nothing',
    ]);
    expect(threeDee.refs).toHaveLength(1);
    expect(threeDee.refs[0]!.kind).toBe("topic");

    const rosout = extractTopicReferences("RosOut", "r", {});
    expect(rosout.warnings).toEqual([
      'configById["r"].topicToRender is empty; the panel will render the first Log topic it finds',
    ]);
    expect(rosout.refs).toEqual([]);
  });

  it("requires diffTopicPath only when diff is enabled with the custom method", () => {
    const required = extractTopicReferences("RawMessages", "r", {
      diffEnabled: true,
      diffMethod: "custom",
      topicPath: "/speed.data",
    });
    expect(required.refs.find((ref) => ref.location.endsWith(".diffTopicPath"))?.required).toBe(
      true,
    );

    // A stale saved path in another mode is not extracted at all.
    const disabled = extractTopicReferences("RawMessages", "r", {
      diffEnabled: false,
      diffMethod: "custom",
      diffTopicPath: "/gone.x",
      topicPath: "/speed.data",
    });
    expect(disabled.refs.some((ref) => ref.location.endsWith(".diffTopicPath"))).toBe(false);

    const previous = extractTopicReferences("RawMessages", "r", {
      diffEnabled: true,
      diffMethod: "previous message",
      diffTopicPath: "/gone.x",
      topicPath: "/speed.data",
    });
    expect(previous.refs.some((ref) => ref.location.endsWith(".diffTopicPath"))).toBe(false);
  });
});

describe("checkLayoutAgainstCatalog", () => {
  it("skips validation entirely when no topics are loaded", () => {
    const result = check(
      { "Plot!p": { paths: [{ value: "/speed.nonexistent" }] } },
      undefined,
      [],
    );
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("accepts a valid Plot path and reports parse/unknown/field/terminal errors", () => {
    const valid = check({ "Plot!p": { paths: [{ value: "/speed.data" }] } });
    expect(valid).toEqual({ errors: [], warnings: [] });

    const unknown = check({ "Plot!p": { paths: [{ value: "/nonexistent.data" }] } });
    expect(unknown.errors).toEqual([
      'configById["Plot!p"].paths[0].value references unknown topic "/nonexistent"',
    ]);

    const field = check({ "Plot!p": { paths: [{ value: "/speed.nope" }] } });
    expect(field.errors).toEqual([
      'configById["Plot!p"].paths[0].value: field "nope" does not exist on s.Speed; run describe_topic on "/speed"',
    ]);

    const terminal = check({ "Plot!p": { paths: [{ value: "/speed.header" }] } });
    expect(terminal.errors).toEqual([
      'configById["Plot!p"].paths[0].value: field "header" does not end in a supported type on s.Speed',
    ]);
  });

  it("reports the arithmetic expression error for the exact collectd example", () => {
    const value = "100 - aorta/default/pub/collectd/s100/cpu.payload.cores[:]{core_id==0}.idle";
    const result = check({ "Plot!p": { paths: [{ value }] } });
    // parseMessagePath logs the nearley error for unparseable input.
    (console.error as jest.Mock).mockClear();
    expect(result.errors).toEqual([
      `configById["Plot!p"].paths[0].value "${value}" is not a valid message path; arithmetic and operators are not supported in paths — compute derived values in a user script`,
    ]);
  });

  it("skips Plot reference lines written as finite numbers in any form", () => {
    const result = check({
      "Plot!p": {
        paths: [
          { value: "+1" },
          { value: ".5" },
          { value: "1e3" },
          { value: "-2.5e-3" },
        ],
      },
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("treats 100-foo as an unknown topic (id syntax) without an arithmetic hint", () => {
    const result = check({ "Plot!p": { paths: [{ value: "100-foo" }] } });
    expect(result.errors).toEqual([
      'configById["Plot!p"].paths[0].value references unknown topic "100-foo"',
    ]);
  });

  it("does not attach arithmetic hints to plain names or filter values", () => {
    const plain = check({ "Plot!p": { paths: [{ value: "foo-bar.x" }] } });
    expect(plain.errors[0]).toContain('references unknown topic "foo-bar"');
    expect(plain.errors[0]).not.toContain("arithmetic");

    const slashed = check({ "Plot!p": { paths: [{ value: "aorta/default/pub/x" }] } });
    expect(slashed.errors[0]).toContain('references unknown topic "aorta/default/pub/x"');
    expect(slashed.errors[0]).not.toContain("arithmetic");

    const filter = check({ "Plot!p": { paths: [{ value: "/nope.data{core_id==-1}" }] } });
    expect(filter.errors[0]).toContain('references unknown topic "/nope"');
    expect(filter.errors[0]).not.toContain("arithmetic");
  });

  it("accepts a valid nested message path verbatim", () => {
    const datatypes: Immutable<RosDatatypes> = new Map([
      ["s.Odom", { definitions: [{ name: "twist", type: "s.Twist" }] }],
      ["s.Twist", { definitions: [{ name: "linear", type: "s.Vec3" }] }],
      [
        "s.Vec3",
        {
          definitions: [
            { name: "x", type: "float64" },
            { name: "y", type: "float64" },
          ],
        },
      ],
    ]);
    const result = check(
      { "Plot!p": { paths: [{ value: "/odom.twist.linear.x" }] } },
      undefined,
      makeTopics([{ name: "/odom", schemaName: "s.Odom" }]),
      datatypes,
    );
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("flags StateTransitions paths ending in non-transitionable types as warnings", () => {
    const result = check({
      "StateTransitions!s": {
        paths: [{ value: "/speed.level" }, { value: "/speed.data" }],
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'configById["StateTransitions!s"].paths[1].value: field "data" does not end in a supported type on s.Speed',
    ]);
  });

  it("requires Gauge/Indicator/PieChart paths and validates them", () => {
    const result = check({
      "Gauge!g": {},
      "Indicator!i": { path: "/speed.level" },
      "PieChart!pc": { path: "/speed.data" },
    });
    expect(result.errors).toEqual(['configById["Gauge!g"].path is required']);
    expect(result.warnings).toEqual([]);
  });

  it("requires RawMessages/RawMessagesVirtual/Table topicPath and checks diffTopicPath", () => {
    const valid = check({
      "RawMessages!r": {
        topicPath: "/speed.data",
        diffEnabled: true,
        diffMethod: "custom",
        diffTopicPath: "/speed.level",
      },
      "RawMessagesVirtual!rv": {
        topicPath: "/speed.data",
        diffEnabled: true,
        diffMethod: "previous message",
      },
      "Table!t": { topicPath: "/speed.data" },
    });
    expect(valid).toEqual({ errors: [], warnings: [] });

    const missing = check({
      "RawMessages!r": {
        diffEnabled: true,
        diffMethod: "custom",
      },
      "Table!t": {},
    });
    expect(missing.errors).toEqual([
      'configById["RawMessages!r"].topicPath is required',
      'configById["RawMessages!r"].diffTopicPath is required',
      'configById["Table!t"].topicPath is required',
    ]);
  });

  it("does not validate a stale diffTopicPath when custom diff is disabled", () => {
    const result = check({
      "RawMessages!r": {
        topicPath: "/speed.data",
        diffEnabled: false,
        diffMethod: "custom",
        diffTopicPath: "/unknown_topic.data",
      },
      "RawMessagesVirtual!rv": {
        topicPath: "/speed.data",
        diffEnabled: true,
        diffMethod: "previous message",
        diffTopicPath: "/unknown_topic.data",
      },
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("checks Image/3D imageMode topics against the image and calibration schemas", () => {
    const result = check({
      "Image!i": {
        imageMode: { imageTopic: "/gps", calibrationTopic: "/gps" },
      },
      "3D!d": {
        imageMode: { imageTopic: "/img", calibrationTopic: "/calib" },
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('configById["Image!i"].imageMode.imageTopic');
    expect(result.warnings[0]).toContain('uses unsupported schema "sensor_msgs/NavSatFix"');
    expect(result.warnings[1]).toContain('configById["Image!i"].imageMode.calibrationTopic');
  });

  it("checks 3D topics keys verbatim and rejects array forms", () => {
    const valid = check({
      "3D!d": { topics: { foo: { visible: true }, "foo.bar": {} } },
    });
    expect(valid).toEqual({ errors: [], warnings: [] });

    const array = check({ "3D!d": { topics: ["foo"] } });
    expect(array.errors).toEqual([
      'configById["3D!d"].topics: topics must be an object keyed by topic name',
    ]);

    const unknown = check({ "3D!d": { topics: { nope: {} } } });
    expect(unknown.errors).toEqual([
      'configById["3D!d"].topics["nope"] references unknown topic "nope"',
    ]);
  });

  it("warns for map followTopic schemas outside NavSatFix/LocationFix (GeoJSON cannot be followed)", () => {
    const geoJson = check({ "map!m": { followTopic: "/geojson" } });
    expect(geoJson.errors).toEqual([]);
    expect(geoJson.warnings).toHaveLength(1);
    expect(geoJson.warnings[0]).toContain('configById["map!m"].followTopic');
    expect(geoJson.warnings[0]).toContain('uses unsupported schema "foxglove_msgs/GeoJSON"');

    const wrongSchema = check({ "map!m": { followTopic: "/imu" } });
    expect(wrongSchema.errors).toEqual([]);
    expect(wrongSchema.warnings[0]).toContain('configById["map!m"].followTopic');
    expect(wrongSchema.warnings[0]).toContain('uses unsupported schema "s.Speed"');

    const ok = check({ "map!m": { followTopic: "/gps" } });
    expect(ok).toEqual({ errors: [], warnings: [] });
  });

  it("validates map disabledTopics entries and topicColors keys verbatim", () => {
    const unknown = check({
      "map!m": {
        disabledTopics: ["/nope"],
        topicColors: { missing: "#ffffff" },
      },
    });
    expect(unknown.errors).toEqual([
      'configById["map!m"].disabledTopics[0] references unknown topic "/nope"',
      'configById["map!m"].topicColors["missing"] references unknown topic "missing"',
    ]);
    expect(unknown.warnings).toEqual([]);

    const wrongSchema = check({
      "map!m": {
        disabledTopics: ["/imu"],
        topicColors: { "/imu": "#ffffff" },
      },
    });
    expect(wrongSchema.errors).toEqual([]);
    expect(wrongSchema.warnings).toHaveLength(2);
    expect(wrongSchema.warnings[0]).toContain('configById["map!m"].disabledTopics[0]');
    expect(wrongSchema.warnings[0]).toContain('uses unsupported schema "s.Speed"');
    expect(wrongSchema.warnings[1]).toContain('configById["map!m"].topicColors["/imu"]');

    const valid = check({
      "map!m": {
        followTopic: "/gps",
        disabledTopics: ["/gps"],
        topicColors: { "/gps": "#ffffff", "/geojson": "#000000" },
      },
    });
    expect(valid).toEqual({ errors: [], warnings: [] });
  });

  it("warns for missing or non-Log RosOut topicToRender", () => {
    const missing = check({ "RosOut!r": {} });
    expect(missing.errors).toEqual([]);
    expect(missing.warnings[0]).toContain("topicToRender is empty");

    const wrongSchema = check({ "RosOut!r": { topicToRender: "/speed" } });
    expect(wrongSchema.warnings[0]).toContain('uses unsupported schema "s.Speed"');

    const ok = check({ "RosOut!r": { topicToRender: "/log" } });
    expect(ok).toEqual({ errors: [], warnings: [] });
  });

  it("checks both Diagnostic panels: required topicToRender in the DiagnosticArray family", () => {
    const ok = check({
      "DiagnosticSummary!ds": { topicToRender: "/diag" },
      "DiagnosticStatusPanel!dsp": { topicToRender: "/diag" },
    });
    expect(ok).toEqual({ errors: [], warnings: [] });

    const missing = check({
      "DiagnosticSummary!ds": {},
      "DiagnosticStatusPanel!dsp": {},
    });
    expect(missing.errors).toEqual([
      'configById["DiagnosticSummary!ds"].topicToRender is required',
      'configById["DiagnosticStatusPanel!dsp"].topicToRender is required',
    ]);

    const wrongSchema = check({
      "DiagnosticSummary!ds": { topicToRender: "/speed" },
      "DiagnosticStatusPanel!dsp": { topicToRender: "/speed" },
    });
    expect(wrongSchema.errors).toEqual([]);
    expect(wrongSchema.warnings).toHaveLength(2);
    expect(wrongSchema.warnings[0]).toContain('uses unsupported schema "s.Speed"');
  });

  it("requires Audio topicPath and warns for non-RawAudio schemas", () => {
    const missing = check({ "Audio!a": {} });
    expect(missing.errors).toEqual(['configById["Audio!a"].topicPath is required']);

    const wrongSchema = check({ "Audio!a": { topicPath: "/speed" } });
    expect(wrongSchema.warnings[0]).toContain('uses unsupported schema "s.Speed"');

    const ok = check({ "Audio!a": { topicPath: "/audio" } });
    expect(ok).toEqual({ errors: [], warnings: [] });
  });

  it("suggests the leading-slash toggle for unknown topics", () => {
    const result = check(
      { "Plot!p": { paths: [{ value: "/odometry.data" }] } },
      undefined,
      makeTopics([{ name: "odometry", schemaName: "s.Speed" }]),
    );
    expect(result.errors).toEqual([
      'configById["Plot!p"].paths[0].value references unknown topic "/odometry"; did you mean "odometry" (no leading slash)?',
    ]);
  });

  it("suggests case-insensitive and edit-distance matches", () => {
    const catalog = makeTopics([{ name: "odometry", schemaName: "s.Speed" }]);
    const byCase = check(
      { "Plot!p": { paths: [{ value: "ODOMETRY.data" }] } },
      undefined,
      catalog,
    );
    expect(byCase.errors[0]).toContain('references unknown topic "ODOMETRY"');
    expect(byCase.errors[0]).toContain('did you mean "odometry"?');

    const byDistance = check(
      { "Plot!p": { paths: [{ value: "odometri.data" }] } },
      undefined,
      catalog,
    );
    expect(byDistance.errors[0]).toContain('did you mean "odometry"?');
  });

  it("resolves quoted topics and long-prefix dot topics", () => {
    const quoted = check({ "Plot!p": { paths: [{ value: '"foo.bar".x' }] } });
    expect(quoted).toEqual({ errors: [], warnings: [] });

    // "foo" is in the catalog but has no "bar" field; the longest-prefix rule adopts "foo.bar"
    // (both "foo" and "foo.bar" are catalog topics) and validates "x" against s.Bar.
    const disambiguated = check({ "Plot!p": { paths: [{ value: "foo.bar.x" }] } });
    expect(disambiguated).toEqual({ errors: [], warnings: [] });

    // With only "foo.bar" in the catalog the parsed topic "foo" is unknown and the prefix rule
    // still resolves it.
    const onlyDotted = check(
      { "Plot!p": { paths: [{ value: "foo.bar.x" }] } },
      undefined,
      makeTopics([{ name: "foo.bar", schemaName: "s.Bar" }]),
    );
    expect(onlyDotted).toEqual({ errors: [], warnings: [] });

    // When the parse result is valid it wins: "foo.a" resolves to topic "foo" field "a".
    const primaryWins = check({ "Plot!p": { paths: [{ value: "foo.a" }] } });
    expect(primaryWins).toEqual({ errors: [], warnings: [] });
  });

  it("adds a quoting hint for parse errors with special topic characters", () => {
    const result = check({ "Plot!p": { paths: [{ value: "foo:bar.x" }] } });
    // parseMessagePath logs the nearley error for unparseable input.
    (console.error as jest.Mock).mockClear();
    expect(result.errors).toEqual([
      'configById["Plot!p"].paths[0].value "foo:bar.x" is not a valid message path; topic names containing special characters must be quoted, e.g. "my.topic".field',
    ]);
  });

  it("validates user script outputs and inputs against the catalog", () => {
    const script = 'export const inputs = ["/speed"];\nexport const output = "/studio_script/calc";';
    const valid = check(
      { "Plot!p": { paths: [{ value: "/studio_script/calc.data" }] } },
      { script1: { name: "calc", sourceCode: script } },
    );
    expect(valid.errors).toEqual([]);
    // Virtual catalog topics have no schema: field checks degrade to warnings.
    expect(valid.warnings).toEqual([
      'configById["Plot!p"].paths[0].value: cannot verify field path "data" on "/studio_script/calc"',
    ]);
  });

  it("rejects misspelled script outputs (no prefix allowlist)", () => {
    const result = check(
      { "Plot!p": { paths: [{ value: "/studio_script/typo.x" }] } },
      {
        script1: {
          name: "calc",
          sourceCode: 'export const inputs = ["/speed"];\nexport const output = "/studio_script/calc";',
        },
      },
    );
    expect(result.errors).toEqual([
      'configById["Plot!p"].paths[0].value references unknown topic "/studio_script/typo"',
    ]);
  });

  it("rejects duplicate outputs, catalog conflicts, missing inputs, and non-prefixed outputs", () => {
    const duplicate = check(
      {},
      {
        a: {
          name: "a",
          sourceCode:
            'export const inputs = ["/speed"];\nexport const output = "/studio_script/dup";',
        },
        b: {
          name: "b",
          sourceCode:
            'export const inputs = ["/speed"];\nexport const output = "/studio_script/dup";',
        },
      },
    );
    expect(duplicate.errors).toEqual([
      'userNodes["b"]: output topic "/studio_script/dup" is also produced by userNodes["a"]',
    ]);

    const conflict = check(
      {},
      {
        a: {
          name: "a",
          sourceCode: 'export const inputs = ["/speed"];\nexport const output = "/speed";',
        },
      },
    );
    expect(conflict.errors).toEqual([
      'userNodes["a"]: output topic "/speed" conflicts with a data source topic',
    ]);

    const missingInput = check(
      {},
      {
        a: {
          name: "a",
          sourceCode:
            'export const inputs = ["/nope"];\nexport const output = "/studio_script/calc";',
        },
      },
    );
    expect(missingInput.errors).toEqual([
      'userNodes["a"]: input "/nope" is not in the catalog',
    ]);

    const missingOutput = check(
      {},
      { a: { name: "a", sourceCode: 'export const inputs = ["/speed"];' } },
    );
    expect(missingOutput.errors).toEqual([
      'userNodes["a"] has no parseable export const output',
    ]);

    const prefix = check(
      {},
      {
        a: {
          name: "a",
          sourceCode: 'export const inputs = ["/speed"];\nexport const output = "calc";',
        },
      },
    );
    expect(prefix.errors).toEqual([]);
    expect(prefix.warnings).toEqual([
      'userNodes["a"]: output topic "calc" does not start with /studio_script/',
    ]);
  });

  it("errors on missing or empty inputs declarations", () => {
    const empty = check(
      {},
      {
        a: {
          name: "a",
          sourceCode: 'export const inputs = [];\nexport const output = "/studio_script/x";',
        },
      },
    );
    expect(empty.errors).toEqual(['userNodes["a"] has no parseable export const inputs']);

    const missing = check(
      {},
      { a: { name: "a", sourceCode: 'export const output = "/studio_script/x";' } },
    );
    expect(missing.errors).toEqual(['userNodes["a"] has no parseable export const inputs']);
  });

  it("rejects dynamic output declarations", () => {
    const result = check(
      {},
      {
        a: {
          name: "a",
          sourceCode:
            'export const inputs = ["/speed"];\nexport const output = prefix + "/x";',
        },
      },
    );
    expect(result.errors).toEqual(['userNodes["a"] has no parseable export const output']);
  });

  it("ignores // and /* inside template strings when parsing scripts", () => {
    // The template containing "/*" without a closing "*/" would swallow the rest of the file
    // (including the real export) if templates were not recognized.
    const sourceCode = [
      'export const inputs = ["/speed"];',
      "const marker = `// /*`;",
      "const escaped = `\\` /*`;",
      "const interpolated = `${1 + 2}`;",
      'export const output = "/studio_script/real";',
    ].join("\n");
    const userNodes = { a: { name: "a", sourceCode } };

    const result = check(
      { "Plot!p": { paths: [{ value: "/studio_script/real.x" }] } },
      userNodes,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'configById["Plot!p"].paths[0].value: cannot verify field path "x" on "/studio_script/real"',
    ]);
  });

  it("strips comments but not string literals before parsing scripts", () => {
    // Fake exports inside a block comment (with its own line) and a line comment must be
    // ignored; "//" and "/*" inside a string literal must not start comments.
    const sourceCode = [
      "/*",
      'export const output = "/studio_script/fake";',
      "*/",
      '// export const output = "/studio_script/fake2";',
      'export const inputs = ["/speed"];',
      'const marker = "/* //";',
      'export const output = "/studio_script/real";',
    ].join("\n");
    const userNodes = { a: { name: "a", sourceCode } };

    const real = check(
      { "Plot!p": { paths: [{ value: "/studio_script/real.x" }] } },
      userNodes,
    );
    expect(real.errors).toEqual([]);
    expect(real.warnings).toEqual([
      'configById["Plot!p"].paths[0].value: cannot verify field path "x" on "/studio_script/real"',
    ]);

    // The commented-out outputs are not registered in the virtual catalog.
    const fake = check(
      { "Plot!p": { paths: [{ value: "/studio_script/fake.x" }] } },
      userNodes,
    );
    expect(fake.errors).toEqual([
      'configById["Plot!p"].paths[0].value references unknown topic "/studio_script/fake"',
    ]);
  });

  it("takes the first repeated export declarations", () => {
    const sourceCode = [
      'export const inputs = ["/speed"];',
      'export const output = "/studio_script/first";',
      'export const output = "/studio_script/second";',
    ].join("\n");
    const userNodes = { a: { name: "a", sourceCode } };

    const first = check(
      { "Plot!p": { paths: [{ value: "/studio_script/first.x" }] } },
      userNodes,
    );
    expect(first.errors).toEqual([]);

    const second = check(
      { "Plot!p": { paths: [{ value: "/studio_script/second.x" }] } },
      userNodes,
    );
    expect(second.errors).toEqual([
      'configById["Plot!p"].paths[0].value references unknown topic "/studio_script/second"',
    ]);
  });

  it("parses multi-line inputs arrays and single-quoted literals", () => {
    const result = check(
      {},
      {
        a: {
          name: "a",
          sourceCode: [
            "export const inputs = [",
            "  '/speed',",
            '  "/imu"',
            "];",
            "export const output = '/studio_script/real';",
          ].join("\n"),
        },
      },
    );
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("allows a script to consume another script's output", () => {
    const result = check(
      {},
      {
        first: {
          name: "first",
          sourceCode:
            'export const inputs = ["/speed"];\nexport const output = "/studio_script/first";',
        },
        second: {
          name: "second",
          sourceCode:
            'export const inputs = ["/studio_script/first"];\nexport const output = "/studio_script/second";',
        },
      },
    );
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("degrades all field checks to warnings when structure construction throws", () => {
    const brokenDatatypes: Immutable<RosDatatypes> = new Map([
      [
        "s.Broken",
        {
          definitions: [{ name: "header", type: "missing/Header" }],
        },
      ],
    ]);
    const result = check(
      { "Plot!p": { paths: [{ value: "/speed.data" }] } },
      undefined,
      defaultTopics,
      brokenDatatypes,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'configById["Plot!p"].paths[0].value: cannot verify field path "data" on "/speed"',
    ]);
  });

  it("leaves extension panels untouched", () => {
    const result = check({
      "SomeExtension.Panel!e": { path: "/nonexistent.x", topic: "/nonexistent" },
      "Plot!p": { paths: [{ value: "/speed.data" }] },
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });
});

describe("formatLayoutCatalogErrors", () => {
  it("renders the rejection summary with errors and warnings", () => {
    expect(
      formatLayoutCatalogErrors({ errors: ["first", "second"], warnings: ["careful"] }),
    ).toBe(
      "propose_layout rejected: 2 problem(s) must be fixed:\n- first\n- second\nWarnings:\n- careful",
    );
  });

  it("omits the warnings section when there are none", () => {
    expect(formatLayoutCatalogErrors({ errors: ["only"], warnings: [] })).toBe(
      "propose_layout rejected: 1 problem(s) must be fixed:\n- only",
    );
  });
});
