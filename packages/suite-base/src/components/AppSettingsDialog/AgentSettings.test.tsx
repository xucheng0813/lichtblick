/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen,
  waitFor, } from "@testing-library/react";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import AppConfigurationContext, {
  AppConfigurationValue,
  IAppConfiguration,
} from "@lichtblick/suite-base/context/AppConfigurationContext";
import {
  AgentSettingsDraft,
  commitAgentSettings,
} from "@lichtblick/suite-base/services/agent/agentSettings";
import * as agentSettingsModule from "@lichtblick/suite-base/services/agent/agentSettings";
import * as remotePromptCustomizationModule from "@lichtblick/suite-base/services/agent/prompts/remotePromptCustomization";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";
import { makeMockAppConfiguration } from "@lichtblick/suite-base/util/makeMockAppConfiguration";

import { AgentSettings, AgentSettingsCommitHandler } from "./settings";

type TestDesktopBridge = {
  deleteSecureCredential: jest.Mock<Promise<unknown>, [string]>;
  getSecureCredential: jest.Mock<Promise<unknown>, [string]>;
  setManySecureCredentials: jest.Mock<
    Promise<unknown>,
    [Array<{ expectedRevision?: string; key: string; value: string }>]
  >;
  vtdInstall?: jest.Mock<
    Promise<{ exitCode: number | null; ok: boolean; output: string }>,
    []
  >;
  vtdStatus?: jest.Mock<
    Promise<{ installed: boolean; path?: string; version?: string }>,
    []
  >;
};

const testGlobal = globalThis as typeof globalThis & {
  desktopBridge?: TestDesktopBridge;
};
const originalBridgeDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "desktopBridge",
);
const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "locks",
);

function installTestCrossRendererLock(): void {
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        callback: () => Promise<unknown>,
      ): Promise<unknown> => await callback(),
    },
  });
}

function installDesktopCredentialBridge(): TestDesktopBridge {
  const credentials = new Map<string, string>();
  const bridge: TestDesktopBridge = {
    deleteSecureCredential: jest.fn(async (name) => {
      credentials.delete(name);
    }),
    getSecureCredential: jest.fn(async (name) => credentials.get(name)),
    setManySecureCredentials: jest.fn(async (entries) => {
      for (const entry of entries) {
        const storedValue = credentials.get(entry.key);
        let storedRevision = "";
        try {
          const record =
            storedValue == undefined
              ? undefined
              : (JSON.parse(storedValue) as Record<string, unknown>);
          storedRevision = typeof record?.revision === "string" ? record.revision : "";
        } catch {
          storedRevision = "";
        }
        if (
          entry.expectedRevision != undefined && entry.expectedRevision !== storedRevision
        ) {
          return { code: "revision-conflict", ok: false };
        }
      }
      for (const entry of entries) {
        credentials.set(entry.key, entry.value);
      }
      return { ok: true };
    }),
  };
  Object.defineProperty(globalThis, "desktopBridge", {
    configurable: true,
    value: bridge,
    writable: true,
  });
  return bridge;
}

function installDesktopVtdBridge(): {
  vtdInstall: NonNullable<TestDesktopBridge["vtdInstall"]>;
  vtdStatus: NonNullable<TestDesktopBridge["vtdStatus"]>;
} {
  const bridge = installDesktopCredentialBridge();
  const vtdInstall = jest.fn<
    Promise<{ exitCode: number | null; ok: boolean; output: string }>,
    []
  >();
  const vtdStatus = jest.fn<
    Promise<{ installed: boolean; path?: string; version?: string }>,
    []
  >();
  bridge.vtdInstall = vtdInstall;
  bridge.vtdStatus = vtdStatus;
  return { vtdInstall, vtdStatus };
}

function makeSharedConfigurations(): [IAppConfiguration, IAppConfiguration] {
  const values = new Map<string, AppConfigurationValue>();
  const makeConfiguration = (): IAppConfiguration => {
    const listeners = new Map<
      string, Set<(newValue: AppConfigurationValue) => void>
    >();
    return {
      addChangeListener: (key, listener) => {
        const current = listeners.get(key) ?? new Set();
        current.add(listener);
        listeners.set(key, current);
      },
      get: (key) => values.get(key),
      removeChangeListener: (key, listener) => {
        listeners.get(key)?.delete(listener);
      },
      set: async (key, value) => {
        values.set(key, value);
        for (const listener of listeners.get(key) ?? []) {
          listener(value);
        }
      },
    };
  };
  return [makeConfiguration(), makeConfiguration()];
}

function makeCachedConfiguration(
  durableValues: Map<string, AppConfigurationValue>,
): IAppConfiguration {
  const cachedValues = new Map(durableValues);
  const listeners = new Map<
    string, Set<(newValue: AppConfigurationValue) => void>
  >();
  return {
    addChangeListener: (key, listener) => {
      const current = listeners.get(key) ?? new Set();
      current.add(listener);
      listeners.set(key, current);
    },
    get: (key) => cachedValues.get(key),
    removeChangeListener: (key, listener) => {
      listeners.get(key)?.delete(listener);
    },
    set: async (key, value) => {
      durableValues.set(key, value);
      cachedValues.set(key, value);
      for (const listener of listeners.get(key) ?? []) {
        listener(value);
      }
    },
  };
}

