// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Resolves the management API base from the configured viz-server URL.
 *
 * The configured base URL usually carries a `/lichtblick` path segment (for example
 * `https://host/lichtblick`) that proxies the workspace API, while management endpoints live
 * under the origin (for example `https://host/api/v1/...`). This helper strips a trailing
 * `lichtblick` path segment — parsed as a URL, never string-sliced.
 *
 * Returns `undefined` for unparseable or non-http(s) input so callers can fail closed.
 */
export function resolveManagementBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  if (baseUrl == undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[segments.length - 1] === "lichtblick") {
    segments.pop();
  }
  return segments.length === 0
    ? parsed.origin
    : `${parsed.origin}/${segments.join("/")}`;
}

/**
 * Builds an endpoint string relative to `baseUrl` that resolves to
 * `{managementBase}{apiPath}` once the HTTP client prepends `baseUrl`.
 *
 * The HTTP client always requests `${baseUrl}/${endpoint}`; the `..` segments produced here are
 * normalized by the URL parser before the request is sent. For a base of `https://host/lichtblick`
 * and a management API path of `/api/v1/layouts/x/default` this yields
 * `../api/v1/layouts/x/default`, which resolves to `https://host/api/v1/layouts/x/default`.
 */
export function resolveManagementEndpoint(
  baseUrl: string,
  managementBase: string,
  apiPath: string,
): string {
  const from = new URL(baseUrl);
  const target = new URL(`${managementBase}${apiPath}`);
  const fromSegments = from.pathname.split("/").filter((segment) => segment.length > 0);
  const targetSegments = target.pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  let common = 0;
  while (
    common < fromSegments.length &&
    common < targetSegments.length &&
    fromSegments[common] === targetSegments[common]
  ) {
    common++;
  }
  const upwards = fromSegments.length - common;
  return [
    ...Array.from({ length: upwards }, () => ".."),
    ...targetSegments.slice(common),
  ].join("/");
}
