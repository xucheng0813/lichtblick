// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import Log from "@lichtblick/log";
import httpService, { HttpService } from "@lichtblick/suite-base/services/http/HttpService";

import { AgentConversationStore, StoredConversation } from "./AgentConversationStore";

const log = Log.getLogger(__filename);

const REMOTE_SAVE_DEBOUNCE_MS = 2_000;

export type ConversationSummary = {
  conversationId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
};

export type ConversationListPage = {
  items: ConversationSummary[];
  total: number;
};

type RemoteStoredConversation = StoredConversation & {
  title: string;
};

type ConversationHttpService = Pick<HttpService, "delete" | "get" | "put">;
type LocalConversationStore = Pick<AgentConversationStore, "delete" | "load" | "save">;

/**
 * Mirrors conversations to vtd-viz-server while keeping IndexedDB as an always-written fallback.
 */
export class RemoteAgentConversationStore {
  readonly #http: ConversationHttpService;
  readonly #local: LocalConversationStore;
  readonly #workspacePath: string;

  #pendingSaves = new Map<string, StoredConversation>();
  #remoteQueue: Promise<void> = Promise.resolve();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor({
    workspace,
    http = httpService,
    local = new AgentConversationStore(),
  }: {
    workspace: string;
    http?: ConversationHttpService;
    local?: LocalConversationStore;
  }) {
    this.#http = http;
    this.#local = local;
    this.#workspacePath = `workspaces/${encodeURIComponent(workspace)}/conversations`;
  }

  public async load(conversationId: string): Promise<StoredConversation | undefined> {
    try {
      const response = await this.#http.get<RemoteStoredConversation>(
        `${this.#workspacePath}/${encodeURIComponent(conversationId)}`,
      );
      const conversation: StoredConversation = {
        conversationId: response.data.conversationId,
        updatedAt: response.data.updatedAt,
        uiMessages: response.data.uiMessages,
        llmHistory: response.data.llmHistory,
      };
      await this.#local.save(conversation);
      return conversation;
    } catch (error) {
      log.warn(error, "Failed to load the remote agent conversation; using local storage");
      return await this.#local.load(conversationId);
    }
  }

  public async save(conversation: StoredConversation): Promise<void> {
    await this.#local.save(conversation);
    this.#pendingSaves.set(conversation.conversationId, conversation);
    this.#scheduleRemoteSave();
  }

  public async delete(conversationId: string): Promise<void> {
    this.#pendingSaves.delete(conversationId);
    await this.#local.delete(conversationId);
    await this.#enqueueRemote(async () => {
      try {
        await this.#http.delete<{ deleted: boolean }>(
          `${this.#workspacePath}/${encodeURIComponent(conversationId)}`,
        );
      } catch (error) {
        log.warn(error, "Failed to delete the remote agent conversation");
      }
    });
  }

  public async list(page: number, pageSize: number): Promise<ConversationListPage> {
    const response = await this.#http.get<ConversationListPage>(this.#workspacePath, {
      page: String(page),
      page_size: String(pageSize),
    });
    return response.data;
  }

  #scheduleRemoteSave(): void {
    if (this.#saveTimer != undefined) {
      clearTimeout(this.#saveTimer);
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      const snapshots = [...this.#pendingSaves.values()];
      this.#pendingSaves.clear();
      void this.#enqueueRemote(async () => {
        for (const snapshot of snapshots) {
          try {
            await this.#http.put<ConversationSummary>(
              `${this.#workspacePath}/${encodeURIComponent(snapshot.conversationId)}`,
              snapshot,
            );
          } catch (error) {
            log.warn(error, "Failed to persist the remote agent conversation");
          }
        }
      });
    }, REMOTE_SAVE_DEBOUNCE_MS);
  }

  async #enqueueRemote(operation: () => Promise<void>): Promise<void> {
    this.#remoteQueue = this.#remoteQueue.then(operation, operation);
    await this.#remoteQueue;
  }
}