const baseDraft: AgentSettingsDraft = {
  anthropic: { apiKey: "", baseUrl: "", model: "claude-test" },
  openAiCompatible: {
    apiKey: "secret-key",
    baseUrl: "https://llm.example.com/v1",
    model: "local-model",
  },
  provider: "openai-compatible",
  revision: "",
  vtdAuthToken: "vtd-secret",
  vtdEndpoint: "https://vtd.example.com",
};

function multiProfileDraft(): AgentSettingsDraft {
  const anthropic = {
    apiKey: "alpha-key",
    baseUrl: "https://alpha.example.com",
    model: "alpha-model",
  };
  const openAiCompatible = {
    apiKey: "alpha-openai-key",
    baseUrl: "https://alpha-openai.example.com/v1",
    model: "alpha-openai-model",
  };
  return {
    ...baseDraft,
    activeProfileId: "profile-alpha",
    anthropic,
    openAiCompatible,
    profiles: [
      {
        anthropic,
        id: "profile-alpha",
        name: "Alpha",
        openAiCompatible,
        provider: "anthropic",
      },
      {
        anthropic: {
          apiKey: "beta-anthropic-key",
          baseUrl: "https://beta-anthropic.example.com",
          model: "beta-anthropic-model",
        },
        id: "profile-beta",
        name: "Beta",
        openAiCompatible: {
          apiKey: "beta-key",
          baseUrl: "https://beta.example.com/v1",
          model: "beta-model",
        },
        provider: "openai-compatible",
      },
    ],
    provider: "anthropic",
  };
}

function renderSettings(
  configuration: IAppConfiguration,
  {
    isDesktop = false,
    onCommitHandlerChange,
  }: {
    isDesktop?: boolean;
    onCommitHandlerChange?: (
      handler: AgentSettingsCommitHandler | undefined,
    ) => void;
  } = {},
) {
  return render(
    <AppConfigurationContext.Provider value={configuration}>
      <AgentSettings isDesktop={isDesktop} onCommitHandlerChange={onCommitHandlerChange} />
    </AppConfigurationContext.Provider>,
  );
}

