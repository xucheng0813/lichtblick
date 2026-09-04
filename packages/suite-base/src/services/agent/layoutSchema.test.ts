// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { LayoutData } from "@lichtblick/suite-base/context/CurrentLayoutContext/actions";

import {
  AGENT_SAFE_LAYOUT_MAX_COLLECTION_ENTRIES,
  AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES,
  AGENT_SAFE_LAYOUT_MAX_GRAPH_DEPTH,
  AGENT_SAFE_LAYOUT_MAX_GRAPH_NODES,
  AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH,
  AGENT_SAFE_LAYOUT_MAX_STRING_BYTES,
  HUMANOID_VIZ_PANEL_TYPE,
  QUADRUPED_VIZ_PANEL_TYPE,
  type AgentSafeLayoutData,
  isValidLayoutProposalData,
  validateLayoutProposal,
  validateLayoutProposalData,
} from "./layoutSchema";

function validLayoutData(): Record<string, unknown> {
  return {
    configById: {
      "3D!scene": {},
      "Plot!speed": { paths: [] },
      "Image!camera": { imageMode: { imageTopic: "/camera" } },
    },
    layout: {
      direction: "row",
      splitPercentage: 60,
      first: "3D!scene",
      second: {
        direction: "column",
        first: "Plot!speed",
        second: "Image!camera",
      },
    },
    globalVariables: {},
    playbackConfig: { speed: 1 },
    userNodes: {},
  };
}

