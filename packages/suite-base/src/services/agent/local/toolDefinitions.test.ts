// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LOCAL_AGENT_TOOL_DEFINITIONS } from "./toolDefinitions";

describe("LOCAL_AGENT_TOOL_DEFINITIONS", () => {
  it("exposes exactly the contracted tool allowlist with object schemas", () => {
    expect(LOCAL_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "vtd_search",
      "vtd_detail",
      "vtd_topics",
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
});
