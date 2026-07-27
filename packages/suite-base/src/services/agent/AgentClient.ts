// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { HttpError } from "@lichtblick/suite-base/services/http/HttpError";

import type {
  AgentEvent,
  IAgentClient,
  LayoutProposal,
  SubscribeEventsOptions,
  SubscribeEventsResult,
  ToolRun,
} from "./types";

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_NON_JSON_FRAMES = 3;
const MAX_HTTP_ERROR_DETAIL_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const AGENT_SSE_MAX_EVENT_BYTES = 1024 * 1024;
/** Hard resource budgets for one physical subscribeEvents connection. Reconnects start at zero. */
export const AGENT_SSE_MAX_CONNECTION_BYTES = 32 * 1024 * 1024;
export const AGENT_SSE_MAX_CONNECTION_EVENTS = 10_000;
/** Compatibility alias; the budget applies to one physical connection, not a session lifetime. */
export const AGENT_SSE_MAX_SUBSCRIPTION_BYTES = AGENT_SSE_MAX_CONNECTION_BYTES;
/** Compatibility alias; the budget applies to one physical connection, not a session lifetime. */
export const AGENT_SSE_MAX_SUBSCRIPTION_EVENTS = AGENT_SSE_MAX_CONNECTION_EVENTS;

const TOOL_RUN_STATUSES = new Set<string>([
  "queued",
  "running",
  "awaiting-confirmation",
  "succeeded",
  "failed",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return typeof value === "undefined" || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return typeof value === "undefined" || isNonEmptyString(value);
}

function isPositiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isToolRun(value: unknown): value is ToolRun {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    TOOL_RUN_STATUSES.has(value.status) &&
    (typeof value.progress === "undefined" ||
      (typeof value.progress === "number" && Number.isFinite(value.progress))) &&
    isOptionalString(value.summary) &&
    isOptionalString(value.error)
  );
}

function isLayoutProposal(value: unknown): value is LayoutProposal {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    "data" in value &&
    isOptionalString(value.summary)
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== "string" || !isPositiveSequence(value.seq)) {
    return false;
  }

  switch (value.type) {
    case "message-start":
    case "message-end":
      return typeof value.messageId === "string" && isNonEmptyString(value.requestId);
    case "token":
      return (
        typeof value.messageId === "string" &&
        typeof value.delta === "string" &&
        isNonEmptyString(value.requestId)
      );
    case "tool-update":
      return (
        typeof value.messageId === "string" &&
        isToolRun(value.toolRun) &&
        isNonEmptyString(value.requestId)
      );
    case "layout-proposal":
      return (
        typeof value.messageId === "string" &&
        isLayoutProposal(value.proposal) &&
        isNonEmptyString(value.requestId)
      );
    case "open-data-source":
      return (
        typeof value.messageId === "string" &&
        Array.isArray(value.urls) &&
        value.urls.every((url) => typeof url === "string") &&
        isOptionalString(value.sessionId) &&
        isNonEmptyString(value.requestId)
      );
    case "error":
      return typeof value.error === "string" && isOptionalNonEmptyString(value.requestId);
    case "done":
      return isNonEmptyString(value.requestId);
    default:
      return false;
  }
}

type SseEventBoundary = {
  index: number;
  length: number;
};

function getLineEndingByteLength(bytes: Uint8Array, index: number): number | undefined {
  const byte = bytes[index];
  if (byte === 0x0a) {
    return 1;
  }
  if (byte === 0x0d) {
    return bytes[index + 1] === 0x0a ? 2 : 1;
  }
  return undefined;
}

function getSseEventBoundary(
  bytes: Uint8Array,
  fromIndex = 0,
): SseEventBoundary | undefined {
  for (let index = fromIndex; index < bytes.byteLength; index++) {
    const firstLength = getLineEndingByteLength(bytes, index);
    if (firstLength == undefined) {
      continue;
    }
    const secondLength = getLineEndingByteLength(bytes, index + firstLength);
    if (secondLength != undefined) {
      return { index, length: firstLength + secondLength };
    }
  }
  return undefined;
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right;
  }
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function trailingLineEndingByteLength(bytes: Uint8Array): number {
  const lastIndex = bytes.byteLength - 1;
  const lastByte = bytes[lastIndex];
  if (lastByte === 0x0d) {
    return 1;
  }
  if (lastByte === 0x0a) {
    return bytes[lastIndex - 1] === 0x0d ? 2 : 1;
  }
  return 0;
}

type ParsedSseFrame =
  | { type: "empty" }
  | { type: "invalid-frame" }
  | { type: "event"; event: AgentEvent };

