// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { QUADRUPED_VIZ_PANEL_TYPE } from "@lichtblick/suite-base/services/agent/layoutSchema";
import type { PanelInventoryEntry } from "@lichtblick/suite-base/services/agent/panelInventory";
import {
  executeToolRuntime,
  TOOL_RUNTIME_MAX_RESULT_BYTES,
  type ToolRuntimeDeps,
} from "@lichtblick/suite-base/services/agent/tools/toolRuntime";

import {
  boundCurrentLayout,
  GET_CURRENT_LAYOUT_MAX_BYTES,
  GET_CURRENT_LAYOUT_TOO_LARGE_MAX_BYTES,
  runGetCurrentLayoutTool,
  runListPanelsTool,
} from "./workspaceStateTools";

function makeDeps(overrides: Partial<ToolRuntimeDeps> = {}): ToolRuntimeDeps {
  return {
    vtdClient: {} as ToolRuntimeDeps["vtdClient"],
    skills: [],
    getCatalog: jest.fn().mockReturnValue({ topics: [], datatypes: new Map() }),
    getInstalledPanelTypes: jest.fn().mockReturnValue(new Set<string>()),
    emitOpenDataSource: jest.fn(),
    emitLayoutProposal: jest.fn(),
    ...overrides,
  };
}

function panel(
  type: string,
  source: "builtin" | "extension",
  extra: Partial<PanelInventoryEntry> = {},
): PanelInventoryEntry {
  return {
    type,
    title: type,
    description: `${type} description.`,
    source,
    ...extra,
  };
}

describe("runListPanelsTool", () => {
  it("annotates each panel type with the skill that documents it", async () => {
    const deps = makeDeps({
      getPanelInventory: () => [
        panel("Plot", "builtin", { title: "Plot", description: "Plots numeric values." }),
        panel(QUADRUPED_VIZ_PANEL_TYPE, "extension", {
          title: "Quadruped Visualization",
          description: "Robot 3D visualization.",
        }),
        panel("Acme.Custom", "extension"),
      ],
    });

    const result = await runListPanelsTool({}, deps);

    expect(result.count).toBe(3);
    expect(result.panels).toEqual([
      expect.objectContaining({ type: "Plot", skillId: "panel-plot" }),
      expect.objectContaining({
        type: QUADRUPED_VIZ_PANEL_TYPE,
        skillId: "robot-viz",
      }),
      // Panels without a skill keep the verbatim inventory entry.
      {
        type: "Acme.Custom",
        title: "Acme.Custom",
        description: "Acme.Custom description.",
        source: "extension",
      },
    ]);
  });

  it("filters by source and by case-insensitive query", async () => {
    const deps = makeDeps({
      getPanelInventory: () => [
        panel("Plot", "builtin", { title: "Plot", description: "Plots numeric values." }),
        panel("Acme.Camera", "extension", {
          title: "Camera",
          description: "Shows camera images.",
        }),
        panel("Acme.Audio", "extension", {
          title: "Audio",
          description: "Plays audio.",
        }),
      ],
    });

    const builtin = await runListPanelsTool({ source: "builtin" }, deps);
    expect(builtin.count).toBe(1);
    expect(builtin.panels[0]?.type).toBe("Plot");

    const camera = await runListPanelsTool({ query: "CAMERA" }, deps);
    expect(camera.count).toBe(1);
    expect(camera.panels[0]?.type).toBe("Acme.Camera");

    const audio = await runListPanelsTool({ source: "extension", query: "audio" }, deps);
    expect(audio.count).toBe(1);
    expect(audio.panels[0]?.type).toBe("Acme.Audio");

    await expect(
      runListPanelsTool({ source: "internal" }, deps),
    ).rejects.toThrow("list_panels.source must be one of: builtin, extension");
  });

  it("errors when the panel inventory is not configured", async () => {
    await expect(runListPanelsTool({}, makeDeps())).rejects.toThrow(
      "list_panels is unavailable: panel inventory not configured",
    );
  });

  it("rejects unknown properties at the runtime boundary", async () => {
    const getPanelInventory = jest.fn(() => [panel("Plot", "builtin")]);
    const deps = makeDeps({ getPanelInventory });

    await expect(
      executeToolRuntime("list_panels", { source: "builtin", bogus: 1 }, deps),
    ).rejects.toThrow('list_panels does not support property "bogus"');
    await expect(
      executeToolRuntime("get_current_layout", { includeScripts: true }, deps),
    ).rejects.toThrow('get_current_layout does not support property "includeScripts"');
    expect(getPanelInventory).not.toHaveBeenCalled();
  });
});

