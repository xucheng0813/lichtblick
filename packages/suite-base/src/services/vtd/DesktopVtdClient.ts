// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  normalizeVtdSearchResponse,
  normalizeVtdSliceGetResponse,
  normalizeVtdSliceStoreResponse,
  normalizeVtdTopicsResponse,
  normalizeVtdUrlResponse,
} from "./HttpVtdClient";
import {
  VtdAbortError,
  VtdDesktopError,
  type VtdDesktopErrorCode,
  VtdJsonError,
  VtdNetworkError,
  VtdNotFoundError,
  VtdPermissionError,
  VtdTimeoutError,
} from "./errors";
import type {
  IVtdClient,
  VtdRecord,
  VtdSearchParams,
  VtdSliceParams,
  VtdTriggerParams,
} from "./types";

// Keep these command literals in lockstep with
// packages/suite-desktop/src/common/types.ts::VtdInvokeCommand. suite-base cannot import the
// desktop package, so this is the intentionally minimal runtime bridge contract.
export const DESKTOP_VTD_INVOKE_COMMANDS = [
  "list",
  "detail",
  "topics",
  "url",
  "slice-store",
  "slice-get",
  "trigger",
] as const;

type DesktopVtdInvokeCommand = (typeof DESKTOP_VTD_INVOKE_COMMANDS)[number];

const DESKTOP_VTD_ERROR_CODES = [
  "invalid-request",
  "unsupported-command",
  "duplicate-request",
  "concurrency-limit",
  "cancelled",
  "timeout",
  "not-found",
  "permission-denied",
  "output-limit",
  "stream",
  "exit",
  "invalid-json",
  "process",
] as const;

type DesktopVtdIpcErrorCode = (typeof DESKTOP_VTD_ERROR_CODES)[number];

type DesktopVtdInvokeResult =
  | { ok: true; value: unknown }
  | { ok: false; code: DesktopVtdIpcErrorCode; message: string };

interface DesktopBridgeWithVtd {
  invokeVtd(
    command: DesktopVtdInvokeCommand,
    params: unknown,
    requestId: string,
  ): Promise<DesktopVtdInvokeResult>;
  cancelVtd(requestId: string): Promise<void>;
}

function desktopBridge(): DesktopBridgeWithVtd {
  const candidate = (globalThis as typeof globalThis & { desktopBridge?: unknown }).desktopBridge;
  if (
    typeof candidate !== "object" ||
    candidate == undefined ||
    typeof (candidate as { invokeVtd?: unknown }).invokeVtd !== "function" ||
    typeof (candidate as { cancelVtd?: unknown }).cancelVtd !== "function"
  ) {
    throw new Error("Desktop VTD bridge is unavailable");
  }
  return candidate as DesktopBridgeWithVtd;
}

function isDesktopVtdInvokeResult(value: unknown): value is DesktopVtdInvokeResult {
  if (typeof value !== "object" || value == undefined) {
    return false;
  }
  const result = value as Partial<DesktopVtdInvokeResult>;
  if (result.ok === true) {
    return Object.prototype.hasOwnProperty.call(result, "value");
  }
  return (
    result.ok === false &&
    typeof result.code === "string" &&
    (DESKTOP_VTD_ERROR_CODES as readonly string[]).includes(result.code) &&
    typeof result.message === "string"
  );
}

function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function withMessage<T extends Error>(error: T, message: string): T {
  error.message = message;
  return error;
}

function ipcError(command: DesktopVtdInvokeCommand, result: Extract<DesktopVtdInvokeResult, { ok: false }>): Error {
  const cause = new Error(result.message);
  switch (result.code) {
    case "cancelled":
      return withMessage(new VtdAbortError(command, { cause }), result.message);
    case "timeout":
      return withMessage(new VtdTimeoutError(command, 30_000, { cause }), result.message);
    case "invalid-json":
      return withMessage(new VtdJsonError(command, { cause }), result.message);
    case "not-found":
      return new VtdNotFoundError(command, result.message, { cause });
    case "permission-denied":
      return new VtdPermissionError(command, result.message, { cause });
    default:
      return new VtdDesktopError(
        command,
        result.code satisfies VtdDesktopErrorCode,
        result.message,
        { cause },
      );
  }
}

export default class DesktopVtdClient implements IVtdClient {
  readonly #bridge: DesktopBridgeWithVtd;

  public constructor() {
    this.#bridge = desktopBridge();
  }

  public async search(
    params: VtdSearchParams,
    signal?: AbortSignal,
  ): Promise<{ records: VtdRecord[]; total?: number }> {
    return normalizeVtdSearchResponse(await this.#invoke("list", params, signal));
  }

  public async detail(id: string, signal?: AbortSignal): Promise<unknown> {
    return await this.#invoke("detail", { id }, signal);
  }

  public async topics(id: string, signal?: AbortSignal): Promise<Record<string, number>> {
    return normalizeVtdTopicsResponse(await this.#invoke("topics", { id }, signal));
  }

  public async sliceStore(
    params: VtdSliceParams,
    signal?: AbortSignal,
  ): Promise<{ mcapSliceId: string; raw: unknown }> {
    return normalizeVtdSliceStoreResponse(await this.#invoke("slice-store", params, signal));
  }

  public async sliceGet(
    sliceId: string,
    signal?: AbortSignal,
  ): Promise<{ downloadUrl: string; raw: unknown }> {
    return normalizeVtdSliceGetResponse(
      await this.#invoke("slice-get", { sliceId }, signal),
    );
  }

  public async url(id: string, signal?: AbortSignal): Promise<{ downloadUrl: string }> {
    return normalizeVtdUrlResponse(await this.#invoke("url", { id }, signal));
  }

  public async trigger(params: VtdTriggerParams, signal?: AbortSignal): Promise<unknown> {
    return await this.#invoke("trigger", params, signal);
  }

  async #invoke(
    command: DesktopVtdInvokeCommand,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted === true) {
      throw new VtdAbortError(command, { cause: signal.reason });
    }
    const requestId = createRequestId();
    const invocation = this.#bridge
      .invokeVtd(command, params, requestId)
      .catch((error: unknown) => {
        throw new VtdNetworkError(command, { cause: error });
      })
      .then((result) => {
        if (!isDesktopVtdInvokeResult(result)) {
          throw new VtdDesktopError(
            command,
            "protocol",
            "Desktop VTD bridge returned an invalid result",
          );
        }
        if (!result.ok) {
          throw ipcError(command, result);
        }
        return result.value;
      });
    if (signal == undefined) {
      return await invocation;
    }

    return await new Promise<unknown>((resolve, reject) => {
      const handleAbort = () => {
        void this.#bridge.cancelVtd(requestId).catch(() => {
          // The renderer still rejects with the AbortSignal reason if main already exited.
        });
        reject(new VtdAbortError(command, { cause: signal.reason }));
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) {
        handleAbort();
      }
      void invocation.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", handleAbort);
      });
    });
  }
}
