// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  VtdAbortError,
  VtdClientError,
  VtdHttpError,
  VtdJsonError,
  VtdNetworkError,
  VtdResponseSizeError,
  VtdSchemaError,
  VtdTimeoutError,
} from "./errors";
import { normalizeVtdSliceParams } from "./normalizeVtdSliceParams";
import type {
  IVtdClient,
  VtdRecord,
  VtdSearchParams,
  VtdSliceParams,
  VtdTriggerParams,
} from "./types";

type Fetch = typeof globalThis.fetch;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Commands that are safe to retry (idempotent read-only lookups). `slice-store` is deliberately
 * excluded: it has a side effect (creating a stored slice) and must never be repeated
 * automatically. All requests go over POST to the sidecar; the retry decision follows this
 * command whitelist, not the HTTP method.
 */
const RETRYABLE_COMMANDS: ReadonlySet<string> = new Set([
  "list",
  "detail",
  "topics",
  "trigger",
  "url",
  "slice-get",
]);

/** HTTP statuses treated as transient upstream failures. */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** At most 2 retries per invocation (3 attempts total). */
const MAX_RETRIES = 2;
/** Exponential backoff bases per retry, each with jitter applied. */
const RETRY_BACKOFF_MS: readonly number[] = [500, 1500];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function isRetryableFailure(error: VtdClientError): boolean {
  if (error instanceof VtdHttpError) {
    return RETRYABLE_STATUS_CODES.has(error.status);
  }
  return error instanceof VtdNetworkError;
}

/**
 * Re-surfaces the final failure of a retried invocation, attaching the retry count to whatever
 * error type the final attempt produced — a JSON/schema/timeout failure after retried 502s must
 * keep the context too. Errors that were already constructed with a retry count are unchanged.
 */
function withRetryContext(error: VtdClientError, retries: number): VtdClientError {
  if (retries > 0 && error.retries === 0) {
    error.retries = retries;
    error.message = `${error.message} (retried ${retries} times)`;
  }
  return error;
}

/** RFC 7231 IMF-fixdate, RFC 850, and asctime forms — the only spellings accepted as HTTP dates. */
const HTTP_DATE_FORMS: readonly RegExp[] = [
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/,
];

/**
 * Parses a `Retry-After` header (delta seconds or HTTP-date) into a delay in milliseconds.
 * Returns `undefined` for missing or malformed values: delta seconds must be pure digits, and
 * date values must match a standard HTTP-date form (Date.parse alone accepts far too much, e.g.
 * "0.5" or bare month names, which would wrongly read as historical dates).
 */
function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  const value = header?.trim();
  if (value == undefined || value.length === 0) {
    return undefined;
  }
  if (/^[0-9]+$/.test(value)) {
    return Number(value) * 1000;
  }
  if (!HTTP_DATE_FORMS.some((pattern) => pattern.test(value))) {
    return undefined;
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - nowMs);
}

