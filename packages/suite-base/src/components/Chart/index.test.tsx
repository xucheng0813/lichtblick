/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, fireEvent, render } from "@testing-library/react";
import { Component, type ReactNode } from "react";

import Rpc, { createLinkedChannels } from "@lichtblick/suite-base/util/Rpc";

// Chart captures supportsOffscreenCanvas when the module is loaded. Enable the worker path (which
// is the one that tears the rpc down with "Rpc terminated" on unmount via WebWorkerManager) before
// the Chart module is imported below.
if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
  Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
    configurable: true,
    value: () => ({}),
  });
}

// the Chart module must be loaded after the defineProperty above, so it is imported dynamically
// rather than statically
const chartModulePromise: Promise<typeof import("./index")> = import("./index");

// rpc handed out by the mocked WebWorkerManager; the test creates it over linked channels so it can
// drive (and terminate) the rpc exactly like the real worker teardown would
// Chart imports ChartJsMux statically but only instantiates it in the in-process (non-worker)
// path, which these tests do not exercise. Mocking it also avoids loading its font assets, which
// jest cannot parse.
jest.mock("./worker/ChartJsMux", () => ({
  __esModule: true,
  default: jest.fn(),
}));

let mockRpc: Rpc | undefined;

jest.mock("@lichtblick/suite-base/util/WebWorkerManager", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    registerWorkerListener: jest.fn(() => mockRpc),
    unregisterWorkerListener: jest.fn(() => {
      // mirrors the real manager: tearing down the worker rejects in-flight rpc calls
      mockRpc?.terminate();
    }),
  })),
}));

class ChartErrorBoundary extends Component<
  { onError: (error: Error) => void; children?: ReactNode },
  { hasError: boolean }
> {
  public static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  public override state = { hasError: false };

  public override componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  public override render(): ReactNode {
    return this.state.hasError ? null : this.props.children;
  }
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Chart", () => {
  beforeEach(() => {
    mockRpc = undefined;
  });

  it("does not surface an unhandled rejection when the component unmounts while rpc calls are in flight", async () => {
    const { default: Chart } = await chartModulePromise;
    const { local, remote } = createLinkedChannels();
    mockRpc = new Rpc(local);
    const remoteRpc = new Rpc(remote);
    // keep the chart's rpc calls pending so they are in flight when the component unmounts
    remoteRpc.receive("initialize", async () => {
      await new Promise<void>(() => {});
    });
    remoteRpc.receive("destroy", async () => {
      await new Promise<void>(() => {});
    });

    const { unmount } = render(
      <Chart type="scatter" height={100} width={100} isBoundsReset={false} options={{}} />,
    );
    await flushMicrotasks(); // the initialize call goes out and stays pending

    unmount(); // teardown: destroy call in flight, then the mock manager terminates the rpc

    await flushMicrotasks(); // deliver the "Rpc terminated" rejections

    // the rejections were swallowed: nothing was logged and no unhandledrejection surfaced (the
    // test framework also fails the test if console.error is called, and an unhandled rejection
    // would fail the suite)
    expect(console.error as jest.Mock).not.toHaveBeenCalled();
  });

  it("does not invoke onClick when the component unmounts while the click rpc call is in flight", async () => {
    const { default: Chart } = await chartModulePromise;
    const { local, remote } = createLinkedChannels();
    mockRpc = new Rpc(local);
    const remoteRpc = new Rpc(remote);
    remoteRpc.receive("initialize", () => ({}));
    remoteRpc.receive("destroy", () => undefined);
    remoteRpc.receive("update", () => ({}));
    // keep the click call pending so it is in flight when the component unmounts
    remoteRpc.receive("getDatalabelAtEvent", async () => {
      await new Promise<void>(() => {});
    });

    const onClick = jest.fn();
    const { container, unmount } = render(
      <Chart
        type="scatter"
        height={100}
        width={100}
        isBoundsReset={false}
        options={{}}
        onClick={onClick}
      />,
    );
    await flushMicrotasks(); // initialize resolves; the first update (from initialization) resolves

    fireEvent.click(container.firstChild as HTMLElement); // the click call goes out and stays pending

    unmount(); // teardown: the mock manager terminates the rpc while the click call is in flight

    await flushMicrotasks(); // deliver the "Rpc terminated" rejection

    // the stale onClick handler of the unmounted component must not run
    expect(onClick).not.toHaveBeenCalled();
    expect(console.error as jest.Mock).not.toHaveBeenCalled();
  });

  it("still reports errors that are not caused by worker termination", async () => {
    const { default: Chart } = await chartModulePromise;
    const { local, remote } = createLinkedChannels();
    mockRpc = new Rpc(local);
    const remoteRpc = new Rpc(remote);

    let updateCount = 0;
    remoteRpc.receive("initialize", () => ({}));
    remoteRpc.receive("destroy", () => undefined);
    remoteRpc.receive("update", () => {
      updateCount += 1;
      if (updateCount > 1) {
        throw new Error("boom");
      }
      return {};
    });

    const onError = jest.fn();
    const consoleErrorMock = console.error as jest.Mock;

    const baseProps = {
      type: "scatter" as const,
      height: 100,
      width: 100,
      isBoundsReset: false,
      options: {},
    };
    const { rerender } = render(
      <ChartErrorBoundary onError={onError}>
        <Chart {...baseProps} />
      </ChartErrorBoundary>,
    );
    await flushMicrotasks(); // initialize resolves; the first update (from initialization) resolves

    rerender(
      <ChartErrorBoundary onError={onError}>
        <Chart {...baseProps} height={101} />
      </ChartErrorBoundary>,
    );
    await flushMicrotasks(); // the second update rejects with "boom" and must be reported

    // the non-termination error was not swallowed: it reached the error boundary (i.e. it was
    // thrown during render) and was logged by the update effect
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    // we asserted the expected console.error calls; clear them so the test framework's own
    // console.error check passes
    consoleErrorMock.mockClear();
  });
});
