// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { KEY_WORKSPACE_PREFIX } from "@lichtblick/suite-base/constants/browserStorageKeys";
import type { LlmMessage } from "@lichtblick/suite-base/services/agent/local/types";

import type { AgentConversationStore, StoredConversation } from "./AgentConversationStore";

export const AGENT_CONVERSATION_ID_KEY = `${KEY_WORKSPACE_PREFIX}studio.agent.conversation-id`;

/**
 * Reads the active conversation id, minting and persisting one on first use.
 *
 * Kept in localStorage under the workspace prefix so parallel dev workspaces do not share a
 * transcript. Storage failures fall back to an in-memory id: the conversation then simply will not
 * survive a reload, which is better than refusing to start.
 */
export function getOrCreateConversationId(makeId: () => string): string {
  try {
    // A missing or blocked localStorage throws here and is handled by the catch below.
    const existing = globalThis.localStorage.getItem(AGENT_CONVERSATION_ID_KEY);
    if (existing != undefined && existing.length > 0) {
      return existing;
    }
    const created = makeId();
    globalThis.localStorage.setItem(AGENT_CONVERSATION_ID_KEY, created);
    return created;
  } catch {
    return makeId();
  }
}

function rememberConversationId(conversationId: string): void {
  try {
    globalThis.localStorage.setItem(AGENT_CONVERSATION_ID_KEY, conversationId);
  } catch {
    // Without storage the new conversation simply will not survive a reload.
  }
}

/**
 * Coordinates persistence of the two halves of a conversation.
 *
 * The UI transcript is owned by the chat provider and the LLM transcript by the orchestrator, but
 * restoring one without the other would show the user messages the model cannot recall. This holds
 * both and writes them as one record.
 */
export type AgentConversationPersistence = {
  /** Resolves the stored record once; repeat calls reuse the same read. */
  restoreLlmHistory: () => Promise<LlmMessage[]>;
  restoreUiMessages: () => Promise<unknown[]>;
  onLlmHistoryChanged: (history: readonly LlmMessage[]) => void;
  onUiMessagesChanged: (messages: readonly unknown[]) => void;
  /**
   * Discards the current conversation and starts a new one.
   *
   * Rotating the id rather than only clearing state matters: the orchestrator re-reads the stored
   * transcript whenever it creates a session, so a "new conversation" that left the old record in
   * place would silently pull the old history back into the model's context.
   */
  startNewConversation: () => void;
  clear: () => void;
};

export function createAgentConversationPersistence({
  conversationId: initialConversationId,
  makeId,
  now = () => new Date(),
  store,
}: {
  conversationId: string;
  /** Mints the id for a new conversation. */
  makeId: () => string;
  now?: () => Date;
  store: AgentConversationStore;
}): AgentConversationPersistence {
  let conversationId = initialConversationId;
  let loaded: Promise<StoredConversation | undefined> | undefined;
  let llmHistory: LlmMessage[] = [];
  let uiMessages: unknown[] = [];
  // Serializes writes so two rapid changes cannot interleave into a torn record.
  let writeQueue: Promise<void> = Promise.resolve();

  const load = async (): Promise<StoredConversation | undefined> => {
    loaded ??= store.load(conversationId);
    const record = await loaded;
    llmHistory = record?.llmHistory ?? [];
    uiMessages = record?.uiMessages ?? [];
    return record;
  };

  const flush = () => {
    const snapshot: StoredConversation = {
      conversationId,
      updatedAt: now().toISOString(),
      llmHistory: [...llmHistory],
      uiMessages: [...uiMessages],
    };
    writeQueue = writeQueue.then(async () => {
      await store.save(snapshot);
    });
  };

  return {
    restoreLlmHistory: async () => {
      await load();
      return [...llmHistory];
    },
    restoreUiMessages: async () => {
      await load();
      return [...uiMessages];
    },
    onLlmHistoryChanged: (history) => {
      llmHistory = [...history];
      flush();
    },
    onUiMessagesChanged: (messages) => {
      uiMessages = [...messages];
      flush();
    },
    startNewConversation: () => {
      const previous = conversationId;
      writeQueue = writeQueue.then(async () => {
        await store.delete(previous);
      });
      conversationId = makeId();
      rememberConversationId(conversationId);
      llmHistory = [];
      uiMessages = [];
      // Resolve rather than reset to undefined so a restore racing this call cannot re-read the
      // discarded conversation.
      loaded = Promise.resolve(undefined);
    },
    clear: () => {
      llmHistory = [];
      uiMessages = [];
      loaded = Promise.resolve(undefined);
      writeQueue = writeQueue.then(async () => {
        await store.delete(conversationId);
      });
    },
  };
}
