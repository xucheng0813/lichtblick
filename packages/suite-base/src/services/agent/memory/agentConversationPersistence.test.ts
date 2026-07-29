/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { LlmMessage } from "@lichtblick/suite-base/services/agent/local/types";

import { AgentConversationStore } from "./AgentConversationStore";
import {
  AGENT_CONVERSATION_ID_KEY,
  createAgentConversationPersistence,
  getOrCreateConversationId,
} from "./agentConversationPersistence";

const history: LlmMessage[] = [{ role: "user", content: "find SN001" }];

describe("getOrCreateConversationId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("mints an id once and reuses it across reloads", () => {
    const first = getOrCreateConversationId(() => "generated-1");
    expect(first).toBe("generated-1");
    expect(localStorage.getItem(AGENT_CONVERSATION_ID_KEY)).toBe("generated-1");

    expect(getOrCreateConversationId(() => "generated-2")).toBe("generated-1");
  });

  it("still returns an id when storage is unavailable", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getOrCreateConversationId(() => "fallback")).toBe("fallback");
    getItem.mockRestore();
  });
});

describe("createAgentConversationPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores both transcripts from one record", async () => {
    const store = new AgentConversationStore();
    await store.save({
      conversationId: "c1",
      updatedAt: "2026-07-28T00:00:00Z",
      llmHistory: history,
      uiMessages: [{ id: "u1", role: "user", text: "find SN001" }],
    });

    const persistence = createAgentConversationPersistence({ conversationId: "c1", makeId: () => "next", store });
    await expect(persistence.restoreLlmHistory()).resolves.toEqual(history);
    await expect(persistence.restoreUiMessages()).resolves.toHaveLength(1);
  });

  it("returns empty transcripts for an unknown conversation", async () => {
    const persistence = createAgentConversationPersistence({
      conversationId: "missing",
      makeId: () => "next",
      store: new AgentConversationStore(),
    });
    await expect(persistence.restoreLlmHistory()).resolves.toEqual([]);
    await expect(persistence.restoreUiMessages()).resolves.toEqual([]);
  });

  it("keeps both halves in the same record when only one changes", async () => {
    const store = new AgentConversationStore();
    const persistence = createAgentConversationPersistence({ conversationId: "c2", makeId: () => "next", store });
    await persistence.restoreLlmHistory();

    persistence.onLlmHistoryChanged(history);
    persistence.onUiMessagesChanged([{ id: "u1" }]);
    // Writes are queued; let the queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = await store.load("c2");
    expect(stored?.llmHistory).toEqual(history);
    expect(stored?.uiMessages).toEqual([{ id: "u1" }]);
  });

  it("snapshots each change so a later mutation cannot rewrite a queued record", async () => {
    const store = new AgentConversationStore();
    const persistence = createAgentConversationPersistence({ conversationId: "c3", makeId: () => "next", store });
    await persistence.restoreLlmHistory();

    const mutable: LlmMessage[] = [{ role: "user", content: "first" }];
    persistence.onLlmHistoryChanged(mutable);
    mutable.push({ role: "user", content: "second" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await store.load("c3"))?.llmHistory).toHaveLength(1);
  });

  it("starts a new conversation by rotating the id and dropping the old record", async () => {
    const store = new AgentConversationStore();
    localStorage.setItem(AGENT_CONVERSATION_ID_KEY, "c5");
    const persistence = createAgentConversationPersistence({
      conversationId: "c5",
      makeId: () => "c6",
      store,
    });
    persistence.onLlmHistoryChanged(history);
    persistence.onUiMessagesChanged([{ id: "u1" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.load("c5")).toBeDefined();

    persistence.startNewConversation();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The old transcript must be gone from storage, not merely hidden: the orchestrator rehydrates
    // from here on its next session.
    expect(await store.load("c5")).toBeUndefined();
    await expect(persistence.restoreLlmHistory()).resolves.toEqual([]);
    await expect(persistence.restoreUiMessages()).resolves.toEqual([]);
    // The new id has to survive a reload, otherwise the next launch resumes the discarded one.
    expect(localStorage.getItem(AGENT_CONVERSATION_ID_KEY)).toBe("c6");
  });

  it("writes subsequent changes under the new conversation id", async () => {
    const store = new AgentConversationStore();
    const persistence = createAgentConversationPersistence({
      conversationId: "c7",
      makeId: () => "c8",
      store,
    });
    persistence.startNewConversation();
    persistence.onLlmHistoryChanged(history);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await store.load("c8"))?.llmHistory).toEqual(history);
    expect(await store.load("c7")).toBeUndefined();
  });

  it("clears the stored conversation", async () => {
    const store = new AgentConversationStore();
    const persistence = createAgentConversationPersistence({ conversationId: "c4", makeId: () => "next", store });
    persistence.onLlmHistoryChanged(history);
    await new Promise((resolve) => setTimeout(resolve, 0));

    persistence.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await store.load("c4")).toBeUndefined();
    await expect(persistence.restoreLlmHistory()).resolves.toEqual([]);
  });
});
