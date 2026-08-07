/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import HttpService from "@lichtblick/suite-base/services/http/HttpService";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";
import { makeMockAppConfiguration } from "@lichtblick/suite-base/util/makeMockAppConfiguration";
import { resolveWorkspace } from "@lichtblick/suite-base/util/vizServerParams";

import {
  fetchAgentBootstrap,
  invalidateAgentBootstrapCache,
  mergeCustomizations,
  publishCustomization,
  readCachedAgentBootstrap,
  readCurrentAgentBootstrap,
  subscribeAgentBootstrapInvalidation,
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
    globalThis.history.replaceState({}, "", "/");
    setHttpBaseUrl(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
    const serialized = JSON.stringify({
      [workspace]: {
        prompt: { ...emptyPrompt, instructions: "cached" },
        version: "v1",
      },
      malformed: { prompt: "bad", version: "v2" },
    });
    if (serialized == undefined) {
      throw new Error("Unable to serialize bootstrap test fixture");
    }
    localStorage.setItem(
      "lichtblick.vizserver.agent-bootstrap.v1",
      serialized,
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

  it("skips cache persistence when JSON serialization returns undefined", async () => {
    const workspace = "unserializable-workspace";
    const mockGet = jest.fn().mockResolvedValue(
      response({
        prompt: emptyPrompt,
        version: "v1",
      }),
    );
    jest.mocked(HttpService).get = mockGet;
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    const stringify = jest.spyOn(JSON, "stringify").mockReturnValueOnce(undefined);

    await expect(fetchAgentBootstrap(workspace)).resolves.toMatchObject({
      version: "v1",
    });

    stringify.mockRestore();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("uses the authoritative workspace snapshot and runtime HTTP base URL", async () => {
    const workspace = "configured-workspace";
    resolveWorkspace(
      makeMockAppConfiguration([
        [AppSetting.VIZ_SERVER_WORKSPACE, workspace],
      ]),
    );
    setHttpBaseUrl("http://runtime.example.com/lichtblick");
    const mockGet = jest.fn().mockResolvedValue(
      response({
        prompt: { ...emptyPrompt, instructions: "from configured workspace" },
        version: "v1",
      }),
    );
    jest.mocked(HttpService).get = mockGet;
    await fetchAgentBootstrap(workspace);

    expect(readCurrentAgentBootstrap()?.prompt?.instructions).toBe(
      "from configured workspace",
    );

    setHttpBaseUrl(undefined);
    expect(readCurrentAgentBootstrap()).toBeUndefined();
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

  it("invalidates the cache and notifies subscribers so the next fetch omits known_version", async () => {
    const workspace = "invalidate-workspace";
    const prompt = { ...emptyPrompt, instructions: "cached instructions" };
    const mockGet = jest
      .fn()
      .mockResolvedValueOnce(response({ prompt, version: "v1" }))
      .mockResolvedValueOnce(response({ prompt: { ...prompt, instructions: "replaced" }, version: "v2" }));
    jest.mocked(HttpService).get = mockGet;
    await fetchAgentBootstrap(workspace);
    expect(readCachedAgentBootstrap(workspace)).toMatchObject({ version: "v1" });

    const listener = jest.fn();
    const unsubscribe = subscribeAgentBootstrapInvalidation(listener);

    invalidateAgentBootstrapCache(workspace);

    // Subscribers are notified synchronously with the workspace id…
    expect(listener).toHaveBeenCalledWith(workspace);
    // …the memory and persisted cache entries are gone…
    expect(readCachedAgentBootstrap(workspace)).toBeUndefined();
    expect(localStorage.getItem("lichtblick.vizserver.agent-bootstrap.v1")).not.toContain(
      workspace,
    );

    // The next fetch sends no known_version and returns the full payload.
    await fetchAgentBootstrap(workspace);
    expect(mockGet).toHaveBeenLastCalledWith(
      `workspaces/${workspace}/agent/bootstrap`,
      {},
    );
    expect(readCachedAgentBootstrap(workspace)).toMatchObject({
      prompt: { instructions: "replaced" },
      version: "v2",
    });

    unsubscribe();
    invalidateAgentBootstrapCache(workspace);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("invalidating an uncached workspace is a no-op that still notifies subscribers", () => {
    const listener = jest.fn();
    subscribeAgentBootstrapInvalidation(listener);
    invalidateAgentBootstrapCache("never-fetched-workspace");
    expect(listener).toHaveBeenCalledWith("never-fetched-workspace");
    expect(readCachedAgentBootstrap("never-fetched-workspace")).toBeUndefined();
  });

  it("ignores an out-of-order stale full-fetch response when writing the cache", async () => {
    const workspace = "out-of-order-workspace";
    let releaseStale: (() => void) | undefined;
    const staleResponse = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const mockGet = jest
      .fn()
      // Stale fetch (v1) — slow, resolves after the fresher one.
      .mockImplementationOnce(async () => {
        await staleResponse;
        return response({ prompt: { ...emptyPrompt, instructions: "stale v1" }, version: "v1" });
      })
      // Fresher fetch (v2, e.g. a post-invalidation re-fetch) — resolves first.
      .mockResolvedValueOnce(
        response({ prompt: { ...emptyPrompt, instructions: "fresh v2" }, version: "v2" }),
      );
    jest.mocked(HttpService).get = mockGet;

    const staleFetch = fetchAgentBootstrap(workspace);
    const freshFetch = fetchAgentBootstrap(workspace);
    await freshFetch;
    expect(readCachedAgentBootstrap(workspace)).toMatchObject({ version: "v2" });

    releaseStale!();
    await staleFetch;
    // The late stale response must not roll the cache back to v1.
    expect(readCachedAgentBootstrap(workspace)).toMatchObject({
      prompt: { instructions: "fresh v2" },
      version: "v2",
    });
  });
});
