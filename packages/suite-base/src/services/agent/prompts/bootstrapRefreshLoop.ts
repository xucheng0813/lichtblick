// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export const AGENT_BOOTSTRAP_BASE_INTERVAL_MS = 5 * 60 * 1000;
export const AGENT_BOOTSTRAP_MAX_BACKOFF_MS = 30 * 60 * 1000;

export type BootstrapRefreshLoop = {
  /** Stops the loop and cancels any pending scheduled refresh. */
  stop: () => void;
  /**
   * Immediately runs one refresh outside the scheduled cadence (used for cache invalidations).
   * Shares the failure/backoff accounting with the loop and restarts the schedule from the base
   * interval on success (or advances the backoff on failure), so a forced refresh and the
   * periodic polling stay in one scheduling state.
   */
  refreshNow: () => Promise<boolean>;
};

export type BootstrapRefreshLoopOptions = {
  /**
   * Performs one fetch. Resolves `true` when the fetch succeeded, `false` when it failed. The
   * returned promise must settle before the next refresh is scheduled.
   */
  refresh: () => Promise<boolean>;
  /** Delay between successful refreshes. Defaults to 5 minutes. */
  baseIntervalMs?: number;
  /** Upper bound for the exponential backoff after consecutive failures. Defaults to 30 minutes. */
  maxBackoffMs?: number;
};

/**
 * Runs a refresh loop with exponential backoff: the first refresh happens immediately, successes
 * keep the cadence at `baseIntervalMs`, and each consecutive failure doubles the delay up to
 * `maxBackoffMs`. A success resets the failure count, returning the cadence to the base interval.
 *
 * The loop is deliberately timer-based (setTimeout chain) so tests can drive it with fake timers.
 */
export function runBootstrapRefreshLoop({
  refresh,
  baseIntervalMs = AGENT_BOOTSTRAP_BASE_INTERVAL_MS,
  maxBackoffMs = AGENT_BOOTSTRAP_MAX_BACKOFF_MS,
}: BootstrapRefreshLoopOptions): BootstrapRefreshLoop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let refreshGeneration = 0;
  const state = { disposed: false };
  const isDisposed = (): boolean => state.disposed;

  const schedule = (delayMs: number): void => {
    if (isDisposed()) {
      return;
    }
    // The latest schedule wins: a newer refresh completion replaces any pending tick so two
    // interleaved completions can never leave two timers behind.
    if (timer != undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void runRefresh();
    }, delayMs);
  };

  const runRefresh = async (): Promise<boolean> => {
    if (isDisposed()) {
      return false;
    }
    const generation = ++refreshGeneration;
    const succeeded = await refresh();
    if (isDisposed()) {
      return succeeded;
    }
    if (generation !== refreshGeneration) {
      // A newer refresh superseded this one while it was in flight; only the newest completion
      // applies the failure/backoff accounting and schedules the next tick, so a stale result
      // (e.g. an old failure) can never overwrite a newer success's reset.
      return succeeded;
    }
    consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
    schedule(
      succeeded
        ? baseIntervalMs
        : Math.min(maxBackoffMs, baseIntervalMs * 2 ** Math.min(consecutiveFailures, 20)),
    );
    return succeeded;
  };

  // Kick off the initial refresh immediately (timer 0 keeps the loop testable with fake timers).
  schedule(0);

  return {
    stop: () => {
      state.disposed = true;
      if (timer != undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    refreshNow: async () => {
      if (isDisposed()) {
        return false;
      }
      // A forced refresh supersedes the pending scheduled one; runRefresh re-schedules.
      if (timer != undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return await runRefresh();
    },
  };
}