describe("get_current_layout", () => {
  it("reports that no layout is selected", async () => {
    const deps = makeDeps({
      getCurrentLayout: () => undefined,
      getCurrentLayoutId: () => undefined,
    });

    await expect(runGetCurrentLayoutTool({}, deps)).resolves.toEqual({
      panelCount: 0,
      note: "No layout is selected.",
    });
  });

  it("treats non-object layout data as no selected layout", () => {
    expect(boundCurrentLayout("layout-1", undefined)).toEqual({
      panelCount: 0,
      note: "No layout is selected.",
    });
  });

  it("echoes the complete LayoutData verbatim with id and panelCount", async () => {
    const layoutData = {
      configById: {
        "Plot!speed": {
          paths: [{ value: "/speed.data" }],
          lichtblickPanelTitle: "Speed",
        },
      },
      layout: "Plot!speed",
      globalVariables: { scale: 1 },
      playbackConfig: { speed: 0.5 },
      userNodes: {
        script1: {
          name: "calc",
          sourceCode: 'export const output = "/studio_script/calc";',
        },
      },
      savedProps: {},
      version: 1,
    };
    const deps = makeDeps({
      getCurrentLayout: () => layoutData,
      getCurrentLayoutId: () => "layout-1",
    });

    await expect(runGetCurrentLayoutTool({}, deps)).resolves.toEqual({
      ...layoutData,
      id: "layout-1",
      panelCount: 1,
    });
    // The echoed userNodes carry the complete script source, not a summary.
    const result = (await runGetCurrentLayoutTool({}, deps)) as {
      userNodes: { script1: { sourceCode: string } };
    };
    expect(result.userNodes.script1.sourceCode).toBe(
      'export const output = "/studio_script/calc";',
    );
  });

  it("degrades to a panel index when the layout exceeds the byte budget", async () => {
    const layoutData = {
      configById: {
        "Plot!speed": {
          paths: [{ value: "/speed.data" }],
          lichtblickPanelTitle: "Speed",
        },
      },
      layout: "Plot!speed",
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {
        big: {
          name: "big",
          sourceCode: "x".repeat(GET_CURRENT_LAYOUT_MAX_BYTES + 64),
        },
      },
    };
    const deps = makeDeps({
      getCurrentLayout: () => layoutData,
      getCurrentLayoutId: () => "layout-9",
    });

    const result = (await runGetCurrentLayoutTool({}, deps)) as {
      byteLength: number;
      id: string;
      note: string;
      panelCount: number;
      panels: Array<{ id: string; type: string; title?: string; byteLength: number }>;
      tooLarge: true;
    };

    expect(result.tooLarge).toBe(true);
    expect(result.id).toBe("layout-9");
    expect(result.panelCount).toBe(1);
    expect(result.byteLength).toBeGreaterThan(GET_CURRENT_LAYOUT_MAX_BYTES);
    expect(result.note).toBe(
      "Layout too large to echo; in-place extension is impossible — propose a new layout or ask the user.",
    );
    expect(result.panels).toEqual([
      {
        id: "Plot!speed",
        type: "Plot",
        title: "Speed",
        byteLength: expect.any(Number),
      },
    ]);
    // The degraded summary must survive the tool-result envelope untouched.
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(
      TOOL_RUNTIME_MAX_RESULT_BYTES,
    );
  });

  it("errors when layout access is not configured", async () => {
    await expect(runGetCurrentLayoutTool({}, makeDeps())).rejects.toThrow(
      "get_current_layout is unavailable: layout access is not configured",
    );
  });

  it("bounds the tooLarge panel index by whole entries and never falls into a preview", async () => {
    // A layout whose full echo exceeds the 128 KB budget, with many panels whose long multibyte
    // titles would push the degraded panel index past the runtime envelope.
    const configById: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 400; index++) {
      configById[`Plot!panel${String(index)}`] = {
        paths: [{ value: "/speed.data" }],
        lichtblickPanelTitle: `速度曲线 ${String(index)} `.repeat(60),
      };
    }
    const layoutData = {
      configById,
      layout: { direction: "row", first: "Plot!panel0", second: "Plot!panel1" },
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {
        big: {
          name: "big",
          sourceCode: "x".repeat(GET_CURRENT_LAYOUT_MAX_BYTES + 64),
        },
      },
    };
    const deps = makeDeps({
      getCurrentLayout: () => layoutData,
      getCurrentLayoutId: () => "layout-many",
    });

    // End-to-end through the runtime envelope: the result must keep the structured tooLarge
    // contract instead of degrading into a raw JSON preview.
    const result = (await executeToolRuntime("get_current_layout", {}, deps)) as {
      byteLength: number;
      note: string;
      omittedCount: number;
      panelCount: number;
      panels: Array<{ id: string; byteLength: number }>;
      tooLarge: true;
      truncatedPanels: true;
    };

    expect(result.tooLarge).toBe(true);
    expect(result.panelCount).toBe(400);
    expect(result.panels.length).toBeLessThan(400);
    expect(result.truncatedPanels).toBe(true);
    expect(result.omittedCount).toBe(400 - result.panels.length);
    expect(Object.hasOwn(result, "preview")).toBe(false);
    expect(result.note).toBe(
      "Layout too large to echo; in-place extension is impossible — propose a new layout or ask the user.",
    );
    const serialized = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    expect(serialized).toBeLessThanOrEqual(GET_CURRENT_LAYOUT_TOO_LARGE_MAX_BYTES);
    expect(serialized).toBeLessThan(TOOL_RUNTIME_MAX_RESULT_BYTES);
  });

  it("drops a single oversized multibyte panel entry wholesale", async () => {
    const hugeTitle = "中文标题".repeat(20_000); // far beyond any per-entry budget
    const layoutData = {
      configById: {
        ["Plot!huge"]: {
          paths: [{ value: "/speed.data" }],
          lichtblickPanelTitle: hugeTitle,
        },
        ["Plot!normal"]: { paths: [{ value: "/speed.data" }] },
      },
      layout: { direction: "row", first: "Plot!huge", second: "Plot!normal" },
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {
        big: {
          name: "big",
          sourceCode: "x".repeat(GET_CURRENT_LAYOUT_MAX_BYTES + 64),
        },
      },
    };
    const deps = makeDeps({
      getCurrentLayout: () => layoutData,
      getCurrentLayoutId: () => "layout-huge-title",
    });

    const result = (await executeToolRuntime("get_current_layout", {}, deps)) as {
      omittedCount: number;
      panelCount: number;
      panels: Array<{ id: string; title?: string }>;
      tooLarge: true;
      truncatedPanels: true;
    };

    expect(result.tooLarge).toBe(true);
    expect(result.panelCount).toBe(2);
    // The oversized entry is never truncated into a pseudo-title: it is dropped whole, together
    // with the trailing entries that could not bring the index under budget while keeping it.
    expect(result.panels).not.toContainEqual(expect.objectContaining({ id: "Plot!huge" }));
    expect(result.panels.every((entry) => entry.title !== hugeTitle)).toBe(true);
    expect(result.truncatedPanels).toBe(true);
    expect(result.omittedCount).toBe(2);
    expect(Object.hasOwn(result, "preview")).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(
      TOOL_RUNTIME_MAX_RESULT_BYTES,
    );
  });
});
