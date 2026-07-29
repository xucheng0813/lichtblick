/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import HttpService from "@lichtblick/suite-base/services/http/HttpService";

import {
  fetchAgentBootstrap,
  mergeCustomizations,
  publishCustomization,
  readCachedAgentBootstrap,
} from "./remotePromptCustomization";

jest.mock("@lichtblick/suite-base/services/http/HttpService");

const emptyPrompt = {
  customSkills: [],
  instructions: "",
  skillOverrides: {},
};

function response(data: unknown) {
  return { data, path: "/test", timestamp: "2026-07-29T00:00:00.000Z" };
}

describe("remote prompt customization", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("merges with local precedence and clamps instructions and custom skills", () => {
    const serverSkills = Array.from({ length: 20 }, (_, index) => ({
      body: `server-${String(index)}`,
      id: `server-${String(index)}`,
      name: `Server ${String(index)}`,
      whenToUse: "server",
    }));
    serverSkills[0] = {
      ...serverSkills[0]!,
      body: "server duplicate",
      id: "shared",
    };
    const localSkill = {
      body: "local duplicate",
      id: "shared",
      name: "Shared",
      whenToUse: "local",
    };
    const merged = mergeCustomizations(
      {
        customSkills: serverSkills,
        instructions: "s".repeat(7_999),
        skillOverrides: { layout: "server", topic: "server" },
      },
      {
        customSkills: [localSkill],
        instructions: "local",
        skillOverrides: { layout: "local" },
      },
    );

    expect(merged.instructions).toHaveLength(8_000);
    expect(merged.instructions.endsWith("local")).toBe(true);
    expect(merged.skillOverrides).toEqual({ layout: "local", topic: "server" });
    expect(merged.customSkills).toHaveLength(20);
    expect(merged.customSkills.filter((skill) => skill.id === "shared")).toEqual([localSkill]);
  });

  it("uses a valid workspace cache and ignores malformed entries", async () => {
    const workspace = "cached-workspace";
    localStorage.setItem(
      "lichtblick.vizserver.agent-bootstrap.v1",
      JSON.stringify({
        [workspace]: {
          prompt: { ...emptyPrompt, instructions: "cached" },
          version: "v1",
        },
        malformed: { prompt: "bad", version: "v2" },
      }),
    );

    expect(readCachedAgentBootstrap(workspace)).toMatchObject({
      prompt: { instructions: "cached" },
      version: "v1",
    });
    expect(readCachedAgentBootstrap("malformed")).toBeUndefined();

    const mockGet = jest.fn().mockResolvedValue(response({ unchanged: true, version: "v1" }));
    jest.mocked(HttpService).get = mockGet;
    const unchanged = await fetchAgentBootstrap(workspace, "v1");
    expect(unchanged).toEqual({ unchanged: true, version: "v1" });
    expect(readCachedAgentBootstrap(workspace)?.prompt?.instructions).toBe("cached");
  });

  it("rejects malformed bootstrap payloads", async () => {
    const mockGet = jest.fn().mockResolvedValue(
      response({
        config: { provider: "unsupported" },
        prompt: emptyPrompt,
        version: "v1",
      }),
    );
    jest.mocked(HttpService).get = mockGet;
    await expect(fetchAgentBootstrap("invalid-workspace")).rejects.toThrow(
      "Invalid agent bootstrap config field: provider",
    );

    mockGet.mockResolvedValue(
      response({
        prompt: { ...emptyPrompt, customSkills: [{ id: "missing-fields" }] },
        version: "v1",
      }),
    );
    await expect(fetchAgentBootstrap("invalid-prompt-workspace")).rejects.toThrow(
      "Invalid agent prompt customization",
    );
  });

  it("drops unknown config fields and never persists the server apiKey", async () => {
    const workspace = "secret-workspace";
    const mockGet = jest.fn().mockResolvedValue(
      response({
        config: {
          apiKey: "server-secret",
          model: "server-model",
          provider: "anthropic",
          unknown: "discard me",
        },
        prompt: emptyPrompt,
        version: "v1",
      }),
    );
    jest.mocked(HttpService).get = mockGet;

    const fetched = await fetchAgentBootstrap(workspace);
    expect(fetched.config).toEqual({
      apiKey: "server-secret",
      model: "server-model",
      provider: "anthropic",
    });
    expect(localStorage.getItem("lichtblick.vizserver.agent-bootstrap.v1")).not.toContain(
      "server-secret",
    );
    expect(localStorage.getItem("lichtblick.agent.credentials.v1")).toBeNull();
  });

  it("publishes the local prompt and updates the cached version and payload", async () => {
    const workspace = "publish-workspace";
    const prompt = { ...emptyPrompt, instructions: "published" };
    const mockPut = jest.fn().mockResolvedValue(response({ version: "v2" }));
    jest.mocked(HttpService).put = mockPut;

    await expect(publishCustomization(workspace, prompt)).resolves.toMatchObject({
      prompt,
      version: "v2",
    });
    expect(mockPut).toHaveBeenCalledWith(`workspaces/${workspace}/agent/prompt`, prompt);
    expect(readCachedAgentBootstrap(workspace)).toMatchObject({
      prompt,
      version: "v2",
    });
  });
});
