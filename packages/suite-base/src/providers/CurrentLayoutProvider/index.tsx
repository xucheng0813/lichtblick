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
 * 选择来源标记:仅用于区分 selection generation 变化的原因(用户切换 vs 内部 fallback/刷新),
 * 以及测试断言。它不参与重校验的准入判定——generation 一旦变化,无论来源(用户切换或内部
 * delete listener 切换)都直接放弃后台重校验,内部来源的变化不允许穿过检查继续执行。
 */
type SelectionSource =
  | "user"
  | "revalidation-refresh"
  | "fallback-initial-load"
  | "fallback-delete-listener"
  | "fallback-revalidation";

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
  const selectionSources = useRef(new Map<number, SelectionSource>());

  // 同一 generation 的 fallback 只执行一次(single-flight):delete listener 与重校验可能同时
  // 通过 generation 检查进入统一 fallback,按 generation 复用同一个 Promise,避免重复云端
  // 查询/选择/profile 写入/默认布局创建。
  const fallbackInFlight = useRef(new Map<number, Promise<void>>());

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

  // setSelectedLayoutId 的返回:true=选择已落地;false=选择失败(布局不存在/加载失败);
  // "incompatible"=版本不兼容(有意拒绝,仅提示不选择);undefined=期间被更新的选择取代。
  const [, setSelectedLayoutId] = useAsyncFn(
    async (
      id: LayoutID | undefined,
      {
        saveToProfile = true,
        source,
      }: { saveToProfile?: boolean; source?: SelectionSource } = {},
    ) => {
      // Selection generation: every call invalidates all in-flight async side effects of earlier
      // selections (layout state commits, profile writes, version alerts, snackbars, failures).
      const generation = ++selectionGeneration.current;
      // 记录该 generation 的来源(默认视为用户操作),仅用于区分变化原因与测试断言。
      selectionSources.current.clear();
      selectionSources.current.set(generation, source ?? "user");
      if (id == undefined) {
        setLayoutState({ selectedLayout: undefined });
        flushProfileWriteError();
        return true;
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
          // 过期请求：丢弃所有异步副作用，不落地任何状态。返回 undefined 表示被取代。
          return undefined;
        }
        const layoutVersion = layout?.baseline.data.version;
        if (layoutVersion != undefined && layoutVersion > MAX_SUPPORTED_LAYOUT_VERSION) {
          setIncompatibleLayoutVersionError(true);
          setLayoutState({ selectedLayout: undefined });
          flushProfileWriteError();
          return "incompatible";
        }
        if (!isMounted()) {
          return undefined;
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
          return false;
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
          return true;
        }
      } catch (error) {
        if (generation !== selectionGeneration.current) {
          // 过期请求的失败不弹错误。
          return undefined;
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
        return false;
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

  /**
   * 统一 fallback:由初始加载(本地无命中)、delete listener、同步后重校验三方共用,保证行为
   * 一处定义。语义与现状(初始加载的 fallback 链)完全一致:app parameter 指定优先;「注入默认
   * 布局」不是独立选择步骤,它的作用是抑制云端 fallback、并在完全无布局时作为 DEFAULT_LAYOUT
   * 的数据来源;云端默认路径一旦启用即为终止路径(即使返回空/失败也不再继续选本地);其余为
   * 组织布局优先排序 → 本地布局 → DEFAULT_LAYOUT。
   *
   * 可选 generation 守卫:调用方(delete listener / 重校验)传入快照后,每次落地选择副作用前
   * 校验 generation 未变化;期间发生用户切换或另一方 fallback 已落地选择时直接放弃,避免重复
   * 云端查询/选择/profile 写入。同一 generation 的并发调用(delete listener 与重校验同时通过
   * 检查)按 generation 复用同一个 Promise(single-flight),保证云端查询/默认布局创建最多一次。
   * 初始加载路径不传 generation,行为与现状完全一致。
   */
  const selectFallbackLayout = useCallback(
    async ({ generation, source }: { generation?: number; source?: SelectionSource } = {}) => {
      if (generation != undefined) {
        const existing = fallbackInFlight.current.get(generation);
        if (existing != undefined) {
          // 同一 generation 已有 fallback 在执行:复用同一个 Promise(single-flight),
          // 避免重复云端查询/选择/profile 写入/默认布局创建。
          await existing;
          return;
        }
      }

      const runFallback = async (): Promise<void> => {
        const isStale = () =>
          generation != undefined && selectionGeneration.current !== generation;

        const layouts = await layoutManager.getLayouts();
        // await getLayouts() 期间 selection 可能已变化:先检查 stale 再解析布局/发出提示,
        // 避免已过期的 fallback 产生可见副作用(如“URL 默认布局不存在”snackbar)。
        if (isStale()) {
          return;
        }

        // Check if there's a layout specified by app parameter. When multiple layouts share the
        // name, prefer the organizational (shared) layout over a local one.
        const matchingLayouts = layouts.filter((l) => l.name === appParameters.defaultLayout);
        const defaultLayoutFromParameters =
          matchingLayouts.find((l) => l.permission.startsWith(ORG_PERMISSION_PREFIX)) ??
          matchingLayouts[0];
        if (defaultLayoutFromParameters) {
          if (isStale()) {
            return;
          }
          // Apply the URL-selected layout for the current session only, without persisting it to the
          // user's profile, so a one-off ?layout= override does not become sticky on later visits.
          await setSelectedLayoutId(defaultLayoutFromParameters.id, {
            saveToProfile: false,
            source,
          });
          return;
        }

        // It there is a defaultLayout setted but didnt found a layout, show a error to the user
        if (appParameters.defaultLayout) {
          enqueueSnackbar(
            t("noDefaultLayoutParameter", { layoutName: appParameters.defaultLayout }),
            {
              variant: "warning",
            },
          );
        }

        // A Docker-injected default retains priority over the cloud fallback. The existing fallback
        // below will persist that injected data only when there are no layouts at all.
        if (!hasInjectedDefaultLayout && remoteLayoutStorage?.getDefaultLayout != undefined) {
          if (isStale()) {
            return;
          }
          await selectCloudDefaultLayout({
            layoutManager,
            remoteLayoutStorage,
            selectLayout: async (id) => {
              // 云端默认路径一旦启用即为终止路径:即使选择已被更新的 selection 取代,
              // 也不再继续选本地布局。
              if (!isStale()) {
                await setSelectedLayoutId(id, { source });
              }
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
          if (isStale()) {
            return;
          }
          await setSelectedLayoutId(sortedLayouts[0]!.id, { source });
          return;
        }

        if (isStale()) {
          return;
        }
        const defaultLayout = await layoutManager.saveNewLayout(DEFAULT_LAYOUT);
        // saveNewLayout await 期间 selection 可能已变化:变化则不再选中新创建的布局。
        if (isStale()) {
          return;
        }
        await setSelectedLayoutId(defaultLayout.id, { source });
      };

      const promise = runFallback();
      if (generation != undefined) {
        fallbackInFlight.current.set(generation, promise);
        const cleanup = () => {
          if (fallbackInFlight.current.get(generation) === promise) {
            fallbackInFlight.current.delete(generation);
          }
        };
        void promise.then(cleanup, cleanup);
      }
      await promise;
    },
    [
      appParameters,
      enqueueSnackbar,
      layoutManager,
      remoteLayoutStorage,
      setSelectedLayoutId,
      t,
    ],
  );

  /**
   * 等待 layout manager 结束所有进行中的操作(如拉取远端布局)。语义与现状一致:不忙立即返回;
   * 忙则轮询,超时后警告并继续。
   */
  const waitForBusyEnd = useCallback(async () => {
    if (!layoutManager.isBusy()) {
      return;
    }
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
  }, [layoutManager]);

  /**
   * 同步结束后的重校验(快速路径专用,严格的 generation 快照并发语义)。
   *
   * 快速路径选中时记录当时的 selection generation 与 layoutId;busy 结束时仅当 generation
   * 未变化、仍选中原 layout、且未编辑(不能只看 working copy:CurrentLayoutSyncAdapter 有
   * 1 秒 debounce)才重新 getLayout 校验。generation 一旦变化,无论来源(用户切换或内部
   * delete listener 切换)都直接放弃——内部 delete 变化意味着统一 fallback 已由 listener 执行,
   * 再跑会造成重复云端查询/选择/profile 写入。
   */
  const revalidateSelectionAfterSync = useCallback(
    async (generationSnapshot: number, layoutId: LayoutID) => {
      if (selectionGeneration.current !== generationSnapshot) {
        log.debug(
          "Skipping layout revalidation: selection changed",
          selectionSources.current.get(selectionGeneration.current),
        );
        return;
      }
      const selected = layoutStateRef.current.selectedLayout;
      if (selected?.id !== layoutId || selected.edited === true) {
        return;
      }

      const layout = await layoutManager.getLayout(layoutId);

      // getLayout await 期间 selection 可能再次变化(用户切换/编辑,或内部 delete listener
      // 的 fallback 已落地):按 generation 快照重新检查后才可执行任何副作用。
      if (selectionGeneration.current !== generationSnapshot) {
        return;
      }
      const selectedNow = layoutStateRef.current.selectedLayout;
      if (selectedNow?.id !== layoutId || selectedNow.edited === true) {
        return;
      }

      if (layout == undefined) {
        // 布局已被远端同步删除:与 delete listener 共用统一 fallback(带 generation 守卫)。
        await selectFallbackLayout({
          generation: generationSnapshot,
          source: "fallback-revalidation",
        });
        return;
      }

      // baseline 有更新 → 用新数据刷新已选布局(复用 setSelectedLayoutId 刷新路径,内部标记);
      // 无变化 → 不动。
      const fetchedData = layout.working?.data ?? layout.baseline.data;
      if (selectedNow.data != undefined && !_.isEqual(selectedNow.data, fetchedData)) {
        await setSelectedLayoutId(layoutId, { saveToProfile: false, source: "revalidation-refresh" });
      }
    },
    [layoutManager, selectFallbackLayout, setSelectedLayoutId],
  );

  // Make sure our layout still exists after changes. If not, run the unified fallback.
  // The fallback semantics are defined in exactly one place (selectFallbackLayout), shared with
  // the post-sync revalidation above.
  useEffect(() => {
    const listener: LayoutManagerEventTypes["change"] = async (event) => {
      if (event.type !== "delete" || !layoutStateRef.current.selectedLayout?.id) {
        return;
      }

      if (event.layoutId === layoutStateRef.current.selectedLayout.id) {
        // 记录触发时的 generation 快照:统一 fallback 落地选择前若 selection 已被其他来源
        // (用户切换或重校验 fallback)改变,直接放弃,避免与重校验重复执行云端查询/选择/profile 写入。
        const generation = selectionGeneration.current;
        try {
          await selectFallbackLayout({ generation, source: "fallback-delete-listener" });
        } catch (error) {
          // listener 的 rejection 无人消费,必须在此兜底。
          log.error("Fallback layout selection failed", error);
        }
      }
    };

    layoutManager.on("change", listener);
    return () => {
      layoutManager.off("change", listener);
    };
  }, [layoutManager, selectFallbackLayout]);

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

    // getUserProfile 与 loadDefaultLayouts 无相互依赖:并行执行,避免串行多一次往返。
    const [{ currentLayoutId }] = await Promise.all([
      getUserProfile(),
      loadDefaultLayouts(layoutManager, loaders),
    ]);

    // 快速路径:进入 isBusy 等待前,用 getLayouts()(本地列表语义)判定 profile 记录的
    // currentLayoutId 是否本地命中。不得用 getLayout(id) 作本地探针——本地未命中会穿透访问远端。
    const localLayouts = await layoutManager.getLayouts();
    if (currentLayoutId != undefined) {
      const localHit = localLayouts.find((element) => element.id === currentLayoutId);
      if (localHit != undefined) {
        // 本地命中:立即选中(用户马上看到面板、数据开始拉取)……
        // setSelectedLayoutId 的返回用于确认快速选择确实成功:true=已落地;false=失败
        // (getLayouts() 命中后、getLayout() 前布局被同步删除/加载失败);"incompatible"=
        // 版本不兼容(alert 已弹出,与现状一致不再选择);undefined=期间被更新的选择取代。
        const fastPathResult = await setSelectedLayoutId(currentLayoutId, {
          saveToProfile: false,
        });
        // 记录本次快速路径选择的 generation 快照与 layoutId;busy 结束后据此重校验。
        const fastPathGeneration = selectionGeneration.current;

        if (fastPathResult === true) {
          // ……同时继续在后台等待 busy 结束。
          await waitForBusyEnd();
          await revalidateSelectionAfterSync(fastPathGeneration, currentLayoutId);
          return;
        }
        if (fastPathResult === false) {
          // 快速选择失败:同一 generation 下(无用户切换)等待同步结束并进入统一 fallback;
          // generation 已变化则说明期间发生了用户选择,不覆盖。
          await waitForBusyEnd();
          if (selectionGeneration.current === fastPathGeneration) {
            await selectFallbackLayout({
              generation: fastPathGeneration,
              source: "fallback-revalidation",
            });
          }
          return;
        }
        // "incompatible":版本不兼容,保持现状(仅提示,不选择);undefined:快速选择期间被
        // 用户切换取代 → 保留用户选择。两种情况下都不做任何事。
        return;
      }
    }

    // 本地无命中(首启/无缓存):行为与现状完全一致,照常等待 busy 后再走完整选择链。
    await waitForBusyEnd();

    const layouts = await layoutManager.getLayouts();

    // The last locally selected layout has highest priority when it can still be restored.
    const layout = currentLayoutId
      ? layouts.find((element) => element.id === currentLayoutId)
      : undefined;

    if (layout) {
      await setSelectedLayoutId(currentLayoutId, { saveToProfile: false });
      return;
    }

    await selectFallbackLayout({ source: "fallback-initial-load" });

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
