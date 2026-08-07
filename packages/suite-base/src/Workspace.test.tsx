/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useContext, useEffect, useState } from "react";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import {
  useMessagePipeline,
  useMessagePipelineGetter,
} from "@lichtblick/suite-base/components/MessagePipeline";
import Sidebars from "@lichtblick/suite-base/components/Sidebars";
import { SidebarItem } from "@lichtblick/suite-base/components/Sidebars/types";
import type { AgentChatProfileOption } from "@lichtblick/suite-base/context/AgentChatContext";
import { useAppContext } from "@lichtblick/suite-base/context/AppContext";
import {
  useCurrentUser,
  useCurrentUserType,
} from "@lichtblick/suite-base/context/CurrentUserContext";
import { useEvents } from "@lichtblick/suite-base/context/EventsContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import { usePlayerSelection } from "@lichtblick/suite-base/context/PlayerSelectionContext";
import {
  WorkspaceContext,
  useWorkspaceStore,
} from "@lichtblick/suite-base/context/Workspace/WorkspaceContext";
import { useWorkspaceActions } from "@lichtblick/suite-base/context/Workspace/useWorkspaceActions";
import { useAppConfigurationValue } from "@lichtblick/suite-base/hooks";
import useAlertCount from "@lichtblick/suite-base/hooks/useAlertCount";
import { useHandleFiles } from "@lichtblick/suite-base/hooks/useHandleFiles";
import { useLayoutTransfer } from "@lichtblick/suite-base/hooks/useLayoutTransfer";
import { PlayerPresence } from "@lichtblick/suite-base/players/types";
import {
  type AgentProfile,
  selectAgentConfiguration,
} from "@lichtblick/suite-base/services/agent/agentSettings";
import * as localAgentClientModule from "@lichtblick/suite-base/services/agent/localAgentClient";
import { invalidateAgentBootstrapCache } from "@lichtblick/suite-base/services/agent/prompts/remotePromptCustomization";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";
import { parseAppURLState } from "@lichtblick/suite-base/util/appURLState";

import Workspace from "./Workspace";

// ── style ─────────────────────────────────────────────────────────────────────
jest.mock("@lichtblick/suite-base/Workspace.style", () => ({
  useStyles: () => ({ classes: { container: "" } }),
}));

// ── external libs ─────────────────────────────────────────────────────────────
jest.mock("i18next", () => ({ t: (key: string) => key }));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
jest.mock("@lichtblick/log", () => ({
  __esModule: true,
  default: { getLogger: () => ({ debug: jest.fn(), error: jest.fn() }) },
}));

const mockAppConfiguration = {
  addChangeListener: jest.fn(),
  get: jest.fn(),
  removeChangeListener: jest.fn(),
  set: jest.fn().mockResolvedValue(undefined),
};
const mockPanelCatalog = {
  getPanels: jest.fn().mockReturnValue([]),
};
const mockDefaultAgentProfile: AgentProfile = {
  anthropic: { apiKey: "", baseUrl: "", model: "claude-test" },
  id: "default",
  name: "Default",
  openAiCompatible: { apiKey: "", baseUrl: "", model: "" },
  provider: "anthropic",
};
let mockAgentProfiles: AgentProfile[] = [mockDefaultAgentProfile];
let mockActiveAgentProfileId = "default";

function resetMockAgentProfiles(): void {
  mockAgentProfiles = [mockDefaultAgentProfile];
  mockActiveAgentProfileId = "default";
}

jest.mock("@lichtblick/suite-base/context/AppConfigurationContext", () => ({
  ...jest.requireActual("@lichtblick/suite-base/context/AppConfigurationContext"),
  useAppConfiguration: () => mockAppConfiguration,
}));
jest.mock("@lichtblick/suite-base/context/ExtensionCatalogContext", () => ({
  useExtensionCatalog: (selector: (state: { installedExtensions: [] }) => unknown) =>
    selector({ installedExtensions: [] }),
}));
jest.mock("@lichtblick/suite-base/context/PanelCatalogContext", () => ({
  usePanelCatalog: () => mockPanelCatalog,
}));
jest.mock("@lichtblick/suite-base/services/agent/agentSettings", () => {
  const actual = jest.requireActual<
    typeof import("@lichtblick/suite-base/services/agent/agentSettings")
  >("@lichtblick/suite-base/services/agent/agentSettings");
  return {
    ...actual,
    selectAgentConfiguration: jest.fn(actual.selectAgentConfiguration),
    useAgentSettings: () => ({
      migrationReady: true,
      snapshot: (() => {
        const legacyApiKey = globalThis.localStorage.getItem(
          "lichtblick.agent.anthropic.apiKey",
        );
        const profiles = mockAgentProfiles.map((profile) =>
          profile.id === mockActiveAgentProfileId && legacyApiKey != undefined
            ? {
                ...profile,
                anthropic: { ...profile.anthropic, apiKey: legacyApiKey },
              }
            : profile,
        );
        const activeProfile =
          profiles.find((profile) => profile.id === mockActiveAgentProfileId) ?? profiles[0]!;
        return {
          activeProfileId: activeProfile.id,
          profiles,
          anthropic: {
            ...activeProfile.anthropic,
          },
          credentialResaveRequired: false,
          credentialStorage: "plaintext",
          openAiCompatible: { ...activeProfile.openAiCompatible },
          provider: activeProfile.provider,
          revision: "",
          storageError: false,
          vtdAuthToken: "",
          vtdEndpoint: "https://vtd.example.com",
        };
      })(),
    }),
  };
});

const mockEnqueueSnackbar = jest.fn();
jest.mock("notistack", () => ({
  useSnackbar: () => ({ enqueueSnackbar: mockEnqueueSnackbar }),
}));

