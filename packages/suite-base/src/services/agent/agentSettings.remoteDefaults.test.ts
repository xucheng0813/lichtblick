/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  type AgentSettingsSnapshot,
  getAgentConfigurationSource,
  getOrgDefaultProfile,
  selectAgentConfiguration,
  validateAgentConfiguration,
} from "@lichtblick/suite-base/services/agent/agentSettings";
import { readCurrentAgentBootstrap } from "@lichtblick/suite-base/services/agent/prompts/remotePromptCustomization";

jest.mock(
  "@lichtblick/suite-base/services/agent/prompts/remotePromptCustomization",
  () => ({
    readCurrentAgentBootstrap: jest.fn(),
  }),
);

function snapshot(
  overrides: Partial<AgentSettingsSnapshot> = {},
): AgentSettingsSnapshot {
  const base: AgentSettingsSnapshot = {
    activeProfileId: "default",
    anthropic: { apiKey: "", baseUrl: "", model: "claude-opus-4-8" },
    credentialResaveRequired: false,
    credentialStorage: "plaintext",
    openAiCompatible: { apiKey: "", baseUrl: "", model: "" },
    profiles: [],
    provider: "anthropic",
    revision: "",
    storageError: false,
    vtdAuthToken: "",
    vtdEndpoint: "",
  };
  const merged = { ...base, ...overrides };
  const profiles: AgentSettingsSnapshot["profiles"] = overrides.profiles ?? [
    {
      anthropic: { ...merged.anthropic },
      id: "default",
      name: "Default",
      openAiCompatible: { ...merged.openAiCompatible },
      provider: merged.provider,
    },
  ];
  return {
    ...merged,
    activeProfileId: overrides.activeProfileId ?? profiles[0]!.id,
    profiles,
  };
}

describe("server default Agent configuration", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("uses server defaults for an unconfigured local Agent without persisting the apiKey", () => {
    jest.mocked(readCurrentAgentBootstrap).mockReturnValue({
      config: {
        apiKey: "server-secret",
        baseUrl: "https://llm.example.com",
        model: "server-model",
        provider: "openai-compatible",
        vtdAuthToken: "server-vtd-token",
        vtdEndpoint: "https://vtd.example.com",
      },
      version: "v1",
    });
    const local = snapshot();

    expect(selectAgentConfiguration(local, { desktop: false })).toEqual({
      apiKey: "server-secret",
      baseUrl: "https://llm.example.com",
      desktop: false,
      model: "server-model",
      provider: "openai-compatible",
      vtdAuthToken: "server-vtd-token",
      vtdEndpoint: "https://vtd.example.com",
    });
    expect(getAgentConfigurationSource(local, { desktop: false })).toBe(
      "server",
    );
    expect(localStorage.getItem("lichtblick.agent.credentials.v1")).toBeNull();
  });

  it("keeps every explicitly configured local value", () => {
    jest.mocked(readCurrentAgentBootstrap).mockReturnValue({
      config: {
        apiKey: "server-secret",
        baseUrl: "https://server.example.com",
        model: "server-model",
        provider: "openai-compatible",
        vtdAuthToken: "server-vtd-token",
        vtdEndpoint: "https://server-vtd.example.com",
      },
      version: "v1",
    });
    const local = snapshot({
      anthropic: {
        apiKey: "local-secret",
        baseUrl: "https://local.example.com",
        model: "local-model",
      },
      provider: "anthropic",
      revision: "local-revision",
      vtdAuthToken: "local-vtd-token",
      vtdEndpoint: "https://local-vtd.example.com",
    });

    expect(selectAgentConfiguration(local, { desktop: false })).toEqual({
      apiKey: "local-secret",
      baseUrl: "https://local.example.com",
      desktop: false,
      model: "local-model",
      provider: "anthropic",
      vtdAuthToken: "local-vtd-token",
      vtdEndpoint: "https://local-vtd.example.com",
    });
    expect(getAgentConfigurationSource(local, { desktop: false })).toBe(
      "local",
    );
  });

  it("does not apply an apiKey belonging to a different server provider", () => {
    jest.mocked(readCurrentAgentBootstrap).mockReturnValue({
      config: {
        apiKey: "openai-secret",
        provider: "openai-compatible",
      },
      version: "v1",
    });
    const local = snapshot({
      anthropic: { apiKey: "", baseUrl: "", model: "local-anthropic-model" },
      revision: "local-revision",
    });

    expect(selectAgentConfiguration(local, { desktop: true }).apiKey).toBe("");
    expect(getAgentConfigurationSource(local, { desktop: true })).toBe("local");
  });

  it("exposes and selects the read-only organization default profile", () => {
    jest.mocked(readCurrentAgentBootstrap).mockReturnValue({
      config: {
        apiKey: "org-secret",
        baseUrl: "https://org-llm.example.com/v1",
        model: "org-model",
        provider: "openai-compatible",
        vtdAuthToken: "org-vtd-token",
        vtdEndpoint: "https://org-vtd.example.com",
      },
      version: "v1",
    });
    const local = snapshot();

    expect(getOrgDefaultProfile()).toEqual({
      anthropic: { apiKey: "", baseUrl: "", model: "claude-opus-4-8" },
      id: "__org__",
      name: "Org default",
      openAiCompatible: {
        apiKey: "org-secret",
        baseUrl: "https://org-llm.example.com/v1",
        model: "org-model",
      },
      provider: "openai-compatible",
    });
    expect(
      selectAgentConfiguration(local, {
        desktop: false,
        profileId: "__org__",
      }),
    ).toEqual({
      apiKey: "org-secret",
      baseUrl: "https://org-llm.example.com/v1",
      desktop: false,
      model: "org-model",
      provider: "openai-compatible",
      vtdAuthToken: "org-vtd-token",
      vtdEndpoint: "https://org-vtd.example.com",
    });
    expect(local.profiles).toHaveLength(1);
    expect(local.profiles[0]?.id).toBe("default");
  });

  it("makes an organization default without an apiKey fail normal validation", () => {
    jest.mocked(readCurrentAgentBootstrap).mockReturnValue({
      config: {
        baseUrl: "https://org-llm.example.com/v1",
        model: "org-model",
        provider: "openai-compatible",
      },
      version: "v1",
    });

    const configuration = selectAgentConfiguration(snapshot(), {
      desktop: true,
      profileId: "__org__",
    });
    expect(configuration.apiKey).toBe("");
    expect(validateAgentConfiguration(configuration).apiKey).toBe("required");
  });
});
