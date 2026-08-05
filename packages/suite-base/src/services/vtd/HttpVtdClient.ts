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

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value != undefined && !Array.isArray(value)
  );
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
    return normalizeVtdSearchResponse(
      await this.#invoke("list", params, signal),
    );
  }

  public async detail(id: string, signal?: AbortSignal): Promise<unknown> {
    return await this.#invoke("detail", { id }, signal);
  }

  public async topics(
    id: string,
    signal?: AbortSignal,
  ): Promise<Record<string, number>> {
    return normalizeVtdTopicsResponse(
      await this.#invoke("topics", { id }, signal),
    );
  }

  public async sliceStore(
    params: VtdSliceParams,
    signal?: AbortSignal,
  ): Promise<{ mcapSliceId: string; raw: unknown }> {
    return normalizeVtdSliceStoreResponse(
      await this.#invoke("slice-store", normalizeVtdSliceParams(params), signal),
    );
  }

  public async sliceGet(
    sliceId: string,
    signal?: AbortSignal,
  ): Promise<{ downloadUrl: string; raw: unknown }> {
    return normalizeVtdSliceGetResponse(
      await this.#invoke("slice-get", { sliceId }, signal),
    );
  }

  public async url(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ downloadUrl: string }> {
    return normalizeVtdUrlResponse(await this.#invoke("url", { id }, signal));
  }

  public async trigger(
    params: VtdTriggerParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.#invoke("trigger", params, signal);
  }

  async #invoke(
    command: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted === true) {
      throw new VtdAbortError(command, { cause: signal.reason });
    }

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
      rejectLifecycle?.(new VtdTimeoutError(command, this.#timeoutMs));
    }, this.#timeoutMs);

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
          throw new VtdTimeoutError(command, this.#timeoutMs, { cause: error });
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
          throw new VtdTimeoutError(command, this.#timeoutMs, { cause: error });
        }
        if (callerAborted) {
          throw new VtdAbortError(command, { cause: signal?.reason ?? error });
        }
        throw new VtdNetworkError(command, { cause: error });
      }
      const detail = new TextDecoder().decode(body);
      if (!response.ok) {
        throw new VtdHttpError(
          command,
          response.status,
          response.statusText,
          detail,
        );
      }
      try {
        return JSON.parse(detail) as unknown;
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