type MockAgentChatProviderProps = React.PropsWithChildren<{
  enabled?: boolean;
  onSelectProfile?: (profileId: string) => void;
  profileOptions?: readonly AgentChatProfileOption[];
  selectedProfileId?: string;
  selectedProfileName?: string;
}>;
const mockAgentChatProvider = jest.fn(({ children }: MockAgentChatProviderProps) => (
  <>{children}</>
));
const mockAgentCatalogWatcher = jest.fn(() => null);

// ── api ───────────────────────────────────────────────────────────────────────
const mockGetMcapBundle = jest.fn();
jest.mock("@lichtblick/suite-base/api/mcapBundle/McapBundleAPI", () => ({
  __esModule: true,
  default: { getMcapBundle: (...args: unknown[]) => mockGetMcapBundle(...args) },
}));

// ── components (rendered as null — Sidebars is the exception below) ────────────
jest.mock("@lichtblick/suite-base/components/Sidebars", () => ({
  __esModule: true,
  default: jest.fn(() => undefined),
}));
jest.mock("@lichtblick/suite-base/components/AppBar", () => ({
  AppBar: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/AgentCatalogWatcher", () => ({
  AgentCatalogWatcher: () => mockAgentCatalogWatcher(),
}));
jest.mock("@lichtblick/suite-base/components/AlertList/AlertsList", () => ({
  AlertsList: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/AccountSettingsSidebar/AccountSettings", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/DataSourceDialog", () => ({
  DataSourceDialog: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/DataSourceSidebar/DataSourceSidebar", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/DocumentDropListener", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/EventsList", () => ({
  EventsList: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/ExtensionsSettings", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/KeyListener", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/LayoutBrowser", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/PanelCatalog", () => ({
  PanelCatalog: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/PanelLayout", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/PanelSettings", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/PlaybackControls", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/RemountOnValueChange", () => ({
  __esModule: true,
  default: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
jest.mock("@lichtblick/suite-base/components/SidebarContent", () => ({
  SidebarContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
jest.mock("@lichtblick/suite-base/components/Stack", () => ({
  __esModule: true,
  default: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
jest.mock("@lichtblick/suite-base/components/StudioLogsSettings", () => ({
  StudioLogsSettings: () => undefined,
  StudioLogsSettingsSidebar: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/SyncAdapters", () => ({
  SyncAdapters: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/TopicList", () => ({
  TopicList: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/VariablesList", () => ({
  __esModule: true,
  default: () => undefined,
}));
jest.mock("@lichtblick/suite-base/components/WorkspaceDialogs", () => ({
  WorkspaceDialogs: () => undefined,
}));

// ── providers ─────────────────────────────────────────────────────────────────
jest.mock("@lichtblick/suite-base/providers/PanelStateContextProvider", () => ({
  PanelStateContextProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
jest.mock("@lichtblick/suite-base/providers/AgentChatProvider", () => ({
  __esModule: true,
  default: (props: React.PropsWithChildren) => mockAgentChatProvider(props),
}));

// ── hooks ─────────────────────────────────────────────────────────────────────
jest.mock("@lichtblick/suite-base/components/MessagePipeline", () => ({
  useMessagePipeline: jest.fn(),
  useMessagePipelineGetter: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/AppContext", () => ({
  useAppContext: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/CurrentLayoutContext", () => ({
  useCurrentLayoutSelector: jest.fn().mockReturnValue(undefined),
  useCurrentLayoutActions: jest.fn().mockReturnValue({
    setSelectedLayoutId: jest.fn(),
  }),
}));
jest.mock("@lichtblick/suite-base/context/CurrentUserContext", () => ({
  useCurrentUser: jest.fn(),
  useCurrentUserType: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/EventsContext", () => ({
  useEvents: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/LayoutManagerContext", () => ({
  useLayoutManager: jest.fn().mockReturnValue({
    getLayouts: jest.fn().mockResolvedValue([]),
    deleteLayout: jest.fn().mockResolvedValue(undefined),
    saveNewLayout: jest.fn().mockResolvedValue({ id: "test-layout-id" }),
    on: jest.fn(),
    off: jest.fn(),
    overwriteLayout: jest.fn(),
    syncWithRemote: jest.fn(),
  }),
}));
jest.mock("@lichtblick/suite-base/context/PlayerSelectionContext", () => ({
  usePlayerSelection: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/Workspace/WorkspaceContext", () => ({
  ...jest.requireActual("@lichtblick/suite-base/context/Workspace/WorkspaceContext"),
  useWorkspaceStore: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/Workspace/useWorkspaceActions", () => ({
  useWorkspaceActions: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/hooks", () => ({
  useAppConfigurationValue: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/hooks/useAlertCount", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/hooks/useAddPanel", () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue(jest.fn()),
}));
jest.mock("@lichtblick/suite-base/hooks/useDefaultWebLaunchPreference", () => ({
  useDefaultWebLaunchPreference: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/hooks/useElectronFilesToOpen", () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue(undefined),
}));
jest.mock("@lichtblick/suite-base/hooks/useHandleFiles", () => ({
  useHandleFiles: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/hooks/useLayoutTransfer", () => ({
  useLayoutTransfer: jest.fn().mockReturnValue({
    parseAndInstallLayout: jest.fn().mockResolvedValue({ id: "default-layout-id" }),
    importLayout: jest.fn(),
    exportLayout: jest.fn(),
  }),
}));
jest.mock("@lichtblick/suite-base/hooks/useSeekTimeFromCLI", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/panels/Plot/hooks/useStructureItemsStoreManager", () => ({
  useStructureItemsStoreManager: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/theme/icons", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("@lichtblick/suite-base/util/appURLState", () => ({
  parseAppURLState: jest.fn().mockReturnValue(undefined),
}));
jest.mock("@lichtblick/suite-base/util/broadcast/useBroadcast", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/util/isDesktopApp", () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue(false),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

const MockedSidebars = Sidebars as unknown as jest.Mock;

const mockPipelineContext = {
  playerState: {
    presence: PlayerPresence.NOT_PRESENT,
    playerId: "",
    activeData: undefined,
    alerts: [],
  },
  startPlayback: undefined,
  pausePlayback: undefined,
  seekPlayback: undefined,
  playUntil: undefined,
};

const mockWorkspaceStore = {
  dialogs: {
    dataSource: { open: false, activeDataSource: undefined, item: undefined },
    preferences: { open: false, initialTab: undefined },
  },
  sidebars: {
    left: { item: undefined, open: false, size: undefined },
    right: { item: undefined, open: false, size: undefined },
  },
};

const mockWorkspaceActions = {
  dialogActions: {
    dataSource: { open: jest.fn(), close: jest.fn() },
    preferences: { open: jest.fn() },
    openFile: { open: jest.fn().mockResolvedValue(undefined) },
  },
  sidebarActions: {
    left: { setOpen: jest.fn(), selectItem: jest.fn(), setSize: jest.fn() },
    right: { setOpen: jest.fn(), selectItem: jest.fn(), setSize: jest.fn() },
  },
  openLayoutBrowser: jest.fn(),
};

beforeAll(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: jest.fn(),
    writable: true,
  });
});

function agentAppConfigurationValue(
  key: string,
  { enabled = false }: { enabled?: boolean } = {},
): [unknown] {
  switch (key) {
    case AppSetting.AGENT_ENABLED:
      return [enabled];
    case AppSetting.AGENT_LLM_PROVIDER:
      return ["anthropic"];
    case AppSetting.AGENT_ANTHROPIC_MODEL:
      return ["claude-test"];
    case AppSetting.AGENT_ANTHROPIC_BASE_URL:
      return [""];
    case AppSetting.AGENT_VTD_ENDPOINT:
      return ["https://vtd.example.com"];
    default:
      return [undefined];
  }
}

function jsonResponse(data: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let consumed = false;
  return {
    body: {
      cancel: jest.fn().mockResolvedValue(undefined),
      getReader: () => ({
        cancel: jest.fn().mockResolvedValue(undefined),
        read: jest.fn(async () => {
          if (consumed) {
            return { done: true, value: undefined };
          }
          consumed = true;
          return { done: false, value: bytes };
        }),
        releaseLock: jest.fn(),
      }),
    },
    headers: { get: () => undefined },
    json: jest.fn(async () => JSON.parse(new TextDecoder().decode(bytes))),
    ok: true,
    status: 200,
    statusText: "OK",
  } as unknown as Response;
}

beforeEach(() => {
  resetMockAgentProfiles();
  jest.mocked(selectAgentConfiguration).mockClear();
});

describe("Workspace - alerts badge in leftSidebarItems", () => {
  beforeEach(() => {
    localStorage.clear();
    mockAgentChatProvider.mockClear();
    mockAgentCatalogWatcher.mockClear();
    (useMessagePipeline as jest.Mock).mockImplementation(
      (selector: (ctx: typeof mockPipelineContext) => unknown) => selector(mockPipelineContext),
    );
    (useMessagePipelineGetter as jest.Mock).mockReturnValue(() => mockPipelineContext);
    (useWorkspaceStore as jest.Mock).mockImplementation(
      (selector: (store: typeof mockWorkspaceStore) => unknown) => selector(mockWorkspaceStore),
    );
    (useWorkspaceActions as jest.Mock).mockReturnValue(mockWorkspaceActions);
    (usePlayerSelection as jest.Mock).mockReturnValue({
      availableSources: [],
      selectSource: jest.fn(),
    });
    (useAlertCount as jest.Mock).mockReturnValue({
      playerAlerts: [],
      sessionAlerts: [],
      alertCount: 0,
    });
    (useHandleFiles as jest.Mock).mockReturnValue({ handleFiles: jest.fn() });
    (useAppConfigurationValue as jest.Mock).mockImplementation((key: string) =>
      agentAppConfigurationValue(key),
    );
    (useCurrentUser as jest.Mock).mockReturnValue({
      currentUser: undefined,
      signIn: undefined,
    });
    (useCurrentUserType as jest.Mock).mockReturnValue("unauthenticated");
    (useEvents as jest.Mock).mockImplementation(
      (selector: (store: { eventsSupported: boolean; selectEvent: jest.Mock }) => unknown) =>
        selector({ eventsSupported: false, selectEvent: jest.fn() }),
    );
    (useAppContext as jest.Mock).mockReturnValue({
      PerformanceSidebarComponent: undefined,
      sidebarItems: [],
      layoutBrowser: undefined,
      workspaceStoreCreator: undefined,
    });
  });

  afterEach(() => {
    MockedSidebars.mockClear();
  });

  it("should not set badge on alerts sidebar item when alertCount is 0", () => {
    // Given
    (useAlertCount as jest.Mock).mockReturnValue({
      playerAlerts: [],
      sessionAlerts: [],
      alertCount: 0,
    });

    // When
    render(<Workspace />);

    // Then
    const leftItems = MockedSidebars.mock.lastCall?.[0]?.leftItems as Map<string, SidebarItem>;
    expect(leftItems.get("alerts")?.badge).toBeUndefined();
  });

  it("should set badge with count and error color on alerts sidebar item when alertCount > 0", () => {
    // Given
    (useAlertCount as jest.Mock).mockReturnValue({
      playerAlerts: [{ message: "err", severity: "error" }],
      sessionAlerts: [],
      alertCount: 1,
    });

    // When
    render(<Workspace />);

    // Then
    const leftItems = MockedSidebars.mock.lastCall?.[0]?.leftItems as Map<string, SidebarItem>;
    expect(leftItems.get("alerts")?.badge).toEqual({
      count: 1,
      color: "error",
    });
  });

  it("should reflect the exact alertCount in the badge", () => {
    // Given
    (useAlertCount as jest.Mock).mockReturnValue({
      playerAlerts: [],
      sessionAlerts: [],
      alertCount: 5,
    });

    // When
    render(<Workspace />);

    // Then
    const leftItems = MockedSidebars.mock.lastCall?.[0]?.leftItems as Map<string, SidebarItem>;
    expect(leftItems.get("alerts")?.badge?.count).toBe(5);
  });

  it("keeps the disabled provider mounted while hiding Agent Chat UI entries", () => {
    render(<Workspace />);

    const rightItems = MockedSidebars.mock.lastCall?.[0]?.rightItems as Map<string, SidebarItem>;
    expect(rightItems.has("agent-chat")).toBe(false);
    expect(mockAgentChatProvider).toHaveBeenCalled();
    expect(mockAgentChatProvider.mock.lastCall?.[0]).toMatchObject({
      enabled: false,
    });
    expect(mockAgentCatalogWatcher).toHaveBeenCalled();
  });

  it("passes the session profile selection into configuration and falls back after deletion", async () => {
    const diagnosticsProfile: AgentProfile = {
      anthropic: { apiKey: "diagnostics-key", baseUrl: "", model: "claude-diagnostics" },
      id: "diagnostics",
      name: "Diagnostics",
      openAiCompatible: { apiKey: "", baseUrl: "", model: "" },
      provider: "anthropic",
    };
    mockAgentProfiles = [
      {
        ...mockDefaultAgentProfile,
        anthropic: { ...mockDefaultAgentProfile.anthropic, apiKey: "default-key" },
      },
      diagnosticsProfile,
    ];
    const root = render(<Workspace />);

    expect(mockAgentChatProvider.mock.lastCall?.[0]).toMatchObject({
      selectedProfileId: "default",
      selectedProfileName: "Default",
    });
    expect(mockAgentChatProvider.mock.lastCall?.[0].profileOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "default", isActive: true }),
        expect.objectContaining({ id: "diagnostics", isActive: false }),
      ]),
    );

    act(() => {
      mockAgentChatProvider.mock.lastCall?.[0].onSelectProfile?.("diagnostics");
    });
    await waitFor(() => {
      expect(mockAgentChatProvider.mock.lastCall?.[0]).toMatchObject({
        selectedProfileId: "diagnostics",
        selectedProfileName: "Diagnostics",
      });
    });
    expect(jest.mocked(selectAgentConfiguration).mock.lastCall?.[1]).toMatchObject({
      profileId: "diagnostics",
    });

    mockAgentProfiles = [mockAgentProfiles[0]!];
    root.rerender(<Workspace />);
    await waitFor(() => {
      expect(mockAgentChatProvider.mock.lastCall?.[0]).toMatchObject({
        selectedProfileId: "default",
        selectedProfileName: "Default",
      });
    });
    expect(jest.mocked(selectAgentConfiguration).mock.lastCall?.[1]).toMatchObject({
      profileId: "default",
    });
  });

  it("normalizes a persisted hidden agent sidebar selection", async () => {
    const persistedAgentStore = {
      ...mockWorkspaceStore,
      sidebars: {
        ...mockWorkspaceStore.sidebars,
        right: { item: "agent-chat", open: false, size: undefined },
      },
    };
    (useWorkspaceStore as jest.Mock).mockImplementation(
      (selector: (store: typeof persistedAgentStore) => unknown) => selector(persistedAgentStore),
    );
    mockWorkspaceActions.sidebarActions.right.selectItem.mockClear();
    mockWorkspaceActions.sidebarActions.right.setOpen.mockClear();

    render(<Workspace />);

    await waitFor(() => {
      expect(mockWorkspaceActions.sidebarActions.right.selectItem).toHaveBeenCalledWith(
        "variables",
      );
      expect(mockWorkspaceActions.sidebarActions.right.setOpen).toHaveBeenCalledWith(false);
    });
  });

  it("mounts the provider and wires direct and agent data-source opening", async () => {
    const selectSource = jest.fn();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ downloadUrl: "https://example.com/record.mcap" }))
      .mockResolvedValueOnce(jsonResponse({ topics: { "/camera": 2, "/imu": 12 } }))
      .mockResolvedValueOnce(jsonResponse({ mcap_slice_id: "slice-1" }))
      .mockRejectedValueOnce(new Error("slice-get temporarily unavailable"))
      .mockResolvedValueOnce(jsonResponse({ download_url: "https://example.com/slice.mcap" }));
    localStorage.setItem("lichtblick.agent.anthropic.apiKey", "test-api-key");
    (useAppConfigurationValue as jest.Mock).mockImplementation((key: string) =>
      agentAppConfigurationValue(key, { enabled: true }),
    );
    (usePlayerSelection as jest.Mock).mockReturnValue({
      availableSources: [],
      selectSource,
    });

    render(<Workspace />);

    const rightItems = MockedSidebars.mock.lastCall?.[0]?.rightItems as Map<string, SidebarItem>;
    expect(rightItems.has("agent-chat")).toBe(true);
    expect(mockAgentChatProvider).toHaveBeenCalled();
    expect(mockAgentChatProvider.mock.lastCall?.[0]).toMatchObject({
      enabled: true,
    });
    expect(mockAgentCatalogWatcher).toHaveBeenCalled();

    const providerProps = mockAgentChatProvider.mock.lastCall?.[0] as {
      onGetVtdTopics: (id: string) => Promise<Record<string, number>>;
      onLoadVtdRecord: (id: string) => Promise<void>;
      onOpenDataSource: (urls: string[]) => void;
      onSliceVtdRecord: (
        params: {
          id: string;
          topics: string[];
          startNs: string;
          endNs: string;
        },
        onProgress: (progress: "slicing" | "loading") => void,
      ) => Promise<void>;
    };
    providerProps.onOpenDataSource(["https://example.com/agent.mcap"]);
    expect(selectSource).toHaveBeenCalledWith("remote-file", {
      type: "connection",
      params: { url: "https://example.com/agent.mcap" },
    });

    await act(async () => {
      await providerProps.onLoadVtdRecord("record-1");
    });
    expect(global.fetch).toHaveBeenCalledWith(
      new URL("https://vtd.example.com/vtd/url"),
      expect.objectContaining({
        body: JSON.stringify({ id: "record-1" }),
        method: "POST",
      }),
    );
    expect(selectSource).toHaveBeenLastCalledWith("remote-file", {
      type: "connection",
      params: { url: "https://example.com/record.mcap" },
    });

    await expect(providerProps.onGetVtdTopics("record-1")).resolves.toEqual({
      "/camera": 2,
      "/imu": 12,
    });
    const sliceParams = {
      id: "record-1",
      topics: ["/camera", "/imu"],
      startNs: "1912689868838297225",
      endNs: "1912690468838297225",
    };
    const firstProgress = jest.fn();
    await expect(providerProps.onSliceVtdRecord(sliceParams, firstProgress)).rejects.toThrow(
      "slice-get",
    );
    expect(firstProgress.mock.calls.map(([progress]) => progress)).toEqual(["slicing", "loading"]);

    const retryProgress = jest.fn();
    await act(async () => {
      await providerProps.onSliceVtdRecord(sliceParams, retryProgress);
    });
    expect(retryProgress).toHaveBeenCalledTimes(1);
    expect(retryProgress).toHaveBeenCalledWith("loading");
    const fetchCalls = (global.fetch as jest.Mock).mock.calls;
    expect(fetchCalls.filter(([url]) => String(url).endsWith("/vtd/slice-store"))).toHaveLength(1);
    expect(fetchCalls.filter(([url]) => String(url).endsWith("/vtd/slice-get"))).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledWith(
      new URL("https://vtd.example.com/vtd/slice-store"),
      expect.objectContaining({ body: JSON.stringify(sliceParams), method: "POST" }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      new URL("https://vtd.example.com/vtd/slice-get"),
      expect.objectContaining({
        body: JSON.stringify({ sliceId: "slice-1" }),
        method: "POST",
      }),
    );
    expect(selectSource).toHaveBeenLastCalledWith("remote-file", {
      type: "connection",
      params: { url: "https://example.com/slice.mcap" },
    });
  });

  it("does not remount WorkspaceContent when agent.enabled changes", () => {
    localStorage.setItem("lichtblick.agent.anthropic.apiKey", "test-api-key");
    let agentEnabled = false;
    const appBarMounted = jest.fn();
    const appBarUnmounted = jest.fn();
    const observedWorkspaceStores = new Set<unknown>();
    function PersistentAppBar(): React.JSX.Element {
      observedWorkspaceStores.add(useContext(WorkspaceContext));
      useEffect(() => {
        appBarMounted();
        return () => {
          appBarUnmounted();
        };
      }, []);
      return <div data-testid="persistent-app-bar" />;
    }
    function RuntimeEnabledHarness(): React.JSX.Element {
      const [enabled, setEnabled] = useState(false);
      agentEnabled = enabled;
      return (
        <>
          <button
            data-testid="toggle-agent"
            onClick={() => {
              setEnabled((value) => !value);
            }}
          />
          <Workspace AppBarComponent={PersistentAppBar} disablePersistenceForStorybook />
        </>
      );
    }
    (useAppConfigurationValue as jest.Mock).mockImplementation((key: string) =>
      agentAppConfigurationValue(key, { enabled: agentEnabled }),
    );

    const root = render(<RuntimeEnabledHarness />);
    expect(appBarMounted).toHaveBeenCalledTimes(1);
    expect(appBarUnmounted).not.toHaveBeenCalled();
    expect(observedWorkspaceStores.size).toBe(1);
    expect([...observedWorkspaceStores][0]).toBeDefined();

    fireEvent.click(root.getByTestId("toggle-agent"));
    expect(appBarMounted).toHaveBeenCalledTimes(1);
    expect(appBarUnmounted).not.toHaveBeenCalled();
    expect(observedWorkspaceStores.size).toBe(1);
    expect(mockAgentChatProvider.mock.lastCall?.[0]).toMatchObject({
      enabled: true,
    });

    fireEvent.click(root.getByTestId("toggle-agent"));
    expect(appBarMounted).toHaveBeenCalledTimes(1);
    expect(appBarUnmounted).not.toHaveBeenCalled();
    expect(observedWorkspaceStores.size).toBe(1);
    expect(mockAgentChatProvider.mock.lastCall?.[0]).toMatchObject({
      enabled: false,
    });

    root.unmount();
    expect(appBarUnmounted).toHaveBeenCalledTimes(1);
  });
});

describe("Workspace - session-based MCAP resolution", () => {
  const mockSelectSource = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    (useMessagePipeline as jest.Mock).mockImplementation(
      (selector: (ctx: typeof mockPipelineContext) => unknown) => selector(mockPipelineContext),
    );
    (useMessagePipelineGetter as jest.Mock).mockReturnValue(() => mockPipelineContext);
    (useWorkspaceStore as jest.Mock).mockImplementation(
      (selector: (store: typeof mockWorkspaceStore) => unknown) => selector(mockWorkspaceStore),
    );
    (useWorkspaceActions as jest.Mock).mockReturnValue(mockWorkspaceActions);
    (usePlayerSelection as jest.Mock).mockReturnValue({
      availableSources: [],
      selectSource: mockSelectSource,
    });
    (useAlertCount as jest.Mock).mockReturnValue({
      playerAlerts: [],
      sessionAlerts: [],
      alertCount: 0,
    });
    (useHandleFiles as jest.Mock).mockReturnValue({ handleFiles: jest.fn() });
    (useAppConfigurationValue as jest.Mock).mockImplementation((key: string) =>
      agentAppConfigurationValue(key),
    );
    (useCurrentUser as jest.Mock).mockReturnValue({
      currentUser: undefined,
      signIn: undefined,
    });
    (useCurrentUserType as jest.Mock).mockReturnValue("unauthenticated");
    (useEvents as jest.Mock).mockImplementation(
      (selector: (store: { eventsSupported: boolean; selectEvent: jest.Mock }) => unknown) =>
        selector({ eventsSupported: false, selectEvent: jest.fn() }),
    );
    (useAppContext as jest.Mock).mockReturnValue({
      PerformanceSidebarComponent: undefined,
      sidebarItems: [],
      layoutBrowser: undefined,
      workspaceStoreCreator: undefined,
    });
  });

  it("should fetch session and call selectSource with resolved URLs and metadata", async () => {
    // Given
    const mcapBundleId = "test-session-123";
    const mockMcaps = [
      { url: "https://example.com/file1.mcap", metadata: { robot: "r1" } },
      { url: "https://example.com/file2.mcap", metadata: { robot: "r2" } },
    ];
    mockGetMcapBundle.mockResolvedValue(mockMcaps);
    (parseAppURLState as jest.Mock).mockReturnValue({ mcapBundleId });

    // When
    render(<Workspace deepLinks={["https://app.example.com/?mcap-bundle=test-session-123"]} />);

    // Then
    await waitFor(() => {
      expect(mockGetMcapBundle).toHaveBeenCalledWith(mcapBundleId, expect.any(AbortSignal));
    });
    await waitFor(() => {
      expect(mockSelectSource).toHaveBeenCalledWith("remote-file", {
        type: "connection",
        params: {
          url: "https://example.com/file1.mcap,https://example.com/file2.mcap",
        },
        sourceMetadata: [{ robot: "r1" }, { robot: "r2" }],
      });
    });
  });

  it("should show error snackbar when session fetch fails", async () => {
    // Given
    const mcapBundleId = "failing-session";
    mockGetMcapBundle.mockRejectedValue(new Error("Network error"));
    (parseAppURLState as jest.Mock).mockReturnValue({ mcapBundleId });

    // When
    render(<Workspace deepLinks={["https://app.example.com/?mcap-bundle=failing-session"]} />);

    // Then
    await waitFor(() => {
      expect(mockGetMcapBundle).toHaveBeenCalledWith(mcapBundleId, expect.any(AbortSignal));
    });
    await waitFor(() => {
      expect(mockEnqueueSnackbar).toHaveBeenCalledWith("Failed to load session data sources", {
        variant: "error",
      });
    });
  });

  it("should not fetch session when mcapBundleId is not present", () => {
    // Given
    (parseAppURLState as jest.Mock).mockReturnValue({
      ds: "remote-file",
      dsParams: { url: "https://example.com/file.mcap" },
    });

    // When
    render(<Workspace deepLinks={["https://app.example.com/?ds=remote-file"]} />);

    // Then
    expect(mockGetMcapBundle).not.toHaveBeenCalled();
  });
});

describe("Workspace - fetchLayoutFromUrl", () => {
  const mockParseAndInstallLayout = jest.fn();
  const mockGetLayouts = jest.fn();
  const mockDeleteLayout = jest.fn();
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const setupWorkspaceMocks = () => {
    (useMessagePipeline as jest.Mock).mockImplementation(
      (selector: (ctx: typeof mockPipelineContext) => unknown) => selector(mockPipelineContext),
    );
    (useMessagePipelineGetter as jest.Mock).mockReturnValue(() => mockPipelineContext);
    (useWorkspaceStore as jest.Mock).mockImplementation(
      (selector: (store: typeof mockWorkspaceStore) => unknown) => selector(mockWorkspaceStore),
    );
    (useWorkspaceActions as jest.Mock).mockReturnValue(mockWorkspaceActions);
    (usePlayerSelection as jest.Mock).mockReturnValue({
      availableSources: [],
      selectSource: jest.fn(),
    });
    (useAlertCount as jest.Mock).mockReturnValue({
      playerAlerts: [],
      sessionAlerts: [],
      alertCount: 0,
    });
    (useHandleFiles as jest.Mock).mockReturnValue({ handleFiles: jest.fn() });
    (useAppConfigurationValue as jest.Mock).mockImplementation((key: string) =>
      agentAppConfigurationValue(key),
    );
    (useCurrentUser as jest.Mock).mockReturnValue({
      currentUser: undefined,
      signIn: undefined,
    });
    (useCurrentUserType as jest.Mock).mockReturnValue("unauthenticated");
    (useEvents as jest.Mock).mockImplementation(
      (selector: (store: { eventsSupported: boolean; selectEvent: jest.Mock }) => unknown) =>
        selector({ eventsSupported: false, selectEvent: jest.fn() }),
    );
    (useAppContext as jest.Mock).mockReturnValue({
      PerformanceSidebarComponent: undefined,
      sidebarItems: [],
      layoutBrowser: undefined,
      workspaceStoreCreator: undefined,
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLayouts.mockResolvedValue([]);
    mockDeleteLayout.mockResolvedValue(undefined);
    mockParseAndInstallLayout.mockResolvedValue({ id: "new-layout-id" });
    (useLayoutManager as jest.Mock).mockReturnValue({
      getLayouts: mockGetLayouts,
      deleteLayout: mockDeleteLayout,
      saveNewLayout: jest.fn().mockResolvedValue({ id: "test-layout-id" }),
      on: jest.fn(),
      off: jest.fn(),
      overwriteLayout: jest.fn(),
      syncWithRemote: jest.fn(),
    });
    (useLayoutTransfer as jest.Mock).mockReturnValue({
      parseAndInstallLayout: mockParseAndInstallLayout,
      importLayout: jest.fn(),
      exportLayout: jest.fn(),
    });
    setupWorkspaceMocks();
  });

  it("should fetch and install layout from valid https URL", async () => {
    // Given
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('{"configById":{}}'),
    });
    (parseAppURLState as jest.Mock).mockReturnValue({
      layoutUrl: "https://example.com/my-layout.json",
    });

    // When
    render(
      <Workspace
        deepLinks={["https://app.example.com/?layoutUrl=https://example.com/my-layout.json"]}
      />,
    );

    // Then
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("https://example.com/my-layout.json");
    });
    await waitFor(() => {
      expect(mockParseAndInstallLayout).toHaveBeenCalledWith(
        expect.objectContaining({ name: "my-layout.json" }),
        "local",
      );
    });
  });

  it("should delete existing layouts with same name after successful install", async () => {
    // Given
    mockGetLayouts.mockResolvedValue([{ id: "old-id", name: "my-layout" }]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue("{}"),
    });
    (parseAppURLState as jest.Mock).mockReturnValue({
      layoutUrl: "https://example.com/my-layout.json",
    });

    // When
    render(
      <Workspace
        deepLinks={["https://app.example.com/?layoutUrl=https://example.com/my-layout.json"]}
      />,
    );

    // Then
    await waitFor(() => {
      expect(mockDeleteLayout).toHaveBeenCalledWith({ id: "old-id" });
    });
  });

  it("should not delete existing layouts if parseAndInstallLayout returns undefined", async () => {
    // Given
    mockGetLayouts.mockResolvedValue([{ id: "old-id", name: "my-layout" }]);
    mockParseAndInstallLayout.mockResolvedValue(undefined);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue("{}"),
    });
    (parseAppURLState as jest.Mock).mockReturnValue({
      layoutUrl: "https://example.com/my-layout.json",
    });

    // When
    render(
      <Workspace
        deepLinks={["https://app.example.com/?layoutUrl=https://example.com/my-layout.json"]}
      />,
    );

    // Then
    await waitFor(() => {
      expect(mockParseAndInstallLayout).toHaveBeenCalled();
    });
    expect(mockDeleteLayout).not.toHaveBeenCalled();
  });

  it("should show error snackbar for non-http(s) URL", async () => {
    // Given
    (parseAppURLState as jest.Mock).mockReturnValue({
      layoutUrl: "file:///local/layout.json",
    });

    // When
    render(
      <Workspace deepLinks={["https://app.example.com/?layoutUrl=file:///local/layout.json"]} />,
    );

    // Then
    await waitFor(() => {
      expect(mockEnqueueSnackbar).toHaveBeenCalledWith(
        "Layout URL must use http or https protocol",
        {
          variant: "error",
        },
      );
    });
  });

  it("should show error snackbar on HTTP error response", async () => {
    // Given
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    (parseAppURLState as jest.Mock).mockReturnValue({
      layoutUrl: "https://example.com/layout.json",
    });

    // When
    render(
      <Workspace
        deepLinks={["https://app.example.com/?layoutUrl=https://example.com/layout.json"]}
      />,
    );

    // Then
    await waitFor(() => {
      expect(mockEnqueueSnackbar).toHaveBeenCalledWith("Failed to load layout (HTTP 404)", {
        variant: "error",
      });
    });
  });

  it("should show error snackbar on network error", async () => {
    // Given
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));
    (parseAppURLState as jest.Mock).mockReturnValue({
      layoutUrl: "https://example.com/layout.json",
    });

    // When
    render(
      <Workspace
        deepLinks={["https://app.example.com/?layoutUrl=https://example.com/layout.json"]}
      />,
    );

    // Then
    await waitFor(() => {
      expect(mockEnqueueSnackbar).toHaveBeenCalledWith("Failed to load layout from URL", {
        variant: "error",
      });
    });
  });

  it("should not fetch layout when layoutUrl is absent from URL state", () => {
    // Given
    global.fetch = jest.fn();
    (parseAppURLState as jest.Mock).mockReturnValue({
      ds: "remote-file",
      dsParams: { url: "https://example.com/file.mcap" },
    });

    // When
    render(<Workspace deepLinks={["https://app.example.com/?ds=remote-file"]} />);

    // Then
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should show error snackbar for malformed URL that cannot be parsed", async () => {
    // Given
    (parseAppURLState as jest.Mock).mockReturnValue({
      layoutUrl: "not a valid url ://",
    });

    // When
    render(<Workspace deepLinks={["https://app.example.com/?layoutUrl=not+a+valid+url"]} />);

    // Then
    await waitFor(() => {
      expect(mockEnqueueSnackbar).toHaveBeenCalledWith("Invalid layout URL", {
        variant: "error",
      });
    });
  });
});

