// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import { useSnackbar } from "notistack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getNodeAtPath } from "react-mosaic-component";
import { useAsync, useAsyncFn, useMountedState } from "react-use";
import shallowequal from "shallowequal";
import { v4 as uuidv4 } from "uuid";

import { useShallowMemo } from "@lichtblick/hooks";
import Logger from "@lichtblick/log";
import { VariableValue } from "@lichtblick/suite";
import { useAnalytics } from "@lichtblick/suite-base/context/AnalyticsContext";
import { useAppParameters } from "@lichtblick/suite-base/context/AppParametersContext";
import CurrentLayoutContext, {
  ICurrentLayout,
  LayoutID,
  LayoutState,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import {
  AddPanelPayload,
  AddPanelsAtomicallyPayload,
  ChangePanelLayoutPayload,
  ClosePanelPayload,
  CreateTabPanelPayload,
  DropPanelPayload,
  EndDragPayload,
  MoveTabPayload,
  PanelsActions,
  SaveConfigsPayload,
  SplitPanelPayload,
  StartDragPayload,
  SwapPanelPayload,
} from "@lichtblick/suite-base/context/CurrentLayoutContext/actions";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import { useRemoteLayoutStorage } from "@lichtblick/suite-base/context/RemoteLayoutStorageContext";
import { useUserProfileStorage } from "@lichtblick/suite-base/context/UserProfileStorageContext";
import {
  BUSY_POLLING_INTERVAL_MS,
  BUSY_POLLING_TIMEOUT_MS,
  DEFAULT_LAYOUT,
  MAX_SUPPORTED_LAYOUT_VERSION,
  ORG_PERMISSION_PREFIX,
} from "@lichtblick/suite-base/providers/CurrentLayoutProvider/constants";
import { hasInjectedDefaultLayout } from "@lichtblick/suite-base/providers/CurrentLayoutProvider/defaultLayout";
import useUpdateSharedPanelState from "@lichtblick/suite-base/providers/CurrentLayoutProvider/hooks/useUpdateSharedPanelState";
import { loadDefaultLayouts } from "@lichtblick/suite-base/providers/CurrentLayoutProvider/loadDefaultLayouts";
import panelsReducer from "@lichtblick/suite-base/providers/CurrentLayoutProvider/reducers";
import { selectCloudDefaultLayout } from "@lichtblick/suite-base/providers/CurrentLayoutProvider/selectCloudDefaultLayout";
import { AppEvent } from "@lichtblick/suite-base/services/IAnalytics";
import { LayoutLoader } from "@lichtblick/suite-base/services/ILayoutLoader";
import { LayoutManagerEventTypes } from "@lichtblick/suite-base/services/ILayoutManager";
import { PanelConfig, PlaybackConfig, UserScripts } from "@lichtblick/suite-base/types/panels";
import { windowAppURLState } from "@lichtblick/suite-base/util/appURLState";
import { getPanelTypeFromId } from "@lichtblick/suite-base/util/layout";

import { IncompatibleLayoutVersionAlert } from "./IncompatibleLayoutVersionAlert";

const log = Logger.getLogger(__filename);

/**
 * Concrete implementation of CurrentLayoutContext.Provider which handles
 * automatically restoring the current layout from LayoutStorage.
 */
export default function CurrentLayoutProvider({
  children,
  loaders = [],
}: React.PropsWithChildren<{
  loaders?: readonly LayoutLoader[];
}>): React.JSX.Element {
  const { enqueueSnackbar } = useSnackbar();
  const { getUserProfile, setUserProfile } = useUserProfileStorage();
  const layoutManager = useLayoutManager();
  const remoteLayoutStorage = useRemoteLayoutStorage();
  const analytics = useAnalytics();
  const isMounted = useMountedState();

  const { t } = useTranslation("general");

  const appParameters = useAppParameters();
  const initialLayoutLoadStarted = useRef(false);

  // Monotonic selection generation; see setSelectedLayoutId below.
  const selectionGeneration = useRef(0);

  // Serialized profile-write queue: writes land strictly in selection order. Requests already
  // stale when getLayout returns are dropped before enqueueing, so every enqueued write lands;
  // there is no execution-time generation re-check (see writeCurrentLayoutIdToProfile).
  const profileWriteQueue = useRef<Promise<void>>(Promise.resolve());

  // A profile-write failure is stashed until the current layout request settles: deciding at
  // failure time would misjudge when the failure lands during a pending switch (e.g. A's write
  // fails while B is loading — A looks selected, but B may supersede it).
  const pendingProfileWriteError = useRef<{ id: LayoutID; error: unknown } | undefined>(undefined);
  const flushProfileWriteError = useCallback(() => {
    const pending = pendingProfileWriteError.current;
    if (pending == undefined) {
      return;
    }
    const selected = layoutStateRef.current.selectedLayout;
    if (selected?.loading === true) {
      // 当前 layout 请求尚未结束：等 settle 后再按最终选中 id 决定提示或丢弃。
      return;
    }
    pendingProfileWriteError.current = undefined;
    if (selected?.id !== pending.id) {
      // 已被更新的选择取代：丢弃，不提示。
      return;
    }
    console.error(pending.error);
    enqueueSnackbar(
      `The current layout could not be saved. ${(pending.error as Error).toString()}`,
      {
        variant: "error",
      },
    );
  }, [enqueueSnackbar]);

  const writeCurrentLayoutIdToProfile = useCallback(
    (id: LayoutID) => {
      // 队列顺序即选择顺序：先入队的写入先落地。getLayout 返回前已过期的请求会在 continuation
      // 整体被丢弃（不入队），因此已入队的成功选择写入一律按顺序落地，不做执行时代际淘汰——
      // 否则“切换 B 失败恢复 A”场景会把 A 的排队写入一并淘汰（B 又不写），
      // 造成 UI 是 A 而持久化仍停留在更早的值。
      profileWriteQueue.current = profileWriteQueue.current
        .then(async () => {
          await setUserProfile({ currentLayoutId: id });
        })
        .catch((error: unknown) => {
          // 失败先暂存：A 写入失败发生在 B pending 期间时，等当前 layout 请求结束后
          // 按最终选中 id 决定提示或丢弃（A 成为最终布局时不静默吞错，B 成功取代则不提示）。
          pendingProfileWriteError.current = { id, error };
          flushProfileWriteError();
        });
    },
    [flushProfileWriteError, setUserProfile],
  );

  const [mosaicId] = useState(() => uuidv4());

  const layoutStateListeners = useRef(new Set<(_: LayoutState) => void>());
  const addLayoutStateListener = useCallback((listener: (_: LayoutState) => void) => {
    layoutStateListeners.current.add(listener);
  }, []);
  const removeLayoutStateListener = useCallback((listener: (_: LayoutState) => void) => {
    layoutStateListeners.current.delete(listener);
  }, []);

  const [layoutState, setLayoutStateInternal] = useState<LayoutState>({
    selectedLayout: undefined,
  });
  const layoutStateRef = useRef(layoutState);
  const [incompatibleLayoutVersionError, setIncompatibleLayoutVersionError] = useState(false);
  const setLayoutState = useCallback((newState: LayoutState) => {
    const layoutVersion = newState.selectedLayout?.data?.version;
    if (layoutVersion != undefined && layoutVersion > MAX_SUPPORTED_LAYOUT_VERSION) {
      setIncompatibleLayoutVersionError(true);
      setLayoutStateInternal({ selectedLayout: undefined });
      return;
    }

    setLayoutStateInternal(newState);

    // listeners rely on being able to getCurrentLayoutState() inside effects that may run before we re-render
    layoutStateRef.current = newState;

    for (const listener of [...layoutStateListeners.current]) {
      listener(newState);
    }
  }, []);

  const selectedPanelIds = useRef<readonly string[]>([]);
  const selectedPanelIdsListeners = useRef(new Set<(_: readonly string[]) => void>());
  const addSelectedPanelIdsListener = useCallback((listener: (_: readonly string[]) => void) => {
    selectedPanelIdsListeners.current.add(listener);
  }, []);
  const removeSelectedPanelIdsListener = useCallback((listener: (_: readonly string[]) => void) => {
    selectedPanelIdsListeners.current.delete(listener);
  }, []);

  const getSelectedPanelIds = useCallback(() => selectedPanelIds.current, []);
  const setSelectedPanelIds = useCallback(
    (value: readonly string[] | ((prevState: readonly string[]) => readonly string[])): void => {
      const newValue = typeof value === "function" ? value(selectedPanelIds.current) : value;
      if (!shallowequal(newValue, selectedPanelIds.current)) {
        selectedPanelIds.current = newValue;
        for (const listener of [...selectedPanelIdsListeners.current]) {
          listener(selectedPanelIds.current);
        }
      }
    },
    [],
  );

  const [, setSelectedLayoutId] = useAsyncFn(
    async (
      id: LayoutID | undefined,
      { saveToProfile = true }: { saveToProfile?: boolean } = {},
    ) => {
      // Selection generation: every call invalidates all in-flight async side effects of earlier
      // selections (layout state commits, profile writes, version alerts, snackbars, failures).
      const generation = ++selectionGeneration.current;
      if (id == undefined) {
        setLayoutState({ selectedLayout: undefined });
        flushProfileWriteError();
        return;
      }
      // 切换期间保留完整的旧 selectedLayout 对象（旧 id+data 成对不拆），仅追加 loading 标记；
      // 绝不组合“新 id + 旧 data”（CurrentLayoutLocalStorageSyncAdapter 等消费者要求
      // id/data 始终对应）。仅首次加载（无旧 layout）允许 data: undefined。
      // 仅把 data != undefined 的最后成功布局作为可恢复快照：无快照时失败恢复为 undefined，
      // 避免残留 {id, data: undefined, loading: false}。
      const previousSelectedLayout = layoutStateRef.current.selectedLayout;
      const recoverableLayout =
        previousSelectedLayout?.data != undefined ? previousSelectedLayout : undefined;
      try {
        setLayoutState({
          selectedLayout:
            recoverableLayout == undefined
              ? { id, loading: true, data: undefined }
              : { ...recoverableLayout, loading: true },
        });
        const layout = await layoutManager.getLayout(id);
        if (generation !== selectionGeneration.current) {
          // 过期请求：丢弃所有异步副作用，不落地任何状态。
          return;
        }
        const layoutVersion = layout?.baseline.data.version;
        if (layoutVersion != undefined && layoutVersion > MAX_SUPPORTED_LAYOUT_VERSION) {
          setIncompatibleLayoutVersionError(true);
          setLayoutState({ selectedLayout: undefined });
          flushProfileWriteError();
          return;
        }
        if (!isMounted()) {
          return;
        }
        setIncompatibleLayoutVersionError(false);
        if (layout == undefined) {
          // 目标 layout 不存在：恢复旧 layout（若有）并结束 loading。
          setLayoutState(
            recoverableLayout == undefined
              ? { selectedLayout: undefined }
              : { selectedLayout: { ...recoverableLayout, loading: false } },
          );
          flushProfileWriteError();
        } else {
          // 新 layout 数据取到后一次性原子替换整个对象。
          setLayoutState({
            selectedLayout: {
              loading: false,
              id: layout.id,
              data: layout.working?.data ?? layout.baseline.data,
              name: layout.name,
            },
          });
          flushProfileWriteError();
          if (saveToProfile) {
            // 串行化 profile 写入：入队即按顺序落地（见 writeCurrentLayoutIdToProfile）。
            writeCurrentLayoutIdToProfile(id);
          }
        }
      } catch (error) {
        if (generation !== selectionGeneration.current) {
          // 过期请求的失败不弹错误。
          return;
        }
        console.error(error);
        enqueueSnackbar(`The layout could not be loaded. ${error.toString()}`, {
          variant: "error",
        });
        setIncompatibleLayoutVersionError(false);
        // 目标加载失败：旧 layout 完整恢复并结束 loading；无快照时清空选择。
        setLayoutState(
          recoverableLayout == undefined
            ? { selectedLayout: undefined }
            : { selectedLayout: { ...recoverableLayout, loading: false } },
        );
        flushProfileWriteError();
      }
    },
    [
      enqueueSnackbar,
      flushProfileWriteError,
      isMounted,
      layoutManager,
      setLayoutState,
      writeCurrentLayoutIdToProfile,
    ],
  );

  const performAction = useCallback(
    (action: PanelsActions) => {
      if (
        layoutStateRef.current.selectedLayout?.data == undefined ||
        layoutStateRef.current.selectedLayout.loading === true
      ) {
        return;
      }
      const oldData = layoutStateRef.current.selectedLayout.data;
      const newData = panelsReducer(oldData, action);

      // The panel state did not change, so no need to perform layout state
      // updates or layout manager updates.
      if (_.isEqual(oldData, newData)) {
        log.warn("Panel action resulted in identical config:", action);
        return;
      }

      // Get all the panel types that exist in the new config
      const panelTypesInUse = [...new Set(Object.keys(newData.configById).map(getPanelTypeFromId))];

      setLayoutState({
        // discared shared panel state for panel types that are no longer in the layout
        sharedPanelState: _.pick(layoutStateRef.current.sharedPanelState, panelTypesInUse),
        selectedLayout: {
          id: layoutStateRef.current.selectedLayout.id,
          data: newData,
          name: layoutStateRef.current.selectedLayout.name,
          edited: true,
        },
      });
    },
    [setLayoutState],
  );

  /**
   * Changes to the layout storage from external user actions need to trigger setLayoutState.
   * Before it was beeing trigged on every change. Now it is triggered only when the layout
   * is reverted, otherize it has some toggling issues when resizing panels.
   */
  useEffect(() => {
    const listener: LayoutManagerEventTypes["change"] = (event) => {
      const { updatedLayout } = event;
      if (
        event.type === "revert" &&
        updatedLayout &&
        updatedLayout.id === layoutStateRef.current.selectedLayout?.id
      ) {
        setLayoutState({
          selectedLayout: {
            loading: false,
            id: updatedLayout.id,
            data: updatedLayout.working?.data ?? updatedLayout.baseline.data,
            name: updatedLayout.name,
          },
        });
      }
    };
    layoutManager.on("change", listener);
    return () => {
      layoutManager.off("change", listener);
    };
  }, [layoutManager, setLayoutState]);

  // Make sure our layout still exists after changes. If not deselect it.
  useEffect(() => {
    const listener: LayoutManagerEventTypes["change"] = async (event) => {
      if (event.type !== "delete" || !layoutStateRef.current.selectedLayout?.id) {
        return;
      }

      if (event.layoutId === layoutStateRef.current.selectedLayout.id) {
        const layouts = await layoutManager.getLayouts();
        await setSelectedLayoutId(layouts[0]?.id);
      }
    };

    layoutManager.on("change", listener);
    return () => {
      layoutManager.off("change", listener);
    };
  }, [enqueueSnackbar, layoutManager, setSelectedLayoutId]);

  // Load initial state by re-selecting the last selected layout from the UserProfile.
  useAsync(async () => {
    if (initialLayoutLoadStarted.current) {
      return;
    }
    initialLayoutLoadStarted.current = true;

    // Don't restore the layout if there's one specified in the app state url.
    if (windowAppURLState()?.layoutId) {
      return;
    }

    // For some reason, this needs to go before the setSelectedLayoutId, probably some initialization
    const { currentLayoutId } = await getUserProfile();

    // Try to load default layouts, before checking to add the fallback "Default".
    await loadDefaultLayouts(layoutManager, loaders);

    // Wait for layout manager to finish any ongoing operations (e.g. fetching remote layouts)
    if (layoutManager.isBusy()) {
      await new Promise<void>((resolve) => {
        const startTime = Date.now();

        const checkBusy = () => {
          const elapsed = Date.now() - startTime;

          if (!layoutManager.isBusy()) {
            resolve();
          } else if (elapsed >= BUSY_POLLING_TIMEOUT_MS) {
            console.warn(
              `CurrentLayoutProvider: timeout after ${BUSY_POLLING_TIMEOUT_MS}ms, continuing anyway`,
            );
            resolve();
          } else {
            setTimeout(checkBusy, BUSY_POLLING_INTERVAL_MS);
          }
        };
        checkBusy();
      });
    }

    const layouts = await layoutManager.getLayouts();

    // The last locally selected layout has highest priority when it can still be restored.
    const layout = currentLayoutId
      ? layouts.find((element) => element.id === currentLayoutId)
      : undefined;

    if (layout) {
      await setSelectedLayoutId(currentLayoutId, { saveToProfile: false });
      return;
    }

    // Check if there's a layout specified by app parameter. When multiple layouts share the
    // name, prefer the organizational (shared) layout over a local one.
    const matchingLayouts = layouts.filter((l) => l.name === appParameters.defaultLayout);
    const defaultLayoutFromParameters =
      matchingLayouts.find((l) => l.permission.startsWith(ORG_PERMISSION_PREFIX)) ??
      matchingLayouts[0];
    if (defaultLayoutFromParameters) {
      // Apply the URL-selected layout for the current session only, without persisting it to the
      // user's profile, so a one-off ?layout= override does not become sticky on later visits.
      await setSelectedLayoutId(defaultLayoutFromParameters.id, { saveToProfile: false });
      return;
    }

    // It there is a defaultLayout setted but didnt found a layout, show a error to the user
    if (appParameters.defaultLayout) {
      enqueueSnackbar(t("noDefaultLayoutParameter", { layoutName: appParameters.defaultLayout }), {
        variant: "warning",
      });
    }

    // A Docker-injected default retains priority over the cloud fallback. The existing fallback
    // below will persist that injected data only when there are no layouts at all.
    if (!hasInjectedDefaultLayout && remoteLayoutStorage?.getDefaultLayout != undefined) {
      await selectCloudDefaultLayout({
        layoutManager,
        remoteLayoutStorage,
        selectLayout: async (id) => {
          await setSelectedLayoutId(id);
        },
      });
      // A configured server owns this fallback. On null, failure, or timeout, keep the current
      // unselected state instead of creating a local copy that a later sync could upload.
      return;
    }

    if (layouts.length > 0) {
      const orgLayouts = layouts.filter((l) => l.permission.startsWith(ORG_PERMISSION_PREFIX));
      const layoutsToSort = orgLayouts.length > 0 ? orgLayouts : layouts;
      const sortedLayouts = [...layoutsToSort].sort((a, b) => a.name.localeCompare(b.name));
      await setSelectedLayoutId(sortedLayouts[0]!.id);
      return;
    }

    const defaultLayout = await layoutManager.saveNewLayout(DEFAULT_LAYOUT);
    await setSelectedLayoutId(defaultLayout.id);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getUserProfile, layoutManager, remoteLayoutStorage, setSelectedLayoutId, enqueueSnackbar]);

  const { updateSharedPanelState } = useUpdateSharedPanelState(layoutStateRef, setLayoutState);

  const actions: ICurrentLayout["actions"] = useMemo(
    () => ({
      updateSharedPanelState,
      setCurrentLayout: () => {},
      setSelectedLayoutId,
      getCurrentLayoutState: () => layoutStateRef.current,

      savePanelConfigs: (payload: SaveConfigsPayload) => {
        performAction({ type: "SAVE_PANEL_CONFIGS", payload });
      },
      updatePanelConfigs: (
        panelType: string,
        perPanelFunc: (config: PanelConfig) => PanelConfig,
      ) => {
        performAction({ type: "SAVE_FULL_PANEL_CONFIG", payload: { panelType, perPanelFunc } });
      },
      createTabPanel: (payload: CreateTabPanelPayload) => {
        performAction({ type: "CREATE_TAB_PANEL", payload });
        setSelectedPanelIds([]);
        analytics.logEvent(AppEvent.PANEL_ADD, { type: "Tab" });
      },
      changePanelLayout: (payload: ChangePanelLayoutPayload) => {
        performAction({ type: "CHANGE_PANEL_LAYOUT", payload });
      },
      overwriteGlobalVariables: (payload: Record<string, VariableValue>) => {
        performAction({ type: "OVERWRITE_GLOBAL_DATA", payload });
      },
      setGlobalVariables: (payload: Record<string, VariableValue>) => {
        performAction({ type: "SET_GLOBAL_DATA", payload });
      },
      setUserScripts: (payload: Partial<UserScripts>) => {
        performAction({ type: "SET_USER_NODES", payload });
      },
      setPlaybackConfig: (payload: Partial<PlaybackConfig>) => {
        performAction({ type: "SET_PLAYBACK_CONFIG", payload });
      },
      closePanel: (payload: ClosePanelPayload) => {
        performAction({ type: "CLOSE_PANEL", payload });

        const closedId = getNodeAtPath(payload.root, payload.path);
        // Deselect the removed panel
        setSelectedPanelIds((ids) => ids.filter((id) => id !== closedId));

        analytics.logEvent(
          AppEvent.PANEL_DELETE,
          typeof closedId === "string" ? { type: getPanelTypeFromId(closedId) } : undefined,
        );
      },
      splitPanel: (payload: SplitPanelPayload) => {
        performAction({ type: "SPLIT_PANEL", payload });
      },
      swapPanel: (payload: SwapPanelPayload) => {
        // Select the new panel if the original panel was selected. We don't know what
        // the new panel id will be so we diff the panelIds of the old and
        // new layout so we can select the new panel.
        const originalIsSelected = selectedPanelIds.current.includes(payload.originalId);
        const beforePanelIds = Object.keys(
          layoutStateRef.current.selectedLayout?.data?.configById ?? {},
        );
        performAction({ type: "SWAP_PANEL", payload });
        if (originalIsSelected) {
          const afterPanelIds = Object.keys(
            layoutStateRef.current.selectedLayout?.data?.configById ?? {},
          );
          setSelectedPanelIds(_.difference(afterPanelIds, beforePanelIds));
        }
        analytics.logEvent(AppEvent.PANEL_ADD, { type: payload.type, action: "swap" });
        analytics.logEvent(AppEvent.PANEL_DELETE, {
          type: getPanelTypeFromId(payload.originalId),
          action: "swap",
        });
      },
      moveTab: (payload: MoveTabPayload) => {
        performAction({ type: "MOVE_TAB", payload });
      },
      addPanel: (payload: AddPanelPayload) => {
        performAction({ type: "ADD_PANEL", payload });
        analytics.logEvent(AppEvent.PANEL_ADD, { type: getPanelTypeFromId(payload.id) });
      },
      addPanelsAtomically: (payload: AddPanelsAtomicallyPayload) => {
        performAction({ type: "ADD_PANELS_ATOMIC", payload });
      },
      dropPanel: (payload: DropPanelPayload) => {
        performAction({ type: "DROP_PANEL", payload });
        analytics.logEvent(AppEvent.PANEL_ADD, {
          type: payload.newPanelType,
          action: "drop",
        });
      },
      startDrag: (payload: StartDragPayload) => {
        performAction({ type: "START_DRAG", payload });
      },
      endDrag: (payload: EndDragPayload) => {
        performAction({ type: "END_DRAG", payload });
      },
    }),
    [analytics, performAction, setSelectedLayoutId, setSelectedPanelIds, updateSharedPanelState],
  );

  const value: ICurrentLayout = useShallowMemo({
    addLayoutStateListener,
    removeLayoutStateListener,
    addSelectedPanelIdsListener,
    removeSelectedPanelIdsListener,
    mosaicId,
    getSelectedPanelIds,
    setSelectedPanelIds,
    actions,
  });

  return (
    <CurrentLayoutContext.Provider value={value}>
      {children}
      {incompatibleLayoutVersionError && (
        <IncompatibleLayoutVersionAlert
          onClose={() => {
            setIncompatibleLayoutVersionError(false);
          }}
        />
      )}
    </CurrentLayoutContext.Provider>
  );
}
