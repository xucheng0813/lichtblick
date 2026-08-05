// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import type { App, IpcMain, WebContents } from "electron";
import { EventEmitter } from "events";

import VtdCliService, {
  invalidateVtdExecutableCache,
  resolveVtdExecutable,
  VtdCliError,
} from "./VtdCliService";
import { DEFAULT_VTD_INSTALL_URL, registerVtdIpcHandlers } from "./VtdIpcHandlers";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

type IpcHandler = (event: { sender: WebContents }, ...args: unknown[]) => unknown;

type BeforeQuitHandler = (event: { preventDefault: () => void }) => void;

type FakeChild = EventEmitter & {
  kill: jest.Mock<boolean, [NodeJS.Signals]>;
  stderr: EventEmitter;
  stdout: EventEmitter;
};

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = jest.fn<boolean, [NodeJS.Signals]>().mockReturnValue(true);
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

function mockChild(child: FakeChild): void {
  mockSpawn.mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
}

function setupHandlers(service = new VtdCliService()): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: jest.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  } as unknown as Pick<IpcMain, "handle">;
  const app = { once: jest.fn(), quit: jest.fn() } as unknown as Pick<App, "once" | "quit">;
  registerVtdIpcHandlers({ app, ipcMain, service });
  return handlers;
}

function requiredHandler(handlers: Map<string, IpcHandler>, channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (handler == undefined) {
    throw new Error(`${channel} handler was not registered`);
  }
  return handler;
}

function fakeSender(id: number): WebContents {
  return Object.assign(new EventEmitter(), { id }) as unknown as WebContents;
}

async function waitForSpawnCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (mockSpawn.mock.calls.length >= expected) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`Timed out waiting for ${expected} spawned processes`);
}

