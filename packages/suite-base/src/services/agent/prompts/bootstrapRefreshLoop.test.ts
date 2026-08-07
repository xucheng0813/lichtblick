// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  AGENT_BOOTSTRAP_BASE_INTERVAL_MS,
  AGENT_BOOTSTRAP_MAX_BACKOFF_MS,
  runBootstrapRefreshLoop,
} from "./bootstrapRefreshLoop";

describe("runBootstrapRefreshLoop", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  it("refreshes immediately and then on the base interval while successful", async () => {
    const refresh = jest.fn().mockResolvedValue(true);
    const loop = runBootstrapRefreshLoop({ refresh });

    expect(refresh).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("backs off exponentially after consecutive failures", async () => {
    const refresh = jest.fn().mockResolvedValue(false);
    const loop = runBootstrapRefreshLoop({ refresh });

    await jest.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    // First failure: base * 2^1 = 10 minutes.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 2 - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    // Second failure: base * 2^2 = 20 minutes.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 4 - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("caps the backoff at the 30 minute maximum", async () => {
    const refresh = jest.fn().mockResolvedValue(false);
    const loop = runBootstrapRefreshLoop({ refresh });

    // Fail repeatedly; the delay must never exceed maxBackoffMs: 10, then 20, then the cap.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 4);
    expect(refresh).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_MAX_BACKOFF_MS);
    expect(refresh).toHaveBeenCalledTimes(4);

    // From here every interval is exactly the cap: nothing fires just before it…
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_MAX_BACKOFF_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(4);
    // …and exactly one tick fires at the cap.
    await jest.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_MAX_BACKOFF_MS * 100);
    expect(refresh).toHaveBeenCalledTimes(105);
    loop.stop();
  });

  it("returns to the base interval after a success following failures", async () => {
    const refresh = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const loop = runBootstrapRefreshLoop({ refresh });

    await jest.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Fail 1 → 10 min.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);
    // Fail 2 → 20 min.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 4);
    expect(refresh).toHaveBeenCalledTimes(3);
    // Success → back to 5 min.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(4);
    // Still on 5 min for the following success.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(5);
    loop.stop();
  });

  it("refreshNow runs immediately, cancels the pending scheduled tick, and shares backoff state", async () => {
    const refresh = jest
      .fn()
      .mockResolvedValueOnce(false) // initial tick fails → backoff starts
      .mockResolvedValue(true); // forced refresh succeeds
    const loop = runBootstrapRefreshLoop({ refresh });

    await jest.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The failure scheduled a 10 minute retry.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 2 - 1);
    expect(refresh).toHaveBeenCalledTimes(1);

    // A forced refresh (cache invalidation) fires immediately…
    await expect(loop.refreshNow()).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    // …resets the failure count and restarts the schedule at the base interval — the previously
    // scheduled 10 minute tick must not fire an extra refresh.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("keeps the newest completion when refreshes interleave (generation fence)", async () => {
    // The initial tick (gen 1) is slow and will succeed; a forced refresh (gen 2) completes
    // first and fails. The stale gen-1 success arriving later must NOT reset the backoff that
    // the newer failure established.
    let resolveOlder: (() => void) | undefined;
    let resolveNewer: (() => void) | undefined;
    const older = new Promise<boolean>((resolve) => {
      resolveOlder = () => {
        resolve(true);
      };
    });
    const newer = new Promise<boolean>((resolve) => {
      resolveNewer = () => {
        resolve(false);
      };
    });
    const refresh = jest
      .fn()
      .mockImplementationOnce(async () => {
        return await older;
      })
      .mockImplementationOnce(async () => {
        return await newer;
      })
      .mockResolvedValue(true);
    const loop = runBootstrapRefreshLoop({ refresh });

    await jest.advanceTimersByTimeAsync(0); // gen 1 starts and hangs
    const forced = loop.refreshNow(); // gen 2 starts and hangs

    // The newer (forced) refresh fails and applies its backoff first…
    resolveNewer!();
    await forced;
    expect(refresh).toHaveBeenCalledTimes(2);

    // …then the older (scheduled) refresh succeeds late. It must not touch the state.
    resolveOlder!();
    await jest.advanceTimersByTimeAsync(0);

    // The failure scheduled a 10 minute retry; the stale success did not restore 5 minutes.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 2 - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    // Exactly one tick fired at the 10 minute mark — no duplicate timers from the interleave —
    // and the cadence is back to the 5 minute base for the success.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(5);
    loop.stop();
  });

  it("refreshNow advances the backoff when the forced refresh fails", async () => {
    const refresh = jest
      .fn()
      .mockResolvedValueOnce(true) // initial success → 5 min cadence
      .mockResolvedValue(false); // forced refresh fails
    const loop = runBootstrapRefreshLoop({ refresh });

    await jest.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The pending 5 minute tick is superseded by the forced refresh.
    await expect(loop.refreshNow()).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
    // Failure #1 → the next tick is 10 minutes out.
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 2 - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("stops scheduling after stop() and does not refresh while disposed", async () => {
    const refresh = jest.fn().mockResolvedValue(true);
    const loop = runBootstrapRefreshLoop({ refresh });

    await jest.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    loop.stop();
    await jest.advanceTimersByTimeAsync(AGENT_BOOTSTRAP_BASE_INTERVAL_MS * 10);
    expect(refresh).toHaveBeenCalledTimes(1);

    // A refresh that resolves after stop() must not schedule another tick.
    const slowRefresh = jest.fn().mockImplementation(async () => {
      return await new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, 1_000);
      });
    });
    const slowLoop = runBootstrapRefreshLoop({ refresh: slowRefresh });
    await jest.advanceTimersByTimeAsync(0);
    slowLoop.stop();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(slowRefresh).toHaveBeenCalledTimes(1);
  });
});
