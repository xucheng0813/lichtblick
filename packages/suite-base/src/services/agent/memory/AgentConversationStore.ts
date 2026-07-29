// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as IDB from "idb/with-async-ittr";

import Log from "@lichtblick/log";
import { KEY_WORKSPACE_PREFIX } from "@lichtblick/suite-base/constants/browserStorageKeys";
import type { LlmMessage } from "@lichtblick/suite-base/services/agent/local/types";

const log = Log.getLogger(__filename);

const DATABASE_NAME = `${KEY_WORKSPACE_PREFIX}lichtblick-agent-conversations`;
const OBJECT_STORE_NAME = "conversations";

/**
 * One persisted conversation.
 *
 * The UI transcript and the LLM transcript are different shapes owned by different layers, but they
 * must be restored together or the user sees messages the model has no memory of. Keeping them in
 * a single record makes that atomic.
 */
export type StoredConversation = {
  conversationId: string;
  updatedAt: string;
  uiMessages: unknown[];
  llmHistory: LlmMessage[];
};

interface ConversationsDB extends IDB.DBSchema {
  conversations: {
    key: string;
    value: StoredConversation;
  };
}

/**
 * Persists agent conversations in IndexedDB.
 *
 * IndexedDB rather than app configuration because a transcript can reach the orchestrator's
 * multi-megabyte history budget, and the desktop configuration backend rewrites its entire
 * settings file on every write.
 */
export class AgentConversationStore {
  #db = IDB.openDB<ConversationsDB>(DATABASE_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(OBJECT_STORE_NAME, { keyPath: "conversationId" });
    },
  });

  public async load(conversationId: string): Promise<StoredConversation | undefined> {
    try {
      return await (await this.#db).get(OBJECT_STORE_NAME, conversationId);
    } catch (error) {
      // A conversation that cannot be restored must not stop a new one from starting.
      log.error(error, "Failed to load the stored agent conversation");
      return undefined;
    }
  }

  public async save(conversation: StoredConversation): Promise<void> {
    try {
      await (await this.#db).put(OBJECT_STORE_NAME, conversation);
    } catch (error) {
      log.error(error, "Failed to persist the agent conversation");
    }
  }

  public async delete(conversationId: string): Promise<void> {
    try {
      await (await this.#db).delete(OBJECT_STORE_NAME, conversationId);
    } catch (error) {
      log.error(error, "Failed to delete the stored agent conversation");
    }
  }
}
