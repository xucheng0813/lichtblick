// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { App, IpcMain, WebContents } from "electron";
import { EventEmitter } from "events";

import VtdCliService, { VtdCliError } from "./VtdCliService";
import { registerVtdIpcHandlers } from "./VtdIpcHandlers";

type IpcHandler = (event: { sender: WebContents }, ...args: unknown[]) => unknown;

type BeforeQuitHandler = (event: { preventDefault: () => void }) => void;

function fakeSender(id: number): WebContents {
  return Object.assign(new EventEmitter(), { id }) as unknown as WebContents;
}

describe("registerVtdIpcHandlers", () => {
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
});
