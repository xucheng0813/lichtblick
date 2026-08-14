/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { type ReactElement } from "react";

import { main, type MainParams } from "./index";

const mockInstallDevtoolsFormatters = jest.fn();
const mockOverwriteFetch = jest.fn();
const mockWaitForFonts = jest.fn();
const mockInitI18n = jest.fn();
const mockCreateRoot = jest.fn();
const mockRootRender = jest.fn();
const mockCanRenderApp = jest.fn();
const mockStudioApp = jest.fn(() => null);
const mockWebRoot = jest.fn(() => null);
const mockCssBaseline = jest.fn((_props: unknown) => null);
const mockCompatibilityBanner = jest.fn((_props: unknown) => null);

// Order in which startup steps are initiated, recorded by the mock factories/wrappers below; used
// to assert that synchronous setup runs before the four concurrent tasks and that none of them is
// abandoned by a synchronous throw.
const callOrder: string[] = [];
// Timestamp recorded when the ./WebRoot module factory runs, i.e. when its dynamic import starts.
const webRootLoad: { at?: number } = {};

jest.mock("@lichtblick/suite-base/components/CssBaseline", () => ({
  __esModule: true,
  // index.tsx imports CssBaseline statically, so the factory runs before this module's body
  // initializes; reference the mock lazily from inside the component instead.
  default: (props: unknown) => mockCssBaseline(props),
}));

jest.mock("@lichtblick/suite-base", () => ({
  __esModule: true,
  installDevtoolsFormatters: () => {
    callOrder.push("installDevtoolsFormatters");
    mockInstallDevtoolsFormatters();
  },
  overwriteFetch: () => {
    callOrder.push("overwriteFetch");
    mockOverwriteFetch();
  },
  waitForFonts: (...args: unknown[]) => {
    callOrder.push("waitForFonts");
    return mockWaitForFonts(...args);
  },
  initI18n: (...args: unknown[]) => {
    callOrder.push("initI18n");
    return mockInitI18n(...args);
  },
  StudioApp: mockStudioApp,
}));

jest.mock("react-dom/client", () => ({
  createRoot: (...args: unknown[]) => {
    mockCreateRoot(...args);
    return { render: mockRootRender };
  },
}));

jest.mock("./WebRoot", () => {
  // the factory runs when the dynamic import is evaluated, recording that loading has started
  webRootLoad.at = Date.now();
  callOrder.push("webRootLoad");
  return { WebRoot: mockWebRoot };
});

jest.mock("./CompatibilityBanner", () => ({
  // index.tsx imports CompatibilityBanner statically, so reference the mock lazily.
  CompatibilityBanner: (props: unknown) => mockCompatibilityBanner(props),
}));

