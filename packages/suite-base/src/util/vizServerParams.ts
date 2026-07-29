// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { IAppConfiguration } from "@lichtblick/suite-base/context/AppConfigurationContext";
import { getHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

export function resolveWorkspace(
  appConfiguration: IAppConfiguration | undefined,
): string | undefined {
  const queryWorkspace = new URL(globalThis.location.href).searchParams.get("workspace");
  if (queryWorkspace) {
    return queryWorkspace;
  }

  const configuredWorkspace = appConfiguration?.get(AppSetting.VIZ_SERVER_WORKSPACE);
  return typeof configuredWorkspace === "string" && configuredWorkspace !== ""
    ? configuredWorkspace
    : undefined;
}

export function resolveVizServerConfigured(workspace: string | undefined): workspace is string {
  return workspace != undefined && workspace !== "" && Boolean(getHttpBaseUrl());
}
