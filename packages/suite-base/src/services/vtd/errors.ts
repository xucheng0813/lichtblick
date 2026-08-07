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
    /**
     * Number of retries already attempted before this error was surfaced. Mutable: the retry
     * loop attaches the count to whatever error type the final attempt produced, so the context
     * survives even when the last failure is not itself retryable (e.g. a JSON parse failure
     * after two retried 502s).
     */
    public retries = 0,
  ) {
    super(retries > 0 ? `${message} (retried ${retries} times)` : message, options);
    this.name = "VtdClientError";
  }
}

export class VtdNetworkError extends VtdClientError {
  public constructor(command: string, options?: ErrorOptions, retries = 0) {
    super(`VTD ${command} request failed at the network layer`, command, options, retries);
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

const MAX_DETAIL_BYTES = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

/**
 * Classifies an error response body into a human-readable detail:
 *
 * - A structured sidecar error (`{ "error": "..." }`) contributes its `error` string.
 * - An HTML page (e.g. an ALB-generated 502) is reported as a gateway page without dumping the
 *   markup.
 * - Anything else is kept as-is, truncated to a bounded length.
 */
export function classifyVtdErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Not JSON — fall through to the HTML/text classification below.
  }
  if (/^\s*<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
    return "gateway returned an HTML error page";
  }
  return trimmed.length > MAX_DETAIL_BYTES
    ? `${trimmed.slice(0, MAX_DETAIL_BYTES)}…`
    : trimmed;
}

export class VtdHttpError extends VtdClientError {
  public constructor(
    command: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBody: string,
    retries = 0,
    /** Raw `Retry-After` response header value, when the server sent one. */
    public readonly retryAfter?: string,
  ) {
    const detail = classifyVtdErrorDetail(responseBody);
    super(
      `VTD ${command} request failed (${status} ${statusText})${
        detail.length > 0 ? `: ${detail}` : ""
      }`,
      command,
      undefined,
      retries,
    );
    this.name = "VtdHttpError";
  }

  /**
   * Human-readable classification of the response body: a structured sidecar `error` string, a
   * gateway HTML page marker, or the trimmed (bounded) raw text.
   */
  public detail(): string {
    return classifyVtdErrorDetail(this.responseBody);
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