describe("Workspace - bootstrap invalidation wiring", () => {
  const workspace = "ws-invalidate";

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    setHttpBaseUrl("http://localhost/lichtblick");
    // An earlier describe restores global.fetch to its pre-mock value (undefined); re-establish
    // the fetch mock for the bootstrap HTTP calls.
    (global as { fetch?: unknown }).fetch = jest.fn();
    mockAppConfiguration.get.mockImplementation((key: string) =>
      key === AppSetting.VIZ_SERVER_WORKSPACE ? workspace : undefined,
    );
    (useMessagePipeline as jest.Mock).mockImplementation(
      (selector: (ctx: typeof mockPipelineContext) => unknown) => selector(mockPipelineContext),
    );
    (useMessagePipelineGetter as jest.Mock).mockReturnValue(() => mockPipelineContext);
    (useWorkspaceStore as jest.Mock).mockImplementation(
      (selector: (store: typeof mockWorkspaceStore) => unknown) => selector(mockWorkspaceStore),
    );
    (useWorkspaceActions as jest.Mock).mockReturnValue(mockWorkspaceActions);
    (usePlayerSelection as jest.Mock).mockReturnValue({
      availableSources: [],
      selectSource: jest.fn(),
    });
    (useAlertCount as jest.Mock).mockReturnValue({
      playerAlerts: [],
      sessionAlerts: [],
      alertCount: 0,
    });
    (useHandleFiles as jest.Mock).mockReturnValue({ handleFiles: jest.fn() });
    (useAppConfigurationValue as jest.Mock).mockImplementation((key: string) =>
      agentAppConfigurationValue(key),
    );
    (useCurrentUser as jest.Mock).mockReturnValue({
      currentUser: undefined,
      signIn: undefined,
    });
    (useCurrentUserType as jest.Mock).mockReturnValue("unauthenticated");
    (useEvents as jest.Mock).mockImplementation(
      (selector: (store: { eventsSupported: boolean; selectEvent: jest.Mock }) => unknown) =>
        selector({ eventsSupported: false, selectEvent: jest.fn() }),
    );
    (useAppContext as jest.Mock).mockReturnValue({
      PerformanceSidebarComponent: undefined,
      sidebarItems: [],
      layoutBrowser: undefined,
      workspaceStoreCreator: undefined,
    });
  });

  afterEach(() => {
    setHttpBaseUrl(undefined);
    mockAppConfiguration.get.mockReset();
  });

  it("re-fetches immediately on bootstrap invalidation and serves the fresh server prompt", async () => {
    // Seed the persisted cache so the initial poll sends known_version=v1; only the
    // post-invalidation re-fetch must be a full fetch.
    const cacheKey = "lichtblick.vizserver.agent-bootstrap.v1";
    const seeded = JSON.stringify({
      [workspace]: {
        prompt: { customSkills: [], instructions: "server v1", skillOverrides: {} },
        version: "v1",
      },
    });
    if (seeded == undefined) {
      throw new Error("Unable to serialize bootstrap fixture");
    }
    localStorage.setItem(cacheKey, seeded);

    const bootstrapFetch = jest.fn(async (url: string | URL) => {
      const urlString = String(url);
      if (urlString.includes("/agent/bootstrap")) {
        // The first poll carries the cached known_version; the post-invalidation re-fetch must
        // omit it and receive the full new payload.
        const hasKnownVersion = urlString.includes("known_version=");
        const version = hasKnownVersion ? "v1" : "v2";
        const instructions = hasKnownVersion ? "server v1" : "server v2";
        return await Promise.resolve(
          jsonResponse({
            data: {
              prompt: { customSkills: [], instructions, skillOverrides: {} },
              version,
            },
            path: urlString,
            timestamp: "2026-07-29T00:00:00.000Z",
          }),
        );
      }
      return await Promise.resolve(jsonResponse({ data: null }));
    });
    (global.fetch as jest.Mock).mockImplementation(bootstrapFetch);

    const useLocalAgentClientSpy = jest.spyOn(localAgentClientModule, "useLocalAgentClient");
    try {
      render(<Workspace />);

      // The initial bootstrap poll reaches the server.
      await waitFor(() => {
        expect(bootstrapFetch).toHaveBeenCalledTimes(1);
      });
      expect(String(bootstrapFetch.mock.calls[0]?.[0])).toContain("known_version=");

      // The live prompt customization reflects the cached server payload.
      const options = useLocalAgentClientSpy.mock.lastCall![1] as {
        getPromptCustomization?: () => { instructions: string };
      };
      await waitFor(() => {
        expect(options.getPromptCustomization?.().instructions).toBe("server v1");
      });

      // A server-side change (e.g. a deleted remote skill) invalidates the bootstrap cache…
      invalidateAgentBootstrapCache(workspace);

      // …and the Workspace subscription immediately re-fetches without known_version…
      await waitFor(() => {
        expect(bootstrapFetch).toHaveBeenCalledTimes(2);
      });
      expect(String(bootstrapFetch.mock.calls[1]?.[0])).not.toContain("known_version=");

      // …updating the active serverCustomizationRef so the next turn serves the fresh prompt.
      await waitFor(() => {
        expect(options.getPromptCustomization?.().instructions).toBe("server v2");
      });
    } finally {
      useLocalAgentClientSpy.mockRestore();
    }
  });

  it("wires the message pipeline into the local agent client data-query deps", async () => {
    const useLocalAgentClientSpy = jest.spyOn(localAgentClientModule, "useLocalAgentClient");
    try {
      render(<Workspace />);

      await waitFor(() => {
        expect(useLocalAgentClientSpy).toHaveBeenCalled();
      });
      const options = useLocalAgentClientSpy.mock.lastCall![1] as {
        dataQuery?: { getContext: () => typeof mockPipelineContext };
      };
      // The adapter re-reads the pipeline on every call, so capability gating and the active
      // time range stay current.
      expect(options.dataQuery).toBeDefined();
      expect(options.dataQuery!.getContext()).toBe(mockPipelineContext);
      expect(options.dataQuery!.getContext().playerState).toBe(mockPipelineContext.playerState);
    } finally {
      useLocalAgentClientSpy.mockRestore();
    }
  });
});