describe("registerVtdIpcHandlers", () => {
  const originalCliPath = process.env.VTD_CLI_PATH;
  const originalInstallUrl = process.env.VTD_INSTALL_URL;

  beforeEach(() => {
    jest.useRealTimers();
    mockSpawn.mockReset();
    process.env.VTD_CLI_PATH = "/test/bin/vtd";
    delete process.env.VTD_INSTALL_URL;
    invalidateVtdExecutableCache();
  });

  afterAll(() => {
    if (originalCliPath == undefined) {
      delete process.env.VTD_CLI_PATH;
    } else {
      process.env.VTD_CLI_PATH = originalCliPath;
    }
    if (originalInstallUrl == undefined) {
      delete process.env.VTD_INSTALL_URL;
    } else {
      process.env.VTD_INSTALL_URL = originalInstallUrl;
    }
    invalidateVtdExecutableCache();
  });

  it("binds invoke/cancel ownership to sender and returns structured results", async () => {
    const handlers = new Map<string, IpcHandler>();
    const lifecycleHandlers = new Map<string, BeforeQuitHandler>();
    const ipcMain = {
      handle: jest.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as Pick<IpcMain, "handle">;
    const app = {
      once: jest.fn((event: string, handler: BeforeQuitHandler) => {
        lifecycleHandlers.set(event, handler);
      }),
      quit: jest.fn(),
    } as unknown as Pick<App, "once" | "quit">;
    const service = new VtdCliService();
    const invoke = jest.spyOn(service, "invoke");
    const cancel = jest.spyOn(service, "cancel").mockImplementation();
    const cancelOwner = jest.spyOn(service, "cancelOwner").mockImplementation();
    const shutdown = jest.spyOn(service, "shutdown").mockResolvedValue();
    const senderOne = fakeSender(101);
    const senderTwo = fakeSender(202);

    registerVtdIpcHandlers({ app, ipcMain, service });
    const invokeHandler = handlers.get("vtd:invoke");
    const cancelHandler = handlers.get("vtd:cancel");
    if (invokeHandler == undefined || cancelHandler == undefined) {
      throw new Error("VTD IPC handlers were not registered");
    }

    invoke.mockResolvedValueOnce({ id: "record-1" });
    await expect(
      invokeHandler(
        { sender: senderOne },
        {
          command: "detail",
          params: { id: "record-1" },
          requestId: "request-1",
        },
      ),
    ).resolves.toEqual({ ok: true, value: { id: "record-1" } });
    expect(invoke).toHaveBeenCalledWith(101, "request-1", "detail", {
      id: "record-1",
    });

    invoke.mockRejectedValueOnce(new VtdCliError("timeout", "timed out"));
    await expect(
      invokeHandler(
        { sender: senderTwo },
        {
          command: "detail",
          params: { id: "record-2" },
          requestId: "request-2",
        },
      ),
    ).resolves.toEqual({ code: "timeout", message: "timed out", ok: false });

    cancelHandler({ sender: senderTwo }, "request-1");
    expect(cancel).toHaveBeenCalledWith(202, "request-1");

    senderOne.emit("destroyed");
    expect(cancelOwner).toHaveBeenCalledWith(101);
    expect(cancelOwner).not.toHaveBeenCalledWith(202);

    const quitEvent = { preventDefault: jest.fn() };
    lifecycleHandlers.get("before-quit")?.(quitEvent);
    expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed invocation envelopes without calling the service", async () => {
    const handlers = new Map<string, IpcHandler>();
    const ipcMain = {
      handle: jest.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as Pick<IpcMain, "handle">;
    const app = { once: jest.fn(), quit: jest.fn() } as unknown as Pick<App, "once" | "quit">;
    const service = new VtdCliService();
    const invoke = jest.spyOn(service, "invoke");
    registerVtdIpcHandlers({ app, ipcMain, service });
    const invokeHandler = handlers.get("vtd:invoke");
    if (invokeHandler == undefined) {
      throw new Error("VTD invoke handler was not registered");
    }

    await expect(invokeHandler({ sender: fakeSender(101) }, [])).resolves.toEqual({
      code: "invalid-request",
      message: "Invalid vtd invocation",
      ok: false,
    });
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockRestore();
    await expect(
      invokeHandler(
        { sender: fakeSender(101) },
        { command: "download", params: {}, requestId: "request-1" },
      ),
    ).resolves.toEqual({
      code: "unsupported-command",
      message: "Unsupported vtd command",
      ok: false,
    });
  });

  it("reports an installed vtd executable and its version", async () => {
    const child = createFakeChild();
    mockChild(child);
    const status = requiredHandler(setupHandlers(), "vtd:status");

    const result = status({ sender: fakeSender(101) });
    expect(mockSpawn).toHaveBeenCalledWith("/test/bin/vtd", ["--version"], { shell: false });
    child.stdout.emit("data", Buffer.from("vtd version 1.2.3\n"));
    child.emit("close", 0);

    await expect(result).resolves.toEqual({
      installed: true,
      path: "/test/bin/vtd",
      version: "vtd version 1.2.3",
    });
  });

  it("reports vtd as not installed when version startup fails or times out", async () => {
    const missingChild = createFakeChild();
    const timeoutChild = createFakeChild();
    mockChild(missingChild);
    mockChild(timeoutChild);
    const status = requiredHandler(setupHandlers(), "vtd:status");

    const missing = status({ sender: fakeSender(101) });
    missingChild.emit(
      "error",
      Object.assign(new Error("spawn /test/bin/vtd ENOENT"), { code: "ENOENT" }),
    );
    await expect(missing).resolves.toEqual({ installed: false });

    jest.useFakeTimers();
    const timedOut = status({ sender: fakeSender(101) });
    jest.advanceTimersByTime(5_000);
    expect(timeoutChild.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(timedOut).resolves.toEqual({ installed: false });
  });

  it("installs vtd, bounds combined output, and refreshes executable resolution", async () => {
    process.env.VTD_CLI_PATH = "/old/bin/vtd";
    expect(resolveVtdExecutable()).toBe("/old/bin/vtd");
    process.env.VTD_CLI_PATH = "/new/bin/vtd";
    const curlChild = createFakeChild();
    const installChild = createFakeChild();
    const statusChild = createFakeChild();
    mockChild(curlChild);
    mockChild(installChild);
    mockChild(statusChild);
    const handlers = setupHandlers();
    const install = requiredHandler(handlers, "vtd:install");
    const status = requiredHandler(handlers, "vtd:status");

    const installation = install({ sender: fakeSender(101) });
    await waitForSpawnCount(1);
    const curlArgs = mockSpawn.mock.calls[0]?.[1];
    expect(mockSpawn.mock.calls[0]?.[0]).toBe("curl");
    expect(curlArgs).toEqual([
      "-fsSL",
      "--proto",
      "=http,https",
      "--proto-redir",
      "=http,https",
      "--output",
      expect.stringMatching(/lichtblick-vtd-install-.*\/install\.sh$/u),
      DEFAULT_VTD_INSTALL_URL,
    ]);
    curlChild.emit("close", 0);

    await waitForSpawnCount(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(2, "bash", [curlArgs?.[6]], { shell: false });
    installChild.stdout.emit("data", Buffer.from(`BEGIN${"x".repeat(9_000)}`));
    installChild.stderr.emit("data", Buffer.from("ACTIONABLE_TAIL"));
    installChild.emit("close", 0);

    const installResult = (await installation) as {
      exitCode: number | null;
      ok: boolean;
      output: string;
    };
    expect(installResult).toMatchObject({ exitCode: 0, ok: true });
    expect(installResult.output).toContain("ACTIONABLE_TAIL");
    expect(installResult.output).not.toContain("BEGIN");
    expect(Buffer.byteLength(installResult.output)).toBeLessThanOrEqual(8 * 1024);

    const refreshedStatus = status({ sender: fakeSender(101) });
    expect(mockSpawn).toHaveBeenNthCalledWith(3, "/new/bin/vtd", ["--version"], { shell: false });
    statusChild.stdout.emit("data", "vtd version 2.0.0");
    statusChild.emit("close", 0);
    await expect(refreshedStatus).resolves.toMatchObject({
      installed: true,
      path: "/new/bin/vtd",
    });
  });

  it("returns install failures and honors the VTD_INSTALL_URL override", async () => {
    process.env.VTD_INSTALL_URL = "https://downloads.example.com/vtd-install.sh";
    process.env.VTD_CLI_PATH = "/old/bin/vtd";
    expect(resolveVtdExecutable()).toBe("/old/bin/vtd");
    process.env.VTD_CLI_PATH = "/new/bin/vtd";
    const curlChild = createFakeChild();
    mockChild(curlChild);
    const install = requiredHandler(setupHandlers(), "vtd:install");

    const result = install({ sender: fakeSender(101) });
    await waitForSpawnCount(1);
    expect(mockSpawn.mock.calls[0]?.[0]).toBe("curl");
    expect(mockSpawn.mock.calls[0]?.[1]?.at(-1)).toBe(
      "https://downloads.example.com/vtd-install.sh",
    );
    curlChild.stderr.emit("data", "download failed");
    curlChild.emit("close", 17);

    await expect(result).resolves.toEqual({ exitCode: 17, ok: false, output: "download failed" });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(resolveVtdExecutable()).toBe("/old/bin/vtd");
  });

  it.each([
    "http://127.0.0.1:1/&/usr/bin/true",
    "https://downloads.example.com/install.sh;touch-pwned",
    "https://downloads.example.com/has space/install.sh",
    "file:///tmp/install.sh",
  ])("rejects unsafe install URL %s without spawning", async (installUrl) => {
    process.env.VTD_INSTALL_URL = installUrl;
    const install = requiredHandler(setupHandlers(), "vtd:install");

    await expect(install({ sender: fakeSender(101) })).resolves.toMatchObject({
      exitCode: null,
      ok: false,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent install requests", async () => {
    const curlChild = createFakeChild();
    const installChild = createFakeChild();
    mockChild(curlChild);
    mockChild(installChild);
    const install = requiredHandler(setupHandlers(), "vtd:install");

    const first = install({ sender: fakeSender(101) });
    const second = install({ sender: fakeSender(202) });
    await waitForSpawnCount(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    curlChild.emit("close", 0);
    await waitForSpawnCount(2);
    installChild.stdout.emit("data", "installed");
    installChild.emit("close", 0);

    await expect(first).resolves.toEqual({ exitCode: 0, ok: true, output: "installed" });
    await expect(second).resolves.toEqual({ exitCode: 0, ok: true, output: "installed" });
  });
});
