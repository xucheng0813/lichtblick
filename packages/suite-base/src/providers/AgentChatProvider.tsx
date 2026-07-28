// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  type MutableRefObject,
  type PropsWithChildren,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { createStore, type StoreApi } from "zustand";

import Logger from "@lichtblick/log";
import {
  AgentChatContext,
  type AgentChatState,
} from "@lichtblick/suite-base/context/AgentChatContext";
import {
  AgentStreamProtocolError,
  AgentStreamSizeLimitError,
} from "@lichtblick/suite-base/services/agent/AgentClient";
import { validateLayoutProposal } from "@lichtblick/suite-base/services/agent/layoutSchema";
import type {
  AgentEvent,
  ChatMessage,
  IAgentClient,
  LayoutProposal,
  ToolRun,
  ToolRunStatus,
} from "@lichtblick/suite-base/services/agent/types";

const log = Logger.getLogger(__filename);

const WAITING_FOR_CATALOG_TIMEOUT_MS = 120_000;
const REQUEST_WATCHDOG_TIMEOUT_MS = 180_000;
const SUBSCRIPTION_RETRY_BASE_MS = 250;
const SUBSCRIPTION_RETRY_MAX_MS = 2_000;
const MAX_TERMINAL_REQUEST_IDS = 1_024;
const AGENT_CHAT_DISABLED_ERROR = "Agent chat is disabled";

type AgentChatProviderProps = PropsWithChildren<{
  client?: IAgentClient;
  enabled?: boolean;
  onApplyProposal?: (proposal: LayoutProposal, signal: AbortSignal) => Promise<void>;
  onOpenDataSource?: (urls: string[], sessionId?: string) => void;
}>;

type CallbackRefs = {
  onApplyProposal?: (proposal: LayoutProposal, signal: AbortSignal) => Promise<void>;
  onOpenDataSource?: (urls: string[], sessionId?: string) => void;
};

type ProposalRecord = {
  messageId: string;
  proposal: LayoutProposal;
  requestId: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
};

type Lifecycle = {
  client: IAgentClient;
  controller: AbortController;
  fatal: boolean;
  generation: number;
  ready: boolean;
};

type SendWaiter = {
  cancelled: boolean;
  postController: AbortController;
  promise: Promise<void>;
  reject: (error: Error) => void;
  requestId: string;
  resolve: () => void;
  settled: boolean;
  failure?: Error;
  watchdog?: ReturnType<typeof setTimeout>;
};

type SessionPromise = {
  generation: number;
  promise: Promise<string>;
};

type Subscription = {
  controller: AbortController;
  fatal: boolean;
  generation: number;
  lastSeq: number;
  retryAttempt: number;
  sessionId: string;
};

type AgentChatRuntime = {
  disable: () => void;
  mount: (client: IAgentClient) => () => void;
  store: StoreApi<AgentChatState>;
};

