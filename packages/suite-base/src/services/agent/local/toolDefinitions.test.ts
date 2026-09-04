// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LOCAL_AGENT_TOOL_DEFINITIONS } from "./toolDefinitions";

describe("LOCAL_AGENT_TOOL_DEFINITIONS", () => {
  it("exposes exactly the contracted tool allowlist with object schemas", () => {
    expect(LOCAL_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "load_skill",
      "memory_write",
      "memory_forget",
      "memory_list",
      "vtd_search",
      "vtd_trigger",
      "vtd_detail",
      "vtd_topics",
      "request_batch_consent",
      "vtd_slice_store",
      "vtd_presign",
      "open_data_source",
      "get_data_catalog",
      "describe_topic",
      "list_panels",
      "get_current_layout",
      "propose_layout",
      "read_messages",
      "search_messages",
      "playback_control",
    ]);
    for (const tool of LOCAL_AGENT_TOOL_DEFINITIONS) {
      expect(tool.inputSchema).toEqual(
        expect.objectContaining({ type: "object" }),
      );
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("defines the catalog tools with verbatim-name and field-lookup contracts", () => {
    const byName = new Map(LOCAL_AGENT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

    const catalog = byName.get("get_data_catalog")!;
    expect(catalog.description).toContain("Names are returned verbatim");
    expect(catalog.description).toContain("no leading slash");
    expect(catalog.inputSchema).toEqual(
      expect.objectContaining({
        additionalProperties: false,
        properties: expect.objectContaining({
          query: expect.any(Object),
          schema: expect.any(Object),
          limit: expect.objectContaining({ type: "integer", minimum: 1, maximum: 500 }),
        }),
      }),
    );

    const describe = byName.get("describe_topic")!;
    expect(describe.description).toContain("flattened field list");
    expect(describe.description).toContain("Unknown names return suggestions");
    expect(describe.inputSchema).toEqual(
      expect.objectContaining({
        additionalProperties: false,
        required: ["topics"],
        properties: expect.objectContaining({
          topics: expect.objectContaining({
            type: "array",
            minItems: 1,
            maxItems: 10,
          }),
          maxDepth: expect.objectContaining({ type: "integer", minimum: 1, maximum: 10 }),
        }),
      }),
    );
  });

  it("defines the workspace-state tools before propose_layout", () => {
    const byName = new Map(LOCAL_AGENT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    const names = LOCAL_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names.indexOf("get_data_catalog")).toBeLessThan(names.indexOf("describe_topic"));
    expect(names.indexOf("describe_topic")).toBeLessThan(names.indexOf("list_panels"));
    expect(names.indexOf("list_panels")).toBeLessThan(names.indexOf("get_current_layout"));
    expect(names.indexOf("get_current_layout")).toBeLessThan(names.indexOf("propose_layout"));

    const listPanels = byName.get("list_panels")!;
    expect(listPanels.description).toContain("built-ins and installed extensions");
    expect(listPanels.description).toContain("Use the returned type string verbatim");
    expect(listPanels.description).toContain("does not include config schemas");
    expect(listPanels.inputSchema).toEqual(
      expect.objectContaining({
        additionalProperties: false,
        properties: expect.objectContaining({
          source: expect.objectContaining({ enum: ["builtin", "extension"] }),
          query: expect.any(Object),
        }),
      }),
    );

    const currentLayout = byName.get("get_current_layout")!;
    expect(currentLayout.description).toContain("full LayoutData plus id");
    expect(currentLayout.description).toContain("reproduced verbatim");
    expect(currentLayout.description).toContain(
      "a tooLarge result means in-place extension is impossible",
    );
    expect(currentLayout.inputSchema).toEqual(
      expect.objectContaining({ additionalProperties: false, properties: {} }),
    );
  });

  it("defines the data-query tool schemas with their limits and enums", () => {
    const byName = new Map(LOCAL_AGENT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

    const read = byName.get("read_messages")!;
    expect(read.inputSchema).toEqual(
      expect.objectContaining({
        required: ["topic"],
        properties: expect.objectContaining({
          topic: expect.any(Object),
          start: expect.any(Object),
          end: expect.any(Object),
          limit: expect.objectContaining({ maximum: 100 }),
        }),
      }),
    );

    const search = byName.get("search_messages")!;
    const searchProperties = (
      search.inputSchema as {
        properties: { level?: { enum?: string[] }; limit?: { maximum?: number } };
      }
    ).properties;
    expect(searchProperties.level?.enum).toEqual([
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
      "unknown",
    ]);
    expect(searchProperties.limit?.maximum).toBe(20);
    expect(search.description).toMatch(/at least one/);

    const playback = byName.get("playback_control")!;
    expect(playback.inputSchema).toEqual(
      expect.objectContaining({
        required: ["action"],
        properties: expect.objectContaining({
          action: expect.objectContaining({ enum: ["seek", "play", "pause"] }),
          time: expect.any(Object),
        }),
      }),
    );
    // The definition documents the seek result contract implemented by the runtime: an optional
    // previousTimeNs that is omitted when the player has no current playback time.
    expect(playback.description).toContain("previousTimeNs");
    expect(playback.description).toMatch(/omitted.*cannot be\s+automatically undone/s);
  });

  it("defines a side-effect-free batch consent plan schema", () => {
    const consent = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "request_batch_consent",
    );

    expect(consent?.description).toContain("side-effect-free confirmation card");
    expect(consent?.inputSchema).toEqual(
      expect.objectContaining({
        required: ["action", "summary", "itemCount"],
        properties: expect.objectContaining({
          action: expect.objectContaining({ type: "string", minLength: 1 }),
          summary: expect.objectContaining({ type: "string", minLength: 1 }),
          itemCount: expect.objectContaining({ type: "integer", minimum: 1 }),
        }),
      }),
    );
  });

  it("keeps nanoseconds as decimal strings and slice storage confirmation explicit", () => {
    const slice = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "vtd_slice_store",
    );

    expect(slice?.description).toContain("confirmation");
    expect(slice?.inputSchema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          startNs: expect.objectContaining({
            type: "string",
            pattern: "^[0-9]+$",
          }),
          endNs: expect.objectContaining({
            type: "string",
            pattern: "^[0-9]+$",
          }),
        }),
      }),
    );
  });

  it("requires VTD search times to be absolute local date-time values", () => {
    const search = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "vtd_search",
    );
    const properties = (
      search?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      }
    ).properties;

    for (const field of [
      "start",
      "end",
      "at",
      "triggerTime",
      "queryStart",
      "queryEnd",
      "queryTime",
    ]) {
      expect(properties?.[field]?.description).toContain(
        "YYYY-MM-DD[ HH:MM:SS]",
      );
      expect(properties?.[field]?.description).toContain(
        "relative times to absolute values",
      );
    }
  });

  it("tells the model that vtd_search results are shown as an interactive list card", () => {
    const search = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "vtd_search",
    );
    expect(search?.description).toContain("interactive list card");
    expect(search?.description).toContain("keep textual summaries brief");
  });

  it("describes data-coverage search fields for looking at a time window", () => {
    const search = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "vtd_search",
    );
    const properties = (
      search?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      }
    ).properties;

    expect(properties?.queryStart?.description).toContain(
      "Data-coverage interval lower bound",
    );
    expect(properties?.queryEnd?.description).toContain(
      "Data-coverage interval upper bound",
    );
    expect(properties?.queryStart?.description).toContain(
      "data at a specific time or interval",
    );
    expect(properties?.queryEnd?.description).toContain(
      "data at a specific time or interval",
    );
  });

  it("documents loading multiple data-source URLs together in one call", () => {
    const openDataSource = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "open_data_source",
    );
    expect(openDataSource?.description).toContain("multiple URLs in one call");
    expect(openDataSource?.description).toContain("load them together");
  });
});
