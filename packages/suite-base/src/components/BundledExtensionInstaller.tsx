// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect, useRef } from "react";

import Logger from "@lichtblick/log";
import {
  useExtensionCatalog,
  type ExtensionCatalog,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import compareVersions from "@lichtblick/suite-base/services/extension/utils/compareVersions";

const log = Logger.getLogger(__filename);

/** Written next to the archives by `ci/fetch-extensions.ts`. */
const BUNDLED_MANIFEST_URL = "extensions/bundled.json";

type BundledExtension = {
  id: string;
  version: string;
  file: string;
};

const selectDownloadExtension = (registry: ExtensionCatalog) => registry.downloadExtension;
const selectInstallExtensions = (registry: ExtensionCatalog) => registry.installExtensions;
const selectInstalledExtensions = (registry: ExtensionCatalog) => registry.installedExtensions;

function isBundledExtension(value: unknown): value is BundledExtension {
  if (typeof value !== "object" || value == undefined) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.file === "string"
  );
}

/**
 * Installs the `.foxe` extensions shipped with the build.
 *
 * These are fetched at build time by `yarn extensions:fetch` and copied into `extensions/` in the
 * output. Installing them at runtime rather than special-casing them in the extension catalog keeps
 * them ordinary local extensions: the user can inspect, disable, or uninstall them like any other.
 *
 * Every failure mode here is non-fatal. A build without bundled extensions, an unreachable file, or
 * a malformed manifest must not stop the app from starting.
 */
export function BundledExtensionInstaller(): ReactNull {
  const downloadExtension = useExtensionCatalog(selectDownloadExtension);
  const installExtensions = useExtensionCatalog(selectInstallExtensions);
  const installedExtensions = useExtensionCatalog(selectInstalledExtensions);
  // The catalog is only trustworthy once it has been read; before that `installedExtensions` is
  // undefined and installing would duplicate work on every startup.
  const ready = installedExtensions != undefined;
  const attempted = useRef(false);

  useEffect(() => {
    if (!ready || attempted.current) {
      return;
    }
    attempted.current = true;

    const installBundledExtensions = async () => {
      let manifest: unknown;
      try {
        const response = await fetch(BUNDLED_MANIFEST_URL);
        if (!response.ok) {
          // A build produced without `yarn extensions:fetch` simply has no manifest.
          log.debug(`No bundled extension manifest (${response.status})`);
          return;
        }
        manifest = await response.json();
      } catch (error) {
        log.debug("No bundled extension manifest available", error);
        return;
      }

      if (!Array.isArray(manifest)) {
        log.error("Bundled extension manifest is not an array");
        return;
      }

      for (const entry of manifest) {
        if (!isBundledExtension(entry)) {
          log.error("Skipping malformed bundled extension entry");
          continue;
        }
        const existing = installedExtensions.find((extension) => extension.id === entry.id);
        if (existing != undefined && compareVersions(existing.version, entry.version) >= 0) {
          continue;
        }
        try {
          const buffer = await downloadExtension(`extensions/${entry.file}`);
          await installExtensions("local", [{ buffer }]);
          log.info(`Installed bundled extension ${entry.id}@${entry.version}`);
        } catch (error) {
          // One bad extension must not prevent the others from installing.
          log.error(`Failed to install bundled extension ${entry.id}`, error);
        }
      }
    };

    void installBundledExtensions();
  }, [downloadExtension, installExtensions, installedExtensions, ready]);

  return ReactNull;
}
