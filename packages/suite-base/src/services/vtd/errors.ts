// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export class VtdClientError extends Error {
  public constructor(
    message: string,
    public readonly command: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VtdClientError";
  }
}

export class VtdNetworkError extends VtdClientError {
  public constructor(command: string, options?: ErrorOptions) {
    super(`VTD ${command} request failed at the network layer`, command, options);
    this.name = "VtdNetworkError";
  }
}

export class VtdAbortError extends VtdClientError {
  public constructor(command: string, options?: ErrorOptions) {
    super(`VTD ${command} request was aborted`, command, options);
    this.name = "AbortError";
  }
}

export class VtdTimeoutError extends VtdClientError {
  public constructor(
    command: string,
    public readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`VTD ${command} request timed out after ${timeoutMs}ms`, command, options);
    this.name = "VtdTimeoutError";
  }
}

export class VtdHttpError extends VtdClientError {
  public constructor(
    command: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBody: string,
  ) {
    const detail = responseBody.trim();
    super(
      `VTD ${command} request failed (${status} ${statusText})${
        detail.length > 0 ? `: ${detail}` : ""
      }`,
      command,
    );
    this.name = "VtdHttpError";
  }
}

export class VtdJsonError extends VtdClientError {
  public constructor(command: string, options?: ErrorOptions) {
    super(`VTD ${command} response is not valid JSON`, command, options);
    this.name = "VtdJsonError";
  }
}

export class VtdSchemaError extends VtdClientError {
  public constructor(message: string, command = "response", options?: ErrorOptions) {
    super(`Invalid VTD response: ${message}`, command, options);
    this.name = "VtdSchemaError";
  }
}

export type VtdDesktopErrorCode =
  | "invalid-request"
  | "unsupported-command"
  | "duplicate-request"
  | "concurrency-limit"
  | "not-found"
  | "permission-denied"
  | "output-limit"
  | "stream"
  | "exit"
  | "process"
  | "protocol";

export class VtdDesktopError extends VtdClientError {
  public constructor(
    command: string,
    public readonly code: VtdDesktopErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, command, options);
    this.name = "VtdDesktopError";
  }
}

export class VtdNotFoundError extends VtdDesktopError {
  public constructor(command: string, message: string, options?: ErrorOptions) {
    super(command, "not-found", message, options);
    this.name = "VtdNotFoundError";
  }
}

export class VtdPermissionError extends VtdDesktopError {
  public constructor(command: string, message: string, options?: ErrorOptions) {
    super(command, "permission-denied", message, options);
    this.name = "VtdPermissionError";
  }
}

export class VtdResponseSizeError extends VtdClientError {
  public constructor(
    command: string,
    public readonly maximumBytes: number,
  ) {
    super(`VTD ${command} response exceeded ${maximumBytes} bytes`, command);
    this.name = "VtdResponseSizeError";
  }
}
