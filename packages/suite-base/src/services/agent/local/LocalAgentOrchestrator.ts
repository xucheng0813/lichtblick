// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { v4 as uuidv4 } from "uuid";

import { validateLayoutProposal } from "@lichtblick/suite-base/services/agent/layoutSchema";
import type {
  AgentEvent,
  IAgentClient,
  LayoutProposal,
  SubscribeEventsOptions,
  SubscribeEventsResult,
  ToolRun,
} from "@lichtblick/suite-base/services/agent/types";
import type {
  IVtdClient,
  VtdSearchParams,
  VtdSliceParams,
} from "@lichtblick/suite-base/services/vtd/types";

import { LOCAL_AGENT_SYSTEM_PROMPT } from "./systemPrompt";
import { LOCAL_AGENT_TOOL_DEFINITIONS } from "./toolDefinitions";
import type {
  CatalogSnapshot,
  ILlmProvider,
  LlmContentBlock,
  LlmMessage,
  LlmStopReason,
  LlmStreamEvent,
} from "./types";

export const LOCAL_AGENT_EVENT_REPLAY_LIMIT = 1000;
export const LOCAL_AGENT_MAX_TOOL_ROUNDS = 16;
export const LOCAL_AGENT_MAX_HISTORY_TURNS = 40;
export const LOCAL_AGENT_MAX_REQUEST_IDS = 4096;
export const LOCAL_AGENT_MAX_SEEN_TOOL_CALL_IDS = 10_000;
export const LOCAL_AGENT_MAX_TOOL_RESULT_BYTES = 256 * 1024;
export const LOCAL_AGENT_MAX_USER_MESSAGE_BYTES = 256 * 1024;
export const LOCAL_AGENT_MAX_HISTORY_BYTES = 4 * 1024 * 1024;
export const LOCAL_AGENT_CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;
export const LOCAL_AGENT_DEPENDENCY_TIMEOUT_MS = 2 * 60 * 1000;

type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
type UnsequencedAgentEvent = WithoutSeq<AgentEvent>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

type RequestState = {
  requestId: string;
  messageId: string;
  signal: AbortSignal;
  catalogReady?: CatalogSnapshot;
  openedDataSource: boolean;
  openingDataSourceThisRound: boolean;
  terminal: "pending" | "done" | "error" | "aborted";
};

type HistoryTurnBoundary = { start: number };

type SessionState = {
  id: string;
  nextSeq: number;
  events: AgentEvent[];
  subscribers: Set<(event: AgentEvent) => void>;
  history: LlmMessage[];
  requests: Map<string, RequestState>;
  requestIds: Set<string>;
  activeToolCallIdsByRequest: Map<string, Set<string>>;
  seenToolCallIds: Set<string>;
  waitingCatalogRequestIds: Set<string>;
  catalogNotifications: Map<string, Promise<void>>;
  historyTurnStarts: HistoryTurnBoundary[];
  controller: AbortController;
  removeParentAbortListener?: () => void;
  queue: Promise<void>;
};

type PendingConfirmation = {
  sessionId: string;
  requestId: string;
  resolve: (result: { approved: boolean }) => void;
  reject: (reason: unknown) => void;
};

type ToolExecution = {
  content: unknown;
  isError?: boolean;
};

type ToolCallEvent = Extract<LlmStreamEvent, { type: "tool-call" }>;
type ToolResultBlock = Extract<LlmContentBlock, { type: "tool-result" }>;

type ToolCallIdRegistration = {
  added: string[];
  requestId: string;
  reusedIndexes: Set<number>;
};

const TOOL_BATCH_BUDGET_ERROR =
  "Tool batch result budget exceeded; this tool was not executed";
const EXECUTED_TOOL_BUDGET_ERROR =
  "Tool execution completed, but its result exceeded the tool batch result budget";
const REUSED_TOOL_CALL_ERROR =
  "Tool-call ID has already been used in this session; this call was not executed";

export type LocalAgentOrchestratorOptions = {
  provider: ILlmProvider;
  vtdClient: IVtdClient;
  getCatalog: () => CatalogSnapshot;
  model?: string;
  confirmationTimeoutMs?: number;
  dependencyTimeoutMs?: number;
  maxSeenToolCallIds?: number;
};

export class LocalAgentConfirmationTimeoutError extends Error {
  public constructor() {
    super("Tool confirmation timed out");
    this.name = "LocalAgentConfirmationTimeoutError";
  }
}

export class LocalAgentDependencyTimeoutError extends Error {
  public constructor(dependency: string, timeoutMs: number) {
    super(`${dependency} did not settle within ${timeoutMs} ms`);
    this.name = "LocalAgentDependencyTimeoutError";
  }
}

export class LocalAgentHistoryLimitError extends Error {
  public constructor() {
    super(
      `The current agent turn exceeds the ${LOCAL_AGENT_MAX_HISTORY_BYTES} byte history budget`,
    );
    this.name = "LocalAgentHistoryLimitError";
  }
}

export class LocalAgentResponseStoppedError extends Error {
  public constructor(public readonly stopReason: LlmStopReason) {
    super(`LLM response stopped: ${stopReason}`);
    this.name = "LocalAgentResponseStoppedError";
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value != undefined && !Array.isArray(value)
  );
}