jest.mock("./canRenderApp", () => ({
  // index.tsx imports canRenderApp statically, so reference the mock lazily.
  canRenderApp: (...args: unknown[]) => mockCanRenderApp(...args),
}));

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("main", () => {
  beforeEach(() => {
    // re-run the mock factories (and thus re-record module load timing) for every test
    jest.resetModules();
    jest.clearAllMocks();
    callOrder.length = 0;
    webRootLoad.at = undefined;
    document.body.innerHTML = '<div id="root"></div>';
    mockCanRenderApp.mockReturnValue(true);
    mockWaitForFonts.mockResolvedValue([]);
    mockInitI18n.mockResolvedValue(undefined);
  });

  it("renders the banner plus WebRoot wrapping StudioApp once all startup steps complete", async () => {
    const params: MainParams = {
      extraProviders: [<div key="extra" />],
      dataSources: [],
    };
    const getParams = jest.fn(async () => {
      callOrder.push("getParams");
      return params;
    });

    await main(getParams);

    expect(mockInstallDevtoolsFormatters).toHaveBeenCalledTimes(1);
    expect(mockOverwriteFetch).toHaveBeenCalledTimes(1);
    expect(mockWaitForFonts).toHaveBeenCalledTimes(1);
    expect(mockInitI18n).toHaveBeenCalledTimes(1);
    expect(mockCreateRoot).toHaveBeenCalledWith(document.getElementById("root"));
    expect(mockRootRender).toHaveBeenCalledTimes(1);

    // the synchronous setup calls run before any of the four concurrent startup tasks are started
    const syncSteps = [
      callOrder.indexOf("installDevtoolsFormatters"),
      callOrder.indexOf("overwriteFetch"),
    ];
    const concurrentStarts = [
      callOrder.indexOf("webRootLoad"),
      callOrder.indexOf("getParams"),
      callOrder.indexOf("waitForFonts"),
      callOrder.indexOf("initI18n"),
    ];
    expect(Math.max(...syncSteps)).toBeLessThan(Math.min(...concurrentStarts));

    const rendered = mockRootRender.mock.calls[0]?.[0] as
      | ReactElement<{ children: [ReactElement, ReactElement] }>
      | undefined;
    expect(rendered).toBeDefined();
    const [banner, rootElement] = rendered!.props.children;
    // banner props are derived from the environment: non-Chrome UA, canRenderApp mocked true
    expect(banner.props.isChrome).toBe(false);
    expect(banner.props.isDismissable).toBe(true);
    expect(rootElement.type).toBe(mockWebRoot);
    expect(rootElement.props.extraProviders).toBe(params.extraProviders);
    expect(rootElement.props.dataSources).toBe(params.dataSources);
    expect(rootElement.props.children.type).toBe(mockStudioApp);
  });

  it("starts i18n init, the WebRoot import and getParams while fonts are still loading", async () => {
    let resolveFonts: (() => void) | undefined;
    mockWaitForFonts.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveFonts = resolve;
      }),
    );
    const getParams = jest.fn(async () => {
      callOrder.push("getParams");
      return {};
    });

    const mainPromise = main(getParams);
    await flushMicrotasks();
    await flushMicrotasks();

    // fonts are still pending, but the other independent startup steps have already been kicked off
    expect(mockInitI18n).toHaveBeenCalledTimes(1);
    expect(getParams).toHaveBeenCalledTimes(1);
    // the WebRoot module has already started loading while fonts are still pending
    expect(webRootLoad.at).toBeDefined();
    expect(mockRootRender).not.toHaveBeenCalled();

    resolveFonts?.();
    await mainPromise;

    expect(mockRootRender).toHaveBeenCalledTimes(1);
    const rendered = mockRootRender.mock.calls[0]?.[0] as
      | ReactElement<{ children: [ReactElement, ReactElement] }>
      | undefined;
    expect(rendered).toBeDefined();
    expect(rendered!.props.children[1].type).toBe(mockWebRoot);
  });

  it("rejects main() when getParams throws synchronously, without abandoning the other startup tasks", async () => {
    // this rejection is delivered after main() has already settled, verifying that the aggregate
    // still holds a rejection handler for every task (a floating promise would surface as an
    // unhandledrejection and fail the suite)
    mockInitI18n.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("late i18n failure"));
        }, 50);
      }),
    );

    await expect(
      main(() => {
        throw new Error("sync params failure");
      }),
    ).rejects.toThrow("sync params failure");

    // the synchronous throw must not abort evaluation of the aggregate: every startup task was
    // still started, and nothing was rendered
    expect(callOrder).toContain("webRootLoad");
    expect(mockWaitForFonts).toHaveBeenCalledTimes(1);
    expect(mockInitI18n).toHaveBeenCalledTimes(1);
    expect(mockRootRender).not.toHaveBeenCalled();
  });

  it("fails fast when a startup step rejects, without an unhandledrejection", async () => {
    mockWaitForFonts.mockRejectedValueOnce(new Error("font loading failed"));
    mockInitI18n.mockRejectedValueOnce(new Error("i18n failed"));

    await expect(main()).rejects.toThrow("font loading failed");

    // both startup steps started in parallel; the second rejection was consumed by Promise.all
    expect(mockInitI18n).toHaveBeenCalledTimes(1);
    expect(mockRootRender).not.toHaveBeenCalled();
  });

  it("renders only the banner when the browser cannot render the app", async () => {
    mockCanRenderApp.mockReturnValue(false);

    await main();

    expect(mockCreateRoot).toHaveBeenCalledTimes(1);
    expect(mockRootRender).toHaveBeenCalledTimes(1);
    expect(mockInstallDevtoolsFormatters).not.toHaveBeenCalled();
    expect(mockWaitForFonts).not.toHaveBeenCalled();
    expect(mockInitI18n).not.toHaveBeenCalled();

    const rendered = mockRootRender.mock.calls[0]?.[0] as
      | ReactElement<{ children: ReactElement }>
      | undefined;
    expect(rendered).toBeDefined();
    // only the banner is rendered, wrapped in CssBaseline, with no app rootElement
    expect(rendered!.props.children.props.children.props.isDismissable).toBe(false);
  });
});
