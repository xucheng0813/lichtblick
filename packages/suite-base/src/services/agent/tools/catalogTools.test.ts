// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  buildCatalogListing,
  CATALOG_TOOL_MAX_DESCRIBE_TOPICS,
  CATALOG_TOOL_MAX_RESULT_BYTES,
  describeTopics,
  flattenSchemaFields,
  normalizeCatalogTopics,
  suggestTopicNames,
  type CatalogTopicSummary,
} from "./catalogTools";

function makeCatalog(
  topics: CatalogTopicSummary[],
  datatypes?: ReadonlyMap<string, unknown>,
) {
  return {
    topics: topics.map((topic) => ({
      ...topic,
      // runtime topic objects carry large binary payloads that must be stripped
      schemaData: new Uint8Array([0, 1, 2]),
      topicStats: { numMessages: 1 },
    })),
    datatypes: datatypes ?? new Map<string, unknown>(),
  };
}

function stringify(value: unknown): string {
  const text = JSON.stringify(value);
  if (text == undefined) {
    throw new Error("JSON.stringify returned undefined");
  }
  return text;
}

describe("normalizeCatalogTopics", () => {
  it("keeps only name/schemaName and drops runtime fields", () => {
    const topics = [
      { name: "/a", schemaName: "s.A", schemaData: new Uint8Array([1]) },
      { name: "/b", schemaName: "s.B", extra: true },
      { name: "/no_schema" },
      { name: 42 },
      "not-an-object",
      undefined,
    ];
    expect(normalizeCatalogTopics(topics)).toEqual([
      { name: "/a", schemaName: "s.A" },
      { name: "/b", schemaName: "s.B" },
      { name: "/no_schema" },
    ]);
  });

  it("drops non-string schemaName values", () => {
    expect(normalizeCatalogTopics([{ name: "/a", schemaName: 7 }])).toEqual([{ name: "/a" }]);
  });
});