function requireRecord(
  value: unknown,
  toolName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${toolName} input must be an object`);
  }
  return value;
}

function requireString(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string {
  const value = input[property];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}.${property} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string | undefined {
  const value = input[property];
  if (!Object.hasOwn(input, property) || typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}.${property} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInteger(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = input[property];
  if (!Object.hasOwn(input, property) || typeof value === "undefined") {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new Error(`${toolName}.${property} must be a positive safe integer`);
  }
  return value as number;
}

function optionalStringArray(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string[] | undefined {
  const value = input[property];
  if (!Object.hasOwn(input, property) || typeof value === "undefined") {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new Error(`${toolName}.${property} must be a non-empty string array`);
  }
  return value as string[];
}

function optionalDecimalString(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string | undefined {
  const value = optionalString(input, property, toolName);
  if (value != undefined && !/^[0-9]+$/.test(value)) {
    throw new Error(
      `${toolName}.${property} must be an unsigned decimal string`,
    );
  }
  return value;
}

function requireUrls(
  input: Record<string, unknown>,
  toolName: string,
): string[] {
  const urls = optionalStringArray(input, "urls", toolName);
  if (urls == undefined) {
    throw new Error(`${toolName}.urls is required`);
  }
  for (const url of urls) {
    try {
      if (url.includes(",")) {
        throw new Error("literal comma");
      }
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        !parsed.pathname.toLowerCase().endsWith(".mcap")
      ) {
        throw new Error("unsupported URL");
      }
    } catch {
      throw new Error(
        `${toolName}.urls must contain only HTTPS .mcap URLs without literal commas; encode commas as %2C`,
      );
    }
  }
  return urls;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function normalizeCatalog(catalog: CatalogSnapshot): {
  topics: readonly unknown[];
  datatypes: Record<string, unknown>;
} {
  return {
    topics: catalog.topics,
    datatypes: Object.fromEntries(catalog.datatypes),
  };
}

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (entry instanceof Map) {
        return Object.fromEntries(entry);
      }
      if (typeof entry === "object" && entry != undefined) {
        if (seen.has(entry)) {
          return "[Circular]";
        }
        seen.add(entry);
      }
      return entry;
    }) ?? String(value)
  );
}

function boundedToolResult(value: unknown): unknown {
  const serialized = safeSerialize(value);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength <= LOCAL_AGENT_MAX_TOOL_RESULT_BYTES) {
    try {
      return JSON.parse(serialized) as unknown;
    } catch {
      return serialized;
    }
  }

  const createTruncatedResult = (preview: string) => ({
    truncated: true,
    byteLength,
    preview,
  });
  let best = createTruncatedResult("");
  let low = 0;
  let high = serialized.length;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    let end = midpoint;
    if (
      end > 0 &&
      end < serialized.length &&
      serialized.charCodeAt(end - 1) >= 0xd800 &&
      serialized.charCodeAt(end - 1) <= 0xdbff &&
      serialized.charCodeAt(end) >= 0xdc00 &&
      serialized.charCodeAt(end) <= 0xdfff
    ) {
      end--;
    }
    const candidate = createTruncatedResult(serialized.slice(0, end));
    if (serializedByteLength(candidate) <= LOCAL_AGENT_MAX_TOOL_RESULT_BYTES) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function toolSummary(value: unknown): string {
  const serialized = typeof value === "string" ? value : safeSerialize(value);
  return serialized.length > 240
    ? `${serialized.slice(0, 237)}...`
    : serialized;
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(safeSerialize(value)).byteLength;
}

function assertValidToolCallIds(toolCalls: readonly ToolCallEvent[]): void {
  const seen = new Set<string>();
  for (const toolCall of toolCalls) {
    if (toolCall.id.trim().length === 0) {
      throw new Error("LLM provider returned an empty tool-call ID");
    }
    if (seen.has(toolCall.id)) {
      throw new Error(
        `LLM provider returned duplicate tool-call ID "${toolCall.id}"`,
      );
    }
    seen.add(toolCall.id);
  }
}

function registerToolCallIds(
  session: SessionState,
  requestId: string,
  toolCalls: readonly ToolCallEvent[],
): ToolCallIdRegistration {
  const added: string[] = [];
  const reusedIndexes = new Set<number>();
  const previouslySeen = new Set(session.seenToolCallIds);
  for (const activeIds of session.activeToolCallIdsByRequest.values()) {
    for (const id of activeIds) {
      previouslySeen.add(id);
    }
  }
  let requestIds = session.activeToolCallIdsByRequest.get(requestId);
  if (requestIds == undefined) {
    requestIds = new Set();
    session.activeToolCallIdsByRequest.set(requestId, requestIds);
  }

  for (const [index, toolCall] of toolCalls.entries()) {
    if (previouslySeen.has(toolCall.id)) {
      reusedIndexes.add(index);
      continue;
    }
    requestIds.add(toolCall.id);
    added.push(toolCall.id);
  }
  return { added, requestId, reusedIndexes };
}

function rollbackToolCallIdRegistration(
  session: SessionState,
  registration: ToolCallIdRegistration,
): void {
  const requestIds = session.activeToolCallIdsByRequest.get(
    registration.requestId,
  );
  if (requestIds == undefined) {
    return;
  }
  for (const id of registration.added) {
    requestIds.delete(id);
  }
  if (requestIds.size === 0) {
    session.activeToolCallIdsByRequest.delete(registration.requestId);
  }
}

function retireRequestToolCallIds(
  session: SessionState,
  requestId: string,
  limit: number,
): void {
  const requestIds = session.activeToolCallIdsByRequest.get(requestId);
  if (requestIds == undefined) {
    return;
  }
  session.activeToolCallIdsByRequest.delete(requestId);
  for (const id of requestIds) {
    session.seenToolCallIds.add(id);
  }
  while (session.seenToolCallIds.size > limit) {
    const oldest = session.seenToolCallIds.values().next().value;
    if (oldest == undefined) {
      throw new Error("Tool-call ID retention pool is unexpectedly empty");
    }
    session.seenToolCallIds.delete(oldest);
  }
}

function stopReasonExplanation(reason: LlmStopReason): string {
  switch (reason) {
    case "max-tokens":
      return "The model reached its output-token limit.";
    case "context-exceeded":
      return "The model exceeded its context window.";
    case "filtered":
      return "The response was stopped by a content filter.";
    case "refusal":
      return "The model refused this request.";
    case "truncated":
      return "The provider stream ended without a complete terminal response.";
    case "pause":
      return "The provider paused this turn.";
    case "end":
    case "tool-use":
      return "The model response ended.";
  }
}

function linkSignals(...signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  abort: (reason: Error) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: (() => void)[] = [];
  for (const signal of signals) {
    if (signal == undefined) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      break;
    }
    const onAbort = () => {
      controller.abort(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push(() => {
      signal.removeEventListener("abort", onAbort);
    });
  }
  return {
    signal: controller.signal,
    abort: (reason: Error) => {
      controller.abort(reason);
    },
    cleanup: () => {
      for (const remove of listeners) {
        remove();
      }
    },
  };
}

async function raceDependency<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  dependency: string,
): Promise<T> {
  signal.throwIfAborted();
  const linked = linkSignals(signal);
  const operation = Promise.resolve().then(
    async () => await factory(linked.signal),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new LocalAgentDependencyTimeoutError(dependency, timeoutMs);
      reject(error);
      linked.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      raceWithAbort(operation, signal),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
    linked.cleanup();
  }
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("Queued local agent operation failed", {
                cause: error,
              }),
        );
      },
    );
  });
}

export class LocalAgentOrchestrator implements IAgentClient {
  public constructor(options: LocalAgentOrchestratorOptions) {
    this.#provider = options.provider;
    this.#vtdClient = options.vtdClient;
    this.#getCatalog = options.getCatalog;
    this.#model = options.model;
    this.#confirmationTimeoutMs =
      options.confirmationTimeoutMs ?? LOCAL_AGENT_CONFIRMATION_TIMEOUT_MS;
    this.#dependencyTimeoutMs =
      options.dependencyTimeoutMs ?? LOCAL_AGENT_DEPENDENCY_TIMEOUT_MS;
    this.#maxSeenToolCallIds =
      options.maxSeenToolCallIds ?? LOCAL_AGENT_MAX_SEEN_TOOL_CALL_IDS;
    if (
      !Number.isSafeInteger(this.#confirmationTimeoutMs) ||
      this.#confirmationTimeoutMs <= 0 ||
      this.#confirmationTimeoutMs > 2_147_483_647
    ) {
      throw new Error("confirmationTimeoutMs must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.#dependencyTimeoutMs) ||
      this.#dependencyTimeoutMs <= 0 ||
      this.#dependencyTimeoutMs > 2_147_483_647
    ) {
      throw new Error("dependencyTimeoutMs must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.#maxSeenToolCallIds) ||
      this.#maxSeenToolCallIds <= 0 ||
      this.#maxSeenToolCallIds > LOCAL_AGENT_MAX_SEEN_TOOL_CALL_IDS
    ) {
      throw new Error(
        `maxSeenToolCallIds must be a positive safe integer no greater than ${LOCAL_AGENT_MAX_SEEN_TOOL_CALL_IDS}`,
      );
    }
  }

  readonly #provider: ILlmProvider;
  readonly #vtdClient: IVtdClient;
  readonly #getCatalog: () => CatalogSnapshot;
  readonly #model: string | undefined;
  readonly #confirmationTimeoutMs: number;
  readonly #dependencyTimeoutMs: number;
  /**
   * Terminal request IDs form a bounded FIFO replay-defense pool, not a lifetime ledger. IDs for a
   * pending request stay in a separate, non-evictable group until that request reaches a terminal
   * state. Once a terminal ID ages out of the pool it may be accepted by a later request.
   */
  readonly #maxSeenToolCallIds: number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #pendingConfirmations = new Map<string, PendingConfirmation>();

  public createSession = async (
    signal?: AbortSignal,
  ): Promise<{ sessionId: string }> => {
    signal?.throwIfAborted();
    const sessionId = `local-${uuidv4()}`;
    const controller = new AbortController();
    const session: SessionState = {
      id: sessionId,
      nextSeq: 1,
      events: [],
      subscribers: new Set(),
      history: [],
      requests: new Map(),
      requestIds: new Set(),
      activeToolCallIdsByRequest: new Map(),
      seenToolCallIds: new Set(),
      waitingCatalogRequestIds: new Set(),
      catalogNotifications: new Map(),
      historyTurnStarts: [],
      controller,
      queue: Promise.resolve(),
    };
    if (signal != undefined) {
      const onAbort = () => {
        this.disposeSession(sessionId, abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      session.removeParentAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
    }
    this.#sessions.set(sessionId, session);
    return { sessionId };
  };

  public sendMessage = async (
    sessionId: string,
    content: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const session = this.#getSession(sessionId);
    if (requestId.trim().length === 0) {
      throw new Error("requestId must be a non-empty string");
    }
    if (content.trim().length === 0) {
      throw new Error("content must be a non-empty string");
    }
    if (serializedByteLength(content) > LOCAL_AGENT_MAX_USER_MESSAGE_BYTES) {
      throw new Error(
        `content exceeds the ${LOCAL_AGENT_MAX_USER_MESSAGE_BYTES} byte limit`,
      );
    }
    if (session.requestIds.has(requestId)) {
      throw new Error(`requestId "${requestId}" has already been used`);
    }

    this.#rememberRequestId(session, requestId);
    const linked = linkSignals(session.controller.signal, signal);
    const run = session.queue.then(async () => {
      linked.signal.throwIfAborted();
      const request: RequestState = {
        requestId,
        messageId: uuidv4(),
        signal: linked.signal,
        openedDataSource: false,
        openingDataSourceThisRound: false,
        terminal: "pending",
      };
      session.requests.set(requestId, request);
      try {
        await this.#runRequest(session, request, content);
      } finally {
        session.requests.delete(requestId);
        this.#cancelRequestConfirmations(
          sessionId,
          requestId,
          abortReason(linked.signal),
        );
      }
    });
    session.queue = run.catch(() => {});
    try {
      await raceWithAbort(run, linked.signal);
    } finally {
      linked.cleanup();
    }
  };

  public subscribeEvents = async (
    sessionId: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
    options?: SubscribeEventsOptions,
  ): Promise<SubscribeEventsResult | void> => {
    const session = this.#getSession(sessionId);
    const lastSeq = options?.lastSeq ?? 0;
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      throw new Error("lastSeq must be a non-negative safe integer");
    }
    signal?.throwIfAborted();

    const oldestSeq = session.events[0]?.seq;
    if (oldestSeq != undefined && lastSeq < oldestSeq - 1) {
      const gap = this.#emit(session, {
        type: "error",
        error: `Event replay window starts at seq ${oldestSeq}; lastSeq ${lastSeq} is no longer available. Reset the session.`,
      });
      onEvent(gap);
      return { reason: "eof" };
    }

    for (const event of session.events) {
      if (event.seq > lastSeq) {
        onEvent(event);
      }
    }
    signal?.throwIfAborted();

    const linked = linkSignals(session.controller.signal, signal);
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => {
        session.subscribers.delete(onEvent);
        linked.cleanup();
        reject(abortReason(linked.signal));
      };
      session.subscribers.add(onEvent);
      linked.signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  /**
   * Abort all work and release all retained history/replay state for one local session.
   */
  public disposeSession(sessionId: string, reason?: Error): void {
    const session = this.#sessions.get(sessionId);
    if (session == undefined) {
      return;
    }
    this.#sessions.delete(sessionId);
    session.removeParentAbortListener?.();
    session.controller.abort(
      reason ?? new DOMException("Session disposed", "AbortError"),
    );
    for (const [key, pending] of this.#pendingConfirmations) {
      if (pending.sessionId === sessionId) {
        this.#pendingConfirmations.delete(key);
        pending.reject(abortReason(session.controller.signal));
      }
    }
    session.events.length = 0;
    session.history.length = 0;
    session.historyTurnStarts.length = 0;
    session.requests.clear();
    session.requestIds.clear();
    session.activeToolCallIdsByRequest.clear();
    session.seenToolCallIds.clear();
    session.waitingCatalogRequestIds.clear();
    session.catalogNotifications.clear();
    session.subscribers.clear();
  }

  /**
   * Dispose every session owned by this orchestrator. Safe to call more than once.
   */
  public reset(): void {
    for (const sessionId of [...this.#sessions.keys()]) {
      this.disposeSession(sessionId);
    }
  }

  public dispose(): void {
    this.reset();
  }

  public confirmToolRun = async (
    sessionId: string,
    toolRunId: string,
    options: { approve: boolean },
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const confirmationKey = this.#confirmationKey(sessionId, toolRunId);
    const pending = this.#pendingConfirmations.get(confirmationKey);
    if (pending == undefined) {
      throw new Error(`No pending confirmation for tool run "${toolRunId}"`);
    }
    this.#pendingConfirmations.delete(confirmationKey);
    pending.resolve({ approved: options.approve });
  };

  public notifyCatalogReady = async (
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    if (requestId.trim().length === 0) {
      throw new Error("requestId must be a non-empty string");
    }
    const session = this.#getSession(sessionId);
    if (!session.waitingCatalogRequestIds.has(requestId)) {
      return;
    }
    let operation = session.catalogNotifications.get(requestId);
    if (operation == undefined) {
      const sessionLinked = linkSignals(session.controller.signal);
      operation = (async () => {
        try {
          const catalog = this.#getCatalog();
          const continuationRequestId = uuidv4();
          const continuation: RequestState = {
            requestId: continuationRequestId,
            messageId: uuidv4(),
            signal: sessionLinked.signal,
            catalogReady: catalog,
            openedDataSource: false,
            openingDataSourceThisRound: false,
            terminal: "pending",
          };
          this.#rememberRequestId(session, continuationRequestId);
          const run = session.queue.then(async () => {
            sessionLinked.signal.throwIfAborted();
            session.requests.set(continuationRequestId, continuation);
            try {
              await this.#runRequest(
                session,
                continuation,
                `The Lichtblick data catalog is ready for request ${requestId}: ${safeSerialize(
                  boundedToolResult(normalizeCatalog(catalog)),
                )}`,
              );
              session.waitingCatalogRequestIds.delete(requestId);
            } finally {
              session.requests.delete(continuationRequestId);
              this.#cancelRequestConfirmations(
                sessionId,
                continuationRequestId,
                abortReason(sessionLinked.signal),
              );
            }
          });
          session.queue = run.catch(() => {});
          await raceWithAbort(run, sessionLinked.signal);
        } finally {
          sessionLinked.cleanup();
        }
      })();
      const ownedOperation = operation;
      session.catalogNotifications.set(requestId, operation);
      const cleanupOperation = () => {
        if (session.catalogNotifications.get(requestId) === ownedOperation) {
          session.catalogNotifications.delete(requestId);
        }
      };
      void operation.then(cleanupOperation, cleanupOperation);
    }

    const callerLinked = linkSignals(session.controller.signal, signal);
    try {
      await raceWithAbort(operation, callerLinked.signal);
    } finally {
      callerLinked.cleanup();
    }
  };

  #getSession(sessionId: string): SessionState {
    const session = this.#sessions.get(sessionId);
    if (session == undefined) {
      throw new Error(`Unknown local agent session "${sessionId}"`);
    }
    return session;
  }

  #emit(session: SessionState, event: UnsequencedAgentEvent): AgentEvent {
    if (!Number.isSafeInteger(session.nextSeq) || session.nextSeq <= 0) {
      throw new Error("Local agent event sequence is exhausted");
    }
    const sequenced: AgentEvent = { ...event, seq: session.nextSeq++ };
    session.events.push(sequenced);
    if (session.events.length > LOCAL_AGENT_EVENT_REPLAY_LIMIT) {
      session.events.splice(
        0,
        session.events.length - LOCAL_AGENT_EVENT_REPLAY_LIMIT,
      );
    }
    for (const subscriber of session.subscribers) {
      try {
        subscriber(sequenced);
      } catch {
        // A faulty observer must not terminate the agent or starve the remaining observers.
      }
    }
    return sequenced;
  }

  async #runRequest(
    session: SessionState,
    request: RequestState,
    content?: string,
  ): Promise<void> {
    const { messageId, requestId, signal } = request;
    const turnBoundary = this.#startHistoryTurn(session);
    if (content != undefined) {
      session.history.push({ role: "user", content });
      this.#enforceHistoryBudget(session, turnBoundary);
    }
    this.#emit(session, { type: "message-start", messageId, requestId });

    try {
      for (let round = 0; round < LOCAL_AGENT_MAX_TOOL_ROUNDS; round++) {
        let roundBoundary: HistoryTurnBoundary | undefined;
        let toolCallIdRegistration: ToolCallIdRegistration | undefined;
        try {
          signal.throwIfAborted();
          const assistantBlocks: LlmContentBlock[] = [];
          const toolCalls: Extract<LlmStreamEvent, { type: "tool-call" }>[] =
            [];
          let stopReason: LlmStopReason | undefined;
          let finalContent: unknown[] | undefined;
          let finalContentFormat: LlmMessage["contentFormat"];
          let acceptingEvents = true;

          try {
            await raceDependency(
              async (dependencySignal) => {
                await this.#provider.stream(
                  {
                    system: LOCAL_AGENT_SYSTEM_PROMPT,
                    messages: [...session.history],
                    tools: LOCAL_AGENT_TOOL_DEFINITIONS,
                    model: this.#model,
                  },
                  (event) => {
                    if (!acceptingEvents) {
                      return;
                    }
                    signal.throwIfAborted();
                    switch (event.type) {
                      case "text":
                        assistantBlocks.push({
                          type: "text",
                          text: event.delta,
                        });
                        this.#emit(session, {
                          type: "token",
                          messageId,
                          delta: event.delta,
                          requestId,
                        });
                        break;
                      case "tool-call":
                        toolCalls.push(event);
                        assistantBlocks.push({
                          type: "tool-call",
                          id: event.id,
                          name: event.name,
                          input: event.input,
                        });
                        break;
                      case "done":
                        stopReason = event.stopReason;
                        finalContent = event.finalContent;
                        finalContentFormat = event.finalContentFormat;
                        break;
                    }
                  },
                  dependencySignal,
                );
              },
              signal,
              this.#dependencyTimeoutMs,
              "LLM provider",
            );
          } finally {
            acceptingEvents = false;
          }
          signal.throwIfAborted();

          if (stopReason == undefined) {
            throw new Error("LLM provider stream ended without a done event");
          }
          roundBoundary = { start: session.history.length };
          session.history.push({
            role: "assistant",
            content: finalContent ?? assistantBlocks,
            contentFormat: finalContentFormat,
          });
          this.#enforceHistoryBudget(session, turnBoundary, roundBoundary);

          if (stopReason === "pause") {
            if (toolCalls.length > 0) {
              throw new Error(
                "LLM provider reported pause with client tool calls",
              );
            }
            // Anthropic pause_turn is resumable by returning its native response as-is.
            roundBoundary = undefined;
            continue;
          }

          if (stopReason !== "end" && stopReason !== "tool-use") {
            if (toolCalls.length === 0) {
              roundBoundary = undefined;
            }
            const explanation = `\n\n[${stopReasonExplanation(stopReason)}]`;
            this.#emit(session, {
              type: "token",
              messageId,
              delta: explanation,
              requestId,
            });
            throw new LocalAgentResponseStoppedError(stopReason);
          }
          if (toolCalls.length === 0) {
            if (stopReason === "tool-use") {
              throw new Error(
                "LLM provider reported tool-use without a tool call",
              );
            }
            roundBoundary = undefined;
            this.#completeRequest(session, request);
            return;
          }

          // A malformed batch cannot be represented unambiguously in either Anthropic or
          // OpenAI-compatible history. Reject the complete assistant round before any tool can
          // produce a side effect; the enclosing roundBoundary catch removes the native response.
          assertValidToolCallIds(toolCalls);

          toolCallIdRegistration = registerToolCallIds(
            session,
            request.requestId,
            toolCalls,
          );
          const { reusedIndexes: reusedToolCallIndexes } =
            toolCallIdRegistration;
          const results: ToolResultBlock[] = [];
          request.openingDataSourceThisRound = toolCalls.some(
            (toolCall, index) =>
              !reusedToolCallIndexes.has(index) &&
              toolCall.name === "open_data_source",
          );
          const reservedResults = toolCalls.map((toolCall, index) =>
            this.#errorToolResult(
              toolCall,
              reusedToolCallIndexes.has(index)
                ? REUSED_TOOL_CALL_ERROR
                : EXECUTED_TOOL_BUDGET_ERROR,
              { executed: false },
            ),
          );
          if (
            !this.#fitsCurrentTurnBudget(session, turnBoundary, reservedResults)
          ) {
            // No tool has run yet, so rolling back this structurally unrepresentable batch cannot
            // hide a completed side effect.
            throw new LocalAgentHistoryLimitError();
          }

          let batchBudgetExceeded = false;
          for (const [index, toolCall] of toolCalls.entries()) {
            signal.throwIfAborted();
            if (reusedToolCallIndexes.has(index)) {
              results.push(
                this.#rejectToolCall(
                  session,
                  request,
                  toolCall,
                  REUSED_TOOL_CALL_ERROR,
                  { syntheticId: true },
                ),
              );
              continue;
            }
            if (batchBudgetExceeded) {
              results.push(
                this.#rejectToolCall(
                  session,
                  request,
                  toolCall,
                  TOOL_BATCH_BUDGET_ERROR,
                ),
              );
              continue;
            }

            const execution = await this.#executeTool(
              session,
              request,
              toolCall,
            );
            const result: ToolResultBlock = {
              type: "tool-result",
              toolCallId: toolCall.id,
              content: execution.content,
              isError: execution.isError,
            };
            const remainingReservations = reservedResults.slice(index + 1);
            if (
              this.#fitsCurrentTurnBudget(session, turnBoundary, [
                ...results,
                result,
                ...remainingReservations,
              ])
            ) {
              results.push(result);
              continue;
            }

            // #executeTool may already have committed an external side effect. Do not throw and
            // let roundBoundary roll it out of history: retain an explicit paired error for this
            // completed call and skip every remaining call in the batch.
            results.push(
              this.#errorToolResult(toolCall, EXECUTED_TOOL_BUDGET_ERROR, {
                executed: true,
              }),
            );
            batchBudgetExceeded = true;
          }
          request.openingDataSourceThisRound = false;
          session.history.push({ role: "user", content: results });
          this.#enforceHistoryBudget(session, turnBoundary, roundBoundary);
          roundBoundary = undefined;

          // Opening a source concludes this protocol-v1 request. Catalog readiness is reported
          // later through notifyCatalogReady and becomes context for a continuation request.
          if (request.openedDataSource) {
            this.#completeRequest(session, request);
            return;
          }
        } catch (error) {
          request.openingDataSourceThisRound = false;
          if (roundBoundary != undefined) {
            session.history.splice(roundBoundary.start);
          }
          if (toolCallIdRegistration != undefined) {
            rollbackToolCallIdRegistration(
              session,
              toolCallIdRegistration,
            );
          }
          throw error;
        }
      }
      throw new Error(
        `Local agent exceeded the ${LOCAL_AGENT_MAX_TOOL_ROUNDS} tool-round limit`,
      );
    } catch (error) {
      if (signal.aborted) {
        request.terminal = "aborted";
        retireRequestToolCallIds(
          session,
          request.requestId,
          this.#maxSeenToolCallIds,
        );
        throw abortReason(signal);
      }
      this.#errorRequest(session, request, error);
      throw error;
    }
  }

  async #executeTool(
    session: SessionState,
    request: RequestState,
    toolCall: ToolCallEvent,
  ): Promise<ToolExecution> {
    const toolRunId = toolCall.id.length > 0 ? toolCall.id : uuidv4();
    const base: Pick<ToolRun, "id" | "name"> = {
      id: toolRunId,
      name: toolCall.name,
    };
    this.#emitToolUpdate(session, request, { ...base, status: "queued" });

    try {
      request.signal.throwIfAborted();
      if (request.openedDataSource) {
        throw new Error(
          "Skipped because the agent is waiting for the new data catalog",
        );
      }
      if (
        request.openingDataSourceThisRound &&
        (toolCall.name === "get_data_catalog" ||
          toolCall.name === "propose_layout")
      ) {
        throw new Error(
          `${toolCall.name} cannot run in the same tool batch as open_data_source; wait for catalog-ready`,
        );
      }
      if (toolCall.name === "vtd_slice_store") {
        this.#emitToolUpdate(session, request, {
          ...base,
          status: "awaiting-confirmation",
          summary: "Waiting for confirmation to store an MCAP slice",
        });
        const approved = await this.#waitForConfirmation(toolRunId, request);
        if (!approved) {
          const content = {
            cancelled: true,
            reason: "User declined the operation",
          };
          this.#emitToolUpdate(session, request, {
            ...base,
            status: "cancelled",
            summary: "Cancelled by user",
            result: content,
          });
          return { content, isError: true };
        }
      }

      request.signal.throwIfAborted();
      this.#emitToolUpdate(session, request, { ...base, status: "running" });
      const content = boundedToolResult(
        await raceDependency(
          async (dependencySignal) =>
            await this.#invokeTool(
              session,
              request,
              toolCall,
              dependencySignal,
            ),
          request.signal,
          this.#dependencyTimeoutMs,
          `Tool ${toolCall.name}`,
        ),
      );
      request.signal.throwIfAborted();
      this.#emitToolUpdate(session, request, {
        ...base,
        status: "succeeded",
        progress: 1,
        summary: toolSummary(content),
        result: content,
      });
      return { content };
    } catch (error) {
      if (request.signal.aborted) {
        this.#emitToolUpdate(session, request, {
          ...base,
          status: "cancelled",
          error: errorMessage(abortReason(request.signal)),
        });
        throw abortReason(request.signal);
      }
      const message = errorMessage(error);
      this.#emitToolUpdate(session, request, {
        ...base,
        status: "failed",
        error: message,
      });
      return { content: { error: message }, isError: true };
    }
  }

  #errorToolResult(
    toolCall: ToolCallEvent,
    message: string,
    options: { executed: boolean },
  ): ToolResultBlock {
    return {
      type: "tool-result",
      toolCallId: toolCall.id,
      content: { error: message, executed: options.executed },
      isError: true,
    };
  }

  #rejectToolCall(
    session: SessionState,
    request: RequestState,
    toolCall: ToolCallEvent,
    message: string,
    options?: { syntheticId?: boolean },
  ): ToolResultBlock {
    const base: Pick<ToolRun, "id" | "name"> = {
      id: options?.syntheticId === true ? uuidv4() : toolCall.id,
      name: toolCall.name,
    };
    this.#emitToolUpdate(session, request, { ...base, status: "queued" });
    this.#emitToolUpdate(session, request, {
      ...base,
      status: "failed",
      error: message,
    });
    return this.#errorToolResult(toolCall, message, { executed: false });
  }

  #fitsCurrentTurnBudget(
    session: SessionState,
    turnBoundary: HistoryTurnBoundary,
    results: readonly ToolResultBlock[],
  ): boolean {
    return (
      serializedByteLength([
        ...session.history.slice(turnBoundary.start),
        { role: "user", content: results },
      ]) <= LOCAL_AGENT_MAX_HISTORY_BYTES
    );
  }

  async #invokeTool(
    session: SessionState,
    request: RequestState,
    toolCall: ToolCallEvent,
    signal: AbortSignal,
  ): Promise<unknown> {
    const input = requireRecord(toolCall.input, toolCall.name);
    switch (toolCall.name) {
      case "vtd_search": {
        const params: VtdSearchParams = {
          botSn: optionalString(input, "botSn", toolCall.name),
          botName: optionalString(input, "botName", toolCall.name),
          triggerType: optionalString(input, "triggerType", toolCall.name),
          start: optionalString(input, "start", toolCall.name),
          end: optionalString(input, "end", toolCall.name),
          at: optionalString(input, "at", toolCall.name),
          page: optionalPositiveInteger(input, "page", toolCall.name),
          pageSize: optionalPositiveInteger(
            input,
            "pageSize",
            toolCall.name,
            100,
          ),
        };
        return await this.#vtdClient.search(params, signal);
      }
      case "vtd_detail":
        return await this.#vtdClient.detail(
          requireString(input, "id", toolCall.name),
          signal,
        );
      case "vtd_topics":
        return await this.#vtdClient.topics(
          requireString(input, "id", toolCall.name),
          signal,
        );
      case "vtd_slice_store": {
        const params: VtdSliceParams = {
          id: requireString(input, "id", toolCall.name),
          topics: optionalStringArray(input, "topics", toolCall.name),
          startNs: optionalDecimalString(input, "startNs", toolCall.name),
          endNs: optionalDecimalString(input, "endNs", toolCall.name),
        };
        return await this.#vtdClient.sliceStore(params, signal);
      }
      case "vtd_presign": {
        const sliceId = optionalString(input, "sliceId", toolCall.name);
        const id = optionalString(input, "id", toolCall.name);
        if ((sliceId == undefined) === (id == undefined)) {
          throw new Error("vtd_presign requires exactly one of sliceId or id");
        }
        return sliceId != undefined
          ? await this.#vtdClient.sliceGet(sliceId, signal)
          : await this.#vtdClient.url(id!, signal);
      }
      case "open_data_source": {
        const urls = requireUrls(input, toolCall.name);
        const sourceSessionId = optionalString(
          input,
          "sessionId",
          toolCall.name,
        );
        request.openedDataSource = true;
        this.#rememberWaitingCatalogRequest(session, request.requestId);
        this.#emit(session, {
          type: "open-data-source",
          messageId: request.messageId,
          urls,
          sessionId: sourceSessionId,
          requestId: request.requestId,
        });
        return {
          status: "opening",
          message: "打开中，等待目录就绪通知",
        };
      }
      case "get_data_catalog":
        return normalizeCatalog(request.catalogReady ?? this.#getCatalog());
      case "propose_layout": {
        const proposal: LayoutProposal = {
          name: requireString(input, "name", toolCall.name),
          data: input.data,
          summary: optionalString(input, "summary", toolCall.name),
        };
        const validated = validateLayoutProposal(proposal);
        this.#emit(session, {
          type: "layout-proposal",
          messageId: request.messageId,
          proposal: validated,
          requestId: request.requestId,
        });
        return { accepted: true, name: validated.name };
      }
      default:
        throw new Error(`Unsupported local agent tool "${toolCall.name}"`);
    }
  }

  #emitToolUpdate(
    session: SessionState,
    request: RequestState,
    toolRun: ToolRun,
  ): void {
    this.#emit(session, {
      type: "tool-update",
      messageId: request.messageId,
      toolRun,
      requestId: request.requestId,
    });
  }

  async #waitForConfirmation(
    toolRunId: string,
    request: RequestState,
  ): Promise<boolean> {
    request.signal.throwIfAborted();
    const sessionId = this.#findRequestSessionId(request);
    const confirmationKey = this.#confirmationKey(sessionId, toolRunId);
    if (this.#pendingConfirmations.has(confirmationKey)) {
      throw new Error(`Duplicate pending tool run id "${toolRunId}"`);
    }
    const pending = deferred<{ approved: boolean }>();
    const entry: PendingConfirmation = {
      sessionId,
      requestId: request.requestId,
      resolve: pending.resolve,
      reject: pending.reject,
    };
    this.#pendingConfirmations.set(confirmationKey, entry);
    const onAbort = () => {
      if (this.#pendingConfirmations.delete(confirmationKey)) {
        pending.reject(abortReason(request.signal));
      }
    };
    const timeout = setTimeout(() => {
      if (this.#pendingConfirmations.delete(confirmationKey)) {
        pending.reject(new LocalAgentConfirmationTimeoutError());
      }
    }, this.#confirmationTimeoutMs);
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) {
      onAbort();
    }
    try {
      return (await pending.promise).approved;
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
      this.#pendingConfirmations.delete(confirmationKey);
    }
  }

  #rememberRequestId(session: SessionState, requestId: string): void {
    session.requestIds.add(requestId);
    while (session.requestIds.size > LOCAL_AGENT_MAX_REQUEST_IDS) {
      const oldest = session.requestIds.values().next().value;
      if (oldest == undefined) {
        break;
      }
      session.requestIds.delete(oldest);
    }
  }

  #rememberWaitingCatalogRequest(
    session: SessionState,
    requestId: string,
  ): void {
    session.waitingCatalogRequestIds.add(requestId);
    while (
      session.waitingCatalogRequestIds.size > LOCAL_AGENT_MAX_HISTORY_TURNS
    ) {
      const oldest = session.waitingCatalogRequestIds.values().next().value;
      if (oldest == undefined) {
        break;
      }
      session.waitingCatalogRequestIds.delete(oldest);
    }
  }

  #completeRequest(session: SessionState, request: RequestState): void {
    if (request.terminal !== "pending") {
      return;
    }
    request.terminal = "done";
    retireRequestToolCallIds(
      session,
      request.requestId,
      this.#maxSeenToolCallIds,
    );
    this.#emit(session, {
      type: "message-end",
      messageId: request.messageId,
      requestId: request.requestId,
    });
    this.#emit(session, { type: "done", requestId: request.requestId });
  }

  #errorRequest(
    session: SessionState,
    request: RequestState,
    error: unknown,
  ): void {
    if (request.terminal !== "pending") {
      return;
    }
    request.terminal = "error";
    retireRequestToolCallIds(
      session,
      request.requestId,
      this.#maxSeenToolCallIds,
    );
    this.#emit(session, {
      type: "error",
      error: errorMessage(error),
      requestId: request.requestId,
    });
  }

  #removeOldestHistoryTurn(
    session: SessionState,
    ...additionalBoundaries: HistoryTurnBoundary[]
  ): void {
    const removed = session.historyTurnStarts[0];
    const end = session.historyTurnStarts[1]?.start ?? session.history.length;
    session.history.splice(0, end);
    session.historyTurnStarts.splice(0, 1);
    const boundaries = new Set([
      ...session.historyTurnStarts,
      ...additionalBoundaries,
    ]);
    if (removed != undefined) {
      boundaries.delete(removed);
    }
    for (const boundary of boundaries) {
      boundary.start -= end;
    }
  }

  #enforceHistoryBudget(
    session: SessionState,
    ...boundaries: HistoryTurnBoundary[]
  ): void {
    while (
      serializedByteLength(session.history) > LOCAL_AGENT_MAX_HISTORY_BYTES &&
      session.historyTurnStarts.length > 1
    ) {
      this.#removeOldestHistoryTurn(session, ...boundaries);
    }
    if (serializedByteLength(session.history) > LOCAL_AGENT_MAX_HISTORY_BYTES) {
      throw new LocalAgentHistoryLimitError();
    }
  }

  #startHistoryTurn(session: SessionState): HistoryTurnBoundary {
    while (session.historyTurnStarts.length >= LOCAL_AGENT_MAX_HISTORY_TURNS) {
      this.#removeOldestHistoryTurn(session);
    }
    const boundary = { start: session.history.length };
    session.historyTurnStarts.push(boundary);
    return boundary;
  }

  #confirmationKey(sessionId: string, toolRunId: string): string {
    return `${sessionId}\0${toolRunId}`;
  }

  #findRequestSessionId(request: RequestState): string {
    for (const session of this.#sessions.values()) {
      if (session.requests.get(request.requestId) === request) {
        return session.id;
      }
    }
    throw new Error(`Request "${request.requestId}" is not active`);
  }

  #cancelRequestConfirmations(
    sessionId: string,
    requestId: string,
    reason: unknown,
  ): void {
    for (const [toolRunId, pending] of this.#pendingConfirmations) {
      if (pending.sessionId === sessionId && pending.requestId === requestId) {
        this.#pendingConfirmations.delete(toolRunId);
        pending.reject(reason);
      }
    }
  }
}
