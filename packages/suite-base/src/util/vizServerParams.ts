// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { APP_CONFIG } from "@lichtblick/suite-base/constants/config";
import { IAppConfiguration } from "@lichtblick/suite-base/context/AppConfigurationContext";
import { getHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

let configuredWorkspaceSnapshot: string | undefined;

function resolveQueryWorkspace(): string | undefined {
  const workspace = new URL(globalThis.location.href).searchParams.get("workspace");
  return workspace == undefined || workspace === "" ? undefined : workspace;
}

export function resolveWorkspace(
  appConfiguration: IAppConfiguration | undefined,
): string | undefined {
  const queryWorkspace = resolveQueryWorkspace();
  const configuredWorkspace = appConfiguration?.get(AppSetting.VIZ_SERVER_WORKSPACE);
  const normalizedConfiguredWorkspace =
    typeof configuredWorkspace === "string" && configuredWorkspace !== ""
      ? configuredWorkspace
      : undefined;

  if (appConfiguration != undefined) {
    // Module-level Agent configuration selection cannot receive AppConfiguration. Keep the most
    // recently resolved setting as a best-effort snapshot; application roots call this function
    // before rendering the Agent workspace.
    configuredWorkspaceSnapshot = normalizedConfiguredWorkspace;
  }

  if (queryWorkspace) {
    return queryWorkspace;
  }

  return normalizedConfiguredWorkspace ?? APP_CONFIG.defaultWorkspace;
}

/**
 * Resolves workspace without an AppConfiguration handle.
 *
 * URL state remains authoritative. The setting fallback is the last snapshot captured by
 * resolveWorkspace(appConfiguration), which application roots invoke during startup.
 */
export function resolveWorkspaceBestEffort(): string | undefined {
  return (
    resolveQueryWorkspace() ?? configuredWorkspaceSnapshot ?? APP_CONFIG.defaultWorkspace
  );
}

export function resolveVizServerConfigured(workspace: string | undefined): workspace is string {
  return workspace != undefined && workspace !== "" && Boolean(getHttpBaseUrl());
}