describe("flattenSchemaFields", () => {
  const datatypes = new Map<string, unknown>([
    [
      "s.Pose",
      {
        definitions: [
          { name: "position", type: "s.Point" },
          { name: "motor_state", type: "s.MotorState", isArray: true },
          { name: "header", type: "std_msgs/Header" },
          { name: "stamp", type: "time" },
          { name: "speeds", type: "float64", isArray: true },
          { name: "CONSTANT", type: "int32", isConstant: true },
        ],
      },
    ],
    [
      "s.Point",
      {
        definitions: [
          { name: "x", type: "float64" },
          { name: "y", type: "float64" },
        ],
      },
    ],
    [
      "s.MotorState",
      {
        definitions: [{ name: "torque", type: "float64" }],
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
    // "time" is a built-in type and must never be recursed into even if present.
    ["time", { definitions: [{ name: "sec", type: "uint32" }] }],
  ]);

  it("flattens nested definitions in order with complex lines before children", () => {
    const listing = flattenSchemaFields("s.Pose", datatypes);
    expect(listing).toEqual({
      schemaName: "s.Pose",
      fields: [
        "position: s.Point",
        "position.x: float64",
        "position.y: float64",
        "motor_state[]: s.MotorState",
        "motor_state[].torque: float64",
        "header: std_msgs/Header",
        "header.stamp: time",
        "header.frame_id: string",
        "stamp: time",
        "speeds[]: float64",
      ],
    });
  });

  it("honors maxDepth", () => {
    const listing = flattenSchemaFields("s.Pose", datatypes, { maxDepth: 1 });
    expect(listing.fields).toEqual([
      "position: s.Point",
      "motor_state[]: s.MotorState",
      "header: std_msgs/Header",
      "stamp: time",
      "speeds[]: float64",
    ]);
    expect(listing.truncated).toBeUndefined();
  });

  it("does not recurse into cycles", () => {
    const cyclic = new Map<string, unknown>([
      [
        "s.Node",
        {
          definitions: [
            { name: "child", type: "s.Node" },
            { name: "value", type: "float64" },
          ],
        },
      ],
    ]);
    expect(flattenSchemaFields("s.Node", cyclic).fields).toEqual([
      "child: s.Node",
      "value: float64",
    ]);
  });

  it("records missing complex datatypes without recursing", () => {
    const broken = new Map<string, unknown>([
      [
        "s.Root",
        {
          definitions: [
            { name: "data", type: "missing/Type", isComplex: true },
            { name: "ok", type: "float64" },
          ],
        },
      ],
    ]);
    const listing = flattenSchemaFields("s.Root", broken);
    expect(listing.fields).toEqual(["data: missing/Type", "ok: float64"]);
    expect(listing.missingDatatypes).toEqual(["missing/Type"]);
  });

  it("marks truncation with a remaining-count note when maxLines is exceeded", () => {
    const wide = new Map<string, unknown>([
      [
        "s.Wide",
        {
          definitions: [
            { name: "a", type: "float64" },
            { name: "b", type: "float64" },
            { name: "c", type: "float64" },
            { name: "nested", type: "s.Child" },
          ],
        },
      ],
      [
        "s.Child",
        {
          definitions: [{ name: "d", type: "float64" }],
        },
      ],
    ]);
    const listing = flattenSchemaFields("s.Wide", wide, { maxLines: 3 });
    expect(listing.truncated).toBe(true);
    expect(listing.fields).toEqual([
      "a: float64",
      "b: float64",
      "c: float64",
      "… (2 more fields; narrow with maxDepth or read one message)",
    ]);
  });

  it("does not mark truncation when the field count exactly equals maxLines", () => {
    const exact = new Map<string, unknown>([
      [
        "s.Exact",
        {
          definitions: [
            { name: "a", type: "float64" },
            { name: "b", type: "float64" },
            { name: "c", type: "float64" },
          ],
        },
      ],
    ]);
    const listing = flattenSchemaFields("s.Exact", exact, { maxLines: 3 });
    expect(listing.truncated).toBeUndefined();
    expect(listing.fields).toEqual(["a: float64", "b: float64", "c: float64"]);
  });

  it("reports the root schema itself as missing when it is absent", () => {
    expect(flattenSchemaFields("nope/Type", new Map())).toEqual({
      schemaName: "nope/Type",
      fields: [],
      missingDatatypes: ["nope/Type"],
    });
  });

  it("recurses through deep nesting up to maxDepth", () => {
    const deep = new Map<string, unknown>();
    const depth = 10;
    for (let level = 0; level < depth; level++) {
      deep.set(level === 0 ? "s.Deep" : `s.Deep_l${level}`, {
        definitions: [
          { name: `v${level}`, type: "float64" },
          { name: "next", type: level === depth - 1 ? "float64" : `s.Deep_l${level + 1}` },
        ],
      });
    }
    expect(flattenSchemaFields("s.Deep", deep, { maxDepth: 3 }).fields).toEqual([
      "v0: float64",
      "next: s.Deep_l1",
      "next.v1: float64",
      "next.next: s.Deep_l2",
      "next.next.v2: float64",
      "next.next.next: s.Deep_l3",
    ]);
    expect(flattenSchemaFields("s.Deep", deep, { maxDepth: 10 }).fields).toHaveLength(20);
  });
});

describe("suggestTopicNames", () => {
  it("suggests the leading-slash toggle first", () => {
    expect(suggestTopicNames("/odometry", ["imu", "odometry", "bms"])).toEqual(["odometry"]);
    expect(suggestTopicNames("odometry", ["/odometry", "imu"])).toEqual(["/odometry"]);
  });

  it("suggests case-insensitive equality", () => {
    expect(suggestTopicNames("ODOMETRY", ["odometry", "imu"])).toEqual(["odometry"]);
  });

  it("suggests suffix-related names in both directions", () => {
    expect(suggestTopicNames("odometry", ["/robot/odometry", "imu"])).toEqual([
      "/robot/odometry",
    ]);
    expect(suggestTopicNames("/robot/odometry", ["odometry", "imu"])).toEqual(["odometry"]);
  });

  it("suggests within Levenshtein distance sorted by distance", () => {
    expect(
      suggestTopicNames("odometr", ["odometry", "odometri", "imu", "very_long_unrelated"]),
    ).toEqual(["odometri", "odometry"]);
  });

  it("deduplicates and caps at max", () => {
    expect(
      suggestTopicNames("odometry", ["odometry", "odometry", "odometri", "odometr"], 2),
    ).toHaveLength(2);
    expect(suggestTopicNames("odometry", ["odometry"], 3)).toEqual([]);
  });
});

describe("buildCatalogListing", () => {
  const topics: CatalogTopicSummary[] = [
    { name: "/imu", schemaName: "sensor_msgs/Imu" },
    { name: "/camera/image", schemaName: "sensor_msgs/Image" },
    { name: "odometry", schemaName: "nav_msgs/Odometry" },
    { name: "/raw_audio_dump", schemaName: "foxglove.RawAudio" },
    { name: "/no_schema" },
  ];
  const catalog = makeCatalog(topics);

  it("returns counts and all topics by default", () => {
    const result = buildCatalogListing(catalog, {});
    expect(result).toEqual({
      topicCount: 5,
      matchedCount: 5,
      returnedCount: 5,
      topics: topics.map(({ name, schemaName }) =>
        schemaName == undefined ? { name } : { name, schemaName },
      ),
    });
  });

  it("filters by exact schema", () => {
    const result = buildCatalogListing(catalog, { schema: "foxglove.RawAudio" });
    expect(result).toEqual({
      topicCount: 5,
      matchedCount: 1,
      returnedCount: 1,
      topics: [{ name: "/raw_audio_dump", schemaName: "foxglove.RawAudio" }],
    });
  });

  it("filters by case-insensitive substring query on name and schemaName", () => {
    expect(buildCatalogListing(catalog, { query: "ODOM" }).topics).toEqual([
      { name: "odometry", schemaName: "nav_msgs/Odometry" },
    ]);
    expect(buildCatalogListing(catalog, { query: "image" }).topics).toEqual([
      { name: "/camera/image", schemaName: "sensor_msgs/Image" },
    ]);
  });

  it("clamps the limit to [1, 500] and defaults to 200", () => {
    expect(buildCatalogListing(catalog, { limit: 0 }).returnedCount).toBe(1);
    expect(buildCatalogListing(catalog, { limit: 1000 }).returnedCount).toBe(5);
    expect(buildCatalogListing(catalog, { limit: 2 }).returnedCount).toBe(2);
    expect(buildCatalogListing(catalog, {}).returnedCount).toBe(5);
  });

  it("marks limit truncation with omittedCount and schemaCounts over the matched set", () => {
    const result = buildCatalogListing(catalog, { limit: 3 });
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(2);
    expect(result.schemaCounts).toEqual({
      "sensor_msgs/Imu": 1,
      "sensor_msgs/Image": 1,
      "nav_msgs/Odometry": 1,
      "foxglove.RawAudio": 1,
      "(no schema)": 1,
    });
  });

  it("drops whole topics to fit the byte budget and stays JSON-parseable", () => {
    // 300 topics with ~450-byte names (each entry stays under the 512-byte per-item cap, so no
    // placeholders) sum to ~140 KB, which the 96 KB budget must trim from the end.
    const manyTopics: CatalogTopicSummary[] = Array.from({ length: 300 }, (_, index) => ({
      name: `/${index}/${"x".repeat(450)}`,
      schemaName: `s.Schema${index}`,
    }));
    const result = buildCatalogListing(makeCatalog(manyTopics), {});
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(300 - result.returnedCount);
    expect(result.returnedCount).toBeLessThan(300);
    expect(stringify(result).length).toBeLessThanOrEqual(CATALOG_TOOL_MAX_RESULT_BYTES);
    expect(JSON.parse(stringify(result))).toEqual(result);
    for (const topic of result.topics) {
      // Names are never rewritten: every returned name is a verbatim catalog name.
      if (!("name" in topic)) {
        throw new Error("expected no omitted placeholders");
      }
      expect(topic.name).toMatch(/^\/\d+\/x{450}$/);
    }
  });

  it("replaces oversized topic summaries with placeholders instead of truncating names", () => {
    // A multibyte name and an emoji name both serialize past 512 bytes; neither may appear in
    // the result (truncated names would be copied by the model as real topic names).
    const chineseName = `/主题/${"数".repeat(500)}`;
    const emojiName = `/emoji/${"😀".repeat(200)}`;
    const result = buildCatalogListing(
      makeCatalog([
        { name: chineseName, schemaName: "s.Chinese" },
        { name: "/normal", schemaName: "s.Normal" },
        { name: emojiName },
      ]),
      {},
    );
    const chineseEntry = result.topics[0]!;
    expect(chineseEntry).toEqual({
      omitted: true,
      byteLength: new TextEncoder().encode(
        JSON.stringify({ name: chineseName, schemaName: "s.Chinese" }),
      ).byteLength,
    });
    const emojiEntry = result.topics[2]!;
    expect(emojiEntry).toEqual({
      omitted: true,
      byteLength: new TextEncoder().encode(JSON.stringify({ name: emojiName })).byteLength,
    });
    expect(result.topics[1]).toEqual({ name: "/normal", schemaName: "s.Normal" });
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(2);
    expect(result.returnedCount).toBe(1);
    // No truncated fake names anywhere in the serialized result.
    expect(stringify(result)).not.toContain("…");
    expect(JSON.parse(stringify(result))).toEqual(result);
  });

  it("trims schemaCounts key-value pairs to honor the byte budget", () => {
    // 500 unique ~210-byte schemaNames: the counts record alone (~110 KB) exceeds the budget,
    // so whole key-value pairs must be dropped with their own truncation metadata.
    const manyTopics: CatalogTopicSummary[] = Array.from({ length: 500 }, (_, index) => ({
      name: `/topic${index}`,
      schemaName: `s.${"y".repeat(200)}.Unique${index}`,
    }));
    const result = buildCatalogListing(makeCatalog(manyTopics), {});
    expect(result.truncated).toBe(true);
    expect(result.schemaCountsTruncated).toBe(true);
    expect(result.schemaCountsOmitted).toBeGreaterThan(0);
    expect(Object.keys(result.schemaCounts ?? {}).length).toBeLessThan(500);
    // The final serialized result must always fit the budget, and remain JSON-parseable.
    expect(stringify(result).length).toBeLessThanOrEqual(CATALOG_TOOL_MAX_RESULT_BYTES);
    expect(JSON.parse(stringify(result))).toEqual(result);
    // Every retained key is a complete verbatim schemaName.
    for (const key of Object.keys(result.schemaCounts ?? {})) {
      expect(manyTopics.some((topic) => topic.schemaName === key)).toBe(true);
    }
  });

  it("honors the byte budget with multibyte schemaName keys", () => {
    const manyTopics: CatalogTopicSummary[] = Array.from({ length: 400 }, (_, index) => ({
      name: `/t${index}`,
      schemaName: `s.${"模式".repeat(100)}.${index}`,
    }));
    const result = buildCatalogListing(makeCatalog(manyTopics), {});
    expect(result.schemaCountsTruncated).toBe(true);
    expect(result.schemaCountsOmitted).toBeGreaterThan(0);
    expect(stringify(result).length).toBeLessThanOrEqual(CATALOG_TOOL_MAX_RESULT_BYTES);
    expect(JSON.parse(stringify(result))).toEqual(result);
  });
});

describe("describeTopics", () => {
  const datatypes = new Map<string, unknown>([
    [
      "s.Pose",
      {
        definitions: [
          { name: "position", type: "s.Point" },
          { name: "stamp", type: "time" },
        ],
      },
    ],
    [
      "s.Point",
      {
        definitions: [{ name: "x", type: "float64" }],
      },
    ],
    [
      "s.Broken",
      {
        definitions: [{ name: "data", type: "missing/Type", isComplex: true }],
      },
    ],
  ]);
  const catalog = makeCatalog(
    [
      { name: "/pose", schemaName: "s.Pose" },
      { name: "/broken", schemaName: "s.Broken" },
      { name: "odometry", schemaName: undefined },
    ],
    datatypes,
  );

  it("rejects more than 10 topic names", () => {
    expect(() => describeTopics(catalog, Array.from({ length: 11 }, (_, i) => `t${i}`))).toThrow(
      `describe_topic supports at most ${CATALOG_TOOL_MAX_DESCRIBE_TOPICS} topics per call, got 11`,
    );
  });

  it("describes known topics, notes unknown topics with suggestions", () => {
    const result = describeTopics(catalog, ["/pose", "/pos", "odometry"]);
    expect(result.topics).toEqual([
      {
        name: "/pose",
        schemaName: "s.Pose",
        fields: ["position: s.Point", "position.x: float64", "stamp: time"],
      },
      { name: "odometry", fields: [], note: "schema unknown; use read_messages" },
    ]);
    expect(result.unknownTopics).toEqual([{ name: "/pos", suggestions: ["/pose"] }]);
    expect(result.truncated).toBeUndefined();
  });

  it("passes through fieldsTruncated and missingDatatypes from flattening", () => {
    const result = describeTopics(catalog, ["/broken"]);
    expect(result.topics).toEqual([
      {
        name: "/broken",
        schemaName: "s.Broken",
        fields: ["data: missing/Type"],
        missingDatatypes: ["missing/Type"],
      },
    ]);
  });

  it("applies maxDepth to the field listing", () => {
    const result = describeTopics(catalog, ["/pose"], 1);
    expect(result.topics[0]!.fields).toEqual(["position: s.Point", "stamp: time"]);
  });

  it("truncates whole field lines (then topics) to fit the byte budget", () => {
    // Each topic is flattened to exactly maxLines (150) field lines with ~430-byte names, so the
    // ten topics sum to ~640 KB — far beyond the 96 KB budget, which must then drop whole lines
    // (and eventually whole topics) from the end.
    const wideDatatypes = new Map<string, unknown>();
    const wideTopics: CatalogTopicSummary[] = [];
    for (let topicIndex = 0; topicIndex < 10; topicIndex++) {
      const schemaName = `s.Wide${topicIndex}`;
      wideTopics.push({ name: `/wide/${topicIndex}`, schemaName });
      wideDatatypes.set(schemaName, {
        definitions: Array.from({ length: 300 }, (_, fieldIndex) => ({
          name: `f${fieldIndex}_${"y".repeat(400)}`,
          type: "float64",
        })),
      });
    }
    const result = describeTopics(
      makeCatalog(wideTopics, wideDatatypes),
      wideTopics.map((topic) => topic.name),
    );
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(stringify(result).length).toBeLessThanOrEqual(CATALOG_TOOL_MAX_RESULT_BYTES);
    // Whole field lines are dropped from the end; earlier topics keep more lines.
    const first = result.topics[0]!;
    expect(first.fields.length).toBeGreaterThan(0);
    expect(JSON.parse(stringify(result))).toEqual(result);
  });

  it("drops oversized field lines instead of truncating them", () => {
    const longDatatypes = new Map<string, unknown>([
      [
        "s.Long",
        {
          definitions: [
            { name: `field_${"y".repeat(2000)}`, type: "float64" },
            { name: "ok", type: "float64" },
          ],
        },
      ],
    ]);
    const result = describeTopics(
      makeCatalog([{ name: "/long", schemaName: "s.Long" }], longDatatypes),
      ["/long"],
    );
    const entry = result.topics[0]!;
    // The oversized line is dropped on a whole-line boundary; the small line survives verbatim.
    expect(entry.fields).toEqual(["ok: float64"]);
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(1);
    expect(stringify(result)).not.toContain("…");
  });
});
