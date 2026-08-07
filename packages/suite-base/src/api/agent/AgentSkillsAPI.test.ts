// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import HttpService from "@lichtblick/suite-base/services/http/HttpService";

import { AgentSkillsAPI } from "./AgentSkillsAPI";

jest.mock("@lichtblick/suite-base/services/http/HttpService");

describe("AgentSkillsAPI", () => {
  let agentSkillsAPI: AgentSkillsAPI;
  const mockWorkspace = "test-workspace";

  beforeEach(() => {
    agentSkillsAPI = new AgentSkillsAPI(mockWorkspace);
    jest.clearAllMocks();
  });

  it("initializes with the workspace and path constants", () => {
    expect(agentSkillsAPI.workspace).toBe(mockWorkspace);
    expect(agentSkillsAPI.workspacePath).toBe("workspaces");
    expect(agentSkillsAPI.skillPath).toBe("agent/skill");
  });

  it("deletes a skill with DELETE on the assumed contract path", async () => {
    const mockDelete = jest.fn().mockResolvedValue({
      data: undefined,
      timestamp: new Date().toISOString(),
      path: "/test",
    });
    jest.mocked(HttpService).delete = mockDelete;

    await agentSkillsAPI.deleteSkill("my-skill");

    expect(mockDelete).toHaveBeenCalledWith(
      `workspaces/${mockWorkspace}/agent/skill/my-skill`,
    );
  });

  it("URL-encodes workspace and skill id", async () => {
    const mockDelete = jest.fn().mockResolvedValue({
      data: undefined,
      timestamp: new Date().toISOString(),
      path: "/test",
    });
    jest.mocked(HttpService).delete = mockDelete;

    await agentSkillsAPI.deleteSkill("skill with spaces/and/slashes");

    expect(mockDelete).toHaveBeenCalledWith(
      `workspaces/${mockWorkspace}/agent/skill/skill%20with%20spaces%2Fand%2Fslashes`,
    );
  });
});
