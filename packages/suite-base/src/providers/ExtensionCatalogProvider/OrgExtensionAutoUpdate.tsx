// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useContext, useEffect, useMemo, useRef, useState } from "react";

import Logger from "@lichtblick/log";
import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import AppConfigurationContext, {
  IAppConfiguration,
} from "@lichtblick/suite-base/context/AppConfigurationContext";
import { ExtensionCatalogContext } from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { IExtensionLoader } from "@lichtblick/suite-base/services/extension/IExtensionLoader";
import { ExtensionInfo } from "@lichtblick/suite-base/types/Extensions";

import { orgExtensionsChanged } from "./orgExtensionComparison";

const log = Logger.getLogger(__filename);

/**
 * Interval between periodic org extension update checks. Matches the 5-minute rhythm used by the
 * agent bootstrap refresh.
 */
export const ORG_EXTENSION_AUTO_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The AppSetting.EXTENSION_AUTO_UPDATE_ORG switch is default-on and controls only this in-session
 * periodic check. The startup update pass inside ExtensionCatalogProvider is existing behavior and
 * is not gated by it.
 */
function useOrgExtensionAutoUpdateEnabled(
  appConfiguration: IAppConfiguration | undefined,
): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => {
    const value = appConfiguration?.get(AppSetting.EXTENSION_AUTO_UPDATE_ORG);
    return typeof value === "boolean" ? value : true;
  });

  useEffect(() => {
    if (appConfiguration == undefined) {
      return;
    }
    const handler = (value: unknown) => {
      setEnabled(typeof value === "boolean" ? value : true);
    };
    appConfiguration.addChangeListener(AppSetting.EXTENSION_AUTO_UPDATE_ORG, handler);
    return () => {
      appConfiguration.removeChangeListener(AppSetting.EXTENSION_AUTO_UPDATE_ORG, handler);
    };
  }, [appConfiguration]);

  return enabled;
}

/**
 * Periodically compares the remote organization extension list against the installed org
 * extensions and triggers a full `refreshAllExtensions()` rebuild only when a new extension or a
 * version change is detected. No changes means no rebuild, so the extension registry is not
 * remounted every interval.
 *
 * Trust boundary: the same remote loader trust model as startup updates is used; no additional
 * signature verification is performed. Failures are logged and retried on the next round; a round
 * never triggers more than one refresh.
 */
export function OrgExtensionAutoUpdate({
  loaders,
}: {
  loaders: readonly IExtensionLoader[];
}): ReactNull {
  const appConfiguration = useContext(AppConfigurationContext);
  const catalogStore = useContext(ExtensionCatalogContext);
  const enabled = useOrgExtensionAutoUpdateEnabled(appConfiguration);
  const orgServerLoader = useMemo(
    () =>
      loaders.find(
        (loader) => loader.namespace === "org" && loader.type === "server",
      ),
    [loaders],
  );
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    if (
      appConfiguration == undefined ||
      catalogStore == undefined ||
      !enabled ||
      orgServerLoader == undefined
    ) {
      return;
    }

    let cancelled = false;

    const checkForOrgUpdates = async (): Promise<void> => {
      if (refreshInFlightRef.current) {
        return;
      }
      // Held from the moment a round starts so a remote fetch slower than one interval can never
      // overlap with the next round's fetch-and-rebuild.
      refreshInFlightRef.current = true;
      try {
        let remoteOrgExtensions: ExtensionInfo[];
        try {
          remoteOrgExtensions = await orgServerLoader.getExtensions();
        } catch (error) {
          // Fail silently: the next round retries.
          log.warn("Failed to check for organization extension updates", error);
          return;
        }
        if (cancelled) {
          return;
        }
        const installedExtensions = catalogStore.getState().installedExtensions;
        if (!orgExtensionsChanged(remoteOrgExtensions, installedExtensions)) {
          return;
        }
        try {
          await catalogStore.getState().refreshAllExtensions();
        } catch (error) {
          log.warn("Failed to refresh extensions after org update check", error);
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    const interval = setInterval(
      () => void checkForOrgUpdates(),
      ORG_EXTENSION_AUTO_UPDATE_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [appConfiguration, catalogStore, enabled, orgServerLoader]);

  return null;
}
