// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import Log from "@lichtblick/log";
import { HttpError } from "@lichtblick/suite-base/services/http/HttpError";
import httpService, { HttpService } from "@lichtblick/suite-base/services/http/HttpService";

import { AgentConversationStore, StoredConversation } from "./AgentConversationStore";

const log = Log.getLogger(__filename);

const REMOTE_SAVE_DEBOUNCE_MS = 2_000;

export type ConversationSummary = {
  conversationId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  profileName?: string;
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
type PendingSave = {
  snapshot: StoredConversation;
  retried: boolean;
  revision: number;
};

/**
 * Mirrors conversations to vtd-viz-server while keeping IndexedDB as an always-written fallback.
 */
export class RemoteAgentConversationStore {
  readonly #http: ConversationHttpService;
  readonly #local: LocalConversationStore;
  readonly #workspacePath: string;

  #pendingSaves = new Map<string, PendingSave>();
  #latestSaveRevisions = new Map<string, number>();
  #nextSaveRevision = 0;
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
      if (response.data == undefined) {
        // 2xx with an empty body: nothing to restore.
        return undefined;
      }
      const conversation: StoredConversation = {
        conversationId: response.data.conversationId,
        updatedAt: response.data.updatedAt,
        uiMessages: response.data.uiMessages,
        llmHistory: response.data.llmHistory,
        ...(response.data.llmHistoryFormat == undefined
          ? {}
          : { llmHistoryFormat: response.data.llmHistoryFormat }),
        ...(response.data.profileName == undefined
          ? {}
          : { profileName: response.data.profileName }),
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
    const revision = ++this.#nextSaveRevision;
    this.#latestSaveRevisions.set(conversation.conversationId, revision);
    this.#pendingSaves.set(conversation.conversationId, {
      snapshot: conversation,
      retried: false,
      revision,
    });
    this.#scheduleRemoteSave();
  }

  public async delete(conversationId: string): Promise<void> {
    this.#pendingSaves.delete(conversationId);
    this.#latestSaveRevisions.delete(conversationId);
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
    if (response.data == undefined) {
      // 2xx with an empty body: an empty page.
      return { items: [], total: 0 };
    }
    return response.data;
  }

  #scheduleRemoteSave(): void {
    if (this.#saveTimer != undefined) {
      clearTimeout(this.#saveTimer);
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      const pendingSaves = [...this.#pendingSaves.values()];
      this.#pendingSaves.clear();
      void this.#enqueueRemote(async () => {
        for (const pendingSave of pendingSaves) {
          const { snapshot, retried, revision } = pendingSave;
          const conversationId = snapshot.conversationId;
          if (this.#latestSaveRevisions.get(conversationId) !== revision) {
            continue;
          }
          try {
            await this.#http.put<ConversationSummary>(
              `${this.#workspacePath}/${encodeURIComponent(conversationId)}`,
              snapshot,
            );
            if (this.#latestSaveRevisions.get(conversationId) === revision) {
              this.#latestSaveRevisions.delete(conversationId);
            }
          } catch (error) {
            if (error instanceof HttpError && error.status === 413) {
              if (this.#latestSaveRevisions.get(conversationId) === revision) {
                this.#latestSaveRevisions.delete(conversationId);
              }
              log.error(
                error,
                "Remote agent conversation exceeds the server size limit; abandoning snapshot",
              );
            } else if (retried) {
              if (this.#latestSaveRevisions.get(conversationId) === revision) {
                this.#latestSaveRevisions.delete(conversationId);
              }
              log.warn(
                error,
                "Failed to persist the remote agent conversation after retry; abandoning snapshot",
              );
            } else if (this.#latestSaveRevisions.get(conversationId) !== revision) {
              log.warn(
                error,
                "Failed to persist the remote agent conversation; a newer snapshot is queued",
              );
            } else {
              this.#pendingSaves.set(conversationId, { ...pendingSave, retried: true });
              this.#scheduleRemoteSave();
              log.warn(error, "Failed to persist the remote agent conversation; retrying once");
            }
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
