/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import {
  CLOUD_AUTO_SAVE_SYNC_DELAY_MS,
  CloudLayoutAutoSaveAdapter,
  CurrentLayoutSyncAdapter,
} from "@lichtblick/suite-base/components/CurrentLayoutSyncAdapter";
import AppConfigurationContext, {
  AppConfigurationValue,
  ChangeHandler,
  IAppConfiguration,
} from "@lichtblick/suite-base/context/AppConfigurationContext";
import {
  CurrentLayoutActions,
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
import { ILayoutStorage, Layout } from "@lichtblick/suite-base/services/ILayoutStorage";
import {
  IRemoteLayoutStorage,
  RemoteLayout,
} from "@lichtblick/suite-base/services/IRemoteLayoutStorage";
import LayoutManager from "@lichtblick/suite-base/services/LayoutManager/LayoutManager";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

jest.mock("notistack", () => ({
  ...jest.requireActual("notistack"),
  useSnackbar: jest.fn().mockReturnValue({ enqueueSnackbar: jest.fn() }),
}));

jest.mock("@lichtblick/log", () => ({
  __esModule: true,
  default: { getLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
}));

const baselineData = {
  configById: { "Image!camera": { imageMode: { imageTopic: "/camera" } } },
  layout: "Image!camera",
  globalVariables: {},
  playbackConfig: { speed: 1 },
  userNodes: {},
};

const seededLayout: Layout = {
  baseline: { data: baselineData, savedAt: "2026-01-01T00:00:00.000Z" as never },
  externalId: "external-1",
  id: "layout-1" as never,
  name: "Org Layout",
  permission: "CREATOR_WRITE",
  syncInfo: undefined,
  working: undefined,
};

const remoteLayout: RemoteLayout = {
  data: baselineData,
  externalId: "external-1",
  id: "layout-1" as never,
  name: "Org Layout",
  permission: "CREATOR_WRITE",
  savedAt: "2026-01-01T00:00:00.000Z" as never,
};

class MockAppConfiguration implements IAppConfiguration {
  private values = new Map<string, AppConfigurationValue>();
  private listeners = new Map<string, Set<ChangeHandler>>();

  public constructor(values: Record<string, AppConfigurationValue>) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
  }

  public get(key: string): AppConfigurationValue {
    return this.values.get(key);
  }

  public async set(key: string, value: AppConfigurationValue): Promise<void> {
    this.values.set(key, value);
    for (const handler of this.listeners.get(key) ?? []) {
      handler(value);
    }
  }

  public addChangeListener(key: string, handler: ChangeHandler): void {
    const handlers = this.listeners.get(key) ?? new Set();
    handlers.add(handler);
    this.listeners.set(key, handlers);
  }

  public removeChangeListener(key: string, handler: ChangeHandler): void {
    this.listeners.get(key)?.delete(handler);
  }
}

function makeLocalStorage(put?: jest.Mock): jest.Mocked<ILayoutStorage> {
  const localLayouts = new Map<string, Layout>([[seededLayout.id, seededLayout]]);
  return {
    list: jest.fn(async (_namespace: string) => [...localLayouts.values()]),
    get: jest.fn(async (_namespace: string, id: LayoutID) => localLayouts.get(id)),
    put:
      put ??
      jest.fn(async (_namespace: string, layout: Layout) => {
        localLayouts.set(layout.id, layout);
        return layout;
      }),
    delete: jest.fn(async (_namespace: string, id: LayoutID) => {
      localLayouts.delete(id);
    }),
    importLayouts: jest.fn().mockResolvedValue(undefined),
    migrateUnnamespacedLayouts: jest.fn().mockResolvedValue(undefined),
  };
}

function makeRemoteStorage(
  updateLayout?: jest.Mock,
): jest.Mocked<IRemoteLayoutStorage> {
  return {
    workspace: "workspace-1",
    getLayouts: jest.fn().mockResolvedValue([remoteLayout]),
    getLayout: jest.fn().mockResolvedValue(remoteLayout),
    saveNewLayout: jest.fn(),
    updateLayout:
      updateLayout ??
      jest.fn().mockResolvedValue({ status: "success", newLayout: remoteLayout }),
    deleteLayout: jest.fn().mockResolvedValue(true),
  };
}

/** Probe that captures the layout actions and state into refs the test can drive. */
function Probe({
  actionsRef,
  statesRef,
}: {
  actionsRef: { current?: CurrentLayoutActions };
  statesRef: { current: LayoutState[] };
}): ReactNull {
  const actions = useCurrentLayoutActions();
  const state = useCurrentLayoutSelector((layoutState) => layoutState);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    actionsRef.current = actions;
    setMounted(true);
  }, [actions, actionsRef]);
  useEffect(() => {
    if (mounted) {
      statesRef.current.push(state);
    }
  }, [mounted, state, statesRef]);
  return null;
}

