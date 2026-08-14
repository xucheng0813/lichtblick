// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { getHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

import McapBundleAPI from "./McapBundleAPI";
import { McapBundleFile } from "./types";

/**
 * Module-level cache of session fetches, keyed by the sessionId plus the actual
 * HTTP base the request is issued against (same-origin relative path semantics
 * when no base URL is configured). It bridges the prefetch kicked off by WebRoot
 * during render with the consumer in Workspace, so the session info request
 * starts before the tree mounts instead of after.
 *
 * Consumers receive a handle carrying the promise and the key fixed at
 * consumption time. Entries are only removed once the consumer has fully
 * handled the outcome (settled and processed, including errors), via
 * clearSessionPrefetch(handle), which is identity-guarded so a stale consumer
 * can never delete a newer entry prefetched under the same key (or under a
 * different base) in the meantime. Keeping entries until then also stops
 * StrictMode effect replays from issuing a second request while a prefetched
 * promise is still being consumed.
 */
const sessionPrefetchCache = new Map<string, Promise<McapBundleFile[]>>();

export type SessionPrefetchHandle = {
  /** Cache key fixed at consumption time (sessionId + request base). */
  key: string;
  promise: Promise<McapBundleFile[]>;
};

export function sessionPrefetchKey(sessionId: string, baseUrl: string | undefined): string {
  return `${baseUrl ?? ""}|${sessionId}`;
}

export function prefetchSession(sessionId: string): SessionPrefetchHandle {
  const key = sessionPrefetchKey(sessionId, getHttpBaseUrl());
  const cached = sessionPrefetchCache.get(key);
  if (cached) {
    return { key, promise: cached };
  }

  const promise = McapBundleAPI.getMcapBundle(sessionId);
  // Pre-attach a rejection handler so a prefetch that fails before the consumer
  // has attached its own handlers does not surface as an unhandledrejection.
  void promise.catch(() => undefined);
  sessionPrefetchCache.set(key, promise);
  return { key, promise };
}

export function consumeSessionPrefetch(sessionId: string): SessionPrefetchHandle | undefined {
  const key = sessionPrefetchKey(sessionId, getHttpBaseUrl());
  const promise = sessionPrefetchCache.get(key);
  return promise == undefined ? undefined : { key, promise };
}

export function clearSessionPrefetch(handle: SessionPrefetchHandle): void {
  // Only remove the entry when it still holds the very promise this handle
  // refers to: a delayed cleanup from an old consumer must not delete a newer
  // entry that was prefetched under the same key in the meantime.
  if (sessionPrefetchCache.get(handle.key) === handle.promise) {
    sessionPrefetchCache.delete(handle.key);
  }
}

/** Removes every cached prefetch; used by tests to isolate cases. */
export function clearAllSessionPrefetches(): void {
  sessionPrefetchCache.clear();
}
