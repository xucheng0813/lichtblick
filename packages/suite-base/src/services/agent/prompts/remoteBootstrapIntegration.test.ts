/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { buildStaticSystemPrompt } from "@lichtblick/suite-base/services/agent/local/systemPrompt";
import { buildToolDefinitions } from "@lichtblick/suite-base/services/agent/local/toolDefinitions";
import {
  EMPTY_CUSTOMIZATION,
  resolveSkills,
} from "@lichtblick/suite-base/services/agent/prompts/agentPrompts";
import {
  fetchAgentBootstrap,
  invalidateAgentBootstrapCache,
  mergeCustomizations,
  readCachedAgentBootstrap,
} from "@lichtblick/suite-base/services/agent/prompts/remotePromptCustomization";
import { runLoadSkillTool } from "@lichtblick/suite-base/services/agent/tools/toolRuntime";
import type { ToolRuntimeDeps } from "@lichtblick/suite-base/services/agent/tools/toolRuntime";
import HttpService from "@lichtblick/suite-base/services/http/HttpService";

jest.mock("@lichtblick/suite-base/services/http/HttpService");

const emptyPrompt = {
  customSkills: [],
  instructions: "",
  skillOverrides: {},
};

const remoteSkill = {
  body: "# Remote skill body\n\nLoaded from the remote bootstrap.",
  id: "remote-skill",
  name: "Remote skill",
  whenToUse: "Use when the remote skill applies.",
};

const localSkill = {
  body: "# Local shadow body\n\nLoaded from local customization.",
  id: "remote-skill",
  name: "Local shadow",
  whenToUse: "Use the local shadow.",
};

function response(data: unknown) {
  return { data, path: "/test", timestamp: "2026-07-29T00:00:00.000Z" };
}

function makeDeps(skills: ReturnType<typeof resolveSkills>): ToolRuntimeDeps {
  return {
    emitLayoutProposal: jest.fn(),
    emitOpenDataSource: jest.fn(),
    getCatalog: () => ({ datatypes: new Map(), topics: [] }),
    getInstalledPanelTypes: () => new Set(),
    skills,
    vtdClient: {} as ToolRuntimeDeps["vtdClient"],
  };
}

