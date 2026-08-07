// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import ExtensionBuilder from "@lichtblick/suite-base/testing/builders/ExtensionBuilder";

import { orgExtensionsChanged } from "./orgExtensionComparison";

function orgExtension(overrides: { id: string; version: string }) {
  return ExtensionBuilder.extensionInfo({
    id: overrides.id,
    namespace: "org",
    version: overrides.version,
  });
}

describe("orgExtensionsChanged", () => {
  it("returns false when every remote org extension is installed with the same version", () => {
    const remote = [orgExtension({ id: "a.b", version: "1.0.0" })];
    const installed = [orgExtension({ id: "a.b", version: "1.0.0" })];

    expect(orgExtensionsChanged(remote, installed)).toBe(false);
  });

  it("treats equivalent version spellings as the same version", () => {
    const remote = [orgExtension({ id: "a.b", version: "1.0" })];
    const installed = [orgExtension({ id: "a.b", version: "1.0.0" })];

    expect(orgExtensionsChanged(remote, installed)).toBe(false);
  });

  it("returns true when a remote org extension has a newer version than installed", () => {
    const remote = [orgExtension({ id: "a.b", version: "2.0.0" })];
    const installed = [orgExtension({ id: "a.b", version: "1.0.0" })];

    expect(orgExtensionsChanged(remote, installed)).toBe(true);
  });

  it("returns true when a remote org extension has an older version than installed", () => {
    // Any version difference (not only upgrades) requires a rebuild so the device converges on
    // the org-published version.
    const remote = [orgExtension({ id: "a.b", version: "0.9.0" })];
    const installed = [orgExtension({ id: "a.b", version: "1.0.0" })];

    expect(orgExtensionsChanged(remote, installed)).toBe(true);
  });

  it("returns true when the remote list contains a brand-new org extension", () => {
    const remote = [
      orgExtension({ id: "a.b", version: "1.0.0" }),
      orgExtension({ id: "c.d", version: "1.0.0" }),
    ];
    const installed = [orgExtension({ id: "a.b", version: "1.0.0" })];

    expect(orgExtensionsChanged(remote, installed)).toBe(true);
  });

  it("returns false when only one of several remote extensions is missing locally", () => {
    // "Remote missing" — an installed org extension absent from the remote list — must not count
    // as a change: a transient empty or partial remote response must never wipe the installed
    // org set mid-session.
    const remote = [orgExtension({ id: "a.b", version: "1.0.0" })];
    const installed = [
      orgExtension({ id: "a.b", version: "1.0.0" }),
      orgExtension({ id: "removed.b", version: "1.0.0" }),
    ];

    expect(orgExtensionsChanged(remote, installed)).toBe(false);
  });

  it("ignores extensions installed under a different namespace with the same id", () => {
    const remote = [orgExtension({ id: "shared.id", version: "1.0.0" })];
    const installed = [
      ExtensionBuilder.extensionInfo({
        id: "shared.id",
        namespace: "local",
        version: "1.0.0",
      }),
    ];

    // The org copy is not installed, so the org list changed from the org perspective.
    expect(orgExtensionsChanged(remote, installed)).toBe(true);
  });

  it("ignores remote entries that carry a non-org namespace", () => {
    const remote = [
      ExtensionBuilder.extensionInfo({
        id: "local.id",
        namespace: "local",
        version: "1.0.0",
      }),
    ];
    const installed: never[] = [];

    expect(orgExtensionsChanged(remote, installed)).toBe(false);
  });

  it("returns true for a change among many unchanged extensions", () => {
    const remote = [
      orgExtension({ id: "a.b", version: "1.0.0" }),
      orgExtension({ id: "c.d", version: "2.0.0" }),
      orgExtension({ id: "e.f", version: "3.0.0" }),
    ];
    const installed = [
      orgExtension({ id: "a.b", version: "1.0.0" }),
      orgExtension({ id: "c.d", version: "1.9.0" }),
      orgExtension({ id: "e.f", version: "3.0.0" }),
    ];

    expect(orgExtensionsChanged(remote, installed)).toBe(true);
  });

  it("returns true for a non-numeric version difference", () => {
    const remote = [orgExtension({ id: "a.b", version: "dev" })];
    const installed = [orgExtension({ id: "a.b", version: "nightly" })];

    expect(orgExtensionsChanged(remote, installed)).toBe(true);
  });

  it("returns false for identical non-numeric versions", () => {
    const remote = [orgExtension({ id: "a.b", version: "dev" })];
    const installed = [orgExtension({ id: "a.b", version: "dev" })];

    expect(orgExtensionsChanged(remote, installed)).toBe(false);
  });

  it("treats an empty remote list as no change even when extensions are installed", () => {
    const installed = [orgExtension({ id: "a.b", version: "1.0.0" })];

    expect(orgExtensionsChanged([], installed)).toBe(false);
  });

  it("returns true when nothing is installed yet and the remote list is non-empty", () => {
    const remote = [orgExtension({ id: "a.b", version: "1.0.0" })];

    expect(orgExtensionsChanged(remote, undefined)).toBe(true);
  });

  it("returns false when nothing is installed yet and the remote list has only non-org entries", () => {
    const remote = [
      ExtensionBuilder.extensionInfo({
        id: "local.id",
        namespace: "local",
        version: "1.0.0",
      }),
    ];

    expect(orgExtensionsChanged(remote, undefined)).toBe(false);
  });

  it("counts org entries when nothing is installed yet and the remote list is mixed", () => {
    const remote = [
      ExtensionBuilder.extensionInfo({
        id: "local.id",
        namespace: "local",
        version: "1.0.0",
      }),
      orgExtension({ id: "a.b", version: "1.0.0" }),
    ];

    expect(orgExtensionsChanged(remote, undefined)).toBe(true);
  });

  it("returns false when nothing is installed yet and the remote list is empty", () => {
    expect(orgExtensionsChanged([], undefined)).toBe(false);
  });
});