describe("AgentSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    setHttpBaseUrl("");
    installDesktopCredentialBridge();
    installTestCrossRendererLock();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setHttpBaseUrl(undefined);
    if (originalLocksDescriptor == undefined) {
      Reflect.deleteProperty(globalThis.navigator, "locks");
    } else {
      Object.defineProperty(
        globalThis.navigator,
        "locks",
        originalLocksDescriptor,
      );
    }
    if (originalBridgeDescriptor == undefined) {
      delete testGlobal.desktopBridge;
    } else {
      Object.defineProperty(
        globalThis, "desktopBridge",
        originalBridgeDescriptor,
      );
    }
  });

  it("does not export raw credential keys or storage readers", () => {
    expect(Object.values(AppSetting)).not.toContain("agent.llmApiKey");
    expect(agentSettingsModule).not.toHaveProperty("getAgentApiKeyStorageKey");
    expect(agentSettingsModule).not.toHaveProperty("readAgentApiKey");
    expect(agentSettingsModule).not.toHaveProperty("writeAgentApiKey");
  });

  it("publishes the enable toggle immediately without waiting for a draft save", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    renderSettings(configuration);

    const toggle = screen.getByRole("checkbox", { name: "Enable agent" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(configuration.get(AppSetting.AGENT_ENABLED)).toBe(true);
    });
    expect(
      screen.getByRole("checkbox", { name: "Enable agent" }),
    ).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Enable agent" }));

    await waitFor(() => {
      expect(configuration.get(AppSetting.AGENT_ENABLED)).toBe(false);
    });
  });

  it("reflects an agent that was already enabled", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    await configuration.set(AppSetting.AGENT_ENABLED, true);
    renderSettings(configuration);

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "Enable agent" }),
      ).toBeChecked();
    });
  });

  it("previews a skill body as rendered markdown", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    renderSettings(configuration);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("option", { name: /^robot-viz/ }));

    // Edit view first: the raw markdown source.
    const editor = screen.getByRole("textbox", {
      name: /Robot visualization panels/,
    });
    expect((editor as HTMLTextAreaElement).value).toContain(
      "# Robot visualization panels",
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    const preview = screen.getByTestId("agent-skill-preview");
    // The heading and table must come back as real elements, not literal markdown syntax.
    expect(preview.querySelector("h1")).toHaveTextContent(
      "Robot visualization panels",
    );
    expect(preview.querySelector("table")).toBeInTheDocument();
    expect(preview.textContent).not.toContain("| Panel type |");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("agent-skill-preview")).not.toBeInTheDocument();
  });

  it("lists stored memories and deletes them without a draft save", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    await configuration.set(
      AppSetting.AGENT_MEMORY,
      JSON.stringify([
        { id: "m1", text: "Usually reviews SN001", createdAt: "2026-07-28T00:00:00Z", },
        { id: "m2", text: "Prefers 3D beside a plot", createdAt: "2026-07-28T00:00:00Z", },
      ]),
    );
    renderSettings(configuration);

    expect(screen.getByText("Usually reviews SN001")).toBeInTheDocument();
    expect(screen.getByText("Prefers 3D beside a plot")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Forget: Usually reviews SN001" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByText("Usually reviews SN001"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Prefers 3D beside a plot")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Forget all" }));

    await waitFor(() => {
      expect(
        screen.getByText("The agent has not stored anything yet."),
      ).toBeInTheDocument();
    });
    expect(configuration.get(AppSetting.AGENT_MEMORY)).toBeUndefined();
  });

  it("keeps a complete draft local and publishes it with one save action", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    const set = jest.spyOn(configuration, "set");
    renderSettings(configuration);

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "next-model" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "next-key" },
    });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://next.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("VTD endpoint"), {
      target: { value: "https://next-vtd.example.com" },
    });
    fireEvent.change(screen.getByLabelText("VTD authentication token"), {
      target: { value: "next-vtd-token" },
    });

    expect(configuration.get(AppSetting.AGENT_OPENAI_MODEL)).toBe(
      "local-model",
    );
    expect(configuration.get(AppSetting.AGENT_VTD_AUTH_TOKEN)).toBeUndefined();
    expect(set).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );

    await waitFor(() => {
      expect(configuration.get(AppSetting.AGENT_OPENAI_MODEL)).toBe(
        "next-model",
      );
      expect(configuration.get(AppSetting.AGENT_OPENAI_BASE_URL)).toBe(
        "https://next.example.com/v1",
      );
      expect(configuration.get(AppSetting.AGENT_VTD_ENDPOINT)).toBe(
        "https://next-vtd.example.com",
      );
    });
    expect(configuration.get(AppSetting.AGENT_VTD_AUTH_TOKEN)).toBeUndefined();
    expect(set).toHaveBeenCalledWith(
      AppSetting.AGENT_LLM_PROVIDER,
      "openai-compatible",
    );
  });

  it("renders cloud skills only when both viz server and workspace are configured", async () => {
    const workspaceOnly = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "cloud-workspace"],
    ]);
    await commitAgentSettings(workspaceOnly, baseDraft);
    const firstRender = renderSettings(workspaceOnly);
    expect(screen.queryByTestId("agent-remote-skills")).not.toBeInTheDocument();
    firstRender.unmount();

    setHttpBaseUrl("https://viz.example.com/lichtblick");
    const serverOnly = makeMockAppConfiguration();
    await commitAgentSettings(serverOnly, baseDraft);
    renderSettings(serverOnly);
    expect(screen.queryByTestId("agent-remote-skills")).not.toBeInTheDocument();
  });

  it("renders cached automatic and organization skills, overrides, and a collapsed long body", async () => {
    const now = Date.parse("2026-08-05T06:00:00.000Z");
    jest.spyOn(Date, "now").mockReturnValue(now);
    const longBody = `# Organization safety\n\n${"Keep this body compact. ".repeat(100)}`;
    jest
      .spyOn(remotePromptCustomizationModule, "readCachedAgentBootstrap")
      .mockReturnValue({
        prompt: {
          customSkills: [
            {
              body: "Cloud layout instructions",
              id: "lichtblick-layouts",
              name: "Cloud layouts",
              whenToUse: "When working with cloud layouts",
            },
            {
              body: "Cloud extension instructions",
              id: "lichtblick-extensions",
              name: "Cloud extensions",
              whenToUse: "When working with cloud extensions",
            },
            {
              body: longBody,
              id: "organization-safety",
              name: "Organization safety",
              whenToUse: "Only use verified topics and approved robot data",
            },
          ],
          instructions: "Organization defaults",
          skillOverrides: { "vtd-query": "Organization VTD query override" },
        },
        syncedAt: new Date(now - 5 * 60_000).toISOString(),
        version: "1234567890abcdef",
      });
    setHttpBaseUrl("https://viz.example.com/lichtblick");
    const configuration = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "cloud-workspace"],
    ]);
    await commitAgentSettings(configuration, baseDraft);

    renderSettings(configuration);

    expect(screen.getByTestId("agent-remote-skills")).toBeVisible();
    expect(screen.getByText("Version 12345678 · Last synced 5 minutes ago")).toBeVisible();
    expect(screen.getAllByText("Automatic")).toHaveLength(2);
    expect(screen.getByText("Organization custom")).toBeVisible();
    expect(screen.getByText("Cloud layouts")).toBeVisible();
    expect(screen.getByText("lichtblick-layouts")).toBeVisible();
    expect(screen.getByText("Organization safety")).toBeVisible();
    expect(
      screen.getByText("Only use verified topics and approved robot data"),
    ).toHaveAttribute("title", "Only use verified topics and approved robot data");
    expect(screen.getByText("Overridden cloud skill IDs")).toBeVisible();
    expect(screen.getByText("vtd-query")).toBeVisible();
    expect(
      screen.getByText("A local skill with the same ID overrides its cloud version."),
    ).toBeVisible();

    expect(
      screen.queryByTestId("agent-remote-skill-body-organization-safety"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Organization safety" }),
    );
    expect(
      screen.getByTestId("agent-remote-skill-body-organization-safety"),
    ).toHaveTextContent("Keep this body compact.");
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Organization safety" }),
    );
    expect(
      screen.queryByTestId("agent-remote-skill-body-organization-safety"),
    ).not.toBeInTheDocument();
  });

  it("forces a full cloud-skill fetch and refreshes the visible cache projection", async () => {
    jest
      .spyOn(remotePromptCustomizationModule, "readCachedAgentBootstrap")
      .mockReturnValue({
        prompt: {
          customSkills: [
            {
              body: "Old body",
              id: "old-skill",
              name: "Old skill",
              whenToUse: "Before refresh",
            },
          ],
          instructions: "",
          skillOverrides: {},
        },
        syncedAt: "2026-08-05T05:00:00.000Z",
        version: "old-version",
      });
    const fetchAgentBootstrap = jest
      .spyOn(remotePromptCustomizationModule, "fetchAgentBootstrap")
      .mockResolvedValue({
        prompt: {
          customSkills: [
            {
              body: "Fresh body",
              id: "fresh-skill",
              name: "Fresh skill",
              whenToUse: "After refresh",
            },
          ],
          instructions: "",
          skillOverrides: {},
        },
        syncedAt: "2026-08-05T06:00:00.000Z",
        version: "fedcba9876543210",
      });
    setHttpBaseUrl("https://viz.example.com/lichtblick");
    const configuration = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "cloud-workspace"],
    ]);
    await commitAgentSettings(configuration, baseDraft);
    renderSettings(configuration);

    fireEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect(await screen.findByText("Cloud skills refreshed.")).toBeVisible();
    expect(fetchAgentBootstrap.mock.calls).toEqual([["cloud-workspace"]]);
    expect(screen.getByText("Fresh skill")).toBeVisible();
    expect(screen.queryByText("Old skill")).not.toBeInTheDocument();
    expect(screen.getByText(/Version fedcba98/)).toBeVisible();
  });

  it("keeps cached cloud skills visible and reports a manual fetch failure", async () => {
    jest
      .spyOn(remotePromptCustomizationModule, "readCachedAgentBootstrap")
      .mockReturnValue({
        prompt: {
          customSkills: [
            {
              body: "Cached body",
              id: "cached-skill",
              name: "Cached skill",
              whenToUse: "When offline",
            },
          ],
          instructions: "",
          skillOverrides: {},
        },
        syncedAt: "2026-08-05T05:00:00.000Z",
        version: "cached-version",
      });
    jest
      .spyOn(remotePromptCustomizationModule, "fetchAgentBootstrap")
      .mockRejectedValue(new Error("network unavailable"));
    setHttpBaseUrl("https://viz.example.com/lichtblick");
    const configuration = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "cloud-workspace"],
    ]);
    await commitAgentSettings(configuration, baseDraft);
    renderSettings(configuration);

    fireEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect(
      await screen.findByText(
        "Could not refresh cloud skills: network unavailable",
      ),
    ).toBeVisible();
    expect(screen.getByText("Cached skill")).toBeVisible();
    expect(screen.getByRole("button", { name: "Fetch now" })).toBeEnabled();
  });

  it("switches provider drafts without persisting or reusing credentials", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, {
      ...baseDraft,
      anthropic: {
        apiKey: "anthropic-key",
        baseUrl: "https://anthropic.example.com",
        model: "claude-test",
      },
      openAiCompatible: {
        apiKey: "openai-key",
        baseUrl: "https://openai.example.com/v1",
        model: "openai-test",
      },
      provider: "anthropic",
    });
    renderSettings(configuration);

    expect(screen.getByLabelText("API key")).toHaveValue("anthropic-key");
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "edited-anthropic-key" },
    });
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "LLM provider" }));
    fireEvent.click(screen.getByRole("option", { name: "OpenAI-compatible" }));

    expect(screen.getByLabelText("Model")).toHaveValue("openai-test");
    expect(screen.getByLabelText("API key")).toHaveValue("openai-key");
    expect(configuration.get(AppSetting.AGENT_LLM_PROVIDER)).toBe("anthropic");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "LLM provider" }));
    fireEvent.click(screen.getByRole("option", { name: "Anthropic" }));
    expect(screen.getByLabelText("API key")).toHaveValue(
      "edited-anthropic-key",
    );
  });

  it("keeps edits isolated while switching between Agent profiles", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    const revision = configuration.get("agent.configurationRevision");
    expect(typeof revision).toBe("string");
    await commitAgentSettings(configuration, {
      ...multiProfileDraft(),
      revision: revision as string,
    });
    renderSettings(configuration);

    expect(screen.getByLabelText("Model")).toHaveValue("alpha-model");
    expect(screen.getByLabelText("API key")).toHaveValue("alpha-key");
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "edited-alpha-model" },
    });

    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Agent profile" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Beta" }));
    expect(screen.getByLabelText("Model")).toHaveValue("beta-model");
    expect(screen.getByLabelText("API key")).toHaveValue("beta-key");
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "edited-beta-key" },
    });

    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Agent profile" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Alpha (active)" }));
    expect(screen.getByLabelText("Model")).toHaveValue("edited-alpha-model");
    expect(screen.getByLabelText("API key")).toHaveValue("alpha-key");

    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Agent profile" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Beta" }));
    expect(screen.getByLabelText("API key")).toHaveValue("edited-beta-key");
  });

  it("supports profile CRUD, default switching, and submits the complete profile draft", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    const commitSpy = jest.spyOn(agentSettingsModule, "commitAgentSettings");
    renderSettings(configuration);

    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-4-8");

    fireEvent.click(screen.getByRole("button", { name: "Rename profile" }));
    const nameInput = screen.getByRole("textbox", { name: "Profile name" });
    fireEvent.change(nameInput, { target: { value: "Renamed profile" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Rename Agent profile" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy profile" }));
    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Agent profile" }),
    );
    expect(
      screen.getByRole("option", { name: "Copy of Renamed profile" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("option", { name: "Copy of Renamed profile" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Set as default" }));
    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Agent profile" }),
    );
    expect(
      screen.getByRole("option", { name: "Copy of Renamed profile (active)" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("option", { name: "Copy of Renamed profile (active)" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(
      screen.getByRole("combobox", { name: "Agent profile" }),
    ).toHaveTextContent("Default (active)");
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );

    await waitFor(() => {
      expect(commitSpy).toHaveBeenCalled();
      expect(configuration.get("agent.activeProfileId")).toBe("default");
    });
    const submittedDraft = commitSpy.mock.calls.at(-1)?.[1];
    expect(submittedDraft).toMatchObject({
      activeProfileId: "default",
      profiles: [
        expect.objectContaining({ id: "default", name: "Default" }),
        expect.objectContaining({ name: "Renamed profile" }),
      ],
      vtdAuthToken: baseDraft.vtdAuthToken,
      vtdEndpoint: baseDraft.vtdEndpoint,
    });
    const storedProfiles = JSON.parse(
      String(configuration.get("agent.profiles")),
    ) as Array<Record<string, unknown>>;
    expect(storedProfiles).toHaveLength(2);
    expect(storedProfiles.map(({ name }) => name)).toEqual([
      "Default",
      "Renamed profile",
    ]);
    expect(JSON.stringify(storedProfiles)).not.toContain("apiKey");
    const credentialBundle = JSON.parse(
      localStorage.getItem("lichtblick.agent.credentials.v1") ?? "",
    ) as { profileKeys: Record<string, unknown> };
    expect(credentialBundle).toMatchObject({
      profileKeys: {
        default: expect.any(Object),
      },
    });
    expect(Object.keys(credentialBundle.profileKeys)).toHaveLength(2);
  });

  it("prevents deleting the final stored profile", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    renderSettings(configuration);

    expect(
      screen.getByRole("button", { name: "Delete profile" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Rename profile" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Agent profile" }),
    ).toHaveTextContent("Default (active)");
  });

  it("shows the organization default as a read-only virtual profile", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    jest
      .spyOn(remotePromptCustomizationModule, "readCurrentAgentBootstrap")
      .mockReturnValue({
        config: {
          apiKey: "organization-key",
          baseUrl: "https://organization.example.com/v1",
          model: "organization-model",
          provider: "openai-compatible",
          vtdAuthToken: "organization-vtd-token",
          vtdEndpoint: "https://organization-vtd.example.com",
        },
        version: "v1",
      });
    renderSettings(configuration);

    fireEvent.mouseDown(
      screen.getByRole("combobox", { name: "Agent profile" }),
    );
    fireEvent.click(
      screen.getByRole("option", { name: "Organization default" }),
    );

    expect(
      screen.getByText(
        "Managed by your organization. This profile is read-only.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "LLM provider" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(screen.getByLabelText("Model")).toHaveValue("organization-model");
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByLabelText("API key")).toHaveValue("organization-key");
    expect(screen.getByLabelText("Base URL")).toBeDisabled();
    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "https://organization.example.com/v1",
    );
    expect(
      screen.getByRole("button", { name: "Rename profile" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete profile" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Set as default" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("VTD endpoint")).toBeEnabled();
    expect(screen.getByLabelText("VTD endpoint")).toHaveValue(
      baseDraft.vtdEndpoint,
    );
  });

  it("exposes a single commit handler for dialog close and tab changes", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    let commitHandler: AgentSettingsCommitHandler | undefined;
    renderSettings(configuration, {
      onCommitHandlerChange: (handler) => {
        commitHandler = handler;
      },
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "closed-model" },
    });
    await act(async () => {
      expect(await commitHandler?.()).toBe(true);
    });

    expect(configuration.get(AppSetting.AGENT_OPENAI_MODEL)).toBe(
      "closed-model",
    );
  });

  it("rejects URL query and fragment suffixes before constructing a client", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, {
      ...baseDraft,
      openAiCompatible: {
        ...baseDraft.openAiCompatible,
        baseUrl: "https://llm.example.com/v1?tenant=a",
      },
      vtdEndpoint: "https://vtd.example.com/#fragment",
    });
    renderSettings(configuration);

    expect(
      screen.getByText(
        "Agent is not configured. Fix the fields below to enable it.",
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText(
        "Enter a valid HTTP or HTTPS URL without credentials, query parameters, or a fragment.",
      ),
    ).toHaveLength(2);
  });

  it("does not read or render Web-only VTD settings on desktop", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });
    const get = jest.spyOn(configuration, "get");
    renderSettings(configuration, { isDesktop: true });

    expect(screen.queryByLabelText("VTD endpoint")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("VTD authentication token"),
    ).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith(AppSetting.AGENT_VTD_ENDPOINT);
  });

  it("shows the installed vtd version and executable path on desktop", async () => {
    const { vtdStatus } = installDesktopVtdBridge();
    vtdStatus.mockResolvedValue({
      installed: true,
      path: "/Users/test/.local/bin/vtd",
      version: "vtd version 1.2.3",
    });
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });

    renderSettings(configuration, { isDesktop: true });

    expect(
      await screen.findByText(
        "vtd is installed v1.2.3 (/Users/test/.local/bin/vtd)",
      ),
    ).toBeVisible();
    expect(vtdStatus).toHaveBeenCalledTimes(1);
  });

  it("shows an installation action when vtd is not installed on desktop", async () => {
    const { vtdStatus } = installDesktopVtdBridge();
    vtdStatus.mockResolvedValue({ installed: false });
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });

    renderSettings(configuration, { isDesktop: true });

    expect(await screen.findByText("vtd CLI is not installed.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Install vtd" })).toBeEnabled();
  });

  it("confirms installation, shows loading, and refreshes desktop vtd status", async () => {
    const { vtdInstall, vtdStatus } = installDesktopVtdBridge();
    vtdStatus
      .mockResolvedValueOnce({ installed: false })
      .mockResolvedValueOnce({
        installed: true,
        path: "/Users/test/.local/bin/vtd",
        version: "1.4.0",
      });
    let resolveInstall:
      | ((result: { exitCode: number; ok: boolean; output: string }) => void)
      | undefined;
    const installation = new Promise<{
      exitCode: number;
      ok: boolean;
      output: string;
    }>((resolve) => {
      resolveInstall = resolve;
    });
    vtdInstall.mockReturnValue(installation);
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });
    renderSettings(configuration, { isDesktop: true });

    fireEvent.click(await screen.findByRole("button", { name: "Install vtd" }));
    expect(screen.getByText("Install vtd CLI?")).toBeVisible();
    expect(
      screen.getByText(
        "This runs the vtd installation script from the internal company source on this computer.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(
      await screen.findByRole("button", { name: "Installing…" }),
    ).toBeDisabled();

    await act(async () => {
      resolveInstall?.({ exitCode: 0, ok: true, output: "installed" });
      await installation;
    });

    expect(
      await screen.findByText(
        "vtd is installed v1.4.0 (/Users/test/.local/bin/vtd)",
      ),
    ).toBeVisible();
    expect(vtdInstall).toHaveBeenCalledTimes(1);
    expect(vtdStatus).toHaveBeenCalledTimes(2);
  });

  it("shows failed installer output in collapsible details", async () => {
    const { vtdInstall, vtdStatus } = installDesktopVtdBridge();
    vtdStatus.mockResolvedValue({ installed: false });
    vtdInstall.mockResolvedValue({
      exitCode: 17,
      ok: false,
      output: "curl: connection refused",
    });
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });
    renderSettings(configuration, { isDesktop: true });

    fireEvent.click(await screen.findByRole("button", { name: "Install vtd" }));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(await screen.findByText("vtd installation failed.")).toBeVisible();
    const outputSummary = screen.getByText("Show installation output");
    fireEvent.click(outputSummary);
    expect(screen.getByText("curl: connection refused")).toBeVisible();
    expect(vtdStatus).toHaveBeenCalledTimes(2);
  });

  it("does not render or query desktop vtd status on the Web", async () => {
    const { vtdInstall, vtdStatus } = installDesktopVtdBridge();
    vtdStatus.mockResolvedValue({ installed: false });
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);

    renderSettings(configuration);

    expect(
      screen.queryByText("vtd CLI is not installed."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Install vtd" }),
    ).not.toBeInTheDocument();
    expect(vtdStatus).not.toHaveBeenCalled();
    expect(vtdInstall).not.toHaveBeenCalled();
  });

  it("disables credential editing until desktop migration finishes", async () => {
    const configuration = makeMockAppConfiguration([
      [AppSetting.AGENT_LLM_PROVIDER, "anthropic"],
      ["agent.llmApiKey", "legacy-secret"],
    ]);
    let resolveCredentialRead: (() => void) | undefined;
    const credentialRead = new Promise<void>((resolve) => {
      resolveCredentialRead = resolve;
    });
    const bridge = installDesktopCredentialBridge();
    bridge.getSecureCredential.mockImplementation(async () => {
      await credentialRead;
      return undefined;
    });

    renderSettings(configuration, { isDesktop: true });

    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save Agent settings" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Loading and migrating Agent credentials…"),
    ).toBeVisible();

    await act(async () => {
      resolveCredentialRead?.();
      await credentialRead;
    });
    await waitFor(() => {
      expect(screen.getByLabelText("API key")).toBeEnabled();
      expect(screen.getByLabelText("API key")).toHaveValue("legacy-secret");
    });
  });

  it("explains the credential trust boundary for Web and desktop", async () => {
    const webConfiguration = makeMockAppConfiguration();
    await commitAgentSettings(webConfiguration, baseDraft);
    const web = renderSettings(webConfiguration);
    expect(
      screen.getByText(
        "On the Web, credentials are stored in plain text and can be read by same-origin scripts. Installed extensions are trusted at the same level as the application and can access credentials stored on this device. Use desktop with a secure credential backend for encrypted at-rest storage.",
      ),
    ).toBeVisible();
    web.unmount();

    localStorage.clear();
    const desktopConfiguration = makeMockAppConfiguration();
    await commitAgentSettings(desktopConfiguration, baseDraft, {
      desktop: true,
    });
    renderSettings(desktopConfiguration, { isDesktop: true });
    expect(
      screen.getByText(
        "On desktop, credentials are encrypted at rest using the operating system's secure credential storage. Installed extensions are trusted at the same level as the application and can access credentials stored on this device.",
      ),
    ).toBeVisible();
  });

  it("warns when desktop falls back to plaintext without a secure backend", async () => {
    const bridge = installDesktopCredentialBridge();
    bridge.setManySecureCredentials.mockResolvedValue({
      code: "insecure-backend",
      ok: false,
    });
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });
    renderSettings(configuration, { isDesktop: true });

    expect(
      await screen.findByText(
        "No secure credential backend is available (for example, Linux without a keyring), so credentials are stored in plain text. Installed extensions are trusted at the same level as the application and can access credentials stored on this device.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("API key")).toBeEnabled();
  });

  it("keeps the draft retryable when plaintext fallback has no cross-window lock", async () => {
    const bridge = installDesktopCredentialBridge();
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });
    renderSettings(configuration, { isDesktop: true });
    await waitFor(() => {
      expect(screen.getByLabelText("Model")).toHaveValue(
        baseDraft.openAiCompatible.model,
      );
    });
    Reflect.deleteProperty(globalThis.navigator, "locks");
    bridge.setManySecureCredentials.mockResolvedValue({
      code: "insecure-backend",
      ok: false,
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "retry-with-cross-window-lock" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );

    expect(
      await screen.findByText(
        "Plaintext credential storage cannot be saved because cross-window locking is unavailable. Use a secure desktop credential backend or a runtime with Web Locks support, then retry.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Model")).toHaveValue(
      "retry-with-cross-window-lock",
    );
    expect(
      screen.getByRole("button", { name: "Save Agent settings" }),
    ).toBeEnabled();
    expect(configuration.get(AppSetting.AGENT_OPENAI_MODEL)).toBe(
      baseDraft.openAiCompatible.model,
    );
    expect(localStorage.getItem("lichtblick.agent.credentials.v1")).toBeNull();
  });

  it("keeps the form disabled when the desktop credential backend is temporarily unavailable", async () => {
    const bridge = installDesktopCredentialBridge();
    bridge.getSecureCredential.mockResolvedValue({
      code: "backend-unavailable",
      ok: false,
    });
    const configuration = makeMockAppConfiguration([
      ["agent.configurationRevision", "existing-revision"],
    ]);

    renderSettings(configuration, { isDesktop: true });

    expect(
      await screen.findByText(
        "The operating system credential backend is temporarily unavailable. Existing desktop credentials and the current form values have been preserved; unlock or restore the credential service, then retry.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save Agent settings" }),
    ).toBeDisabled();
    expect(bridge.setManySecureCredentials).not.toHaveBeenCalled();
    expect(bridge.deleteSecureCredential).not.toHaveBeenCalled();
    expect(localStorage.getItem("lichtblick.agent.credentials.v1")).toBeNull();
  });

  it("keeps the loaded draft retryable when the backend becomes unavailable during save", async () => {
    const bridge = installDesktopCredentialBridge();
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft, { desktop: true });
    renderSettings(configuration, { isDesktop: true });
    await waitFor(() => {
      expect(screen.getByLabelText("API key")).toHaveValue("secret-key");
    });
    bridge.setManySecureCredentials.mockResolvedValue({
      code: "backend-unavailable",
      ok: false,
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "retry-after-unlock" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );

    expect(
      await screen.findByText(
        "The operating system credential backend is temporarily unavailable. Existing desktop credentials and the current form values have been preserved; unlock or restore the credential service, then retry.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("API key")).toHaveValue("secret-key");
    expect(screen.getByLabelText("Model")).toHaveValue("retry-after-unlock");
    expect(
      screen.queryByText(
        "Agent credentials or settings could not be read or saved. Your draft has not been discarded.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save Agent settings" }),
    ).toBeEnabled();

    bridge.setManySecureCredentials.mockResolvedValue({ ok: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByText(
          "The operating system credential backend is temporarily unavailable. Existing desktop credentials and the current form values have been preserved; unlock or restore the credential service, then retry.",
        ),
      ).not.toBeInTheDocument();
      expect(configuration.get(AppSetting.AGENT_OPENAI_MODEL)).toBe(
        "retry-after-unlock",
      );
    });
  });

  it("loads legacy basic_text credentials and asks the user to save them again", async () => {
    const revision = "legacy-basic-text-revision";
    const configurationMirror = {
      anthropicBaseUrl: "",
      anthropicModel: "legacy-model",
      openAiBaseUrl: "",
      openAiModel: "",
      provider: "anthropic",
      vtdEndpoint: "",
    };
    const legacyValues = new Map([
      [
        "agent.llmApiKey",
        JSON.stringify({
          anthropicApiKey: "legacy-basic-text-key",
          configuration: configurationMirror,
          openAiApiKey: "",
          revision,
        }),
      ],
      ["agent.vtdAuthToken", JSON.stringify({ revision, value: "" })],
    ]);
    const bridge = installDesktopCredentialBridge();
    bridge.getSecureCredential.mockImplementation(async (name) => ({
      code: "insecure-backend",
      ok: true,
      value: legacyValues.get(name),
    }));
    const configuration = makeMockAppConfiguration([
      [AppSetting.AGENT_LLM_PROVIDER, configurationMirror.provider],
      [
        AppSetting.AGENT_ANTHROPIC_BASE_URL,
        configurationMirror.anthropicBaseUrl,
      ],
      [AppSetting.AGENT_ANTHROPIC_MODEL, configurationMirror.anthropicModel],
      [AppSetting.AGENT_OPENAI_BASE_URL, configurationMirror.openAiBaseUrl],
      [AppSetting.AGENT_OPENAI_MODEL, configurationMirror.openAiModel],
      ["agent.configurationRevision", revision],
    ]);

    renderSettings(configuration, { isDesktop: true });

    expect(
      await screen.findByText(
        "These credentials are currently stored with plaintext-equivalent protection by a legacy insecure backend. Review and save Agent settings again to move them to the supported plaintext fallback. Installed extensions are trusted at the same level as the application and can access credentials stored on this device.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("API key")).toHaveValue(
      "legacy-basic-text-key",
    );

    const saveButton = screen.getByRole("button", {
      name: "Save Agent settings",
    });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    expect(
      await screen.findByText(
        "No secure credential backend is available (for example, Linux without a keyring), so credentials are stored in plain text. Installed extensions are trusted at the same level as the application and can access credentials stored on this device.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "These credentials are currently stored with plaintext-equivalent protection by a legacy insecure backend. Review and save Agent settings again to move them to the supported plaintext fallback. Installed extensions are trusted at the same level as the application and can access credentials stored on this device.",
      ),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("lichtblick.agent.credentials.v1")).toContain(
      "legacy-basic-text-key",
    );
  });

  it("reloads the winner and warns when another tab makes the draft stale", async () => {
    const [firstConfiguration, secondConfiguration] = makeSharedConfigurations();
    await commitAgentSettings(firstConfiguration, baseDraft);
    renderSettings(secondConfiguration);
    fireEvent.change(screen.getByLabelText("VTD endpoint"), {
      target: { value: "https://stale.example.com" },
    });

    const currentRevision = firstConfiguration.get(
      "agent.configurationRevision",
    );
    expect(typeof currentRevision).toBe("string");
    await commitAgentSettings(firstConfiguration, {
      ...baseDraft,
      anthropic: { ...baseDraft.anthropic, apiKey: "winner-key" },
      revision: currentRevision as string,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );

    expect(
      await screen.findByText(
        "Agent settings changed in another tab. The latest saved values were reloaded; review them and try your edit again.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("VTD endpoint")).toHaveValue(
      baseDraft.vtdEndpoint,
    );
  });

  it("reloads a desktop winner from secure storage and saves on the next attempt", async () => {
    const durableValues = new Map<string, AppConfigurationValue>();
    const firstConfiguration = makeCachedConfiguration(durableValues);
    await commitAgentSettings(firstConfiguration, baseDraft, { desktop: true });
    const secondConfiguration = makeCachedConfiguration(durableValues);
    renderSettings(secondConfiguration, { isDesktop: true });
    await waitFor(() => {
      expect(screen.getByLabelText("Model")).toHaveValue("local-model");
    });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "stale-model" },
    });

    const firstRevision = firstConfiguration.get("agent.configurationRevision");
    expect(typeof firstRevision).toBe("string");
    await commitAgentSettings(
      firstConfiguration,
      {
        ...baseDraft,
        openAiCompatible: {
          ...baseDraft.openAiCompatible,
          baseUrl: "https://winner.example.com/v1",
          model: "winner-model",
        },
        revision: firstRevision as string,
      },
      { desktop: true },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );

    expect(
      await screen.findByText(
        "Agent settings changed in another tab. The latest saved values were reloaded; review them and try your edit again.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Model")).toHaveValue("winner-model");
    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "https://winner.example.com/v1",
    );

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "retry-model" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );
    await waitFor(() => {
      expect(secondConfiguration.get(AppSetting.AGENT_OPENAI_MODEL)).toBe(
        "retry-model",
      );
      expect(
        screen.queryByText(
          "Agent settings changed in another tab. The latest saved values were reloaded; review them and try your edit again.",
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the draft retryable after a credential persistence failure", async () => {
    const configuration = makeMockAppConfiguration();
    await commitAgentSettings(configuration, baseDraft);
    renderSettings(configuration);
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "retry-key" },
    });

    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );
    expect(
      await screen.findByText(
        "Agent credentials or settings could not be read or saved. Your draft has not been discarded.",
      ),
    ).toBeVisible();

    setItem.mockRestore();
    fireEvent.click(
      screen.getByRole("button", { name: "Save Agent settings" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save Agent settings" }),
      ).toBeDisabled();
    });
  });
});
