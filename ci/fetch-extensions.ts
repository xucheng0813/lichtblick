// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

// Downloads the .foxe extensions listed in ci/extensions.json into .extensions/, which the web and
// desktop builds copy into their output and the app installs on first run.
//
// These archives are tens of megabytes and are hosted on an internal server, so they are not
// committed to git. Already-downloaded files with a matching SHA-256 are left alone, which makes
// this cheap to run before every build.

import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";

const REPO_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "ci", "extensions.json");
const OUTPUT_DIR = path.join(REPO_ROOT, ".extensions");
/** Emitted alongside the archives and read by the app at runtime to decide what to install. */
const RUNTIME_MANIFEST = "bundled.json";

type ManifestEntry = {
  id: string;
  version: string;
  file: string;
  url: string;
  sha256: string;
};

function sha256(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function readIfMatching(filePath: string, expected: string): Promise<boolean> {
  try {
    return sha256(new Uint8Array(await fs.readFile(filePath))) === expected;
  } catch {
    return false;
  }
}

/**
 * Raised when the extension host cannot be reached at all. Distinct from a checksum mismatch: with
 * --optional this is tolerated, because CI runners outside the internal network legitimately cannot
 * reach it, whereas a corrupted artifact is never acceptable.
 */
class ExtensionHostUnreachableError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtensionHostUnreachableError";
  }
}

async function download(entry: ManifestEntry, destination: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(entry.url);
  } catch (error) {
    throw new ExtensionHostUnreachableError(
      `Cannot reach the extension host for ${entry.file} at ${entry.url}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new ExtensionHostUnreachableError(
      `Failed to download ${entry.file}: ${response.status} ${response.statusText}. ` +
        `The extension host must be reachable from this machine.`,
    );
  }
  const data = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(data);
  if (actual !== entry.sha256) {
    // A mismatch means the published artifact changed under a version that is supposed to be
    // immutable. Writing it anyway would silently ship an unreviewed extension.
    throw new Error(
      `Checksum mismatch for ${entry.file}.\n  expected ${entry.sha256}\n  actual   ${actual}`,
    );
  }
  // Write to a temporary file first so an interrupted run cannot leave a truncated archive that a
  // later run would have to detect as corrupt.
  const temporary = `${destination}.download`;
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, destination);
}

async function main(): Promise<void> {
  // The extension host is on an internal network that GitHub-hosted runners cannot reach, so CI
  // passes --optional: an unreachable host degrades to a build without bundled extensions rather
  // than a failed build. A checksum mismatch still fails even with --optional.
  const optional = process.argv.includes("--optional");
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")) as {
    extensions: ManifestEntry[];
  };
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const available: ManifestEntry[] = [];
  for (const entry of manifest.extensions) {
    const destination = path.join(OUTPUT_DIR, entry.file);
    if (await readIfMatching(destination, entry.sha256)) {
      console.log(`up to date  ${entry.file}`);
      available.push(entry);
      continue;
    }
    console.log(`downloading ${entry.file} from ${entry.url}`);
    try {
      await download(entry, destination);
    } catch (error) {
      if (optional && error instanceof ExtensionHostUnreachableError) {
        console.warn(`skipped     ${entry.file}: ${error.message}`);
        continue;
      }
      throw error;
    }
    console.log(`downloaded  ${entry.file}`);
    available.push(entry);
  }

  // The runtime manifest lists only what is actually on disk, so the app never tries to install an
  // archive this build does not ship.
  await fs.writeFile(
    path.join(OUTPUT_DIR, RUNTIME_MANIFEST),
    `${JSON.stringify(
      available.map(({ id, version, file }) => ({ id, version, file })),
      undefined,
      2,
    )}\n`,
    "utf8",
  );

  if (available.length < manifest.extensions.length) {
    console.warn(
      `\n${String(manifest.extensions.length - available.length)} of ` +
        `${String(manifest.extensions.length)} extensions were not downloaded. ` +
        `This build will not include them.`,
    );
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
