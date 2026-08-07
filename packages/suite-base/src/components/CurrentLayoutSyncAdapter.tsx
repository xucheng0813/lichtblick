// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { enqueueSnackbar } from "notistack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsync, useMountedState } from "react-use";
import { useDebounce } from "use-debounce";

import Logger from "@lichtblick/log";
import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { useAnalytics } from "@lichtblick/suite-base/context/AnalyticsContext";
import { useAppConfiguration } from "@lichtblick/suite-base/context/AppConfigurationContext";
import {
  LayoutID,
  LayoutState,
  useCurrentLayoutSelector,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import { useAppConfigurationValue } from "@lichtblick/suite-base/hooks";
import { AppEvent } from "@lichtblick/suite-base/services/IAnalytics";
import type { LayoutManagerChangeEvent } from "@lichtblick/suite-base/services/ILayoutManager";
import type { Layout } from "@lichtblick/suite-base/services/ILayoutStorage";
import { layoutIsShared } from "@lichtblick/suite-base/services/ILayoutStorage";
import { resolveVizServerConfigured, resolveWorkspace } from "@lichtblick/suite-base/util/vizServerParams";

type UpdatedLayout = NonNullable<LayoutState["selectedLayout"]>;

const log = Logger.getLogger(__filename);

const EMPTY_UNSAVED_LAYOUTS: Record<LayoutID, UpdatedLayout> = {};
const SAVE_INTERVAL_MS = 1000;

/**
 * Delay between committing an auto-saved layout (working → baseline) and kicking a
 * `syncWithRemote()` so the committed edit can be uploaded. Deliberately ≥ 10s: long enough to
 * absorb rapid successive edits without spamming syncs, short enough that an edit reaches the
 * server well before the next periodic sync.
 */
export const CLOUD_AUTO_SAVE_SYNC_DELAY_MS = 10_000;

const selectCurrentLayout = (state: LayoutState) => state.selectedLayout;

/**
 * Observes changes in the current layout and asynchronously pushes them to the
 * layout manager.
 */
export function CurrentLayoutSyncAdapter(): ReactNull {
  const selectedLayout = useCurrentLayoutSelector(selectCurrentLayout);

  const layoutManager = useLayoutManager();

  const [unsavedLayouts, setUnsavedLayouts] = useState(EMPTY_UNSAVED_LAYOUTS);

  const isMounted = useMountedState();

  const analytics = useAnalytics();

  useEffect(() => {
    if (selectedLayout?.edited === true) {
      setUnsavedLayouts((old) => ({
        ...old,
        [selectedLayout.id]: selectedLayout,
      }));
    }
  }, [selectedLayout]);

  const [debouncedUnsavedLayouts, debouncedUnsavedLayoutActions] = useDebounce(
    unsavedLayouts,
    SAVE_INTERVAL_MS,
  );

  // Flush and clear pending updates on unmount.
  useEffect(() => {
    return () => {
      debouncedUnsavedLayoutActions.flush();
      debouncedUnsavedLayoutActions.cancel();
    };
  }, [debouncedUnsavedLayoutActions]);

  // Write all pending layout updates to the layout manager. Under the hood this
  // uses useEffect so it happens after DOM updates are complete.
  useAsync(async () => {
    const unsavedLayoutsSnapshot = { ...debouncedUnsavedLayouts };
    setUnsavedLayouts(EMPTY_UNSAVED_LAYOUTS);

    for (const params of Object.values(unsavedLayoutsSnapshot)) {
      try {
        await layoutManager.updateLayout(params);
      } catch (error) {
        log.error(error);
        if (isMounted()) {
          enqueueSnackbar(`Your changes could not be saved. ${error.toString()}`, {
            variant: "error",
            key: "CurrentLayoutProvider.throttledSave",
          });
        }
      }
    }

    analytics.logEvent(AppEvent.LAYOUT_UPDATE);
  }, [analytics, debouncedUnsavedLayouts, isMounted, layoutManager]);

  return ReactNull;
}

/**
 * Auto-saves edits of remote layouts to the cloud (AppSetting.LAYOUT_AUTO_SAVE_TO_CLOUD,
 * default off).
 *
 * The chain follows the explicit-save semantics (v3 N2): once a debounced edit has landed in the
 * layout's `working` copy (the LayoutManager emits a change event with `updatedLayout`), the edit
 * is queued behind a debounce window (`CLOUD_AUTO_SAVE_SYNC_DELAY_MS`, ≥ 10s) that merges rapid
 * edits into a single commit. When the window closes we call the existing `overwriteLayout` — the
 * same operation as the user clicking Save — which commits working → baseline and uploads the
 * committed data for remote layouts (ORG_WRITE shared, or personal layouts that already exist on
 * the remote, identified by their `externalId`). A `syncWithRemote()` kick follows after the
 * commit; the combined delay means rapid edits produce exactly one remote write.
 *
 * Exclusions: ORG_READ layouts, layouts marked remotely-deleted, the loading state, layouts that
 * are no longer selected, and any workspace without a configured viz server. Uploads are
 * last-write-wins; failures surface through the standard snackbar.
 */
/**
 * Auto-saves edits of remote layouts to the cloud (AppSetting.LAYOUT_AUTO_SAVE_TO_CLOUD,
 * default off).
 *
 * The chain follows the explicit-save semantics (v3 N2): once a debounced edit has landed in the
 * layout's `working` copy (the LayoutManager emits a change event with `updatedLayout`), the edit
 * is queued behind a debounce window (`CLOUD_AUTO_SAVE_SYNC_DELAY_MS`, ≥ 10s) that merges rapid
 * edits into a single commit. When the window closes we call the existing `overwriteLayout` — the
 * same operation as the user clicking Save — which commits working → baseline and uploads the
 * committed data for remote layouts (ORG_WRITE shared, or personal layouts that already exist on
 * the remote, identified by their `externalId`). A `syncWithRemote()` kick follows immediately
 * after the commit; the combined delay means rapid edits produce exactly one remote write.
 *
 * Exclusions: ORG_READ layouts, layouts marked remotely-deleted, the loading state, layouts that
 * are no longer selected, purely-local personal layouts (no `externalId`), and any workspace
 * without a configured viz server. Queued commits and kicks are re-validated when they run
 * (switch off, layout/workspace changed, unmounted) and cancelled on unmount or workspace
 * change. Uploads are last-write-wins; failures surface through the standard snackbar.
 */
export function CloudLayoutAutoSaveAdapter(): ReactNull {
  const layoutManager = useLayoutManager();
  const appConfiguration = useAppConfiguration();
  const [autoSaveEnabled] = useAppConfigurationValue<boolean>(
    AppSetting.LAYOUT_AUTO_SAVE_TO_CLOUD,
  );
  const currentLayoutId = useCurrentLayoutSelector((state) => state.selectedLayout?.id);
  const currentLayoutLoading = useCurrentLayoutSelector(
    (state) => state.selectedLayout?.loading === true,
  );
  const isMounted = useMountedState();

  const resolvedWorkspace = resolveWorkspace(appConfiguration);
  const workspace = useMemo(
    () => (resolveVizServerConfigured(resolvedWorkspace) ? resolvedWorkspace : undefined),
    [resolvedWorkspace],
  );

  // Refs keep the latest switch/selection/workspace visible to timers without re-registering them.
  const autoSaveEnabledRef = useRef(autoSaveEnabled);
  useEffect(() => {
    autoSaveEnabledRef.current = autoSaveEnabled;
  }, [autoSaveEnabled]);
  const currentLayoutIdRef = useRef(currentLayoutId);
  useEffect(() => {
    currentLayoutIdRef.current = currentLayoutId;
  }, [currentLayoutId]);
  const currentLayoutLoadingRef = useRef(currentLayoutLoading);
  useEffect(() => {
    currentLayoutLoadingRef.current = currentLayoutLoading;
  }, [currentLayoutLoading]);
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  /** Debounce timers per layout: a new edit resets the window instead of committing immediately. */
  const pendingCommitsRef = useRef(new Map<LayoutID, ReturnType<typeof setTimeout>>());
  const pendingKicksRef = useRef(
    new Map<LayoutID, { timer: ReturnType<typeof setTimeout>; controller: AbortController }>(),
  );
  /** Serialization per layout: commits for one layout never overlap. */
  const autoSaveChainsRef = useRef(new Map<LayoutID, Promise<void>>());

  const clearPendingCommit = useCallback((layoutId: LayoutID) => {
    const timer = pendingCommitsRef.current.get(layoutId);
    if (timer != undefined) {
      clearTimeout(timer);
      pendingCommitsRef.current.delete(layoutId);
    }
  }, []);

  const clearPendingKick = useCallback(
    (layoutId: LayoutID) => {
      const pending = pendingKicksRef.current.get(layoutId);
      if (pending != undefined) {
        clearTimeout(pending.timer);
        pending.controller.abort();
        pendingKicksRef.current.delete(layoutId);
      }
    },
    [],
  );

  // Cancel queued commits and kicks on unmount or whenever the effect re-runs (workspace or
  // switch changed), so nothing queued under the old conditions can fire later.
  useEffect(() => {
    const pendingCommits = pendingCommitsRef.current;
    const pendingKicks = pendingKicksRef.current;
    return () => {
      for (const timer of pendingCommits.values()) {
        clearTimeout(timer);
      }
      pendingCommits.clear();
      for (const pending of pendingKicks.values()) {
        clearTimeout(pending.timer);
        pending.controller.abort();
      }
      pendingKicks.clear();
    };
  }, []);

  /** True when the queued auto-save is still wanted: mounted, switch on, not loading, same
   * layout selected, workspace unchanged. Re-evaluated each time queued work actually runs — the
   * conditions can change while a commit or kick is queued or in flight. */
  const isAutoSaveStillWanted = useCallback(
    (layoutId: LayoutID, workspaceAtSchedule: string | undefined): boolean => {
      if (!isMounted() || autoSaveEnabledRef.current !== true) {
        return false;
      }
      if (currentLayoutLoadingRef.current) {
        return false;
      }
      if (currentLayoutIdRef.current !== layoutId) {
        return false;
      }
      const currentResolvedWorkspace = resolveWorkspace(appConfiguration);
      return (
        (resolveVizServerConfigured(currentResolvedWorkspace)
          ? currentResolvedWorkspace
          : undefined) === workspaceAtSchedule
      );
    },
    [appConfiguration, isMounted],
  );

  const scheduleSyncKick = useCallback(
    (layout: Layout, workspaceAtCommit: string | undefined) => {
      clearPendingKick(layout.id);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void (async () => {
          try {
            // Re-validate when the kick runs: switch on, not loading, same layout selected, and
            // the workspace unchanged. The committed edit itself is already safe in local storage.
            if (!isAutoSaveStillWanted(layout.id, workspaceAtCommit)) {
              return;
            }
            try {
              await layoutManager.syncWithRemote(controller.signal);
            } catch (error) {
              log.error(error);
              if (isMounted()) {
                enqueueSnackbar(`Cloud auto-save failed. ${error.toString()}`, {
                  variant: "error",
                  key: "CloudLayoutAutoSaveAdapter.sync",
                });
              }
            }
          } finally {
            // Keep the controller registered while the sync is in flight so a switch/workspace
            // change or unmount can abort it; drop the entry only after completion.
            const pending = pendingKicksRef.current.get(layout.id);
            if (pending?.controller === controller) {
              pendingKicksRef.current.delete(layout.id);
            }
          }
        })();
      }, CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
      pendingKicksRef.current.set(layout.id, { controller, timer });
    },
    [clearPendingKick, isAutoSaveStillWanted, isMounted, layoutManager],
  );


  /** True when the layout is a remote layout eligible for cloud auto-save. */
  const qualifies = useCallback((layout: Layout): boolean => {
    if (layout.working == undefined) {
      return false;
    }
    if (layout.permission === "ORG_READ") {
      return false;
    }
    if (layout.syncInfo?.status === "remotely-deleted") {
      return false;
    }
    // Only remote layouts auto-save: ORG_WRITE shared, or personal layouts that already exist on
    // the remote (personal-remote). A personal layout without an externalId is purely local and
    // must not enter the sync path.
    if (!layoutIsShared(layout) && layout.externalId == undefined) {
      return false;
    }
    return true;
  }, []);


  const commitAndKick = useCallback(
    async (layoutId: LayoutID, workspaceAtSchedule: string | undefined) => {
      // Re-validate at execution time: the switch may have been turned off, the layout or
      // workspace may have changed, or the component may have unmounted while we were queued.
      if (!isAutoSaveStillWanted(layoutId, workspaceAtSchedule)) {
        return;
      }
      let layout: Layout | undefined;
      try {
        // Re-read the latest layout so a debounce window that merged several edits commits them
        // in one shot.
        layout = await layoutManager.getLayout(layoutId);
      } catch {
        return;
      }
      if (layout == undefined || !qualifies(layout)) {
        return;
      }
      try {
        // Explicit-save semantics: commit working → baseline and upload for remote layouts,
        // exactly as if the user clicked Save.
        await layoutManager.overwriteLayout({ id: layoutId });
      } catch (error) {
        log.error(error);
        if (isMounted()) {
          enqueueSnackbar(`Your changes could not be saved to the cloud. ${error.toString()}`, {
            variant: "error",
            key: "CloudLayoutAutoSaveAdapter.overwrite",
          });
        }
        return;
      }
      // The commit (and remote write, if any) landed after the debounce window. Re-check the
      // conditions before scheduling the kick: the switch may have been turned off or the layout
      // may have changed while the commit was in flight (an in-flight commit cannot be aborted).
      if (!isAutoSaveStillWanted(layoutId, workspaceAtSchedule)) {
        return;
      }
      // The sync kick keeps the rest of the workspace consistent.
      scheduleSyncKick(layout, workspaceAtSchedule);
    },
    [isAutoSaveStillWanted, isMounted, layoutManager, qualifies, scheduleSyncKick],
  );

  const enqueueAutoSave = useCallback(
    (layoutId: LayoutID) => {
      const workspaceAtSchedule = workspaceRef.current;
      if (workspaceAtSchedule == undefined) {
        return;
      }
      // Debounce-merge: rapid edits reset the window and produce a single commit + remote write.
      clearPendingCommit(layoutId);
      const timer = setTimeout(() => {
        pendingCommitsRef.current.delete(layoutId);
        // Serialize per layout: a commit waits for the previous one to finish.
        const previous = autoSaveChainsRef.current.get(layoutId) ?? Promise.resolve();
        const chain = previous
          .catch(() => {})
          .then(async () => {
            await commitAndKick(layoutId, workspaceAtSchedule);
          })
          .catch(() => {});
        autoSaveChainsRef.current.set(layoutId, chain);
        void chain.then(() => {
          if (autoSaveChainsRef.current.get(layoutId) === chain) {
            autoSaveChainsRef.current.delete(layoutId);
          }
        });
      }, CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
      pendingCommitsRef.current.set(layoutId, timer);
    },
    [clearPendingCommit, commitAndKick],
  );

  useEffect(() => {
    const onChange = (event: LayoutManagerChangeEvent) => {
      if (event.type !== "change" || event.updatedLayout == undefined) {
        return;
      }
      const layout = event.updatedLayout;
      // The switch is off: no auto-save work at all (and no network calls).
      if (autoSaveEnabledRef.current !== true || workspaceRef.current == undefined) {
        return;
      }
      // Nothing new to commit; also prevents reacting to our own overwriteLayout commits.
      if (layout.working == undefined) {
        return;
      }
      // Cheap event-time exclusions; the authoritative re-check happens at commit time.
      if (layout.permission === "ORG_READ") {
        return;
      }
      if (layout.syncInfo?.status === "remotely-deleted") {
        return;
      }
      if (currentLayoutLoadingRef.current) {
        return;
      }
      if (currentLayoutIdRef.current !== layout.id) {
        return;
      }
      enqueueAutoSave(layout.id);
    };
    layoutManager.on("change", onChange);
    // Effect re-runs (switch or workspace change) cancel queued work before it can fire; capture
    // the refs up front so the cleanup observes the same maps.
    const pendingCommits = pendingCommitsRef.current;
    const pendingKicks = pendingKicksRef.current;
    return () => {
      layoutManager.off("change", onChange);
      for (const timer of pendingCommits.values()) {
        clearTimeout(timer);
      }
      pendingCommits.clear();
      for (const pending of pendingKicks.values()) {
        clearTimeout(pending.timer);
        pending.controller.abort();
      }
      pendingKicks.clear();
    };
  }, [autoSaveEnabled, enqueueAutoSave, layoutManager, workspace]);

  return ReactNull;
}
