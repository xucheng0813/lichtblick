// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { App, IpcMain, WebContents } from "electron";

import VtdCliService, { VtdCliError } from "./VtdCliService";
import type { VtdInvokeRequest, VtdInvokeResult } from "../common/types";

type RegisterVtdIpcHandlersOptions = {
  app: Pick<App, "once" | "quit">;
  ipcMain: Pick<IpcMain, "handle">;
  service?: VtdCliService;
};

function errorResult(error: unknown): VtdInvokeResult {
  if (error instanceof VtdCliError) {
    return { code: error.code, message: error.message, ok: false };
  }
  return {
    code: "process",
    message: error instanceof Error ? error.message : "Unknown vtd CLI error",
    ok: false,
  };
}

export function registerVtdIpcHandlers({
  app,
  ipcMain,
  service = new VtdCliService(),
}: RegisterVtdIpcHandlersOptions): VtdCliService {
  const trackedSenders = new Map<number, WebContents>();

  const trackSender = (sender: WebContents): void => {
    const previous = trackedSenders.get(sender.id);
    if (previous === sender) {
      return;
    }
    if (previous != undefined) {
      service.cancelOwner(sender.id);
    }
    trackedSenders.set(sender.id, sender);
    sender.once("destroyed", () => {
      if (trackedSenders.get(sender.id) === sender) {
        trackedSenders.delete(sender.id);
        service.cancelOwner(sender.id);
      }
    });
  };

  ipcMain.handle("vtd:invoke", async (event, request: unknown): Promise<VtdInvokeResult> => {
    trackSender(event.sender);
    if (typeof request !== "object" || request == undefined || Array.isArray(request)) {
      return {
        code: "invalid-request",
        message: "Invalid vtd invocation",
        ok: false,
      };
    }
    // This cast links the IPC envelope to the shared type only. VtdCliService validates every
    // renderer-controlled field before spawning.
    const invocation = request as Partial<VtdInvokeRequest>;
    try {
      return {
        ok: true,
        value: await service.invoke(
          event.sender.id,
          invocation.requestId,
          invocation.command,
          invocation.params,
        ),
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle("vtd:cancel", (event, requestId: unknown) => {
    trackSender(event.sender);
    service.cancel(event.sender.id, requestId);
  });

  app.once("before-quit", (event) => {
    event.preventDefault();
    trackedSenders.clear();
    void service.shutdown().then(
      () => {
        app.quit();
      },
      () => {
        app.quit();
      },
    );
  });

  return service;
}