async function flushTimers(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe("N6 incremental apply through the real N2 auto-save chain", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("commits one edited layout and produces exactly one remote write", async () => {
    setHttpBaseUrl("http://localhost/lichtblick");
    const put = jest.fn(async (_namespace: string, layout: Layout) => layout);
    const local = makeLocalStorage(put);
    const updateLayout = jest.fn();
    updateLayout.mockResolvedValue({ status: "success", newLayout: remoteLayout });
    const remote = makeRemoteStorage(updateLayout);
    const layoutManager = new LayoutManager({ local, remote });
    layoutManager.setOnline({ online: true });

    const userProfile: UserProfileStorage = {
      getUserProfile: jest.fn().mockResolvedValue({ currentLayoutId: "layout-1" }),
      setUserProfile: jest.fn().mockResolvedValue(undefined),
    };
    const appConfiguration = new MockAppConfiguration({
      [AppSetting.VIZ_SERVER_WORKSPACE]: "workspace-1",
      [AppSetting.LAYOUT_AUTO_SAVE_TO_CLOUD]: true,
    });

    const actionsRef: { current?: CurrentLayoutActions } = {};
    const statesRef: { current: LayoutState[] } = { current: [] };
    render(
      <AppConfigurationContext.Provider value={appConfiguration}>
        <AppParametersProvider appParameters={{}}>
          <RemoteLayoutStorageContext.Provider value={remote}>
            <LayoutManagerContext.Provider value={layoutManager}>
              <UserProfileStorageContext.Provider value={userProfile}>
                <CurrentLayoutProvider loaders={[]}>
                  <CurrentLayoutSyncAdapter />
                  <CloudLayoutAutoSaveAdapter />
                  <Probe actionsRef={actionsRef} statesRef={statesRef} />
                </CurrentLayoutProvider>
              </UserProfileStorageContext.Provider>
            </LayoutManagerContext.Provider>
          </RemoteLayoutStorageContext.Provider>
        </AppParametersProvider>
      </AppConfigurationContext.Provider>,
    );

    // Initial selection settles.
    await flushTimers(0);
    expect(statesRef.current.at(-1)?.selectedLayout?.id).toBe("layout-1");
    expect(statesRef.current.at(-1)?.selectedLayout?.loading).toBe(false);

    // One atomic incremental apply (the N6 fast path the agent uses).
    act(() => {
      actionsRef.current!.addPanelsAtomically({
        layout: {
          direction: "column",
          first: "Image!camera",
          second: "Gauge!battery",
          splitPercentage: 70,
        },
        configs: { "Gauge!battery": { path: "/battery", minValue: 0, maxValue: 100 } },
      });
    });
    expect(statesRef.current.at(-1)?.selectedLayout).toMatchObject({
      edited: true,
      id: "layout-1",
    });

    // Local debounced save commits the working copy (CurrentLayoutSyncAdapter, 1s window).
    await flushTimers(1_000);
    expect(put).toHaveBeenCalled();
    expect(updateLayout).toHaveBeenCalledTimes(0);

    // The cloud auto-save window closes (≥10s): explicit save uploads the committed baseline and
    // schedules a syncWithRemote kick (itself ≥10s later). Advance PAST the kick so the assertion
    // covers the whole chain: exactly ONE remote write — the kick must not re-upload a layout the
    // explicit save already marked tracked.
    await flushTimers(CLOUD_AUTO_SAVE_SYNC_DELAY_MS + 5_000); // commit (≈11s)
    await flushTimers(CLOUD_AUTO_SAVE_SYNC_DELAY_MS + 5_000); // kick (≈21s) and settle
    await flushTimers(0);
    expect(updateLayout).toHaveBeenCalledTimes(1);
    expect(updateLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "external-1",
        id: "layout-1",
        data: expect.objectContaining({
          layout: {
            direction: "column",
            first: "Image!camera",
            second: "Gauge!battery",
            splitPercentage: 70,
          },
        }),
      }),
    );

    // The selection never changed and only one edited commit was observed.
    expect(statesRef.current.at(-1)?.selectedLayout?.id).toBe("layout-1");
    expect(
      statesRef.current.filter((state) => state.selectedLayout?.edited === true),
    ).toHaveLength(1);
  });
});
