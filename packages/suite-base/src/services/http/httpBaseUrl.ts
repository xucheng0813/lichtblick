// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { APP_CONFIG } from "@lichtblick/suite-base/constants/config";

let httpBaseUrlOverride: string | undefined;

function removeTrailingSlashes(url: string | undefined): string | undefined {
  return url?.replace(/\/+$/, "");
}

export function setHttpBaseUrl(url: string | undefined): void {
  httpBaseUrlOverride = removeTrailingSlashes(url);
}

export function getHttpBaseUrl(): string | undefined {
  return removeTrailingSlashes(httpBaseUrlOverride ?? APP_CONFIG.apiUrl);
}