function parseSseFrame(frame: string): ParsedSseFrame {
  const data = frame
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");

  if (data.length === 0) {
    return { type: "empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { type: "invalid-frame" };
  }

  if (!isRecord(parsed) || !isPositiveSequence(parsed.seq)) {
    return { type: "invalid-frame" };
  }

  if (!isAgentEvent(parsed)) {
    throw new AgentStreamProtocolError("Invalid agent event received");
  }
  return { type: "event", event: parsed };
}

async function readResponseTextWithLimit(response: Response, byteLimit: number): Promise<string> {
  if (response.body == undefined) {
    const text = await response.text();
    return text.length > byteLimit ? `${text.slice(0, byteLimit)}…` : text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let detail = "";
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        detail += decoder.decode();
        break;
      }
      const remaining = byteLimit - bytesRead;
      if (value.byteLength > remaining) {
        detail += decoder.decode(value.subarray(0, Math.max(remaining, 0)), { stream: true });
        detail += decoder.decode();
        truncated = true;
        break;
      }
      bytesRead += value.byteLength;
      detail += decoder.decode(value, { stream: true });
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => {
        // The response stream may already have been cancelled.
      });
    }
    reader.releaseLock();
  }
  return truncated ? `${detail}…` : detail;
}

export class AgentStreamSizeLimitError extends Error {
  public constructor(message = "Agent event stream exceeded a resource limit") {
    super(message);
    this.name = "AgentStreamSizeLimitError";
  }
}

export class AgentStreamProtocolError extends Error {
  public constructor(
    message = `Agent event stream contained ${MAX_CONSECUTIVE_NON_JSON_FRAMES} consecutive invalid data frames`,
  ) {
    super(message);
    this.name = "AgentStreamProtocolError";
  }
}

export class AgentStreamIdleTimeoutError extends Error {
  public constructor(idleTimeoutMs: number) {
    super(`Agent event stream received no bytes for ${idleTimeoutMs}ms`);
    this.name = "AgentStreamIdleTimeoutError";
  }
}

export class AgentClient implements IAgentClient {
  readonly #baseUrl: string;

