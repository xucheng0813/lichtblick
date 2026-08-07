// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import compareVersions from "@lichtblick/suite-base/services/extension/utils/compareVersions";
import { ExtensionInfo } from "@lichtblick/suite-base/types/Extensions";

/**
 * Namespace-aware comparison of the remote organization extension list against the locally
 * installed extensions, used by the periodic in-session org extension update check.
 *
 * Matching is scoped to the "org" namespace on both sides: an extension installed under another
 * namespace (e.g. "local") with the same id is never treated as satisfying the org list, and
 * remote entries carrying a non-org namespace are ignored.
 *
 * Returns true when any remote org extension has no locally installed org extension with the same
 * id and version — i.e. a new org extension or a version change. Extensions that exist locally but
 * are absent from the remote list do NOT count as changed: a transient empty or partial remote
 * response must never wipe the installed org set mid-session; deletions are picked up by the next
 * startup refresh.
 */
export function orgExtensionsChanged(
  remoteOrgExtensions: readonly ExtensionInfo[],
  installedExtensions: readonly ExtensionInfo[] | undefined,
): boolean {
  // Only org-namespace entries of the remote list participate in the comparison; entries carrying
  // another namespace are ignored regardless of the installed state.
  const remoteOrg = remoteOrgExtensions.filter(
    (remote) => remote.namespace == undefined || remote.namespace === "org",
  );

  // The catalog exposes installedExtensions as undefined until the first refresh completes.
  // Nothing is installed yet, so only a non-empty org remote list is worth a refresh.
  if (installedExtensions == undefined) {
    return remoteOrg.length > 0;
  }

  return remoteOrg.some((remote) => {
    const installed = installedExtensions.find(
      (candidate) => candidate.namespace === "org" && candidate.id === remote.id,
    );
    if (installed == undefined) {
      return true;
    }
    const sameVersion =
      installed.version === remote.version ||
      compareVersions(installed.version, remote.version) === 0;
    return !sameVersion;
  });
}