describe("layoutSchema", () => {
  it("exposes AgentSafeLayoutData as an opaque validated LayoutData subtype", () => {
    const unvalidated = validLayoutData() as LayoutData;
    const acceptsAgentSafeData = (_data: AgentSafeLayoutData): void => {};
    const validated = validateLayoutProposalData(unvalidated);

    // @ts-expect-error Plain LayoutData has not crossed the Agent-safe runtime validation boundary.
    acceptsAgentSafeData(unvalidated);
    acceptsAgentSafeData(validated);
    expect(validated).toBe(unvalidated);
  });

  it("exports the Agent-safe layout budgets for backend schema alignment", () => {
    expect({
      collectionEntries: AGENT_SAFE_LAYOUT_MAX_COLLECTION_ENTRIES,
      configEntries: AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES,
      graphDepth: AGENT_SAFE_LAYOUT_MAX_GRAPH_DEPTH,
      graphNodes: AGENT_SAFE_LAYOUT_MAX_GRAPH_NODES,
      mosaicDepth: AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH,
      stringBytes: AGENT_SAFE_LAYOUT_MAX_STRING_BYTES,
    }).toEqual({
      collectionEntries: 4096,
      configEntries: 256,
      graphDepth: 64,
      graphNodes: 10_000,
      mosaicDepth: 64,
      stringBytes: 256 * 1024,
    });
  });

  it("accepts a valid LayoutProposal.data and preserves its object identity", () => {
    const data = validLayoutData();

    expect(validateLayoutProposalData(data)).toBe(data);
    expect(isValidLayoutProposalData(data)).toBe(true);
  });

  it("returns a proposal whose data is validated as AgentSafeLayoutData", () => {
    const proposal = { name: "Vehicle", summary: "Useful panels", data: validLayoutData() };

    expect(validateLayoutProposal(proposal)).toEqual(proposal);
  });

  it("accepts string baseLayoutId and baseFingerprint fields", () => {
    const proposal = {
      name: "Vehicle",
      baseLayoutId: "layout-1",
      baseFingerprint: "0a1b2c3d",
      data: validLayoutData(),
    };

    expect(validateLayoutProposal(proposal)).toEqual(proposal);
  });

  it.each<Record<string, unknown>>([
    { baseLayoutId: 42 },
    { baseLayoutId: {} },
    { baseLayoutId: null },
    { baseFingerprint: 42 },
    { baseFingerprint: ["abc"] },
    { baseFingerprint: null },
  ])("rejects a non-string baseline field %j", (badFields) => {
    expect(() =>
      validateLayoutProposal({
        name: "Vehicle",
        data: validLayoutData(),
        ...badFields,
      }),
    ).toThrow(/baseLayoutId|baseFingerprint must be a string/);
  });

  it("accepts an installed extension panel through the runtime allowlist", () => {
    const panelType = "Acme Extension.Custom Panel";
    const panelId = `${panelType}!main`;
    const proposal = {
      name: "Extension panel",
      data: {
        configById: { [panelId]: { customSetting: { enabled: true } } },
        layout: panelId,
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
      },
    };

    expect(
      validateLayoutProposal(proposal, {
        installedPanelTypes: new Set([panelType]),
      }),
    ).toEqual(proposal);
  });

  it("rejects an extension panel absent from the runtime allowlist", () => {
    const panelType = "Acme Extension.Custom Panel";
    const panelId = `${panelType}!main`;
    const proposal = {
      name: "Uninstalled extension panel",
      data: {
        configById: { [panelId]: {} },
        layout: panelId,
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
      },
    };

    expect(() =>
      validateLayoutProposal(proposal, {
        installedPanelTypes: new Set(["Other Extension.Other Panel"]),
      }),
    ).toThrow(`uses unsupported panel type "${panelType}"`);
  });

  it("preserves the static-only behavior when no runtime allowlist is provided", () => {
    const panelType = "Acme Extension.Custom Panel";
    const panelId = `${panelType}!main`;
    const proposal = {
      name: "No runtime inventory",
      data: {
        configById: { [panelId]: {} },
        layout: panelId,
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
      },
    };

    expect(() => validateLayoutProposal(proposal)).toThrow(
      `uses unsupported panel type "${panelType}"`,
    );
  });

  it("keeps built-in per-panel validation when the runtime allowlist includes that type", () => {
    const proposal = {
      name: "Invalid Plot",
      data: {
        configById: { "Plot!speed": { paths: "not-an-array" } },
        layout: "Plot!speed",
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
      },
    };

    expect(() =>
      validateLayoutProposal(proposal, {
        installedPanelTypes: new Set(["Plot"]),
      }),
    ).toThrow('configById["Plot!speed"].paths must be an array');
  });

  it("accepts an empty layout with no Mosaic tree", () => {
    const data = {
      configById: {},
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {},
    };

    expect(validateLayoutProposalData(data)).toBe(data);
  });

  it("rejects a panel type outside the allowlist", () => {
    const data = validLayoutData();
    data.configById = { "Bogus!publisher": {} };
    data.layout = "Bogus!publisher";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'uses unsupported panel type "Bogus"',
    );
    expect(isValidLayoutProposalData(data)).toBe(false);
  });

  it.each(["Plot", "Plot!", "!suffix", "Plot!one!two", "Plot! "])(
    "rejects malformed panel id %s",
    (panelId) => {
      const data = validLayoutData();
      data.configById = { [panelId]: {} };
      data.layout = panelId;

      expect(() => validateLayoutProposalData(data)).toThrow(
        'must match "<type>!<suffix>"',
      );
    },
  );

  it.each(["Audio", "DiagnosticSummary", "Teleop"])(
    "accepts the built-in %s panel without a runtime inventory",
    (panelType) => {
      const panelId = `${panelType}!main`;
      const data = validLayoutData();
      data.configById = { [panelId]: {} };
      data.layout = panelId;

      expect(() => validateLayoutProposalData(data)).not.toThrow();
      expect(isValidLayoutProposalData(data)).toBe(true);
    },
  );

  it("accepts a Tab panel without a runtime inventory", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": { activeTabIdx: 0, tabs: [{ title: "Main" }] },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).not.toThrow();
    expect(isValidLayoutProposalData(data)).toBe(true);
  });

  it("accepts panels nested inside Tab layouts and shares the panel id namespace", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!outer": {
        activeTabIdx: 0,
        tabs: [
          {
            title: "Main",
            layout: {
              direction: "row",
              first: "Plot!speed",
              second: "Tab!inner",
            },
          },
        ],
      },
      "Tab!inner": {
        activeTabIdx: 1,
        tabs: [
          { title: "First", layout: "Image!camera" },
          { title: "Second" },
        ],
      },
      "Plot!speed": {},
      "Image!camera": {},
    };
    data.layout = "Tab!outer";

    expect(validateLayoutProposalData(data)).toBe(data);
  });

  it("rejects a panel id reused across tabs", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": {
        activeTabIdx: 0,
        tabs: [
          { title: "A", layout: "Plot!same" },
          { title: "B", layout: "Plot!same" },
        ],
      },
      "Plot!same": {},
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'duplicate panel id "Plot!same" in layout',
    );
  });

  it("rejects a Tab config whose tabs field is not an array", () => {
    const data = validLayoutData();
    data.configById = { "Tab!tabs": { activeTabIdx: 0, tabs: "not-an-array" } };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Tab!tabs"].tabs must be an array',
    );
  });

  it("rejects a Tab entry without a string title", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": { activeTabIdx: 0, tabs: [{ layout: "Plot!speed" }] },
      "Plot!speed": {},
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Tab!tabs"].tabs[0] must be an object with a string title',
    );
  });

  it("rejects a non-object Tab entry", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": { activeTabIdx: 0, tabs: ["not-an-object"] },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Tab!tabs"].tabs[0] must be an object with a string title',
    );
  });

  it("rejects a Tab entry with an unknown field", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": { activeTabIdx: 0, tabs: [{ title: "A", extra: true }] },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Tab!tabs"].tabs[0] contains unknown field "extra"',
    );
  });

  it("rejects a Tab layout of null", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": { activeTabIdx: 0, tabs: [{ title: "A", layout: null }] },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Tab!tabs"].tabs[0].layout must be a panel id or Mosaic branch',
    );
  });

  it("rejects a Tab layout that is not a panel id or Mosaic branch", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": { activeTabIdx: 0, tabs: [{ title: "A", layout: 42 }] },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Tab!tabs"].tabs[0].layout must be a panel id or Mosaic branch',
    );
  });

  it("rejects a Tab layout with an invalid Mosaic branch", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": {
        activeTabIdx: 0,
        tabs: [
          {
            title: "A",
            layout: {
              direction: "diagonal",
              first: "Plot!speed",
              second: "Image!camera",
            },
          },
        ],
      },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'direction must be "row" or "column"',
    );
  });

  it("rejects a Tab layout referencing a missing configById entry", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": {
        activeTabIdx: 0,
        tabs: [{ title: "A", layout: "Plot!missing" }],
      },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'layout panel "Plot!missing" is missing a configById entry',
    );
  });

  it.each([
    [
      { tabs: [{ title: "A" }] },
      'configById["Tab!tabs"].activeTabIdx must be an integer',
    ],
    [
      { activeTabIdx: 0.5, tabs: [{ title: "A" }] },
      'configById["Tab!tabs"].activeTabIdx must be an integer',
    ],
  ])("rejects a non-integer Tab activeTabIdx %p", (config, error) => {
    const data = validLayoutData();
    data.configById = { "Tab!tabs": config };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(error);
  });

  it.each([
    [
      { activeTabIdx: -2, tabs: [{ title: "A" }] },
      "must be between -1 and tabs.length - 1 (tabs.length = 1)",
    ],
    [
      { activeTabIdx: 1, tabs: [{ title: "A" }] },
      "must be between -1 and tabs.length - 1 (tabs.length = 1)",
    ],
    [
      { activeTabIdx: 0, tabs: [] },
      "must be between -1 and tabs.length - 1 (tabs.length = 0)",
    ],
  ])("rejects an out-of-range Tab activeTabIdx %p", (config, error) => {
    const data = validLayoutData();
    data.configById = { "Tab!tabs": config };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      `configById["Tab!tabs"].activeTabIdx ${error}`,
    );
  });

  it("accepts activeTabIdx -1 for a Tab with no tab created yet", () => {
    const data = validLayoutData();
    data.configById = { "Tab!tabs": { activeTabIdx: -1, tabs: [] } };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).not.toThrow();
    expect(isValidLayoutProposalData(data)).toBe(true);
  });

  it("accepts activeTabIdx -1 alongside existing tabs", () => {
    const data = validLayoutData();
    data.configById = {
      "Tab!tabs": {
        activeTabIdx: -1,
        tabs: [{ title: "A", layout: "Plot!speed" }],
      },
      "Plot!speed": {},
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).not.toThrow();
    expect(isValidLayoutProposalData(data)).toBe(true);
  });

  it("applies the shared Mosaic depth budget to Tab layouts instead of resetting it", () => {
    const configById: Record<string, unknown> = { "Plot!leaf": {} };
    let inner: unknown = "Plot!leaf";
    for (let index = 0; index < 65; index++) {
      const tabId = `Tab!tab-${index}`;
      const siblingId = `Plot!sibling-${index}`;
      configById[siblingId] = {};
      configById[tabId] = {
        activeTabIdx: 0,
        tabs: [
          {
            title: `tab ${index}`,
            layout: { direction: "row", first: inner, second: siblingId },
          },
        ],
      };
      inner = tabId;
    }
    const data = {
      configById,
      layout: "Tab!tab-64",
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {},
    };

    expect(() => validateLayoutProposalData(data)).toThrow(
      "exceeds the maximum Mosaic depth",
    );
  });

  it("rejects a wide Tab tree exceeding the graph node budget with a stable reason", () => {
    // Two Tab panels with 4096 tabs each: below the per-collection (4096) and config-entry
    // (256) limits, but far above the 10,000-node JSON graph budget. The rejection happens
    // during the JSON graph validation, before any Mosaic traversal.
    const configById: Record<string, unknown> = {};
    for (const tabId of ["Tab!a", "Tab!b"]) {
      configById[tabId] = {
        activeTabIdx: -1,
        tabs: Array.from({ length: 4096 }, (_, index) => ({ title: `tab ${index}` })),
      };
    }
    const data = {
      configById,
      layout: { direction: "row", first: "Tab!a", second: "Tab!b" },
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {},
    };

    expect(() => validateLayoutProposalData(data)).toThrow(
      "LayoutProposal.data contains too many values",
    );
  });

  it("rejects shared object references in Tab configs without overflowing", () => {
    const data = validLayoutData();
    const sharedLayout = {
      direction: "row",
      first: "Plot!speed",
      second: "Image!camera",
    };
    data.configById = {
      "Tab!tabs": {
        activeTabIdx: 0,
        tabs: [
          { title: "A", layout: sharedLayout },
          { title: "B", layout: sharedLayout },
        ],
      },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow(
      "contains a shared object reference",
    );
  });

  it("rejects cyclic references inside Tab configs without overflowing", () => {
    const data = validLayoutData();
    const tabEntry: Record<string, unknown> = { title: "A" };
    tabEntry.layout = tabEntry;
    data.configById = {
      "Tab!tabs": { activeTabIdx: 0, tabs: [tabEntry] },
    };
    data.layout = "Tab!tabs";

    expect(() => validateLayoutProposalData(data)).toThrow("contains a cyclic value");
  });

  it.each([QUADRUPED_VIZ_PANEL_TYPE, HUMANOID_VIZ_PANEL_TYPE])(
    "accepts the extension panel type %s, whose name contains spaces and dots",
    (panelType) => {
      const panelId = `${panelType}!main`;
      const data = validLayoutData();
      data.configById = { [panelId]: {} };
      data.layout = panelId;

      expect(() => validateLayoutProposalData(data)).not.toThrow();
      expect(isValidLayoutProposalData(data)).toBe(true);
    },
  );

  it("accepts a RosOut panel from the static allowlist without a runtime inventory", () => {
    const data = validLayoutData();
    data.configById = {
      "RosOut!logs": {
        topicToRender: "/rosout",
        minLogLevel: 2,
        searchTerms: ["wheel"],
      },
    };
    data.layout = "RosOut!logs";
    const proposal = { name: "RosOut", summary: "Logs", data };

    expect(() => validateLayoutProposalData(data)).not.toThrow();
    expect(isValidLayoutProposalData(data)).toBe(true);
    // No installedPanelTypes option: the static allowlist alone must admit RosOut.
    expect(validateLayoutProposal(proposal)).toEqual(proposal);
  });

  it("accepts a bare RosOut config with default filtering", () => {
    const data = validLayoutData();
    data.configById = { "RosOut!logs": {} };
    data.layout = "RosOut!logs";

    expect(isValidLayoutProposalData(data)).toBe(true);
  });

  it("still rejects an unlisted panel type that contains spaces", () => {
    // Relaxing the id shape to allow extension panel names must not turn the allowlist into a
    // shape check.
    const panelId = "Some Other Extension.Some Panel!main";
    const data = validLayoutData();
    data.configById = { [panelId]: {} };
    data.layout = panelId;

    expect(() => validateLayoutProposalData(data)).toThrow("uses unsupported panel type");
  });

  it("rejects a Mosaic leaf without a configById entry", () => {
    const data = validLayoutData();
    data.layout = "Table!missing";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'layout panel "Table!missing" is missing a configById entry',
    );
  });

  it("rejects orphan configById entries that are not present in the Mosaic tree", () => {
    const data = validLayoutData();
    (data.configById as Record<string, unknown>)["Gauge!orphan"] = {};

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById contains orphan panel config "Gauge!orphan"',
    );
  });

  it("rejects duplicate panel instance ids in the Mosaic tree", () => {
    const data = validLayoutData();
    data.configById = { "Plot!same": {} };
    data.layout = {
      direction: "row",
      first: "Plot!same",
      second: "Plot!same",
    };

    expect(() => validateLayoutProposalData(data)).toThrow(
      'duplicate panel id "Plot!same" in layout',
    );
  });

  it.each([
    [{ first: "Plot!speed", second: "Image!camera" }, 'direction must be "row" or "column"'],
    [
      { direction: "diagonal", first: "Plot!speed", second: "Image!camera" },
      'direction must be "row" or "column"',
    ],
    [{ direction: "row", first: "Plot!speed" }, "must contain both first and second"],
    [
      {
        direction: "row",
        first: "Plot!speed",
        second: "Image!camera",
        splitPercentage: 101,
      },
      "splitPercentage must be a number from 0 to 100",
    ],
  ])("rejects an invalid Mosaic branch", (layout, error) => {
    const data = validLayoutData();
    data.layout = layout;

    expect(() => validateLayoutProposalData(data)).toThrow(error);
  });

  it("rejects unknown fields on Mosaic branches", () => {
    const data = validLayoutData();
    (data.layout as Record<string, unknown>).extra = { hidden: true };

    expect(() => validateLayoutProposalData(data)).toThrow(
      'layout contains unknown field "extra"',
    );
  });

  it("rejects cyclic Mosaic objects", () => {
    const data = validLayoutData();
    const layout: Record<string, unknown> = {
      direction: "row",
      first: "Plot!speed",
    };
    layout.second = layout;
    data.layout = layout;

    expect(() => validateLayoutProposalData(data)).toThrow("contains a cyclic value");
  });

  it("rejects a Mosaic tree deeper than 64 branches without overflowing the call stack", () => {
    const configById: Record<string, unknown> = { "Plot!leaf": { paths: [] } };
    let layout: unknown = "Plot!leaf";
    for (let index = 0; index < 65; index++) {
      const panelId = `Plot!sibling-${index}`;
      configById[panelId] = { paths: [] };
      layout = {
        direction: "row",
        first: layout,
        second: panelId,
      };
    }
    const data = {
      configById,
      layout,
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {},
    };

    expect(() => validateLayoutProposalData(data)).toThrow("exceeds the maximum nesting depth");
  });

  it("rejects non-object panel configs", () => {
    const data = validLayoutData();
    data.configById = { "Gauge!speed": 42 };
    data.layout = "Gauge!speed";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Gauge!speed"] must be an object',
    );
  });

  it("rejects structurally unsafe panel configuration fields", () => {
    const data = validLayoutData();
    data.configById = { "Plot!speed": { paths: {} } };
    data.layout = "Plot!speed";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'configById["Plot!speed"].paths must be an array',
    );
  });

  it.each([
    ["Plot!speed", { paths: [null] }, "paths[0]"],
    ["StateTransitions!state", { paths: [{ label: "missing value" }] }, "paths[0]"],
    [
      "Indicator!status",
      {
        rules: [{ color: "red", label: "Bad", operator: "contains", rawValue: "1" }],
      },
      "rules[0]",
    ],
    ["Indicator!status", { rules: [null] }, "rules[0]"],
  ])("rejects invalid array elements for %s", (panelId, config, error) => {
    const data = validLayoutData();
    data.configById = { [panelId]: config };
    data.layout = panelId;

    expect(() => validateLayoutProposalData(data)).toThrow(error);
  });

  it("accepts structurally valid Indicator rule elements", () => {
    const data = validLayoutData();
    data.configById = {
      "Indicator!status": {
        rules: [{ color: "red", label: "Alert", operator: ">=", rawValue: "10" }],
      },
    };
    data.layout = "Indicator!status";

    expect(validateLayoutProposalData(data)).toBe(data);
  });

  it("accepts user script nodes shaped exactly as { name, sourceCode }", () => {
    const data = validLayoutData();
    data.userNodes = {
      "script-1": { name: "Speed km/h", sourceCode: "export const inputs = ['/speed'];" },
    };

    expect(validateLayoutProposalData(data)).toBe(data);
  });

  it.each([
    [
      "non-object node",
      { "script-1": "export const inputs = [];" },
      /userNodes\["script-1"\] must be an object/,
    ],
    [
      "missing sourceCode",
      { "script-1": { name: "Speed" } },
      /must contain exactly name and sourceCode/,
    ],
    [
      "extra field",
      { "script-1": { name: "Speed", sourceCode: "export const inputs = [];", enabled: true } },
      /must contain exactly name and sourceCode/,
    ],
    [
      "empty name",
      { "script-1": { name: "", sourceCode: "export const inputs = [];" } },
      /name and \.sourceCode must be non-empty strings/,
    ],
    [
      "empty sourceCode",
      { "script-1": { name: "Speed", sourceCode: "" } },
      /name and \.sourceCode must be non-empty strings/,
    ],
    [
      "non-string sourceCode",
      { "script-1": { name: "Speed", sourceCode: 42 } },
      /name and \.sourceCode must be non-empty strings/,
    ],
  ])("rejects a malformed user script node: %s", (_label, userNodes, expected) => {
    const data = validLayoutData();
    data.userNodes = userNodes;

    expect(() => validateLayoutProposalData(data)).toThrow(expected);
  });

  it("still runs the generic JSON budgets over user script nodes", () => {
    const data = validLayoutData();
    data.userNodes = {
      "script-1": { name: "x", sourceCode: "export const inputs = [];".repeat(20_000) },
    };

    expect(() => validateLayoutProposalData(data)).toThrow(
      "exceeds the string size limit",
    );
  });

  it("rejects cyclic values inside panel configurations", () => {
    const config: Record<string, unknown> = { paths: [] };
    config.self = config;
    const data = validLayoutData();
    data.configById = { "Plot!speed": config };
    data.layout = "Plot!speed";

    expect(() => validateLayoutProposalData(data)).toThrow("contains a cyclic value");
  });

  it("rejects more than 256 panel configurations", () => {
    const configById = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`Plot!panel-${index}`, { paths: [] }]),
    );
    const data = validLayoutData();
    data.configById = configById;
    data.layout = "Plot!panel-0";

    expect(() => validateLayoutProposalData(data)).toThrow("exceeds the 256 panel limit");
  });

  it("applies the string budget from the LayoutData root object", () => {
    const data = validLayoutData();
    data.extra = "x".repeat(AGENT_SAFE_LAYOUT_MAX_STRING_BYTES + 1);

    expect(() => validateLayoutProposalData(data)).toThrow("exceeds the string size limit");
  });

  it("rejects unknown top-level LayoutData fields", () => {
    const data = validLayoutData();
    data.extra = "unexpected";

    expect(() => validateLayoutProposalData(data)).toThrow(
      'LayoutProposal.data contains unknown field "extra"',
    );
  });

  it.each([
    [undefined, "LayoutProposal.data must be an object"],
    [
      {
        configById: {},
        globalVariables: {},
        playbackConfig: { speed: "fast" },
        userNodes: {},
      },
      "playbackConfig.speed must be a finite number",
    ],
    [
      {
        configById: {},
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
        version: Number.NaN,
      },
      "version must contain only JSON-compatible values",
    ],
    [
      {
        configById: {},
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
        version: null,
      },
      "version must be a finite number",
    ],
    [
      {
        configById: {},
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
        savedProps: null,
      },
      "savedProps must be an object",
    ],
  ])("rejects invalid LayoutData base fields", (data, error) => {
    expect(() => validateLayoutProposalData(data)).toThrow(error);
  });
});
