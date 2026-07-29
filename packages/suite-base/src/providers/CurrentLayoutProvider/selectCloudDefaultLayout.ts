// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import Logger from "@lichtblick/log";
import { LayoutID } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { ILayoutManager } from "@lichtblick/suite-base/services/ILayoutManager";
import { IRemoteLayoutStorage } from "@lichtblick/suite-base/services/IRemoteLayoutStorage";
import delay from "@lichtblick/suite-base/util/delay";

const log = Logger.getLogger(__filename);

export const CLOUD_DEFAULT_LAYOUT_POLLING_INTERVAL_MS = 250;
export const CLOUD_DEFAULT_LAYOUT_TIMEOUT_MS = 10_000;

type SelectCloudDefaultLayoutProps = {
  layoutManager: Pick<ILayoutManager, "getLayouts">;
  remoteLayoutStorage: IRemoteLayoutStorage | undefined;
  selectLayout: (id: LayoutID) => Promise<unknown>;
};

/**
 * Selects the remote default only after the normal layout sync has cached the same layout id.
 * The remote DTO must never be saved through LayoutManager because that would create a second id.
 */
export async function selectCloudDefaultLayout({
  layoutManager,
  remoteLayoutStorage,
  selectLayout,
}: SelectCloudDefaultLayoutProps): Promise<boolean> {
  if (remoteLayoutStorage?.getDefaultLayout == undefined) {
    return false;
  }

  try {
    const defaultLayout = await remoteLayoutStorage.getDefaultLayout();
    if (defaultLayout == undefined) {
      return false;
    }

    const deadline = Date.now() + CLOUD_DEFAULT_LAYOUT_TIMEOUT_MS;
    for (;;) {
      const layouts = await layoutManager.getLayouts();
      if (layouts.some((layout) => layout.id === defaultLayout.id)) {
        await selectLayout(defaultLayout.id);
        return true;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        log.debug(
          `Cloud default layout ${defaultLayout.id} was not cached within ${CLOUD_DEFAULT_LAYOUT_TIMEOUT_MS}ms`,
        );
        return false;
      }
      await delay(Math.min(CLOUD_DEFAULT_LAYOUT_POLLING_INTERVAL_MS, remainingMs));
    }
  } catch (error) {
    log.debug("Unable to select the cloud default layout", error);
    return false;
  }
}