function createDeferred<T>(): Deferred<T> {
  let rejectPromise: (error: Error) => void = () => {};
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  void promise.catch(() => {
    // A lifecycle generation may be cancelled before an action starts waiting on its gate.
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

class LifecycleGenerationCancelledError extends Error {
  public constructor() {
    super("Agent Chat lifecycle generation was cancelled");
    this.name = "LifecycleGenerationCancelledError";
  }
}

type WaitingInfo = {
  requestId: string;
  timeout: ReturnType<typeof setTimeout>;
  urls: readonly string[];
};

function createAssistantMessage(messageId: string): ChatMessage {
  return {
    id: messageId,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
  };
}

function updateAssistantMessage(
  messages: ChatMessage[],
  messageId: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  if (messageIndex === -1) {
    return [...messages, update(createAssistantMessage(messageId))];
  }
  return messages.map((message, index) => (index === messageIndex ? update(message) : message));
}

const TERMINAL_TOOL_STATUSES = new Set<ToolRunStatus>(["succeeded", "failed", "cancelled"]);

const ALLOWED_TOOL_TRANSITIONS: Record<ToolRunStatus, ReadonlySet<ToolRunStatus>> = {
  queued: new Set(["queued", "running", "awaiting-confirmation", "succeeded", "failed", "cancelled"]),
  running: new Set(["running", "awaiting-confirmation", "succeeded", "failed", "cancelled"]),
  "awaiting-confirmation": new Set([
    "awaiting-confirmation",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
};

function reduceToolRun(current: ToolRun | undefined, next: ToolRun): ToolRun {
  if (current == undefined) {
    return next;
  }
  if (!ALLOWED_TOOL_TRANSITIONS[current.status].has(next.status)) {
    return current;
  }
  if (TERMINAL_TOOL_STATUSES.has(current.status) && current.status !== next.status) {
    return current;
  }
  return { ...current, ...next };
}

function upsertToolRun(toolRuns: ToolRun[] | undefined, nextToolRun: ToolRun): ToolRun[] {
  const runs = toolRuns ?? [];
  const runIndex = runs.findIndex((run) => run.id === nextToolRun.id);
  if (runIndex === -1) {
    return [...runs, nextToolRun];
  }
  return runs.map((run, index) =>
    index === runIndex ? reduceToolRun(run, nextToolRun) : run,
  );
}

function reduceAgentEventState(
  state: AgentChatState,
  event: AgentEvent,
  endedMessageIds: Set<string>,
  lastSeqByToolRun: Map<string, number>,
): Partial<AgentChatState> {
  switch (event.type) {
    case "message-start":
      return {
        messages: updateAssistantMessage(state.messages, event.messageId, (message) => message),
      };
    case "token":
      if (endedMessageIds.has(event.messageId)) {
        return {};
      }
      return {
        messages: updateAssistantMessage(state.messages, event.messageId, (message) => ({
          ...message,
          content: message.content + event.delta,
        })),
      };
    case "message-end":
      endedMessageIds.add(event.messageId);
      return {
        messages: updateAssistantMessage(state.messages, event.messageId, (message) => message),
      };
    case "tool-update": {
      const previousSeq = lastSeqByToolRun.get(event.toolRun.id) ?? 0;
      if (event.seq <= previousSeq) {
        return {};
      }
      lastSeqByToolRun.set(event.toolRun.id, event.seq);
      return {
        messages: updateAssistantMessage(state.messages, event.messageId, (message) => ({
          ...message,
          toolRuns: upsertToolRun(message.toolRuns, event.toolRun),
        })),
      };
    }
    case "layout-proposal":
    case "open-data-source":
      return {
        messages: updateAssistantMessage(state.messages, event.messageId, (message) => message),
      };
    case "done":
    case "error":
      return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function createAgentChatRuntime(callbackRefs: MutableRefObject<CallbackRefs>): AgentChatRuntime {
  let applyingProposal: Promise<void> | undefined;
  let committedEnabled: boolean | undefined;
  let initializationGate = createDeferred<Lifecycle>();
  let lifecycle: Lifecycle | undefined;
  let nextGeneration = 0;
  let queuedProposal: ProposalRecord | undefined;
  let sessionPromise: SessionPromise | undefined;
  let subscription: Subscription | undefined;

  const confirmingToolRuns = new Map<string, Promise<void>>();
  const endedMessageIds = new Set<string>();
  const lastSeqByToolRun = new Map<string, number>();
  const sendWaiters = new Map<string, SendWaiter>();
  const terminalRequestIds = new Set<string>();
  const waitingRequests = new Map<string, WaitingInfo>();

  const actions: AgentChatState["actions"] = {
    sendMessage: async (text: string) => {
      const active = await getActionLifecycle();
      if (active == undefined) {
        return;
      }
      if (text.trim().length === 0) {
        return;
      }

      const requestId = uuidv4();
      const userMessage: ChatMessage = {
        id: uuidv4(),
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      if (!isActive(active)) {
        return;
      }
      store.setState((state) => ({
        error: undefined,
        messages: [...state.messages, userMessage],
      }));

      let waiter: SendWaiter | undefined;
      let removeLifecycleAbortListener: (() => void) | undefined;
      try {
        const sessionId = await ensureSession(active);
        if (!isActive(active)) {
          return;
        }

        const postController = new AbortController();
        const abortPost = () => {
          postController.abort(active.controller.signal.reason);
        };
        active.controller.signal.addEventListener("abort", abortPost, { once: true });
        removeLifecycleAbortListener = () => {
          active.controller.signal.removeEventListener("abort", abortPost);
        };

        waiter = createSendWaiter(requestId, postController, active);
        startSubscription(sessionId, active);
        store.setState({ status: "streaming" });

        await Promise.all([
          active.client.sendMessage(sessionId, text, requestId, postController.signal),
          waiter.promise,
        ]);
      } catch (error) {
        if (waiter?.cancelled === true) {
          return;
        }
        if (waiter?.failure != undefined) {
          throw waiter.failure;
        }
        if (!isActive(active)) {
          return;
        }
        failRequest(requestId, error);
        throw error;
      } finally {
        removeLifecycleAbortListener?.();
      }
    },
    confirmToolRun: async (toolRunId: string, options: { approve: boolean }) => {
      const active = await getActionLifecycle();
      if (active == undefined) {
        return;
      }
      const existing = confirmingToolRuns.get(toolRunId);
      if (existing != undefined) {
        await existing;
        return;
      }

      const operation = (async () => {
        clearRecoverableError();
        try {
          const sessionId = await ensureSession(active);
          if (!isActive(active)) {
            return;
          }
          startSubscription(sessionId, active);
          await active.client.confirmToolRun(
            sessionId,
            toolRunId,
            options,
            active.controller.signal,
          );
          restoreStatusAfterSideEffect(active);
        } catch (error) {
          if (isActive(active) && !isAbortError(error)) {
            setRecoverableError(error);
          }
        }
      })();
      confirmingToolRuns.set(toolRunId, operation);
      try {
        await operation;
      } finally {
        if (confirmingToolRuns.get(toolRunId) === operation) {
          confirmingToolRuns.delete(toolRunId);
        }
      }
    },
    applyProposal: async () => {
      const active = await getActionLifecycle();
      if (active == undefined) {
        return;
      }
      if (applyingProposal != undefined) {
        await applyingProposal;
        return;
      }

      const state = store.getState();
      const proposal = state.pendingProposal;
      const proposalMessageId = state.pendingProposalMessageId;
      const proposalRequestId = state.pendingProposalRequestId;
      if (
        proposal == undefined ||
        proposalMessageId == undefined ||
        proposalRequestId == undefined
      ) {
        return;
      }

      const operation = (async () => {
        clearRecoverableError();
        try {
          const validatedProposal = validateLayoutProposal(proposal);
          await callbackRefs.current.onApplyProposal?.(
            validatedProposal,
            active.controller.signal,
          );
          if (!isActive(active)) {
            return;
          }
          const currentState = store.getState();
          if (
            currentState.pendingProposal === proposal &&
            currentState.pendingProposalMessageId === proposalMessageId &&
            currentState.pendingProposalRequestId === proposalRequestId
          ) {
            promoteQueuedProposal();
          }
          restoreStatusAfterSideEffect(active);
        } catch (error) {
          if (isActive(active) && !isAbortError(error)) {
            setRecoverableError(error);
          }
        }
      })();
      applyingProposal = operation;
      try {
        await operation;
      } finally {
        if (applyingProposal === operation) {
          applyingProposal = undefined;
        }
      }
    },
    dismissProposal: () => {
      assertCommittedEnabled();
      if (applyingProposal == undefined) {
        promoteQueuedProposal();
      }
    },
    notifyCatalogReady: (requestId: string) => {
      assertCommittedEnabled();
      const state = store.getState();
      const active = lifecycle;
      if (
        !waitingRequests.has(requestId) ||
        active == undefined ||
        !isActive(active) ||
        state.sessionId == undefined
      ) {
        return;
      }

      removeWaitingRequest(requestId);
      publishWaitingProjection({ fallbackStatus: "idle" });
      void active.client
        .notifyCatalogReady(state.sessionId, requestId, active.controller.signal)
        .catch((error: unknown) => {
          if (isActive(active) && !isAbortError(error)) {
            log.warn(`Failed to notify the agent that the catalog is ready: ${errorMessage(error)}`);
          }
        });
    },
    cancelWaiting: () => {
      assertCommittedEnabled();
      const requestId = getLatestWaitingRequest()?.requestId;
      if (requestId == undefined) {
        return;
      }
      removeWaitingRequest(requestId);
      const waiter = sendWaiters.get(requestId);
      if (waiter != undefined) {
        waiter.cancelled = true;
        waiter.postController.abort();
        settleWaiter(waiter, { result: "resolve" });
      }
      markRequestTerminal(requestId);
      publishWaitingProjection({ fallbackStatus: "idle" });
    },
    reset: () => {
      assertCommittedEnabled();
      const active = lifecycle;
      if (active == undefined) {
        store.setState(emptyState());
        return;
      }
      stopLifecycle(active.generation);
      startLifecycle(active.client);
      store.setState(emptyState());
    },
  };

  const store = createStore<AgentChatState>()(() => ({
    ...emptyState(),
    actions,
  }));

  function emptyState(): Omit<AgentChatState, "actions"> {
    return {
      error: undefined,
      messages: [],
      pendingProposal: undefined,
      pendingProposalMessageId: undefined,
      pendingProposalRequestId: undefined,
      sessionId: undefined,
      status: "idle",
      waitingRequest: undefined,
    };
  }

  function startLifecycle(client: IAgentClient): Lifecycle {
    const active: Lifecycle = {
      client,
      controller: new AbortController(),
      fatal: false,
      generation: ++nextGeneration,
      ready: false,
    };
    const gate = initializationGate;
    lifecycle = active;
    void Promise.resolve().then(() => {
      if (
        lifecycle === active &&
        committedEnabled === true &&
        !active.controller.signal.aborted &&
        initializationGate === gate
      ) {
        active.ready = true;
        gate.resolve(active);
      }
    });
    return active;
  }

  async function waitForLifecycle(): Promise<Lifecycle> {
    if (committedEnabled === false) {
      assertCommittedEnabled();
    }
    let active = lifecycle;
    if (active?.fatal === true) {
      const client = active.client;
      stopLifecycle(active.generation);
      store.setState({
        error: undefined,
        sessionId: undefined,
        status: "idle",
        waitingRequest: undefined,
      });
      active = startLifecycle(client);
    }
    if (active?.ready === true && isActive(active)) {
      return active;
    }

    const gate = initializationGate;
    const initialized = await gate.promise;
    if (lifecycle !== initialized || !isActive(initialized)) {
      throw new LifecycleGenerationCancelledError();
    }
    return initialized;
  }

  async function getActionLifecycle(): Promise<Lifecycle | undefined> {
    try {
      return await waitForLifecycle();
    } catch (error) {
      if (error instanceof LifecycleGenerationCancelledError) {
        return undefined;
      }
      throw error;
    }
  }

  function assertCommittedEnabled(): void {
    if (committedEnabled === false) {
      store.setState({ error: undefined, status: "idle" });
      throw new Error(AGENT_CHAT_DISABLED_ERROR);
    }
    if (committedEnabled == undefined) {
      throw new LifecycleGenerationCancelledError();
    }
  }

  function isActive(expected: Lifecycle): boolean {
    return (
      committedEnabled === true &&
      lifecycle === expected &&
      expected.ready &&
      !expected.fatal &&
      !expected.controller.signal.aborted
    );
  }

  function getOperationalStatus(error?: string): AgentChatState["status"] {
    if (waitingRequests.size > 0) {
      return "waiting-for-catalog";
    }
    if (sendWaiters.size > 0) {
      return "streaming";
    }
    return error == undefined ? "idle" : "error";
  }

  function setRecoverableError(error: unknown): void {
    const message = errorMessage(error);
    store.setState({
      error: message,
      status: getOperationalStatus(message),
    });
  }

  function clearRecoverableError(): void {
    store.setState((state) => ({
      error: undefined,
      status: state.status === "error" ? getOperationalStatus() : state.status,
    }));
  }

  function restoreStatusAfterSideEffect(expected: Lifecycle): void {
    if (!isActive(expected)) {
      return;
    }
    store.setState((state) => {
      if (expected.fatal) {
        return {};
      }
      return { status: getOperationalStatus(state.error) };
    });
  }

  async function ensureSession(expected: Lifecycle): Promise<string> {
    const existingSessionId = store.getState().sessionId;
    if (existingSessionId != undefined) {
      return existingSessionId;
    }
    if (sessionPromise?.generation === expected.generation) {
      return await sessionPromise.promise;
    }
    if (!isActive(expected)) {
      throw new Error("Agent Chat provider is not mounted");
    }

    store.setState({ error: undefined, status: "connecting" });
    const pending = expected.client.createSession(expected.controller.signal).then(({ sessionId }) => {
      if (isActive(expected)) {
        store.setState({ sessionId });
      }
      return sessionId;
    });
    const record = { generation: expected.generation, promise: pending };
    sessionPromise = record;
    try {
      return await pending;
    } finally {
      if (sessionPromise === record) {
        sessionPromise = undefined;
      }
    }
  }

  function createSendWaiter(
    requestId: string,
    postController: AbortController,
    expected: Lifecycle,
  ): SendWaiter {
    let resolvePromise: () => void = () => {};
    let rejectPromise: (error: Error) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: SendWaiter = {
      cancelled: false,
      postController,
      promise,
      reject: rejectPromise,
      requestId,
      resolve: resolvePromise,
      settled: false,
    };
    sendWaiters.set(requestId, waiter);
    resetRequestWatchdog(waiter, expected);
    return waiter;
  }

  function resetRequestWatchdog(waiter: SendWaiter, expected: Lifecycle): void {
    if (waiter.watchdog != undefined) {
      clearTimeout(waiter.watchdog);
    }
    waiter.watchdog = setTimeout(() => {
      if (!isActive(expected) || sendWaiters.get(waiter.requestId) !== waiter) {
        return;
      }
      failRequest(waiter.requestId, new Error("Timed out waiting for the agent response"));
    }, REQUEST_WATCHDOG_TIMEOUT_MS);
  }

  function settleWaiter(
    waiter: SendWaiter | undefined,
    outcome: { result: "resolve" } | { result: "reject"; error: Error },
  ): void {
    if (waiter == undefined || waiter.settled) {
      return;
    }
    waiter.settled = true;
    sendWaiters.delete(waiter.requestId);
    if (waiter.watchdog != undefined) {
      clearTimeout(waiter.watchdog);
      waiter.watchdog = undefined;
    }
    if (outcome.result === "reject") {
      waiter.failure = outcome.error;
      waiter.postController.abort(outcome.error);
      waiter.reject(outcome.error);
    } else {
      waiter.resolve();
    }
    store.setState((state) => {
      if (lifecycle?.fatal === true) {
        return {};
      }
      return { status: getOperationalStatus(state.error) };
    });
  }

  function rejectAllWaiters(error: Error): void {
    for (const waiter of [...sendWaiters.values()]) {
      markRequestTerminal(waiter.requestId);
      settleWaiter(waiter, { result: "reject", error });
    }
  }

  function startSubscription(sessionId: string, expected: Lifecycle): void {
    if (
      subscription?.generation === expected.generation &&
      subscription.sessionId === sessionId &&
      !subscription.fatal &&
      !subscription.controller.signal.aborted
    ) {
      return;
    }

    subscription?.controller.abort();
    const subscriptionController = new AbortController();
    const abortSubscription = () => {
      subscriptionController.abort(expected.controller.signal.reason);
    };
    expected.controller.signal.addEventListener("abort", abortSubscription, { once: true });
    const record: Subscription = {
      controller: subscriptionController,
      fatal: false,
      generation: expected.generation,
      lastSeq: 0,
      retryAttempt: 0,
      sessionId,
    };
    subscription = record;

    const handleSubscriptionEvent = (event: AgentEvent) => {
      if (!isActive(expected) || subscription !== record || record.fatal) {
        return;
      }
      if (!Number.isSafeInteger(event.seq) || event.seq <= 0) {
        failSubscription(
          record,
          new AgentStreamProtocolError("Agent event seq must be a positive safe integer"),
        );
        return;
      }
      record.retryAttempt = 0;
      if (event.seq <= record.lastSeq) {
        return;
      }
      record.lastSeq = event.seq;
      handleAgentEvent(event, expected, record);
    };

    void (async () => {
      try {
        while (isActive(expected) && subscription === record && !record.fatal) {
          try {
            await expected.client.subscribeEvents(
              sessionId,
              handleSubscriptionEvent,
              subscriptionController.signal,
              { lastSeq: record.lastSeq },
            );
          } catch (error) {
            if (
              subscriptionController.signal.aborted ||
              !isActive(expected) ||
              subscription !== record
            ) {
              return;
            }
            if (
              error instanceof AgentStreamSizeLimitError ||
              error instanceof AgentStreamProtocolError
            ) {
              failSubscription(record, error);
              return;
            }
          }

          if (
            subscriptionController.signal.aborted ||
            !isActive(expected) ||
            subscription !== record
          ) {
            return;
          }

          const delayMs = Math.min(
            SUBSCRIPTION_RETRY_BASE_MS * 2 ** record.retryAttempt,
            SUBSCRIPTION_RETRY_MAX_MS,
          );
          record.retryAttempt = Math.min(record.retryAttempt + 1, 3);
          await abortableDelay(delayMs, subscriptionController.signal);
        }
      } finally {
        expected.controller.signal.removeEventListener("abort", abortSubscription);
        if (subscription === record && (record.fatal || subscriptionController.signal.aborted)) {
          subscription = undefined;
        }
      }
    })();
  }

  function failSubscription(record: Subscription, error: Error): void {
    if (record.fatal) {
      return;
    }
    record.fatal = true;
    failSession(record, error);
  }

  function handleAgentEvent(
    event: AgentEvent,
    expected: Lifecycle,
    subscriptionRecord: Subscription,
  ): void {
    if (!isActive(expected)) {
      return;
    }

    const requestId = event.requestId;
    if (requestId != undefined && terminalRequestIds.has(requestId)) {
      return;
    }
    const waiter = requestId == undefined ? undefined : sendWaiters.get(requestId);
    if (waiter != undefined) {
      resetRequestWatchdog(waiter, expected);
    }

    store.setState((state) =>
      reduceAgentEventState(state, event, endedMessageIds, lastSeqByToolRun),
    );

    switch (event.type) {
      case "message-start":
      case "token":
      case "message-end":
      case "tool-update":
        return;
      case "layout-proposal":
        try {
          const proposal = validateLayoutProposal(event.proposal);
          enqueueProposal({
            messageId: event.messageId,
            proposal,
            requestId: event.requestId,
          });
        } catch (error) {
          const validationError = new Error(`Invalid layout proposal: ${errorMessage(error)}`);
          failRequest(event.requestId, validationError);
        }
        return;
      case "open-data-source":
        enterWaitingForCatalog(event.requestId, event.urls, expected);
        try {
          callbackRefs.current.onOpenDataSource?.(
            event.urls,
            event.sessionId ?? store.getState().sessionId,
          );
          if (!isActive(expected) || subscription !== subscriptionRecord) {
            return;
          }
        } catch (error) {
          const callbackError = error instanceof Error ? error : new Error(String(error));
          failRequest(event.requestId, callbackError);
        }
        return;
      case "error": {
        const eventError = new Error(event.error);
        if (event.requestId == undefined) {
          subscriptionRecord.fatal = true;
          failSession(subscriptionRecord, eventError);
        } else {
          failRequest(event.requestId, eventError);
        }
        return;
      }
      case "done":
        markRequestTerminal(event.requestId);
        settleWaiter(sendWaiters.get(event.requestId), { result: "resolve" });
        return;
    }
  }

  function enqueueProposal(record: ProposalRecord): void {
    const state = store.getState();
    if (state.pendingProposal == undefined) {
      store.setState({
        pendingProposal: record.proposal,
        pendingProposalMessageId: record.messageId,
        pendingProposalRequestId: record.requestId,
      });
      return;
    }
    queuedProposal = record;
  }

  function promoteQueuedProposal(): void {
    const next = queuedProposal;
    queuedProposal = undefined;
    store.setState({
      pendingProposal: next?.proposal,
      pendingProposalMessageId: next?.messageId,
      pendingProposalRequestId: next?.requestId,
    });
  }

  function enterWaitingForCatalog(
    requestId: string,
    urls: readonly string[],
    expected: Lifecycle,
  ): void {
    removeWaitingRequest(requestId);
    const timeout = setTimeout(() => {
      const waiting = waitingRequests.get(requestId);
      if (!isActive(expected) || waiting?.timeout !== timeout) {
        return;
      }
      failRequest(requestId, new Error("Timed out waiting for the data catalog"));
    }, WAITING_FOR_CATALOG_TIMEOUT_MS);
    waitingRequests.set(requestId, { requestId, timeout, urls });
    publishWaitingProjection({ clearError: true });
  }

  function removeWaitingRequest(requestId: string): void {
    const waiting = waitingRequests.get(requestId);
    if (waiting != undefined) {
      clearTimeout(waiting.timeout);
      waitingRequests.delete(requestId);
    }
  }

  function getLatestWaitingRequest(): WaitingInfo | undefined {
    let latest: WaitingInfo | undefined;
    for (const waiting of waitingRequests.values()) {
      latest = waiting;
    }
    return latest;
  }

  function publishWaitingProjection(
    options: { clearError?: boolean; fallbackStatus?: AgentChatState["status"] } = {},
  ): void {
    const latest = getLatestWaitingRequest();
    store.setState((state) => ({
      error: options.clearError === true ? undefined : state.error,
      status:
        latest == undefined
          ? (options.fallbackStatus ?? getOperationalStatus(state.error))
          : "waiting-for-catalog",
      waitingRequest:
        latest == undefined
          ? undefined
          : { requestId: latest.requestId, urls: latest.urls },
    }));
  }

  function clearAllWaitingRequests(): void {
    for (const waiting of waitingRequests.values()) {
      clearTimeout(waiting.timeout);
    }
    waitingRequests.clear();
  }

  function failRequest(requestId: string, error: unknown): void {
    const requestError = error instanceof Error ? error : new Error(String(error));
    markRequestTerminal(requestId);
    removeWaitingRequest(requestId);
    settleWaiter(sendWaiters.get(requestId), { result: "reject", error: requestError });
    const message = requestError.message;
    const latest = getLatestWaitingRequest();
    store.setState({
      error: message,
      status:
        latest != undefined
          ? "waiting-for-catalog"
          : getOperationalStatus(message),
      waitingRequest:
        latest == undefined
          ? undefined
          : { requestId: latest.requestId, urls: latest.urls },
    });
  }

  function failSession(record: Subscription, error: Error): void {
    const active = lifecycle;
    if (
      active?.generation !== record.generation ||
      subscription !== record ||
      active.fatal
    ) {
      return;
    }
    record.fatal = true;
    active.fatal = true;
    clearAllWaitingRequests();
    rejectAllWaiters(error);
    record.controller.abort(error);
    active.controller.abort(error);
    sessionPromise = undefined;
    store.setState({
      error: error.message,
      sessionId: undefined,
      status: "error",
      waitingRequest: undefined,
    });
  }

  function markRequestTerminal(requestId: string): void {
    terminalRequestIds.delete(requestId);
    terminalRequestIds.add(requestId);
    while (terminalRequestIds.size > MAX_TERMINAL_REQUEST_IDS) {
      const oldest = terminalRequestIds.values().next().value;
      if (oldest == undefined) {
        break;
      }
      terminalRequestIds.delete(oldest);
    }
  }

  function clearRuntimeState(): void {
    applyingProposal = undefined;
    confirmingToolRuns.clear();
    endedMessageIds.clear();
    lastSeqByToolRun.clear();
    queuedProposal = undefined;
    sessionPromise = undefined;
    subscription = undefined;
    terminalRequestIds.clear();
    clearAllWaitingRequests();
  }

  function releaseAllWaiters(): void {
    for (const waiter of sendWaiters.values()) {
      waiter.cancelled = true;
      waiter.settled = true;
      if (waiter.watchdog != undefined) {
        clearTimeout(waiter.watchdog);
        waiter.watchdog = undefined;
      }
      waiter.postController.abort();
      waiter.resolve();
    }
    sendWaiters.clear();
  }

  function stopLifecycle(expectedGeneration?: number): void {
    if (expectedGeneration != undefined && lifecycle?.generation !== expectedGeneration) {
      return;
    }
    const active = lifecycle;
    lifecycle = undefined;
    const cancelledGate = initializationGate;
    initializationGate = createDeferred<Lifecycle>();
    cancelledGate.reject(new LifecycleGenerationCancelledError());
    active?.controller.abort();
    subscription?.controller.abort();
    releaseAllWaiters();
    clearRuntimeState();
  }

  return {
    disable: () => {
      committedEnabled = false;
      const pendingInitialization = initializationGate;
      if (lifecycle != undefined) {
        stopLifecycle();
      } else {
        initializationGate = createDeferred<Lifecycle>();
        pendingInitialization.reject(new LifecycleGenerationCancelledError());
      }
      store.setState(emptyState());
    },
    mount: (client: IAgentClient) => {
      committedEnabled = true;
      if (lifecycle != undefined) {
        stopLifecycle();
      }
      const active = startLifecycle(client);
      store.setState(emptyState());
      return () => {
        stopLifecycle(active.generation);
      };
    },
    store,
  };
}

export default function AgentChatProvider({
  children,
  client,
  enabled = true,
  onApplyProposal,
  onOpenDataSource,
}: AgentChatProviderProps): React.JSX.Element {
  const callbackRefs = useRef<CallbackRefs>({});
  const [runtime] = useState(() => createAgentChatRuntime(callbackRefs));

  useLayoutEffect(() => {
    callbackRefs.current = { onApplyProposal, onOpenDataSource };
    return () => {
      callbackRefs.current = {};
    };
  }, [onApplyProposal, onOpenDataSource]);

  useLayoutEffect(() => {
    if (!enabled || client == undefined) {
      runtime.disable();
      return;
    }
    return runtime.mount(client);
  }, [client, enabled, runtime]);

  return <AgentChatContext.Provider value={runtime.store}>{children}</AgentChatContext.Provider>;
}
