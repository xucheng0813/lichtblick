/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { HttpError } from "@lichtblick/suite-base/services/http/HttpError";
import type { HttpService } from "@lichtblick/suite-base/services/http/HttpService";

import type { AgentConversationStore, StoredConversation } from "./AgentConversationStore";
import { RemoteAgentConversationStore } from "./RemoteAgentConversationStore";

const conversation: StoredConversation = {
  conversationId: "conversation-1",
  updatedAt: "2026-07-29T00:00:00.000Z",
  uiMessages: [{ id: "message-1" }],
  llmHistory: [{ role: "user", content: "inspect this recording" }],
};

function createRejectedDeferred(): {
  promise: Promise<never>;
  reject: (error: Error) => void;
} {
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (error) => {
      rejectPromise?.(error);
    },
  };
}

function createStores() {
  const local = {
    delete: jest.fn().mockResolvedValue(undefined),
    load: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<AgentConversationStore, "delete" | "load" | "save">>;
  const http = {
    delete: jest.fn().mockResolvedValue({
      data: { deleted: true },
      path: "",
      timestamp: "",
    }),
    get: jest.fn(),
    put: jest.fn().mockResolvedValue({
      data: {
        conversationId: conversation.conversationId,
        title: "inspect this recording",
        updatedAt: conversation.updatedAt,
        messageCount: 1,
      },
      path: "",
      timestamp: "",
    }),
  } as unknown as jest.Mocked<Pick<HttpService, "delete" | "get" | "put">>;
  return {
    http,
    local,
    store: new RemoteAgentConversationStore({
      workspace: "workspace/a",
      http,
      local,
    }),
  };
}

describe("RemoteAgentConversationStore", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("loads remotely first and refreshes the local fallback", async () => {
    const { http, local, store } = createStores();
    http.get.mockResolvedValue({
      data: { ...conversation, title: "inspect this recording" },
      path: "",
      timestamp: "",
    });

    await expect(store.load(conversation.conversationId)).resolves.toEqual(conversation);
    expect(http.get).toHaveBeenCalledWith("workspaces/workspace%2Fa/conversations/conversation-1");
    expect(local.save).toHaveBeenCalledWith(conversation);
    expect(local.load).not.toHaveBeenCalled();
  });

  it("falls back to IndexedDB for HTTP and network failures", async () => {
    const { http, local, store } = createStores();
    http.get.mockRejectedValue(new HttpError("offline", 0, "Network Error"));
    local.load.mockResolvedValue(conversation);

    await expect(store.load(conversation.conversationId)).resolves.toEqual(conversation);
    expect(local.load).toHaveBeenCalledWith(conversation.conversationId);
    expect(console.warn).toHaveBeenCalled();
    (console.warn as jest.Mock).mockClear();
  });

  it("always writes locally and trailing-debounces serialized remote saves", async () => {
    jest.useFakeTimers();
    const { http, local, store } = createStores();
    const updatedConversation: StoredConversation = {
      ...conversation,
      updatedAt: "2026-07-29T00:00:01.000Z",
      uiMessages: [{ id: "message-2" }],
    };

    await store.save(conversation);
    await store.save(updatedConversation);

    expect(local.save).toHaveBeenCalledTimes(2);
    expect(http.put).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000);

    expect(http.put).toHaveBeenCalledTimes(1);
    expect(http.put).toHaveBeenCalledWith(
      "workspaces/workspace%2Fa/conversations/conversation-1",
      updatedConversation,
    );
  });

  it("does not retry snapshots rejected as too large", async () => {
    jest.useFakeTimers();
    const { http, store } = createStores();
    http.put.mockRejectedValue(new HttpError("too large", 413, "Payload Too Large"));

    await store.save(conversation);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(2_000);

    expect(http.put).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    (console.error as jest.Mock).mockClear();
  });

  it("requeues a transiently failed snapshot once and then succeeds", async () => {
    jest.useFakeTimers();
    const { http, store } = createStores();
    http.put.mockRejectedValueOnce(new HttpError("offline", 0, "Network Error"));

    await store.save(conversation);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(2_000);

    expect(http.put).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
    (console.warn as jest.Mock).mockClear();
  });

  it("abandons a transiently failed snapshot after one retry", async () => {
    jest.useFakeTimers();
    const { http, store } = createStores();
    http.put.mockRejectedValue(new HttpError("offline", 0, "Network Error"));

    await store.save(conversation);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(2_000);

    expect(http.put).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(2);
    (console.warn as jest.Mock).mockClear();
  });

  it("does not requeue a failed snapshot behind a newer queued save", async () => {
    jest.useFakeTimers();
    const { http, store } = createStores();
    const firstPut = createRejectedDeferred();
    const newerConversation: StoredConversation = {
      ...conversation,
      updatedAt: "2026-07-29T00:00:01.000Z",
      uiMessages: [{ id: "message-2" }],
    };
    http.put.mockReturnValueOnce(firstPut.promise);

    await store.save(conversation);
    await jest.advanceTimersByTimeAsync(2_000);
    await store.save(newerConversation);
    await jest.advanceTimersByTimeAsync(2_000);

    firstPut.reject(new HttpError("offline", 0, "Network Error"));
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(2_000);

    expect(http.put).toHaveBeenCalledTimes(2);
    expect(http.put).toHaveBeenNthCalledWith(
      2,
      "workspaces/workspace%2Fa/conversations/conversation-1",
      newerConversation,
    );
    expect(console.warn).toHaveBeenCalledTimes(1);
    (console.warn as jest.Mock).mockClear();
  });

  it("deletes locally even when the remote delete fails", async () => {
    const { http, local, store } = createStores();
    http.delete.mockRejectedValue(new HttpError("offline", 0, "Network Error"));

    await expect(store.delete(conversation.conversationId)).resolves.toBeUndefined();
    expect(local.delete).toHaveBeenCalledWith(conversation.conversationId);
    expect(console.warn).toHaveBeenCalled();
    (console.warn as jest.Mock).mockClear();
  });

  it("passes pagination through to the server", async () => {
    const { http, store } = createStores();
    const page = {
      items: [
        {
          conversationId: conversation.conversationId,
          title: "inspect this recording",
          updatedAt: conversation.updatedAt,
          messageCount: 1,
        },
      ],
      total: 1,
    };
    http.get.mockResolvedValue({ data: page, path: "", timestamp: "" });

    await expect(store.list(2, 25)).resolves.toEqual(page);
    expect(http.get).toHaveBeenCalledWith("workspaces/workspace%2Fa/conversations", {
      page: "2",
      page_size: "25",
    });
  });
});
