/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, render } from "@testing-library/react";
import { useEffect } from "react";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import AppConfigurationContext, {
  AppConfigurationValue,
  ChangeHandler,
  IAppConfiguration,
} from "@lichtblick/suite-base/context/AppConfigurationContext";
import {
  ExtensionCatalog,
  useExtensionCatalog,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import {
  IExtensionLoader,
  LoadedExtension,
} from "@lichtblick/suite-base/services/extension/IExtensionLoader";
import ExtensionBuilder from "@lichtblick/suite-base/testing/builders/ExtensionBuilder";
import { Namespace } from "@lichtblick/suite-base/types";
import { ExtensionInfo } from "@lichtblick/suite-base/types/Extensions";

import ExtensionCatalogProvider from "./ExtensionCatalogProvider";
import { ORG_EXTENSION_AUTO_UPDATE_INTERVAL_MS } from "./OrgExtensionAutoUpdate";

jest.mock("@lichtblick/suite-base/util/isDesktopApp", () => jest.fn());

const defaultSource = `module.exports = { activate: function() { return 1; } }`;

class MockAppConfiguration implements IAppConfiguration {
  private values = new Map<string, AppConfigurationValue>();
  private listeners = new Map<string, Set<ChangeHandler>>();

  public constructor(values: Record<string, AppConfigurationValue> = {}) {
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

function createMockLoader(
  overrides: Partial<IExtensionLoader> & {
    namespace: Namespace;
    type: IExtensionLoader["type"];
  },
): IExtensionLoader {
  return {
    getExtension: jest.fn(),
    getExtensions: jest.fn().mockResolvedValue([]),
    loadExtension: jest.fn().mockResolvedValue({ raw: defaultSource }),
    installExtension: jest.fn(),
    uninstallExtension: jest.fn(),
    ...overrides,
  };
}

async function flushAllPendingPromises(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
  }
}

async function advanceOneInterval(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ORG_EXTENSION_AUTO_UPDATE_INTERVAL_MS);
    await flushAllPendingPromises();
  });
}

function StoreProbe({
  onState,
}: {
  onState: (state: ExtensionCatalog) => void;
}): ReactNull {
  const state = useExtensionCatalog((catalog) => catalog);
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
}

async function setup(options?: {
  appConfiguration?: IAppConfiguration;
  loaders?: IExtensionLoader[];
  onStoreState?: (state: ExtensionCatalog) => void;
}) {
  const config = options?.appConfiguration ?? new MockAppConfiguration();
  const loaders = options?.loaders;
  const onStoreState = options?.onStoreState;

  render(
    <AppConfigurationContext.Provider value={config}>
      <ExtensionCatalogProvider loaders={loaders ?? []}>
        {onStoreState != undefined && <StoreProbe onState={onStoreState} />}
      </ExtensionCatalogProvider>
    </AppConfigurationContext.Provider>,
  );

  // Let the mount-time refreshAllExtensions settle.
  await act(async () => {
    await flushAllPendingPromises();
  });

  return { config };
}

