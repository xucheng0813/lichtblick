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
      "propose_layout",
    ]);
    for (const tool of LOCAL_AGENT_TOOL_DEFINITIONS) {
      expect(tool.inputSchema).toEqual(
        expect.objectContaining({ type: "object" }),
      );
      expect(tool.description.length).toBeGreaterThan(0);
    }
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