describe("remote bootstrap integration", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("carries a remote skill from bootstrap to prompt index, load_skill enum, and loaded body", async () => {
    const workspace = "integration-workspace";
    const mockGet = jest.fn().mockResolvedValue(
      response({ prompt: { ...emptyPrompt, customSkills: [remoteSkill] }, version: "v1" }),
    );
    jest.mocked(HttpService).get = mockGet;

    const bootstrap = await fetchAgentBootstrap(workspace);
    expect(bootstrap.unchanged).toBeUndefined();

    // Turn context: server prompt merged with local, resolved to the effective skill set.
    const customization = mergeCustomizations(bootstrap.prompt, EMPTY_CUSTOMIZATION);
    const skills = resolveSkills(customization);

    // 1. Prompt index carries the remote skill's trigger line.
    const prompt = buildStaticSystemPrompt({ skills });
    expect(prompt).toContain(`- ${remoteSkill.id}: ${remoteSkill.whenToUse}`);

    // 2. The dynamic load_skill enum includes the remote skill id.
    const toolDefinitions = buildToolDefinitions(skills.map((skill) => skill.id));
    const loadSkill = toolDefinitions.find((tool) => tool.name === "load_skill");
    const schemaEnum = (
      loadSkill?.inputSchema as { properties?: { skillId?: { enum?: string[] } } }
    ).properties?.skillId?.enum;
    expect(schemaEnum).toContain(remoteSkill.id);

    // 3. load_skill resolves the id against the same resolved set and returns the body.
    const result = await runLoadSkillTool({ skillId: remoteSkill.id }, makeDeps(skills));
    expect(result).toContain(`<skill id="${remoteSkill.id}">`);
    expect(result).toContain("Loaded from the remote bootstrap.");
  });

  it("applies a remote skill version update on the next turn", async () => {
    const workspace = "integration-workspace";
    const updatedSkill = {
      ...remoteSkill,
      body: "# Remote skill body\n\nUpdated instructions from the server.",
      whenToUse: "Use the updated remote skill.",
    };
    const mockGet = jest
      .fn()
      .mockResolvedValueOnce(
        response({ prompt: { ...emptyPrompt, customSkills: [remoteSkill] }, version: "v1" }),
      )
      .mockResolvedValueOnce(
        response({ prompt: { ...emptyPrompt, customSkills: [updatedSkill] }, version: "v2" }),
      );
    jest.mocked(HttpService).get = mockGet;

    // Turn 1: v1.
    await fetchAgentBootstrap(workspace);
    const turn1Skills = resolveSkills(
      mergeCustomizations(
        readCachedAgentBootstrap(workspace)!.prompt,
        EMPTY_CUSTOMIZATION,
      ),
    );
    const turn1Prompt = buildStaticSystemPrompt({ skills: turn1Skills });
    expect(turn1Prompt).toContain("- remote-skill: Use when the remote skill applies.");

    // Turn 2: the server published v2; a normal poll with known_version returns the new payload
    // and the next turn's prompt index reflects it immediately.
    const turn2Skills = resolveSkills(
      mergeCustomizations(
        (await fetchAgentBootstrap(workspace, "v1")).prompt,
        EMPTY_CUSTOMIZATION,
      ),
    );
    const turn2Prompt = buildStaticSystemPrompt({ skills: turn2Skills });
    expect(turn2Prompt).toContain("- remote-skill: Use the updated remote skill.");
    expect(turn2Prompt).not.toContain("- remote-skill: Use when the remote skill applies.");

    const result = await runLoadSkillTool({ skillId: "remote-skill" }, makeDeps(turn2Skills));
    expect(result).toContain("Updated instructions from the server.");
  });

  it("lets a local skill with the same id intentionally shadow the remote skill", async () => {
    const workspace = "integration-workspace";
    const mockGet = jest.fn().mockResolvedValue(
      response({ prompt: { ...emptyPrompt, customSkills: [remoteSkill] }, version: "v1" }),
    );
    jest.mocked(HttpService).get = mockGet;

    const bootstrap = await fetchAgentBootstrap(workspace);
    const customization = mergeCustomizations(bootstrap.prompt, {
      ...EMPTY_CUSTOMIZATION,
      customSkills: [localSkill],
    });
    const skills = resolveSkills(customization);

    // The local skill wins the id; the remote copy is dropped from the merged set.
    expect(skills.filter((skill) => skill.id === remoteSkill.id)).toHaveLength(1);
    expect(skills.find((skill) => skill.id === remoteSkill.id)?.body).toBe(localSkill.body);

    // The index line and the loaded body come from the local shadow, not the remote skill.
    const prompt = buildStaticSystemPrompt({ skills });
    expect(prompt).toContain("- remote-skill: Use the local shadow.");
    const result = await runLoadSkillTool({ skillId: remoteSkill.id }, makeDeps(skills));
    expect(result).toContain("Loaded from local customization.");
    expect(result).not.toContain("Loaded from the remote bootstrap.");
  });

  it("forces a full re-fetch after invalidation and the next turn sees the new skill set", async () => {
    const workspace = "integration-workspace";
    const mockGet = jest
      .fn()
      .mockResolvedValueOnce(
        response({ prompt: { ...emptyPrompt, customSkills: [remoteSkill] }, version: "v1" }),
      )
      .mockResolvedValueOnce(response({ prompt: emptyPrompt, version: "v2" }));
    jest.mocked(HttpService).get = mockGet;

    await fetchAgentBootstrap(workspace);
    invalidateAgentBootstrapCache(workspace);

    // The re-fetch omits known_version and returns the full (now skill-less) payload.
    const bootstrap = await fetchAgentBootstrap(workspace);
    expect(mockGet).toHaveBeenLastCalledWith(
      `workspaces/${workspace}/agent/bootstrap`,
      {},
    );
    const skills = resolveSkills(mergeCustomizations(bootstrap.prompt, EMPTY_CUSTOMIZATION));
    expect(skills.find((skill) => skill.id === "remote-skill")).toBeUndefined();
    const prompt = buildStaticSystemPrompt({ skills });
    expect(prompt).not.toContain("remote-skill:");
    const toolDefinitions = buildToolDefinitions(skills.map((skill) => skill.id));
    const loadSkill = toolDefinitions.find((tool) => tool.name === "load_skill");
    const schemaEnum = (
      loadSkill?.inputSchema as { properties?: { skillId?: { enum?: string[] } } }
    ).properties?.skillId?.enum;
    expect(schemaEnum).not.toContain("remote-skill");
  });
});
