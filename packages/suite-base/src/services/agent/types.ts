// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

export type ToolRunStatus =
  | "queued"
  | "running"
  | "awaiting-confirmation"
  | "succeeded"
  | "failed"
  | "cancelled";
export type ToolRun = {
  id: string;
  name: string;
  status: ToolRunStatus;
  progress?: number;
  summary?: string;
  result?: unknown;
  error?: string;
};
export type ChatRole = "user" | "assistant";
export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  toolRuns?: ToolRun[];
  createdAt: string;
};
export type LayoutProposal = { name: string; data: unknown; summary?: string };
export type AgentEventEnvelope = {
  /** Monotonically increasing positive safe integer within a session event stream. */
  seq: number;
  /** Non-empty when present; identifies the associated sendMessage request. */
  requestId?: string;
};
export type AgentEvent =
  | (AgentEventEnvelope & { type: "message-start"; messageId: string; requestId: string })
  | (AgentEventEnvelope & { type: "token"; messageId: string; delta: string; requestId: string })
  | (AgentEventEnvelope & { type: "message-end"; messageId: string; requestId: string })
  | (AgentEventEnvelope & {
      type: "tool-update";
      messageId: string;
      toolRun: ToolRun;
      requestId: string;
    })
  | (AgentEventEnvelope & {
      type: "layout-proposal";
      messageId: string;
      proposal: LayoutProposal;
      requestId: string;
    })
  | (AgentEventEnvelope & {
      type: "open-data-source";
      messageId: string;
      urls: string[];
      sessionId?: string;
      requestId: string;
    })
  | (AgentEventEnvelope & { type: "error"; error: string })
  | (AgentEventEnvelope & { type: "done"; requestId: string });
export type SubscribeEventsOptions = {
  /**
   * Maximum time without receiving any response bytes before the subscription rejects.
   * Defaults to 60 seconds.
   */
  idleTimeoutMs?: number;
  /** Non-negative safe-integer replay cursor. The server returns events above this value. */
  lastSeq?: number;
};
export type SubscribeEventsResult = {
  /**
   * EOF always means that this physical connection ended and may be reconnected. A server that
   * intends to terminate the session must send a session-level error or a dedicated control event.
   */
  reason: "eof";
};
export interface IAgentClient {
  createSession: (signal?: AbortSignal) => Promise<{ sessionId: string }>;
  sendMessage: (
    sessionId: string,
    content: string,
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Resolves with an EOF reason when the physical SSE connection closes. Events with
   * seq <= options.lastSeq, including replayed events, are discarded. Caller cancellation rejects
   * with the AbortSignal reason. The void union preserves compatibility with legacy client
   * implementations; AgentClient always returns SubscribeEventsResult.
   */
  subscribeEvents: (
    sessionId: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
    options?: SubscribeEventsOptions,
  ) => Promise<SubscribeEventsResult | void>;
  confirmToolRun: (
    sessionId: string,
    toolRunId: string,
    options: { approve: boolean },
    signal?: AbortSignal,
  ) => Promise<void>;
  notifyCatalogReady: (
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}
