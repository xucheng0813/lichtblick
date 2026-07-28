// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LOCAL_AGENT_SYSTEM_PROMPT } from "./systemPrompt";

describe("LOCAL_AGENT_SYSTEM_PROMPT", () => {
  it("describes the VTD workflow, confirmation, and safe layout boundary", () => {
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain("vtd_search");
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toMatch(/explicit\s+user confirmation/);
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain("catalog-ready");
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain("AgentSafeLayoutData");
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain("<type>!<suffix>");
  });
});
