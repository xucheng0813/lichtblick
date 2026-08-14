/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { render } from "@testing-library/react";

import { BasicBuilder } from "@lichtblick/test-builders";

import { WebRoot } from "./WebRoot";

const mockSharedRootProps: Array<Record<string, unknown>> = [];
const mockCallOrder: string[] = [];
const mockPrefetchSession = jest.fn();
const mockSetHttpBaseUrl = jest.fn();
const mockGetHttpBaseUrl = jest.fn().mockReturnValue(undefined);
const mockAppConfigGet = jest.fn().mockReturnValue(undefined);

jest.mock("@lichtblick/suite-base", () => {
  const Stub = jest.fn();
  return {
    __esModule: true,
    AppSetting: { SHOW_DEBUG_PANELS: "showDebugPanels" },
    IdbExtensionLoader: Stub,
    RemoteExtensionLoader: Stub,
    FoxgloveWebSocketDataSourceFactory: Stub,
    McapLocalDataSourceFactory: Stub,
    RemoteDataSourceFactory: Stub,
    Ros1LocalBagDataSourceFactory: Stub,
    Ros2LocalBagDataSourceFactory: Stub,
    RosbridgeDataSourceFactory: Stub,
    SampleNuscenesDataSourceFactory: Stub,
    UlogLocalDataSourceFactory: Stub,
    SharedRoot: (props: Record<string, unknown>) => {
      mockCallOrder.push("sharedroot");
      mockSharedRootProps.push(props);
      return null;
    },
  };
});

jest.mock("@lichtblick/suite-base/api/mcapBundle/sessionPrefetch", () => ({
  prefetchSession: (...args: unknown[]) => {
    mockCallOrder.push("prefetchSession");
    mockPrefetchSession(...args);
  },
}));

jest.mock("@lichtblick/suite-base/services/http/httpBaseUrl", () => ({
  setHttpBaseUrl: (...args: unknown[]) => {
    mockCallOrder.push("setHttpBaseUrl");
    mockSetHttpBaseUrl(...args);
  },
  getHttpBaseUrl: () => mockGetHttpBaseUrl(),
}));

jest.mock("@lichtblick/suite-base/constants/config", () => ({
  APP_CONFIG: { apiUrl: undefined },
}));

jest.mock("./services/LocalStorageAppConfiguration", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    get: mockAppConfigGet,
  })),
}));

describe("WebRoot", () => {
  beforeEach(() => {
    mockSharedRootProps.length = 0;
    mockCallOrder.length = 0;
    mockAppConfigGet.mockReturnValue(undefined);
    jest.clearAllMocks();
    globalThis.history.replaceState({}, "", "/");
  });

  const renderWebRoot = () =>
    render(
      <WebRoot extraProviders={undefined} dataSources={undefined}>
        <div />
      </WebRoot>,
    );

  it("maps the ?layout= query parameter to appParameters.defaultLayout", () => {
    const layout = BasicBuilder.string();
    globalThis.history.replaceState({}, "", `/?layout=${layout}`);
    renderWebRoot();
    expect(mockSharedRootProps).toHaveLength(1);
    expect(mockSharedRootProps[0]!.appParameters).toEqual({ defaultLayout: layout });
  });

  it("provides empty appParameters when no layout query parameter is present", () => {
    renderWebRoot();
    expect(mockSharedRootProps[0]!.appParameters).toEqual({});
  });

  it("treats an empty ?layout= value the same as a missing layout parameter", () => {
    globalThis.history.replaceState({}, "", "/?layout=");
    renderWebRoot();
    expect(mockSharedRootProps[0]!.appParameters).toEqual({});
  });

  it("ignores unrelated query parameters when building appParameters", () => {
    const workspace = BasicBuilder.string();
    globalThis.history.replaceState({}, "", `/?workspace=${workspace}`);
    renderWebRoot();
    expect(mockSharedRootProps[0]!.appParameters).toEqual({});
  });

  it("prefetches the session during render, after the base URL is configured and before mount", () => {
    globalThis.history.replaceState({}, "", "/?mcap-bundle=abc-123");
    renderWebRoot();
    expect(mockCallOrder).toEqual(["setHttpBaseUrl", "prefetchSession", "sharedroot"]);
    expect(mockPrefetchSession).toHaveBeenCalledWith("abc-123");
  });

  it("prefetches the session even when no base URL is configured", () => {
    // The LocalStorageAppConfiguration mock returns undefined for every setting,
    // so no base URL is configured: the prefetch still runs and the request will
    // go to the same-origin relative "session/<id>" endpoint.
    globalThis.history.replaceState({}, "", "/?mcap-bundle=abc-123");
    renderWebRoot();
    expect(mockCallOrder).toEqual(["setHttpBaseUrl", "prefetchSession", "sharedroot"]);
    expect(mockSetHttpBaseUrl).toHaveBeenCalledWith(undefined);
    expect(mockPrefetchSession).toHaveBeenCalledWith("abc-123");
  });

  it("prefetches with the configured base URL", () => {
    mockAppConfigGet.mockReturnValue("https://api.example.com/");
    globalThis.history.replaceState({}, "", "/?mcap-bundle=abc-123");
    renderWebRoot();
    expect(mockCallOrder).toEqual(["setHttpBaseUrl", "prefetchSession", "sharedroot"]);
    expect(mockSetHttpBaseUrl).toHaveBeenCalledWith("https://api.example.com/");
    expect(mockPrefetchSession).toHaveBeenCalledWith("abc-123");
  });

  it("does not prefetch when no mcap-bundle query parameter is present", () => {
    renderWebRoot();
    expect(mockPrefetchSession).not.toHaveBeenCalled();
    expect(mockCallOrder).toEqual(["setHttpBaseUrl", "sharedroot"]);
  });

  it("treats an empty mcap-bundle the same as a missing mcap-bundle", () => {
    globalThis.history.replaceState({}, "", "/?mcap-bundle=");
    renderWebRoot();
    expect(mockPrefetchSession).not.toHaveBeenCalled();
    expect(mockCallOrder).toEqual(["setHttpBaseUrl", "sharedroot"]);
  });
});
