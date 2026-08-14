// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { getHttpBaseUrl, setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

import {
  clearAllSessionPrefetches,
  clearSessionPrefetch,
  consumeSessionPrefetch,
  prefetchSession,
  sessionPrefetchKey,
} from "./sessionPrefetch";

const mockGetSession = jest.fn();

jest.mock("./McapBundleAPI", () => ({
  __esModule: true,
  default: { getMcapBundle: (...args: unknown[]) => mockGetSession(...args) },
}));

describe("sessionPrefetch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAllSessionPrefetches();
    setHttpBaseUrl(undefined);
  });

  afterEach(() => {
    clearAllSessionPrefetches();
    setHttpBaseUrl(undefined);
  });

  it("prefetches via the same-origin relative path when no base URL is configured", async () => {
    const sessionId = "s1";
    const mcaps = [{ url: "https://example.com/a.mcap", metadata: {} }];
    mockGetSession.mockResolvedValue(mcaps);

    const handle = prefetchSession(sessionId);

    // No base URL configured: the request goes to the same-origin relative
    // "session/<id>" endpoint (falsy base in tests) and is still prefetched.
    expect(getHttpBaseUrl()).toBeFalsy();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledWith(sessionId);
    expect(handle.key).toBe(`|${sessionId}`);
    expect(sessionPrefetchKey(sessionId, getHttpBaseUrl())).toBe(handle.key);

    // The consumer resolves the same key and reuses the cached promise.
    expect(consumeSessionPrefetch(sessionId)?.promise).toBe(handle.promise);
    await expect(handle.promise).resolves.toEqual(mcaps);
  });

  it("keys prefetches by the configured base URL and does not cross-contaminate bases", async () => {
    setHttpBaseUrl("https://api.example.com/");
    const sessionId = "s1";
    mockGetSession.mockResolvedValue([]);

    const handle = prefetchSession(sessionId);

    expect(getHttpBaseUrl()).toBe("https://api.example.com");
    expect(handle.key).toBe("https://api.example.com|s1");
    expect(consumeSessionPrefetch(sessionId)?.promise).toBe(handle.promise);

    // A different base URL yields a different key: the cache does not cross-contaminate.
    setHttpBaseUrl(undefined);
    expect(consumeSessionPrefetch(sessionId)).toBeUndefined();

    // A fresh prefetch under the other base issues a new request.
    const otherHandle = prefetchSession(sessionId);
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    expect(otherHandle.promise).not.toBe(handle.promise);
  });

  it("dedupes repeated prefetches for the same key", () => {
    const sessionId = "s1";
    mockGetSession.mockResolvedValue([]);

    const first = prefetchSession(sessionId);
    const second = prefetchSession(sessionId);

    expect(second.promise).toBe(first.promise);
    expect(second.key).toBe(first.key);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it("pre-attaches a rejection handler so early failures do not raise unhandledrejection", async () => {
    const sessionId = "failing";
    mockGetSession.mockRejectedValueOnce(new Error("boom"));

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      // Simulate the failure settling before any consumer attaches a handler.
      const handle = prefetchSession(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);

      // Consumers can still observe the failure.
      await expect(handle.promise).rejects.toThrow("boom");

      // After the consumer clears the entry, a retry issues a fresh request that
      // is not poisoned by the earlier failure.
      clearSessionPrefetch(handle);
      mockGetSession.mockResolvedValue([{ url: "https://example.com/b.mcap", metadata: {} }]);
      const retry = prefetchSession(sessionId);
      expect(mockGetSession).toHaveBeenCalledTimes(2);
      await expect(retry.promise).resolves.toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("keeps the entry until the consumer clears it after handling", () => {
    const sessionId = "s1";
    mockGetSession.mockResolvedValue([]);
    void prefetchSession(sessionId);
    expect(consumeSessionPrefetch(sessionId)).toBeDefined();

    const handle = consumeSessionPrefetch(sessionId);
    clearSessionPrefetch(handle!);
    expect(consumeSessionPrefetch(sessionId)).toBeUndefined();
  });

  it("clears by the handle's fixed key, unaffected by later base changes", () => {
    const sessionId = "s1";
    mockGetSession.mockResolvedValue([]);
    setHttpBaseUrl("https://api.example.com");
    const handle = prefetchSession(sessionId);

    // The base changes after consumption (simulating a delayed cleanup from an
    // old consumer): a prefetch under the new base is a different entry.
    setHttpBaseUrl(undefined);
    const otherHandle = prefetchSession(sessionId);
    expect(otherHandle.promise).not.toBe(handle.promise);

    // Clearing with the old handle only removes the old entry.
    clearSessionPrefetch(handle);
    expect(consumeSessionPrefetch(sessionId)?.promise).toBe(otherHandle.promise);

    clearSessionPrefetch(otherHandle);
    expect(consumeSessionPrefetch(sessionId)).toBeUndefined();
  });

  it("does not delete a newer promise when a stale handle is cleared", () => {
    const sessionId = "s1";
    mockGetSession.mockResolvedValue([]);

    const first = prefetchSession(sessionId);
    clearSessionPrefetch(first);

    // A new prefetch under the same key replaces the entry with a new promise.
    const second = prefetchSession(sessionId);
    expect(second.promise).not.toBe(first.promise);

    // A delayed cleanup holding the stale handle must not delete the new entry.
    clearSessionPrefetch(first);
    expect(consumeSessionPrefetch(sessionId)?.promise).toBe(second.promise);
  });
});