describe("OrgExtensionAutoUpdate", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not poll when no org server loader is wired", async () => {
    const extension = ExtensionBuilder.extensionInfo({ namespace: "local" });
    const getExtensions = jest.fn().mockResolvedValue([extension]);
    const loader = createMockLoader({
      namespace: "local",
      type: "browser",
      getExtensions,
    });

    await setup({ loaders: [loader] });

    expect(getExtensions).toHaveBeenCalledTimes(1); // mount refresh only
    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(1);
  });

  it("does not poll when AppConfiguration is absent", async () => {
    const extension = ExtensionBuilder.extensionInfo({ namespace: "org" });
    const getExtensions = jest.fn().mockResolvedValue([extension]);
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
    });

    render(
      <ExtensionCatalogProvider loaders={[loader]}>
        <div />
      </ExtensionCatalogProvider>,
    );
    await act(async () => {
      await flushAllPendingPromises();
    });

    expect(getExtensions).toHaveBeenCalledTimes(1); // mount refresh only
    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(1);
  });

  it("triggers one full refresh when the org list changed and none when it did not", async () => {
    const extensionV1 = ExtensionBuilder.extensionInfo({
      id: "publisher.extension",
      namespace: "org",
      version: "1.0.0",
    });
    const extensionV2 = { ...extensionV1, version: "2.0.0" };
    const getExtensions = jest.fn().mockResolvedValue([extensionV1]);
    const loadExtension = jest.fn().mockResolvedValue({ raw: defaultSource });
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
      loadExtension,
    });
    const storeStates: string[] = [];

    await setup({
      loaders: [loader],
      onStoreState: (state) => {
        const orgVersion = state.installedExtensions?.find(
          (extension) => extension.id === extensionV1.id,
        )?.version;
        storeStates.push(orgVersion ?? "none");
      },
    });
    storeStates.length = 0;

    // No change: the check runs but must not rebuild.
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(1);
    expect(storeStates).toEqual([]);

    // The org publishes 2.0.0: the next check must rebuild exactly once.
    getExtensions.mockResolvedValue([extensionV2]);
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(2);
    expect(loadExtension).toHaveBeenLastCalledWith(extensionV1.id);
    // The rebuild converges the registry on the org-published version.
    expect(storeStates.at(-1)).toBe("2.0.0");

    // After the rebuild the installed version matches the remote list again.
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(2);
  });

  it("does not poll while the switch is off, and starts polling after it is enabled", async () => {
    const extension = ExtensionBuilder.extensionInfo({ namespace: "org" });
    const getExtensions = jest.fn().mockResolvedValue([extension]);
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
    });
    const config = new MockAppConfiguration({
      [AppSetting.EXTENSION_AUTO_UPDATE_ORG]: false,
    });

    await setup({ appConfiguration: config, loaders: [loader] });
    expect(getExtensions).toHaveBeenCalledTimes(1); // mount refresh only

    await advanceOneInterval();
    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(1);

    // Enabling the switch mid-session starts the periodic check.
    await act(async () => {
      await config.set(AppSetting.EXTENSION_AUTO_UPDATE_ORG, true);
    });
    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(2);
  });

  it("stops polling when the switch is turned off mid-session", async () => {
    const extension = ExtensionBuilder.extensionInfo({ namespace: "org" });
    const getExtensions = jest.fn().mockResolvedValue([extension]);
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
    });
    const config = new MockAppConfiguration();

    await setup({ appConfiguration: config, loaders: [loader] });
    expect(getExtensions).toHaveBeenCalledTimes(1);

    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(2);

    await act(async () => {
      await config.set(AppSetting.EXTENSION_AUTO_UPDATE_ORG, false);
    });
    await advanceOneInterval();
    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(2);
  });

  it("defaults to enabled when the switch has no stored value", async () => {
    const extension = ExtensionBuilder.extensionInfo({ namespace: "org" });
    const getExtensions = jest.fn().mockResolvedValue([extension]);
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
    });

    await setup({ loaders: [loader] });

    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(2);
  });

  it("retries on the next round after the org list fetch fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const extension = ExtensionBuilder.extensionInfo({ namespace: "org" });
    const getExtensions = jest.fn().mockResolvedValue([extension]);
    const loadExtension = jest.fn().mockResolvedValue({ raw: defaultSource });
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
      loadExtension,
    });

    await setup({ loaders: [loader] });

    getExtensions.mockRejectedValueOnce(new Error("network down"));
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(1); // no rebuild after a failed check

    getExtensions.mockResolvedValue([{ ...extension, version: "2.0.0" }]);
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(2); // recovered and rebuilt

    (console.warn as jest.Mock).mockRestore();
  });

  it("never starts a second round while a slow remote fetch is still pending", async () => {
    const extensionV1 = ExtensionBuilder.extensionInfo({
      id: "publisher.extension",
      namespace: "org",
      version: "1.0.0",
    });
    const extensionV2 = { ...extensionV1, version: "2.0.0" };
    const getExtensions = jest.fn().mockResolvedValue([extensionV1]);
    const loadExtension = jest.fn().mockResolvedValue({ raw: defaultSource });
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
      loadExtension,
    });

    await setup({ loaders: [loader] });

    // The org publishes 2.0.0 and the next remote fetch hangs across several rounds. The round
    // that started it must hold the in-flight flag from its first await onward.
    let resolveSlowFetch!: (value: ExtensionInfo[]) => void;
    const slowFetch = new Promise<ExtensionInfo[]>((resolve) => {
      resolveSlowFetch = resolve;
    });
    getExtensions
      .mockReturnValueOnce(slowFetch) // round 1 check
      .mockResolvedValueOnce([extensionV2]); // refreshAllExtensions' internal list fetch

    // Round 1 starts the slow fetch; the in-flight flag is already held.
    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(2);
    expect(loadExtension).toHaveBeenCalledTimes(1);

    // Rounds 2 and 3 bail out before fetching while the round-1 fetch is still pending.
    await advanceOneInterval();
    await advanceOneInterval();
    expect(getExtensions).toHaveBeenCalledTimes(2);
    expect(loadExtension).toHaveBeenCalledTimes(1);

    // The slow fetch resolves with a changed list: exactly one rebuild happens.
    await act(async () => {
      resolveSlowFetch([extensionV2]);
      await flushAllPendingPromises();
    });
    expect(loadExtension).toHaveBeenCalledTimes(2);
    expect(loadExtension).toHaveBeenLastCalledWith(extensionV1.id);

    // The flag is released; the next round sees matching versions and stays idle.
    getExtensions.mockResolvedValue([extensionV2]);
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(2);
  });

  it("never triggers a second refresh while one is still in flight", async () => {
    const extensionV1 = ExtensionBuilder.extensionInfo({
      id: "publisher.extension",
      namespace: "org",
      version: "1.0.0",
    });
    const extensionV2 = { ...extensionV1, version: "2.0.0" };
    const getExtensions = jest.fn().mockResolvedValue([extensionV1]);
    const loadExtension = jest.fn().mockResolvedValue({ raw: defaultSource });
    const loader = createMockLoader({
      namespace: "org",
      type: "server",
      getExtensions,
      loadExtension,
    });

    await setup({ loaders: [loader] });

    // The org publishes 2.0.0 and the rebuild hangs (slow remote download).
    let resolveSlowLoad!: (value: LoadedExtension) => void;
    const slowLoad = new Promise<LoadedExtension>((resolve) => {
      resolveSlowLoad = resolve;
    });
    getExtensions.mockResolvedValue([extensionV2]);
    loadExtension.mockReturnValueOnce(slowLoad);

    await advanceOneInterval();
    // The check fetched the list once and the rebuild fetched it again internally.
    expect(loadExtension).toHaveBeenCalledTimes(2); // rebuild started
    expect(getExtensions).toHaveBeenCalledTimes(3);

    // While the rebuild is in flight, later rounds must not start another one.
    await advanceOneInterval();
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(2);
    expect(getExtensions).toHaveBeenCalledTimes(3); // both later rounds bailed out early

    // The rebuild finishes; the next round sees matching versions and stays idle.
    await act(async () => {
      resolveSlowLoad({ raw: defaultSource });
      await flushAllPendingPromises();
    });
    await advanceOneInterval();
    expect(loadExtension).toHaveBeenCalledTimes(2);
    expect(getExtensions).toHaveBeenCalledTimes(4);
  });
});