  public constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  public async createSession(signal?: AbortSignal): Promise<{ sessionId: string }> {
    const response = await this.#requestJson("/agent/sessions", {
      method: "POST",
      signal,
    });
    const payload =
      isRecord(response) && isRecord(response.data) ? response.data : response;

    if (!isRecord(payload) || typeof payload.sessionId !== "string" || payload.sessionId === "") {
      throw new Error("Agent session response did not include a sessionId");
    }
    return { sessionId: payload.sessionId };
  }

  public async sendMessage(
    sessionId: string,
    content: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isNonEmptyString(requestId)) {
      throw new Error("requestId must be a non-empty string");
    }
    await this.#request(
      `/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content, requestId }),
        signal,
      },
      "application/json",
    );
  }

  public async subscribeEvents(
    sessionId: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
    options: SubscribeEventsOptions = {},
  ): Promise<SubscribeEventsResult> {
    signal?.throwIfAborted();
    const requestedIdleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(requestedIdleTimeoutMs) || requestedIdleTimeoutMs <= 0) {
      throw new Error("idleTimeoutMs must be a positive finite number");
    }
    const idleTimeoutMs = Math.min(requestedIdleTimeoutMs, MAX_TIMER_DELAY_MS);
    const initialLastSeq = options.lastSeq ?? 0;
    if (!Number.isSafeInteger(initialLastSeq) || initialLastSeq < 0) {
      throw new Error("lastSeq must be a non-negative safe integer");
    }

    const subscriptionController = new AbortController();
    const subscriptionSignal = subscriptionController.signal;
    const forwardAbort = () => {
      subscriptionController.abort(signal?.reason);
    };
    signal?.addEventListener("abort", forwardAbort, { once: true });

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimer != undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        subscriptionController.abort(new AgentStreamIdleTimeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
    };
    resetIdleTimer();

    try {
      const query = options.lastSeq == undefined ? "" : `?lastSeq=${initialLastSeq}`;
      const response = await this.#request(
        `/agent/sessions/${encodeURIComponent(sessionId)}/events${query}`,
        {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: subscriptionSignal,
        },
        undefined,
      );
      const contentType = response.headers.get("content-type");
      if (contentType?.toLowerCase().includes("text/event-stream") !== true) {
        throw new Error("Agent event response is not a text/event-stream");
      }
      if (response.body == undefined) {
        throw new Error("Agent event response did not include a body");
      }
      subscriptionSignal.throwIfAborted();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer: Uint8Array = new Uint8Array();
      let consecutiveNonJsonFrames = 0;
      let eventCount = 0;
      let lastDeliveredSeq = initialLastSeq;
      let connectionByteLength = 0;

      const abortReader = () => {
        void reader.cancel(subscriptionSignal.reason).catch(() => {
          // The fetch implementation may already have cancelled the stream.
        });
      };
      subscriptionSignal.addEventListener("abort", abortReader, { once: true });

      const emitFrame = (frame: string) => {
        const parsed = parseSseFrame(frame);
        if (parsed.type === "empty") {
          return;
        }
        if (parsed.type === "invalid-frame") {
          consecutiveNonJsonFrames++;
          if (consecutiveNonJsonFrames >= MAX_CONSECUTIVE_NON_JSON_FRAMES) {
            throw new AgentStreamProtocolError();
          }
          return;
        }

        consecutiveNonJsonFrames = 0;
        eventCount++;
        if (eventCount > AGENT_SSE_MAX_CONNECTION_EVENTS) {
          throw new AgentStreamSizeLimitError(
            `Agent event stream exceeded the ${AGENT_SSE_MAX_CONNECTION_EVENTS} event connection limit`,
          );
        }
        if (parsed.event.seq <= lastDeliveredSeq) {
          return;
        }
        lastDeliveredSeq = parsed.event.seq;
        onEvent(parsed.event);
      };

      const emitCompleteFrames = () => {
        let frameStart = 0;
        let boundary = getSseEventBoundary(buffer);
        while (boundary != undefined) {
          const frameBytes = buffer.subarray(frameStart, boundary.index);
          if (frameBytes.byteLength > AGENT_SSE_MAX_EVENT_BYTES) {
            throw new AgentStreamSizeLimitError(
              `Agent SSE frame exceeded the ${AGENT_SSE_MAX_EVENT_BYTES} byte event limit`,
            );
          }
          emitFrame(decoder.decode(frameBytes));
          subscriptionSignal.throwIfAborted();
          frameStart = boundary.index + boundary.length;
          boundary = getSseEventBoundary(buffer, frameStart);
        }
        if (frameStart > 0) {
          buffer = buffer.slice(frameStart);
        }
        const unfinishedFrameByteLength =
          buffer.byteLength - trailingLineEndingByteLength(buffer);
        if (unfinishedFrameByteLength > AGENT_SSE_MAX_EVENT_BYTES) {
          throw new AgentStreamSizeLimitError(
            `Agent SSE frame exceeded the ${AGENT_SSE_MAX_EVENT_BYTES} byte event limit`,
          );
        }
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (value.byteLength > 0) {
            resetIdleTimer();
          }
          if (
            connectionByteLength + value.byteLength >
            AGENT_SSE_MAX_CONNECTION_BYTES
          ) {
            throw new AgentStreamSizeLimitError(
              `Agent event stream exceeded the ${AGENT_SSE_MAX_CONNECTION_BYTES} byte connection limit`,
            );
          }
          connectionByteLength += value.byteLength;
          buffer = concatenateBytes(buffer, value);
          emitCompleteFrames();
        }

        emitCompleteFrames();
        if (buffer.byteLength > 0) {
          if (buffer.byteLength > AGENT_SSE_MAX_EVENT_BYTES) {
            throw new AgentStreamSizeLimitError(
              `Agent SSE frame exceeded the ${AGENT_SSE_MAX_EVENT_BYTES} byte event limit`,
            );
          }
          emitFrame(decoder.decode(buffer));
        }
        subscriptionSignal.throwIfAborted();
      } finally {
        subscriptionSignal.removeEventListener("abort", abortReader);
        await reader.cancel().catch(() => {
          // A completed or aborted stream may reject a second cancellation.
        });
        reader.releaseLock();
      }
      return { reason: "eof" };
    } catch (error) {
      if (subscriptionSignal.reason instanceof AgentStreamIdleTimeoutError) {
        throw subscriptionSignal.reason;
      }
      throw error;
    } finally {
      if (idleTimer != undefined) {
        clearTimeout(idleTimer);
      }
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  public async confirmToolRun(
    sessionId: string,
    toolRunId: string,
    options: { approve: boolean },
    signal?: AbortSignal,
  ): Promise<void> {
    const action = options.approve ? "confirm" : "cancel";
    await this.#request(
      `/agent/tool-runs/${encodeURIComponent(toolRunId)}/${action}`,
      {
        method: "POST",
        body: JSON.stringify({ sessionId }),
        signal,
      },
      "application/json",
    );
  }

  public async notifyCatalogReady(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isNonEmptyString(requestId)) {
      throw new Error("requestId must be a non-empty string");
    }
    await this.#request(
      `/agent/sessions/${encodeURIComponent(sessionId)}/catalog-ready`,
      {
        method: "POST",
        body: JSON.stringify({ requestId }),
        signal,
      },
      "application/json",
    );
  }

  async #requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#request(path, init, "application/json");
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new HttpError(
        `Failed to parse response: ${(error as Error).message}`,
        response.status,
        response.statusText,
        response,
      );
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    contentType: string | undefined,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (contentType != undefined) {
      headers.set("Content-Type", contentType);
      headers.set("Accept", "application/json");
    }

    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: "same-origin",
      headers,
    });
    if (response.ok) {
      return response;
    }

    let detail = "";
    try {
      detail = await readResponseTextWithLimit(response, MAX_HTTP_ERROR_DETAIL_BYTES);
    } catch {
      // Keep the status-only error when the body cannot be read.
    }
    const suffix = detail.length > 0 ? ` - ${detail}` : "";
    throw new HttpError(
      `HTTP Error: ${response.status} ${response.statusText}${suffix}`,
      response.status,
      response.statusText,
      response,
    );
  }
}

export default AgentClient;
