/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, renderHook, waitFor } from "@testing-library/react";
import { SnackbarProvider, useSnackbar } from "notistack";
import { useEffect } from "react";

import { Condvar } from "@lichtblick/den/async";
import { CurrentLayoutSyncAdapter } from "@lichtblick/suite-base/components/CurrentLayoutSyncAdapter";
import {
  CurrentLayoutActions,
  LayoutData,
  LayoutID,
  LayoutState,
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import LayoutManagerContext from "@lichtblick/suite-base/context/LayoutManagerContext";
import { RemoteLayoutStorageContext } from "@lichtblick/suite-base/context/RemoteLayoutStorageContext";
import {
  UserProfileStorage,
  UserProfileStorageContext,
} from "@lichtblick/suite-base/context/UserProfileStorageContext";
import AppParametersProvider from "@lichtblick/suite-base/providers/AppParametersProvider";
import CurrentLayoutProvider from "@lichtblick/suite-base/providers/CurrentLayoutProvider";
import {
  BUSY_POLLING_INTERVAL_MS,
  BUSY_POLLING_TIMEOUT_MS,
  MAX_SUPPORTED_LAYOUT_VERSION,
} from "@lichtblick/suite-base/providers/CurrentLayoutProvider/constants";
import { ILayoutManager } from "@lichtblick/suite-base/services/ILayoutManager";
import { IRemoteLayoutStorage } from "@lichtblick/suite-base/services/IRemoteLayoutStorage";
import LayoutBuilder from "@lichtblick/suite-base/testing/builders/LayoutBuilder";
import { BasicBuilder } from "@lichtblick/test-builders";

jest.mock("notistack", () => ({
  ...jest.requireActual("notistack"),
  useSnackbar: jest.fn().mockReturnValue({
    enqueueSnackbar: jest.fn(),
  }),
}));

const TEST_LAYOUT: LayoutData = {
  layout: "ExamplePanel!1",
  configById: {},
  globalVariables: {},
  userNodes: {},
  playbackConfig: {
    speed: 0.2,
  },
};

function mockThrow(name: string) {
  return () => {
    throw new Error(`Unexpected mock function call ${name}`);
  };
}

function makeMockLayoutManager() {
  return {
    supportsSharing: false,
    supportsSyncing: false,
    isBusy: jest.fn().mockReturnValue(false),
    isOnline: false,
    error: undefined,
    on: jest.fn(),
    off: jest.fn(),
    setError: jest.fn(),
    setOnline: jest.fn(),
    getLayouts: jest.fn(),
    getLayout: jest.fn(),
    saveNewLayout: jest.fn().mockImplementation(mockThrow("saveNewLayout")),
    updateLayout: jest.fn().mockImplementation(mockThrow("updateLayout")),
    deleteLayout: jest.fn().mockImplementation(mockThrow("deleteLayout")),
    overwriteLayout: jest.fn().mockImplementation(mockThrow("overwriteLayout")),
    revertLayout: jest.fn().mockImplementation(mockThrow("revertLayout")),
    makePersonalCopy: jest.fn().mockImplementation(mockThrow("makePersonalCopy")),
    syncWithRemote: jest.fn().mockImplementation(mockThrow("syncWithRemote")),
  };
}
function makeMockUserProfile() {
  return {
    getUserProfile: jest.fn().mockImplementation(mockThrow("getUserProfile")),
    setUserProfile: jest.fn().mockImplementation(mockThrow("setUserProfile")),
  };
}
type MockRemoteLayoutStorage = jest.Mocked<IRemoteLayoutStorage> & {
  getDefaultLayout: jest.MockedFunction<NonNullable<IRemoteLayoutStorage["getDefaultLayout"]>>;
};

function makeMockRemoteLayoutStorage(): MockRemoteLayoutStorage {
  return {
    workspace: "test-workspace",
    getLayouts: jest.fn(),
    getDefaultLayout: jest.fn(),
    getLayout: jest.fn(),
    saveNewLayout: jest.fn(),
    updateLayout: jest.fn(),
    deleteLayout: jest.fn(),
  };
}

function renderTest({
  mockLayoutManager,
  mockUserProfile,
  mockAppParameters = {},
  mockRemoteLayoutStorage,
}: {
  mockLayoutManager: ILayoutManager;
  mockUserProfile: UserProfileStorage;
  mockAppParameters?: Record<string, string>;
  mockRemoteLayoutStorage?: IRemoteLayoutStorage;
}) {
  const childMounted = new Condvar();
  const childMountedWait = childMounted.wait();
  const all: Array<{
    actions: CurrentLayoutActions;
    layoutState: LayoutState;
    childMounted: Promise<void>;
  }> = [];
  const { result } = renderHook(
    () => {
      const value = {
        actions: useCurrentLayoutActions(),
        layoutState: useCurrentLayoutSelector((state) => state),
        childMounted: childMountedWait,
      };
      all.push(value);
      return value;
    },
    {
      wrapper: function Wrapper({ children }) {
        useEffect(() => {
          childMounted.notifyAll();
        }, []);
        return (
          <AppParametersProvider appParameters={mockAppParameters}>
            <SnackbarProvider>
              <RemoteLayoutStorageContext.Provider value={mockRemoteLayoutStorage}>
                <LayoutManagerContext.Provider value={mockLayoutManager}>
                  <UserProfileStorageContext.Provider value={mockUserProfile}>
                    <CurrentLayoutProvider loaders={[]}>
                      {children}
                      <CurrentLayoutSyncAdapter />
                    </CurrentLayoutProvider>
                  </UserProfileStorageContext.Provider>
                </LayoutManagerContext.Provider>
              </RemoteLayoutStorageContext.Provider>
            </SnackbarProvider>
          </AppParametersProvider>
        );
      },
    },
  );
  return { result, all };
}

describe("CurrentLayoutProvider", () => {
  const mockLayoutManager = makeMockLayoutManager();
  const mockUserProfile = makeMockUserProfile();

  beforeEach(() => {
    // Default mocks
    mockLayoutManager.getLayout.mockImplementation(async () => undefined);
    mockLayoutManager.getLayouts.mockImplementation(() => []);
    mockUserProfile.getUserProfile.mockResolvedValue({ currentLayoutId: undefined });
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockClear();
    jest.clearAllMocks();
  });

  it("uses currentLayoutId from UserProfile to load from LayoutStorage", async () => {
    const expectedState: LayoutData = {
      layout: "Foo!bar",
      configById: { "Foo!bar": { setting: 1 } },
      globalVariables: { var: "hello" },
      userNodes: { node1: { name: "node", sourceCode: "node()" } },
      playbackConfig: { speed: 0.1 },
    };
    const condvar = new Condvar();
    const layoutStorageGetCalledWait = condvar.wait();

    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "example",
          name: "Example layout",
          data: { data: expectedState },
          permission: "CREATOR_WRITE",
        },
      ];
    });

    mockLayoutManager.getLayout.mockImplementation(async () => {
      condvar.notifyAll();
      return {
        id: "example",
        name: "Example layout",
        baseline: { updatedAt: new Date(10).toISOString(), data: expectedState },
      };
    });

    mockUserProfile.getUserProfile.mockResolvedValue({ currentLayoutId: "example" });

    const { all } = renderTest({ mockLayoutManager, mockUserProfile });
    await act(async () => {
      await layoutStorageGetCalledWait;
    });

    expect(mockLayoutManager.getLayouts).toHaveBeenCalled();
    expect(all.map((item) => (item instanceof Error ? undefined : item.layoutState))).toEqual([
      { selectedLayout: undefined },
      {
        selectedLayout: {
          loading: false,
          id: "example",
          data: expectedState,
          name: "Example layout",
        },
      },
    ]);
  });

  it("restores the local selection before URL and cloud defaults", async () => {
    const currentLayout = LayoutBuilder.layout({
      id: LayoutBuilder.layoutId("local-layout"),
      name: "Local layout",
    });
    const urlLayout = LayoutBuilder.layout({
      id: LayoutBuilder.layoutId("url-layout"),
      name: "URL layout",
    });
    const mockRemoteLayoutStorage = makeMockRemoteLayoutStorage();
    mockRemoteLayoutStorage.getDefaultLayout.mockResolvedValue(LayoutBuilder.remoteLayout());
    const selected = new Condvar();

    mockLayoutManager.getLayouts.mockResolvedValue([currentLayout, urlLayout]);
    mockLayoutManager.getLayout.mockImplementation(async (id) => {
      if (id === currentLayout.id) {
        selected.notifyAll();
        return currentLayout;
      }
      return undefined;
    });
    mockUserProfile.getUserProfile.mockResolvedValue({
      currentLayoutId: currentLayout.id,
    });

    renderTest({
      mockLayoutManager,
      mockUserProfile,
      mockAppParameters: { defaultLayout: urlLayout.name },
      mockRemoteLayoutStorage,
    });
    await act(async () => {
      await selected.wait();
    });

    expect(mockLayoutManager.getLayout).toHaveBeenCalledWith(currentLayout.id);
    expect(mockRemoteLayoutStorage.getDefaultLayout).not.toHaveBeenCalled();
  });

  it("does not create a layout when the cloud workspace has no default", async () => {
    const mockRemoteLayoutStorage = makeMockRemoteLayoutStorage();
    const requested = new Condvar();
    mockRemoteLayoutStorage.getDefaultLayout.mockImplementation(async () => {
      requested.notifyAll();
      return undefined;
    });

    renderTest({
      mockLayoutManager,
      mockUserProfile,
      mockRemoteLayoutStorage,
    });
    await act(async () => {
      await requested.wait();
    });

    expect(mockLayoutManager.saveNewLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.getLayout).not.toHaveBeenCalled();
  });

  it("selects the cloud default after the same layout id appears in the local cache", async () => {
    const mockRemoteLayoutStorage = makeMockRemoteLayoutStorage();
    const remoteDefault = LayoutBuilder.remoteLayout();
    const cachedDefault = LayoutBuilder.layout({ id: remoteDefault.id });
    const selected = new Condvar();
    mockRemoteLayoutStorage.getDefaultLayout.mockResolvedValue(remoteDefault);
    mockUserProfile.setUserProfile.mockResolvedValue(undefined);
    mockLayoutManager.getLayouts
      .mockResolvedValueOnce([])
      .mockResolvedValue([cachedDefault]);
    mockLayoutManager.getLayout.mockImplementation(async (id) => {
      if (id === cachedDefault.id) {
        selected.notifyAll();
        return cachedDefault;
      }
      return undefined;
    });

    const { all } = renderTest({
      mockLayoutManager,
      mockUserProfile,
      mockRemoteLayoutStorage,
    });
    await act(async () => {
      await selected.wait();
    });

    await waitFor(() => {
      expect(all.at(-1)?.layoutState.selectedLayout?.id).toBe(remoteDefault.id);
    });
    expect(mockLayoutManager.saveNewLayout).not.toHaveBeenCalled();
  });

  it("refuses to load an incompatible layout", async () => {
    const expectedState: LayoutData = {
      layout: "Foo!bar",
      configById: { "Foo!bar": { setting: 1 } },
      globalVariables: { var: "hello" },
      userNodes: { node1: { name: "node", sourceCode: "node()" } },
      playbackConfig: { speed: 0.1 },
      version: MAX_SUPPORTED_LAYOUT_VERSION + 1,
    };

    const condvar = new Condvar();
    const layoutStorageGetCalledWait = condvar.wait();

    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "example",
          name: "Example layout",
          data: { data: expectedState },
          permission: "CREATOR_WRITE",
        },
      ];
    });

    mockLayoutManager.getLayout.mockImplementation(async () => {
      condvar.notifyAll();
      return {
        id: "example",
        name: "Example layout",
        baseline: { updatedAt: new Date(10).toISOString(), data: expectedState },
      };
    });

    mockUserProfile.getUserProfile.mockResolvedValue({ currentLayoutId: "example" });

    const { all } = renderTest({ mockLayoutManager, mockUserProfile });
    await act(async () => {
      await layoutStorageGetCalledWait;
    });

    expect(mockLayoutManager.getLayouts).toHaveBeenCalled();
    expect(all.map((item) => (item instanceof Error ? undefined : item.layoutState))).toEqual([
      { selectedLayout: undefined },
      { selectedLayout: undefined },
    ]);
  });

  it("keeps identity of action functions when modifying layout", async () => {
    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "example",
          name: "Test layout",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
      ];
    });

    mockLayoutManager.updateLayout.mockImplementation(async () => {
      return {
        id: "example",
        name: "Test layout",
        baseline: { data: TEST_LAYOUT, updatedAt: new Date(10).toISOString() },
      };
    });
    mockUserProfile.getUserProfile.mockResolvedValue({ currentLayoutId: "example" });

    const { result } = renderTest({
      mockLayoutManager,
      mockUserProfile,
    });
    await act(async () => {
      await result.current.childMounted;
    });
    const actions = result.current.actions;
    expect(result.current.actions).toBe(actions);
    act(() => {
      result.current.actions.savePanelConfigs({
        configs: [{ id: "ExamplePanel!1", config: { foo: "bar" } }],
      });
    });

    expect(result.current.actions.savePanelConfigs).toBe(actions.savePanelConfigs);
  });

  it("applies ADD_PANELS_ATOMIC as a single edited commit without changing the selection", async () => {
    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "example",
          name: "Test layout",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
      ];
    });
    mockLayoutManager.getLayout.mockImplementation(async () => ({
      id: "example",
      name: "Test layout",
      baseline: { data: TEST_LAYOUT, updatedAt: new Date(10).toISOString() },
      working: undefined,
    }));
    mockUserProfile.getUserProfile.mockResolvedValue({ currentLayoutId: "example" });

    const { result } = renderTest({ mockLayoutManager, mockUserProfile });
    await act(async () => {
      await result.current.childMounted;
    });
    await waitFor(() => {
      expect(result.current.layoutState.selectedLayout?.loading).toBe(false);
    });

    await act(async () => {
      result.current.actions.addPanelsAtomically({
        layout: {
          direction: "row",
          first: "ExamplePanel!1",
          second: "Gauge!battery",
          splitPercentage: 60,
        },
        configs: { "Gauge!battery": { path: "/battery", minValue: 0, maxValue: 100 } },
      });
    });

    // One edited commit: layout and new configs land together, selection id and name unchanged.
    expect(result.current.layoutState.selectedLayout).toEqual({
      id: "example",
      name: "Test layout",
      edited: true,
      data: {
        ...TEST_LAYOUT,
        layout: {
          direction: "row",
          first: "ExamplePanel!1",
          second: "Gauge!battery",
          splitPercentage: 60,
        },
        configById: { "Gauge!battery": { path: "/battery", minValue: 0, maxValue: 100 } },
      },
    });
  });

  it("selects the first layout in alphabetic order, when there is no selected layout", async () => {
    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "layout1",
          name: "LAYOUT 1",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
        {
          id: "layout2",
          name: "ABC Layout 2",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
      ];
    });

    const { result, all } = renderTest({
      mockLayoutManager,
      mockUserProfile,
    });

    await act(async () => {
      await result.current.childMounted;
    });

    const selectedLayout = all.find((item) => item.layoutState.selectedLayout?.id)?.layoutState
      .selectedLayout?.id;

    expect(selectedLayout).toBeDefined();
    expect(selectedLayout).toBe("layout2");
  });

  it("selects the first org layout, when current layout is not found", async () => {
    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "layout1",
          name: "LAYOUT 1",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
        {
          id: "layout2",
          name: "ORG Layout 2",
          data: { data: TEST_LAYOUT },
          permission: "ORG_READ",
        },
      ];
    });
    mockUserProfile.getUserProfile.mockResolvedValue({ currentLayoutId: "nonexistent" });

    const { result, all } = renderTest({
      mockLayoutManager,
      mockUserProfile,
    });

    await act(async () => {
      await result.current.childMounted;
    });

    const selectedLayout = all.find((item) => item.layoutState.selectedLayout?.id)?.layoutState
      .selectedLayout?.id;

    expect(selectedLayout).toBeDefined();
    expect(selectedLayout).toBe("layout2");
  });

  it("selects the first org layout, if any, in alphabetic order, when there is no selected layout", async () => {
    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "layout1",
          name: "ABC Layout 1",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
        {
          id: "layout2",
          name: "DEF Layout 2",
          data: { data: TEST_LAYOUT },
          permission: "ORG_READ",
        },
        {
          id: "layout3",
          name: "ABC Layout 3",
          data: { data: TEST_LAYOUT },
          permission: "ORG_READ",
        },
      ];
    });

    const { result, all } = renderTest({
      mockLayoutManager,
      mockUserProfile,
    });

    await act(async () => {
      await result.current.childMounted;
    });

    const selectedLayout = all.find((item) => item.layoutState.selectedLayout?.id)?.layoutState
      .selectedLayout?.id;

    expect(selectedLayout).toBeDefined();
    expect(selectedLayout).toBe("layout3");
  });

  it("select a layout through app parameters", async () => {
    const mockAppParameters = { defaultLayout: "LAYOUT 2" };
    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "layout1",
          name: "LAYOUT 1",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
        {
          id: "layout2",
          name: "LAYOUT 2",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
        {
          id: "layout3",
          name: "ABC Layout 3",
          data: { data: TEST_LAYOUT },
          permission: "ORG_READ",
        },
      ];
    });

    const { result, all } = renderTest({
      mockLayoutManager,
      mockUserProfile,
      mockAppParameters,
    });

    await act(async () => {
      await result.current.childMounted;
    });

    const selectedLayout = all.find((item) => item.layoutState.selectedLayout?.id)?.layoutState
      .selectedLayout?.id;

    expect(selectedLayout).toBeDefined();
    expect(selectedLayout).toBe("layout2");
    // A ?layout= override is session-only and must not be persisted to the user profile.
    expect(mockUserProfile.setUserProfile).not.toHaveBeenCalled();
  });

  it("prefers the organizational layout when the app parameter name matches multiple layouts", async () => {
    const mockAppParameters = { defaultLayout: "SHARED LAYOUT" };
    mockLayoutManager.getLayouts.mockImplementation(async () => {
      return [
        {
          id: "personal",
          name: "SHARED LAYOUT",
          data: { data: TEST_LAYOUT },
          permission: "CREATOR_WRITE",
        },
        {
          id: "org",
          name: "SHARED LAYOUT",
          data: { data: TEST_LAYOUT },
          permission: "ORG_READ",
        },
      ];
    });

    const { result, all } = renderTest({
      mockLayoutManager,
      mockUserProfile,
      mockAppParameters,
    });

    await act(async () => {
      await result.current.childMounted;
    });

    const selectedLayout = all.find((item) => item.layoutState.selectedLayout?.id)?.layoutState
      .selectedLayout?.id;

    expect(selectedLayout).toBe("org");
  });

  it("should show a message to the user if the defaultLayout from app parameter is not found", async () => {
    const mockAppParameters = { defaultLayout: BasicBuilder.string() };

    const { result } = renderTest({
      mockLayoutManager,
      mockUserProfile,
      mockAppParameters,
    });

    await act(async () => {
      await result.current.childMounted;
    });

    const { enqueueSnackbar } = useSnackbar();

    expect(enqueueSnackbar).toHaveBeenCalledWith(
      `The layout '${mockAppParameters.defaultLayout}' specified in the app parameters does not exist.`,
      { variant: "warning" },
    );
  });

  describe("selection races", () => {
    const layoutA: LayoutData = {
      layout: "Plot!a",
      configById: { "Plot!a": { paths: [] } },
      globalVariables: {},
      userNodes: {},
      playbackConfig: { speed: 0.2 },
    };
    const layoutB: LayoutData = {
      layout: "Plot!b",
      configById: { "Plot!b": { paths: [] } },
      globalVariables: {},
      userNodes: {},
      playbackConfig: { speed: 0.3 },
    };
    const layoutX: LayoutData = {
      layout: "Plot!x",
      configById: { "Plot!x": { paths: [] } },
      globalVariables: {},
      userNodes: {},
      playbackConfig: { speed: 0.1 },
    };
    const layoutAResponse = {
      id: "a" as LayoutID,
      name: "Layout A",
      baseline: { updatedAt: new Date(10).toISOString(), data: layoutA },
    };
    const layoutBResponse = {
      id: "b" as LayoutID,
      name: "Layout B",
      baseline: { updatedAt: new Date(11).toISOString(), data: layoutB },
    };
    const layoutXResponse = {
      id: "x" as LayoutID,
      name: "Layout X",
      baseline: { updatedAt: new Date(9).toISOString(), data: layoutX },
    };

    it("keeps only the newest selection when switch requests resolve out of order", async () => {
      let resolveA!: (value: unknown) => void;
      const gateA = new Promise((resolve) => {
        resolveA = resolve;
      });
      // A 的 getLayout 挂起；B 立即返回。
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => await gateA)
        .mockImplementationOnce(async () => layoutBResponse);

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
        // A 最后才返回：代际已过期，其数据不得落地。
        resolveA(layoutAResponse);
      });

      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "b",
          data: layoutB,
          name: "Layout B",
        });
      });
    });

    it("does not show an error when a superseded selection fails", async () => {
      let rejectA!: (reason: Error) => void;
      const gateA = new Promise((_, reject) => {
        rejectA = reject;
      });
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => await gateA)
        .mockImplementationOnce(async () => layoutBResponse);

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });
      const { enqueueSnackbar } = useSnackbar();

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
        // 过期请求的失败不产生错误提示。
        rejectA(new Error("stale failure"));
      });

      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "b",
          data: layoutB,
          name: "Layout B",
        });
      });
      expect(enqueueSnackbar).not.toHaveBeenCalledWith(
        expect.stringContaining("could not be loaded"),
        expect.anything(),
      );
    });

    it("restores the previous layout when loading the target layout fails", async () => {
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => layoutAResponse)
        .mockImplementationOnce(async () => {
          throw new Error("load failed");
        });

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });
      const { enqueueSnackbar } = useSnackbar();

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
      });
      // 先等 A 完整落地（成为可恢复快照），再切换到会失败的 B。
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "a",
          data: layoutA,
          name: "Layout A",
        });
      });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
      });

      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "a",
          data: layoutA,
          name: "Layout A",
        });
      });
      expect(enqueueSnackbar).toHaveBeenCalledWith(
        expect.stringContaining("could not be loaded"),
        { variant: "error" },
      );
    });

    it("clears the selection when the first load is superseded by a failed switch", async () => {
      // 首次加载 A 挂起时切 B，B 失败：无可恢复快照（A 从未带数据落地）→
      // 恢复为 selectedLayout: undefined，而不是残留 {id:A, data:undefined, loading:false}。
      let resolveA!: (value: unknown) => void;
      const gateA = new Promise((resolve) => {
        resolveA = resolve;
      });
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => await gateA)
        .mockImplementationOnce(async () => {
          throw new Error("B load failed");
        });

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
      });

      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toBeUndefined();
      });

      // A 随后返回也因代际过期被丢弃，不产生任何残留状态。
      await act(async () => {
        resolveA(layoutAResponse);
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toBeUndefined();
      });
    });

    it("keeps the previous layout (id+data paired) without a data:undefined intermediate state", async () => {
      let resolveB!: (value: unknown) => void;
      const gateB = new Promise((resolve) => {
        resolveB = resolve;
      });
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => layoutAResponse)
        .mockImplementationOnce(async () => await gateB);

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "a",
          data: layoutA,
          name: "Layout A",
        });
      });

      await act(async () => {
        // B 加载挂起：切换中间态保留完整旧 layout，仅追加 loading 标记。
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
      });
      expect(result.current.actions.getCurrentLayoutState().selectedLayout).toEqual({
        id: "a",
        data: layoutA,
        name: "Layout A",
        loading: true,
      });

      await act(async () => {
        resolveB(layoutBResponse);
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "b",
          data: layoutB,
          name: "Layout B",
        });
      });
    });

    it("serializes profile writes so a stale write never overwrites the newest selection", async () => {
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => layoutAResponse)
        .mockImplementationOnce(async () => layoutBResponse);

      // setUserProfile 返回可控 Promise：A 的写入挂起，直到 B 已入队后才落定。
      const pendingProfileWrites: Array<{ resolve: () => void }> = [];
      mockUserProfile.setUserProfile.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          pendingProfileWrites.push({ resolve });
        });
      });

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
      });
      // A 加载完成且代际仍为当前：其 profile 写入已排队执行（挂起中）。
      await waitFor(() => {
        expect(mockUserProfile.setUserProfile).toHaveBeenCalledWith({
          currentLayoutId: "a",
        });
      });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "b",
          data: layoutB,
          name: "Layout B",
        });
      });
      // B 的写入串行排在 A 之后，A 未落定前不会开始。
      expect(mockUserProfile.setUserProfile).toHaveBeenCalledTimes(1);

      // A 的写入最后才落定；B 的写入随后执行并成为最终 profile 值。
      await act(async () => {
        pendingProfileWrites[0]?.resolve();
      });
      await waitFor(() => {
        expect(mockUserProfile.setUserProfile).toHaveBeenCalledTimes(2);
        expect(mockUserProfile.setUserProfile).toHaveBeenLastCalledWith({
          currentLayoutId: "b",
        });
      });
    });

    it("persists the restored layout when a superseded selection fails after an earlier write", async () => {
      // X 写入挂起 → A 成功入队 → B 失败恢复 A → 释放 X → 最终 profile 值为 A。
      // 队列顺序保证 X 先落地、A 后落地；不得因代际把 A 的排队写入淘汰。
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => layoutXResponse)
        .mockImplementationOnce(async () => layoutAResponse)
        .mockImplementationOnce(async () => {
          throw new Error("B load failed");
        });

      const pendingProfileWrites: Array<{ resolve: () => void }> = [];
      mockUserProfile.setUserProfile.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          pendingProfileWrites.push({ resolve });
        });
      });

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("x" as LayoutID);
      });
      // X 的写入已排队执行（挂起中）。
      await waitFor(() => {
        expect(mockUserProfile.setUserProfile).toHaveBeenCalledWith({
          currentLayoutId: "x",
        });
      });

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "a",
          data: layoutA,
          name: "Layout A",
        });
      });

      // B 失败：恢复 A 为最终选中布局；B 不产生任何 profile 写入。
      await act(async () => {
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "a",
          data: layoutA,
          name: "Layout A",
        });
      });

      // 释放 X 的挂起写入；串行队列随后执行 A 的写入，最终 profile 值为 A。
      await act(async () => {
        pendingProfileWrites[0]?.resolve();
      });
      await waitFor(() => {
        expect(mockUserProfile.setUserProfile).toHaveBeenCalledTimes(2);
        expect(mockUserProfile.setUserProfile).toHaveBeenLastCalledWith({
          currentLayoutId: "a",
        });
      });
    });

    it("does not surface a profile-write failure when a newer selection succeeds", async () => {
      // A 的写入失败发生在 B pending 期间；B 随后成功取代 A → A 的保存失败被丢弃，不提示。
      let resolveB!: (value: unknown) => void;
      const gateB = new Promise((resolve) => {
        resolveB = resolve;
      });
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => layoutAResponse)
        .mockImplementationOnce(async () => await gateB);

      const pendingProfileWrites: Array<{ reject: (error: Error) => void }> = [];
      mockUserProfile.setUserProfile.mockImplementation(async () => {
        await new Promise<void>((_, reject) => {
          pendingProfileWrites.push({ reject });
        });
      });

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });
      const { enqueueSnackbar } = useSnackbar();

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
      });
      await waitFor(() => {
        expect(mockUserProfile.setUserProfile).toHaveBeenCalledWith({
          currentLayoutId: "a",
        });
      });

      // B 开始加载（挂起）；此时 A 的写入失败 → 暂存，等待 B 的请求结束后再决定。
      await act(async () => {
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
        pendingProfileWrites[0]?.reject(new Error("profile save failed"));
      });

      // B 成功 → 最终选中为 B → A 的保存失败不提示。
      await act(async () => {
        resolveB(layoutBResponse);
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "b",
          data: layoutB,
          name: "Layout B",
        });
      });
      expect(enqueueSnackbar).not.toHaveBeenCalledWith(
        expect.stringContaining("could not be saved"),
        expect.anything(),
      );
    });

    it("surfaces a profile-write failure when the superseding selection fails and the old layout is restored", async () => {
      // A 的写入失败发生在 B pending 期间；B 失败恢复 A → A 成为最终布局 → 提示 A 的保存失败。
      let rejectB!: (reason: Error) => void;
      const gateB = new Promise((_, reject) => {
        rejectB = reject;
      });
      mockLayoutManager.getLayout
        .mockImplementationOnce(async () => layoutAResponse)
        .mockImplementationOnce(async () => await gateB);

      const pendingProfileWrites: Array<{ reject: (error: Error) => void }> = [];
      mockUserProfile.setUserProfile.mockImplementation(async () => {
        await new Promise<void>((_, reject) => {
          pendingProfileWrites.push({ reject });
        });
      });

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });
      const { enqueueSnackbar } = useSnackbar();

      await act(async () => {
        result.current.actions.setSelectedLayoutId("a" as LayoutID);
      });
      await waitFor(() => {
        expect(mockUserProfile.setUserProfile).toHaveBeenCalledWith({
          currentLayoutId: "a",
        });
      });

      // B 开始加载（挂起）；此时 A 的写入失败 → 暂存。
      await act(async () => {
        result.current.actions.setSelectedLayoutId("b" as LayoutID);
        pendingProfileWrites[0]?.reject(new Error("profile save failed"));
      });

      // B 失败 → 恢复 A（loading: false）→ 按最终选中 id（A）提示保存失败。
      await act(async () => {
        rejectB(new Error("B load failed"));
      });
      await waitFor(() => {
        expect(result.current.layoutState.selectedLayout).toEqual({
          loading: false,
          id: "a",
          data: layoutA,
          name: "Layout A",
        });
      });
      expect(enqueueSnackbar).toHaveBeenCalledWith(
        expect.stringContaining("could not be saved"),
        { variant: "error" },
      );
    });
  });

  describe("Default layout logic", () => {
    function mockBusyTimes(times: number) {
      Array.from({ length: times }).forEach(() => {
        mockLayoutManager.isBusy.mockReturnValueOnce(true);
      });
      mockLayoutManager.isBusy.mockReturnValue(false);
    }

    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      jest.useRealTimers();
      (console.warn as jest.Mock).mockRestore();
    });

    it("should resolve immediately if layoutManager is not busy", async () => {
      // Given/When
      mockLayoutManager.isBusy.mockReturnValue(false);

      const { result } = renderTest({ mockLayoutManager, mockUserProfile });

      await act(async () => {
        await result.current.childMounted;
      });

      // Then
      expect(mockLayoutManager.isBusy).toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(mockLayoutManager.getLayouts).toHaveBeenCalled();
    });

    it("should poll until layoutManager is not busy", async () => {
      // Given/When
      const busyCount = 3;
      mockBusyTimes(busyCount);

      const { result } = renderTest({
        mockLayoutManager,
        mockUserProfile,
      });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(busyCount * BUSY_POLLING_INTERVAL_MS);
        await result.current.childMounted;
      });

      // Then
      expect(mockLayoutManager.isBusy).toHaveBeenCalledTimes(4);
      expect(console.warn).not.toHaveBeenCalled();
      expect(mockLayoutManager.getLayouts).toHaveBeenCalled();
    });

    it("should timeout after 5 seconds, log warning and continue as normal", async () => {
      mockLayoutManager.isBusy.mockReturnValue(true); // Always busy

      const { result } = renderTest({
        mockLayoutManager,
        mockUserProfile,
      });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(BUSY_POLLING_TIMEOUT_MS + 100);
        await result.current.childMounted;
      });

      expect(console.warn).toHaveBeenCalledWith(
        `CurrentLayoutProvider: timeout after ${BUSY_POLLING_TIMEOUT_MS}ms, continuing anyway`,
      );
      expect(mockLayoutManager.getLayouts).toHaveBeenCalled();
    });
  });

  describe("Fallback Default layout creation", () => {
    it("creates a personal Default layout when no layouts exist", async () => {
      // Given a layout manager with no existing layouts and a user profile without a selection
      const localOnlyManager = makeMockLayoutManager();
      localOnlyManager.getLayouts.mockResolvedValue([]);
      localOnlyManager.saveNewLayout.mockResolvedValue({
        id: "new-default",
        name: "Default",
        baseline: { data: TEST_LAYOUT, updatedAt: new Date(10).toISOString() },
      });
      mockUserProfile.getUserProfile.mockResolvedValue({ currentLayoutId: undefined });

      // When the provider initializes
      const { result } = renderTest({ mockLayoutManager: localOnlyManager, mockUserProfile });
      await act(async () => {
        await result.current.childMounted;
      });

      // Then a personal Default layout is created
      expect(localOnlyManager.saveNewLayout).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Default", permission: "CREATOR_WRITE" }),
      );
    });
  });
});
