/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { APP_CONFIG } from "@lichtblick/suite-base/constants/config";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";
import { makeMockAppConfiguration } from "@lichtblick/suite-base/util/makeMockAppConfiguration";

import {
  resolveVizServerConfigured,
  resolveWorkspace,
  resolveWorkspaceBestEffort,
} from "./vizServerParams";

jest.mock("@lichtblick/suite-base/constants/config", () => ({
  APP_CONFIG: {
    apiUrl: undefined,
    defaultWorkspace: "build-default-workspace",
  },
}));

describe("vizServerParams", () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, "", "/");
    setHttpBaseUrl(undefined);
    resolveWorkspace(
      makeMockAppConfiguration([[AppSetting.VIZ_SERVER_WORKSPACE, ""]]),
    );
  });

  it("prefers the workspace query parameter over the app setting", () => {
    globalThis.history.replaceState({}, "", "/?workspace=query-workspace");
    const configuration = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "configured-workspace"],
    ]);

    expect(resolveWorkspace(configuration)).toBe("query-workspace");
  });

  it("falls back to the configured workspace", () => {
    const configuration = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "configured-workspace"],
    ]);

    expect(resolveWorkspace(configuration)).toBe("configured-workspace");
  });

  it("returns undefined when neither workspace source is non-empty", () => {
    globalThis.history.replaceState({}, "", "/?workspace=");
    const configuration = makeMockAppConfiguration([[AppSetting.VIZ_SERVER_WORKSPACE, ""]]);

    // Temporarily remove the build-time default to verify the empty-resolution path.
    (APP_CONFIG as { defaultWorkspace?: string }).defaultWorkspace = undefined;
    try {
      expect(resolveWorkspace(configuration)).toBeUndefined();
      expect(resolveWorkspaceBestEffort()).toBeUndefined();
    } finally {
      (APP_CONFIG as { defaultWorkspace?: string }).defaultWorkspace = "build-default-workspace";
    }
  });

  it("falls back to the build-time default workspace when neither URL nor setting resolves", () => {
    globalThis.history.replaceState({}, "", "/?workspace=");
    const configuration = makeMockAppConfiguration([[AppSetting.VIZ_SERVER_WORKSPACE, ""]]);

    expect(resolveWorkspace(configuration)).toBe("build-default-workspace");
    expect(resolveWorkspaceBestEffort()).toBe("build-default-workspace");
  });

  it("prefers the URL query parameter over the build-time default workspace", () => {
    globalThis.history.replaceState({}, "", "/?workspace=query-workspace");
    const configuration = makeMockAppConfiguration([[AppSetting.VIZ_SERVER_WORKSPACE, ""]]);

    expect(resolveWorkspace(configuration)).toBe("query-workspace");
    expect(resolveWorkspaceBestEffort()).toBe("query-workspace");
  });

  it("prefers the app setting over the build-time default workspace", () => {
    globalThis.history.replaceState({}, "", "/");
    const configuration = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "configured-workspace"],
    ]);

    expect(resolveWorkspace(configuration)).toBe("configured-workspace");
  });

  it("best-effort resolution prefers the URL and otherwise uses the cached setting snapshot", () => {
    const configuration = makeMockAppConfiguration([
      [AppSetting.VIZ_SERVER_WORKSPACE, "configured-workspace"],
    ]);
    resolveWorkspace(configuration);

    expect(resolveWorkspaceBestEffort()).toBe("configured-workspace");

    globalThis.history.replaceState({}, "", "/?workspace=query-workspace");
    expect(resolveWorkspaceBestEffort()).toBe("query-workspace");
  });

  it("requires both workspace and base URL to be configured", () => {
    expect(resolveVizServerConfigured("workspace")).toBe(false);

    setHttpBaseUrl("http://viz.example.com:9903/lichtblick");

    expect(resolveVizServerConfigured(undefined)).toBe(false);
    expect(resolveVizServerConfigured("")).toBe(false);
    expect(resolveVizServerConfigured("workspace")).toBe(true);
  });
});