/** Waits for a retry backoff, abortable by the caller signal. */
async function waitForRetry(
  ms: number,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new VtdAbortError(command, { cause: signal.reason }));
      return;
    }
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new VtdAbortError(command, { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalTriggerTime(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function optionalEpochNanoseconds(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^\d+$/.test(value) ? value : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? String(Math.trunc(value))
    : undefined;
}

function requiredString(
  value: unknown,
  field: string,
  command: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VtdSchemaError(`${field} must be a non-empty string`, command);
  }
  return value;
}

async function readBoundedResponseBody(
  response: Response,
  command: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength != undefined &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    void response.body?.cancel().catch(() => {
      // The size classification is authoritative even if stream cancellation itself fails.
    });
    throw new VtdResponseSizeError(command, MAX_RESPONSE_BYTES);
  }
  if (response.body == undefined) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {
          // The size classification is authoritative even if stream cancellation itself fails.
        });
        throw new VtdResponseSizeError(command, MAX_RESPONSE_BYTES);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function rawValue(value: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(value, "raw") ? value.raw : value;
}

function recordId(value: unknown): string {
  if (
    (typeof value !== "string" || value.length === 0) &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new VtdSchemaError("record id is missing", "list");
  }
  return String(value);
}

function normalizeRecord(value: unknown): VtdRecord {
  if (!isRecord(value)) {
    throw new VtdSchemaError("list entry must be an object", "list");
  }
  const raw = rawValue(value);
  const rawRecord = isRecord(raw) ? raw : value;
  return {
    id: recordId(value.id),
    botName: optionalString(value.botName ?? value.bot_name),
    botSn: optionalString(value.botSn ?? value.bot_sn),
    triggerType: optionalString(value.triggerType ?? value.trigger_type),
    dataType: optionalStringOrNumber(value.dataType ?? value.data_type),
    triggerTime: optionalTriggerTime(
      value.triggerTime ?? value.trigger_time ?? rawRecord.trigger_time,
    ),
    dataStartNs: optionalEpochNanoseconds(
      value.dataStartNs ?? value.data_st ?? rawRecord.data_st,
    ),
    dataEndNs: optionalEpochNanoseconds(
      value.dataEndNs ?? value.data_et ?? rawRecord.data_et,
    ),
    sizeBytes: optionalNumber(
      value.sizeBytes ?? value.size_bytes ?? value.data_size,
    ),
    raw,
  };
}

export function normalizeVtdSearchResponse(value: unknown): {
  records: VtdRecord[];
  total?: number;
} {
  if (!isRecord(value)) {
    throw new VtdSchemaError("list result must be an object", "list");
  }
  const rawRecords = Array.isArray(value.records)
    ? value.records
    : Array.isArray(value.data)
      ? value.data
      : undefined;
  if (rawRecords == undefined) {
    throw new VtdSchemaError("list result does not contain records", "list");
  }
  const pagination = isRecord(value.pagination) ? value.pagination : undefined;
  const total = optionalNumber(
    value.total ?? value.total_count ?? pagination?.total,
  );
  return {
    records: rawRecords.map(normalizeRecord),
    ...(total == undefined ? {} : { total }),
  };
}

export function normalizeVtdTopicsResponse(
  value: unknown,
): Record<string, number> {
  if (!isRecord(value)) {
    throw new VtdSchemaError("topics result must be an object", "topics");
  }
  const rawTopics = isRecord(value.topics) ? value.topics : value;
  const topics: Record<string, number> = {};
  for (const [topic, count] of Object.entries(rawTopics)) {
    if (typeof count !== "number" || !Number.isFinite(count)) {
      throw new VtdSchemaError(
        `topic count for ${topic} must be a number`,
        "topics",
      );
    }
    topics[topic] = count;
  }
  return topics;
}

export function normalizeVtdSliceStoreResponse(value: unknown): {
  mcapSliceId: string;
  raw: unknown;
} {
  if (!isRecord(value)) {
    throw new VtdSchemaError(
      "slice-store result must be an object",
      "slice-store",
    );
  }
  return {
    mcapSliceId: requiredString(
      value.mcapSliceId ?? value.mcap_slice_id,
      "mcap_slice_id",
      "slice-store",
    ),
    raw: rawValue(value),
  };
}

export function normalizeVtdSliceGetResponse(value: unknown): {
  downloadUrl: string;
  raw: unknown;
} {
  if (!isRecord(value)) {
    throw new VtdSchemaError("slice-get result must be an object", "slice-get");
  }
  return {
    downloadUrl: requiredString(
      value.downloadUrl ?? value.download_url,
      "download_url",
      "slice-get",
    ),
    raw: rawValue(value),
  };
}

export function normalizeVtdUrlResponse(value: unknown): {
  downloadUrl: string;
} {
  if (!isRecord(value)) {
    throw new VtdSchemaError("url result must be an object", "url");
  }
  return {
    downloadUrl: requiredString(
      value.downloadUrl ?? value.download_url,
      "download_url",
      "url",
    ),
  };
}

export default class HttpVtdClient implements IVtdClient {
  readonly #endpoint: URL;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #authToken: string | undefined;

  public constructor(
    endpoint: string,
    fetchImpl: Fetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    authToken?: string,
  ) {
    if (endpoint.length === 0) {
      throw new Error("VTD endpoint must not be empty");
    }
    const runtimeLocation = (
      globalThis as unknown as {
        location?: { origin?: string };
      }
    ).location;
    const baseUrl = runtimeLocation?.origin ?? "http://localhost";
    const parsedEndpoint = new URL(endpoint, baseUrl);
    if (
      !["http:", "https:"].includes(parsedEndpoint.protocol) ||
      parsedEndpoint.username.length > 0 ||
      parsedEndpoint.password.length > 0 ||
      parsedEndpoint.search.length > 0 ||
      parsedEndpoint.hash.length > 0
    ) {
      throw new Error(
        "VTD endpoint must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("VTD timeout must be a positive number");
    }
    if (
      authToken?.includes("\r") === true ||
      authToken?.includes("\n") === true
    ) {
      throw new Error("VTD auth token must not contain line breaks");
    }
    parsedEndpoint.pathname = `${parsedEndpoint.pathname.replace(/\/+$/, "")}/`;
    this.#endpoint = parsedEndpoint;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#authToken = authToken;
  }

  public async search(
    params: VtdSearchParams,
    signal?: AbortSignal,
  ): Promise<{ records: VtdRecord[]; total?: number }> {
    const { retries, value } = await this.#invoke("list", params, signal);
    try {
      return normalizeVtdSearchResponse(value);
    } catch (error) {
      // Schema validation runs outside the retry loop; attach the already-spent retry count so a
      // schema failure after retried upstream errors keeps the context.
      if (error instanceof VtdClientError) {
        throw withRetryContext(error, retries);
      }
      throw error;
    }
  }

  public async detail(id: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.#invoke("detail", { id }, signal)).value;
  }

  public async topics(
    id: string,
    signal?: AbortSignal,
  ): Promise<Record<string, number>> {
    const { retries, value } = await this.#invoke("topics", { id }, signal);
    try {
      return normalizeVtdTopicsResponse(value);
    } catch (error) {
      if (error instanceof VtdClientError) {
        throw withRetryContext(error, retries);
      }
      throw error;
    }
  }

  public async sliceStore(
    params: VtdSliceParams,
    signal?: AbortSignal,
  ): Promise<{ mcapSliceId: string; raw: unknown }> {
    const { retries, value } = await this.#invoke(
      "slice-store",
      normalizeVtdSliceParams(params),
      signal,
    );
    try {
      return normalizeVtdSliceStoreResponse(value);
    } catch (error) {
      if (error instanceof VtdClientError) {
        throw withRetryContext(error, retries);
      }
      throw error;
    }
  }

  public async sliceGet(
    sliceId: string,
    signal?: AbortSignal,
  ): Promise<{ downloadUrl: string; raw: unknown }> {
    const { retries, value } = await this.#invoke("slice-get", { sliceId }, signal);
    try {
      return normalizeVtdSliceGetResponse(value);
    } catch (error) {
      if (error instanceof VtdClientError) {
        throw withRetryContext(error, retries);
      }
      throw error;
    }
  }

  public async url(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ downloadUrl: string }> {
    const { retries, value } = await this.#invoke("url", { id }, signal);
    try {
      return normalizeVtdUrlResponse(value);
    } catch (error) {
      if (error instanceof VtdClientError) {
        throw withRetryContext(error, retries);
      }
      throw error;
    }
  }

  public async trigger(
    params: VtdTriggerParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await this.#invoke("trigger", params, signal)).value;
  }

  async #invoke(
    command: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ value: unknown; retries: number }> {
    if (signal?.aborted === true) {
      throw new VtdAbortError(command, { cause: signal.reason });
    }

    // One deadline for the whole invocation (every attempt plus every backoff): the total time
    // never exceeds the configured timeout budget.
    const deadlineMs = Date.now() + this.#timeoutMs;
    let attempts = 0;
    for (;;) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        // Every exit path carries the retry context, including a deadline exhausted after
        // retries have already been completed. A retry is only counted once its request has
        // actually been issued (`attempts - 1`), so an interrupted backoff never inflates it.
        throw withRetryContext(
          new VtdTimeoutError(command, this.#timeoutMs),
          Math.max(0, attempts - 1),
        );
      }
      // This request is about to be issued.
      attempts += 1;
      const retries = Math.max(0, attempts - 1);
      try {
        return {
          retries,
          value: await this.#requestOnce(command, params, signal, remainingMs),
        };
      } catch (error) {
        if (
          !(error instanceof VtdClientError) ||
          !RETRYABLE_COMMANDS.has(command) ||
          !isRetryableFailure(error) ||
          retries >= MAX_RETRIES
        ) {
          throw withRetryContext(error, retries);
        }
        const delayMs = await this.#retryDelayMs(error, deadlineMs, retries);
        if (delayMs == undefined) {
          // The backoff would blow the remaining budget; give up now.
          throw withRetryContext(error, retries);
        }
        try {
          await waitForRetry(delayMs, command, signal);
        } catch (waitError) {
          // An abort during the backoff keeps the context of the retries that were actually
          // issued so far — the interrupted retry itself was never sent, so it is not counted.
          if (waitError instanceof VtdClientError) {
            throw withRetryContext(waitError, retries);
          }
          throw waitError;
        }
      }
    }
  }

  /**
   * Computes the delay before the next retry. A valid `Retry-After` for 429 responses takes
   * precedence (including 0, i.e. an immediate retry) as long as it fits the remaining budget.
   * A Retry-After that is malformed or exceeds the remaining budget is ignored in favor of the
   * configured backoff with jitter; if even the backoff does not fit the remaining budget, the
   * invocation gives up (`undefined`).
   */
  async #retryDelayMs(
    error: VtdClientError,
    deadlineMs: number,
    retries: number,
  ): Promise<number | undefined> {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    if (error instanceof VtdHttpError && error.status === 429) {
      const retryAfterMs = parseRetryAfterMs(error.retryAfter, Date.now());
      if (retryAfterMs != undefined && retryAfterMs <= remainingMs) {
        return retryAfterMs;
      }
    }
    const retryIndex = Math.min(retries, RETRY_BACKOFF_MS.length - 1);
    const backoffMs = Math.round(
      RETRY_BACKOFF_MS[retryIndex]! * (0.5 + Math.random()),
    );
    if (backoffMs > remainingMs) {
      return undefined;
    }
    return backoffMs;
  }

  async #requestOnce(
    command: string,
    params: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    let rejectLifecycle: ((error: VtdClientError) => void) | undefined;
    const lifecycle = new Promise<never>((_resolve, reject) => {
      rejectLifecycle = reject;
    });
    const handleAbort = () => {
      callerAborted = true;
      controller.abort(signal?.reason);
      rejectLifecycle?.(new VtdAbortError(command, { cause: signal?.reason }));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectLifecycle?.(new VtdTimeoutError(command, timeoutMs));
    }, timeoutMs);

    const request = async (): Promise<unknown> => {
      let response: Response;
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (this.#authToken != undefined && this.#authToken.length > 0) {
          headers.authorization = `Bearer ${this.#authToken}`;
        }
        response = await this.#fetch(
          new URL(`vtd/${command}`, this.#endpoint),
          {
            body: JSON.stringify(params),
            headers,
            method: "POST",
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (timedOut) {
          throw new VtdTimeoutError(command, timeoutMs, { cause: error });
        }
        if (callerAborted) {
          throw new VtdAbortError(command, { cause: signal?.reason ?? error });
        }
        throw new VtdNetworkError(command, { cause: error });
      }

      let body: Uint8Array;
      try {
        body = await readBoundedResponseBody(response, command);
      } catch (error) {
        if (error instanceof VtdClientError) {
          throw error;
        }
        if (timedOut) {
          throw new VtdTimeoutError(command, timeoutMs, { cause: error });
        }
        if (callerAborted) {
          throw new VtdAbortError(command, { cause: signal?.reason ?? error });
        }
        throw new VtdNetworkError(command, { cause: error });
      }
      const responseText = new TextDecoder().decode(body);
      if (!response.ok) {
        throw new VtdHttpError(
          command,
          response.status,
          response.statusText,
          responseText,
          0,
          response.headers.get("retry-after") ?? undefined,
        );
      }
      try {
        return JSON.parse(responseText) as unknown;
      } catch (error) {
        throw new VtdJsonError(command, { cause: error });
      }
    };

    try {
      return await Promise.race([request(), lifecycle]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
    }
  }
}
