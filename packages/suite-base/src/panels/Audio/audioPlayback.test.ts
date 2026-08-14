// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Time } from "@lichtblick/rostime";

import {
  AudioChunk,
  AudioPlaybackApi,
  AudioPlaybackScheduler,
  AudioPlaybackSource,
  JITTER_BUFFER_SEC,
  createAudioPlaybackScheduler,
  decodePcmToMono,
} from "./audioPlayback";

const makeTime = (sec: number): Time => ({ sec, nsec: 0 });

// `bytes` bytes of mono s16 at 1000 Hz = bytes / 2000 seconds of audio.
const makeData = (bytes = 800): Uint8Array => new Uint8Array(bytes);

const makeChunk = (overrides: Partial<AudioChunk> = {}): AudioChunk => ({
  timestamp: makeTime(0),
  data: makeData(),
  format: "pcm-s16",
  sampleRate: 1000,
  numberOfChannels: 1,
  ...overrides,
});

type MockSource = AudioPlaybackSource & {
  connect: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
};

function makeMockApi(overrides: Partial<AudioPlaybackApi> = {}): {
  api: AudioPlaybackApi;
  sources: MockSource[];
  createBufferSource: jest.Mock;
  advance: (time: number) => void;
} {
  const sources: MockSource[] = [];
  let currentTime = 0;
  const createBufferSource = jest.fn((): AudioPlaybackSource => {
    const source: MockSource = {
      buffer: undefined,
      connect: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      onended: undefined,
    };
    sources.push(source);
    return source;
  });
  const api: AudioPlaybackApi = {
    getCurrentTime: () => currentTime,
    destination: {},
    createBuffer: jest.fn((_channels: number, length: number, sampleRate: number) => ({
      length,
      sampleRate,
      getChannelData: jest.fn(() => new Float32Array(length)),
    })),
    createBufferSource,
    ...overrides,
  };
  return {
    api,
    sources,
    createBufferSource,
    advance: (time: number) => {
      currentTime = time;
    },
  };
}

// Assert the start() call of the source at `index` with tolerance for floating point schedule
// times (audio-clock arithmetic like 0.15 + 2.3 is not exactly representable).
const expectStart = (
  sources: MockSource[],
  index: number,
  when: number,
  offset: number,
  duration: number,
): void => {
  const source = sources[index];
  expect(source).toBeDefined();
  expect(source!.start.mock.calls).toHaveLength(1);
  const call = source!.start.mock.calls[0]!;
  expect(call[0]).toBeCloseTo(when, 5);
  expect(call[1]).toBe(offset);
  expect(call[2]).toBeCloseTo(duration, 5);
};

describe("decodePcmToMono", () => {
  it("decodes little-endian signed-16 interleaved samples", () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0xff, 0x7f]); // 0, -32768, +32767
    const mono = decodePcmToMono(data, 1);
    expect(mono).toBeDefined();
    expect(mono!.length).toBe(3);
    expect(mono![0]).toBeCloseTo(0);
    expect(mono![1]).toBeCloseTo(-1);
    expect(mono![2]).toBeCloseTo(1);
  });

  it("downmixes multiple channels to mono by averaging", () => {
    // channel 0: +32767, channel 1: -32767 → average 0
    const data = new Uint8Array([0xff, 0x7f, 0x01, 0x80]);
    const mono = decodePcmToMono(data, 2);
    expect(mono).toBeDefined();
    expect(mono!.length).toBe(1);
    expect(mono![0]).toBeCloseTo(0);
  });

  it("truncates odd trailing bytes to whole frames", () => {
    // 3 bytes: 1 whole mono frame; with 2 channels it is less than one frame.
    const data = new Uint8Array([0x00, 0x00, 0x00]);
    expect(decodePcmToMono(data, 1)!.length).toBe(1);
    expect(decodePcmToMono(data, 2)!.length).toBe(0);
  });

  it("handles views with a non-aligned byteOffset without throwing", () => {
    const backing = new Uint8Array([0xaa, 0x00, 0x00, 0x00, 0x80, 0xbb]);
    const view = backing.subarray(1, 5); // byteOffset 1 — not Int16-aligned
    const mono = decodePcmToMono(view, 1);
    expect(mono!.length).toBe(2);
    expect(mono![0]).toBeCloseTo(0);
    expect(mono![1]).toBeCloseTo(-1);
  });

  it("rejects non-Uint8Array data", () => {
    expect(decodePcmToMono(new DataView(new ArrayBuffer(4)) as unknown as Uint8Array, 1)).toBeUndefined();
  });
});

describe("createAudioPlaybackScheduler", () => {
  const makeScheduler = (
    api: AudioPlaybackApi,
    onError?: (message: string | undefined) => void,
    onScheduled?: (samples: Float32Array, sampleRate: number) => void,
  ): AudioPlaybackScheduler => createAudioPlaybackScheduler(api, { onError, onScheduled });

  it("anchors the first chunk at currentTime + jitter and maps later chunks by media delta", () => {
    const { api, sources, advance } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) }));
    expectStart(sources, 0, JITTER_BUFFER_SEC, 0, 0.4);

    advance(0.5);
    scheduler.schedule(makeChunk({ timestamp: makeTime(1.2) }));
    // mappedStart = 0.15 + 1.2 = 1.35, after the first chunk ended (0.55); bound 2.5.
    expectStart(sources, 1, JITTER_BUFFER_SEC + 1.2, 0, 0.4);
  });

  it("reanchors and plays on underrun when a chunk maps into the past with nothing pending", () => {
    const { api, sources, advance } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) })); // scheduled 0.15, ends 0.55
    advance(2.0); // the first chunk finished long ago

    // Underrun: mappedStart (0.65) < now and nothing is pending → re-anchor and play.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.5) }));
    expectStart(sources, 1, 2.15, 0, 0.4);
    // The new anchor is the second chunk (media 0.5 → ctx 2.15).
    scheduler.schedule(makeChunk({ timestamp: makeTime(1.0) }));
    expectStart(sources, 2, 2.65, 0, 0.4);
  });

  it("drops late chunks that map into the past while audio is still pending", () => {
    const { api, sources, advance } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) })); // ends 0.55
    // A long chunk that is still playing when the clock advances.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.5), data: makeData(2600) })); // 1.3 s
    expectStart(sources, 1, 0.65, 0, 1.3); // ends 1.95

    advance(1.5); // the second chunk is still playing (ends 1.95)
    const countBefore = sources.length;
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.6) })); // maps to 0.75 < now
    expect(sources).toHaveLength(countBefore);
    expect(scheduler.getStats().lateDropped).toBe(1);
  });

  it("flushes and reanchors when a chunk goes backward in media time", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) }));
    // Backward chunk: media time is older than the last committed chunk.
    scheduler.schedule(makeChunk({ timestamp: makeTime(-1) }));
    expect(sources[0]!.stop).toHaveBeenCalled();
    expectStart(sources, 1, JITTER_BUFFER_SEC, 0, 0.4);
    // The new anchor is the backward chunk (media -1 → ctx 0.15).
    scheduler.schedule(makeChunk({ timestamp: makeTime(-0.5) }));
    expectStart(sources, 2, 0.65, 0, 0.4);
  });

  it("flushes and reanchors when the media gap to the previous chunk end exceeds 2s", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) })); // media end 0.4
    // Gap = 2.5 - 0.4 = 2.1 > 2 → jump, re-anchor at the new chunk.
    scheduler.schedule(makeChunk({ timestamp: makeTime(2.5) }));
    expect(sources[0]!.stop).toHaveBeenCalled();
    expectStart(sources, 1, JITTER_BUFFER_SEC, 0, 0.4);
    scheduler.schedule(makeChunk({ timestamp: makeTime(3.0) }));
    expectStart(sources, 2, 0.65, 0, 0.4);
  });

  it("trims the overlapping head against the actual scheduled end, rounded up to whole frames", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0), data: makeData(2000) })); // 1 s
    // 2000-byte chunk scheduled at 0.15, ends 1.15.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.5), data: makeData(2000) })); // maps 0.65
    // overlap 0.5 s → 500 frames trimmed; the buffer holds only the trimmed remainder and
    // starts exactly at the previous scheduled end.
    expectStart(sources, 1, 1.15, 0, 0.5);

    // Fractional overlap rounds UP: no two sources ever overlap on the audio clock.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.5001), data: makeData(2400) }));
    // maps to 0.6501; overlap with scheduledEnd 1.65 is 0.9999 → 1000 frames (1.0 s) trimmed.
    expectStart(sources, 2, 1.6501, 0, 0.2);
    expect(sources[2]!.start.mock.calls[0]![0]).toBeGreaterThan(1.65);
  });

  it("drops chunks whose overlap trim consumes the whole chunk", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0), data: makeData(2000) })); // ends 1.15
    const countBefore = sources.length;
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.5), data: makeData(1000) })); // 0.5 s
    expect(sources).toHaveLength(countBefore);
    expect(scheduler.getStats().overlapDropped).toBe(1);
  });

  it("drops chunks beyond the upper bound while audio is still pending", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) })); // pending until 0.55
    const countBefore = sources.length;
    // Media gap 2.3 - 0.4 = 1.9 ≤ 2 (no jump), but mappedStart 2.45 ≥ bound 2.0 → drop.
    scheduler.schedule(makeChunk({ timestamp: makeTime(2.3) }));
    expect(sources).toHaveLength(countBefore);
    expect(scheduler.getStats().upperBoundDropped).toBe(1);
  });

  it("reanchors and plays chunks at the upper bound when nothing is pending", () => {
    const { api, sources, advance } = makeMockApi();
    const scheduler = makeScheduler(api);

    // Two 0.5 s chunks establish the anchor and leave scheduledEnd at 1.65.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0), data: makeData(1000) }));
    scheduler.schedule(makeChunk({ timestamp: makeTime(1.0), data: makeData(1000) }));
    expectStart(sources, 1, 1.15, 0, 0.5);
    // The clock advances exactly to the end of the queued audio (nothing pending).
    advance(1.65);
    // Media gap 3.5 - 1.5 = 2.0 (no jump), mappedStart 3.65 == bound 1.65 + 2 → re-anchor.
    scheduler.schedule(makeChunk({ timestamp: makeTime(3.5), data: makeData(1000) }));
    expect(sources[0]!.stop).toHaveBeenCalled();
    expect(sources[1]!.stop).toHaveBeenCalled();
    expectStart(sources, 2, 1.8, 0, 0.5);
    // The new anchor is the recovery chunk (media 3.5 → ctx 1.8).
    scheduler.schedule(makeChunk({ timestamp: makeTime(4.0), data: makeData(1000) }));
    expectStart(sources, 3, 2.3, 0, 0.5);
  });

  it("trims the tail to the upper bound even for sub-frame excess", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) })); // anchor at 0.15, ends 0.55
    // Maps to startTime 0.7495; 1251 frames end at 2.0005 — 0.5 frames beyond the bound.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.5995), data: makeData(2502) }));
    const call = sources[1]!.start.mock.calls[0]! as [number, number, number];
    expect(call[0]).toBeCloseTo(0.7495, 4);
    expect(call[2]).toBeCloseTo(1.25, 4); // 1250 frames — the fractional frame was trimmed
    // The scheduled end never exceeds currentTime + 2 s, even for sub-frame excess.
    expect(call[0] + call[2]).toBeLessThanOrEqual(2.0 + 1e-6);
  });

  it("trims the tail of chunks that cross the upper bound", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) })); // ends 0.55
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.6), data: makeData(3000) })); // 1.5 s
    // maps to 0.75; chunkEnd 2.25 > bound 2.0 → 250 frames trimmed → 1.25 s.
    expectStart(sources, 1, 0.75, 0, 1.25);
  });

  it("recovers playback after upper-bound drops once the queue drains", () => {
    const { api, sources, advance } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) })); // pending until 0.55
    scheduler.schedule(makeChunk({ timestamp: makeTime(2.3) })); // dropped (pending)
    expect(scheduler.getStats().upperBoundDropped).toBe(1);

    advance(1.0); // the first chunk finished — the queue drained
    // The very same chunk that was dropped now maps within the new bound and plays.
    scheduler.schedule(makeChunk({ timestamp: makeTime(2.3) }));
    expectStart(sources, 1, 2.45, 0, 0.4);
    expect(scheduler.getStats().upperBoundDropped).toBe(1);
  });

  it("compares overlap against the actual scheduled end, not the theoretical end of a trimmed chunk", () => {
    const { api, sources, advance } = makeMockApi();
    const scheduler = makeScheduler(api);

    // A 2 s chunk is tail-trimmed at schedule time: it ends at the 2 s bound, so its
    // theoretical (untrimmed) end of 2.15 never played.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0), data: makeData(4000) }));
    const trimmedCall = sources[0]!.start.mock.calls[0]! as [number, number, number];
    expect(trimmedCall[0] + trimmedCall[2]).toBeLessThanOrEqual(2.0 + 1e-6);

    advance(1.0);
    // Maps to 2.05: after the actual end (≈2.0) but before the theoretical end (2.15). A
    // scheduler comparing against the theoretical end would trim this chunk; the real one
    // plays it in full.
    scheduler.schedule(makeChunk({ timestamp: makeTime(1.9) }));
    expectStart(sources, 1, 2.05, 0, 0.4);
  });

  it("counts truncation warnings by remainder bytes, not by playable frames", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    // Whole frames plus one trailing byte: plays the frames and counts the truncation.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0), data: makeData(1003) }));
    expect(sources).toHaveLength(1);
    expectStart(sources, 0, JITTER_BUFFER_SEC, 0, 501 / 1000);
    expect(scheduler.getStats().truncated).toBe(1);

    // Truly empty whole-frame input is a validation skip, not a truncation.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.6), data: new Uint8Array(0) }));
    expect(sources).toHaveLength(1);
    expect(scheduler.getStats().skipped).toBe(1);
    expect(scheduler.getStats().truncated).toBe(1);

    // A lone partial frame (less than one whole frame) is a truncation.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.6), data: new Uint8Array(1) }));
    expect(sources).toHaveLength(1);
    expect(scheduler.getStats().truncated).toBe(2);
  });

  it("skips chunks with non-finite timestamps without scheduling", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: { sec: Number.NaN, nsec: 0 } }));
    scheduler.schedule(makeChunk({ timestamp: { sec: Number.POSITIVE_INFINITY, nsec: 0 } }));
    expect(sources).toHaveLength(0);
    expect(scheduler.getStats().skipped).toBe(2);
  });

  it("rejects unsupported formats and invalid channel counts, then recovers on a valid chunk", () => {
    const { api, sources } = makeMockApi();
    const onError = jest.fn();
    const scheduler = makeScheduler(api, onError);

    scheduler.schedule(makeChunk({ format: "pcm-u8" }));
    expect(sources).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("pcm-s16"));

    scheduler.schedule(makeChunk({ numberOfChannels: 0 }));
    scheduler.schedule(makeChunk({ numberOfChannels: 2.5 }));
    scheduler.schedule(makeChunk({ numberOfChannels: Number.NaN }));
    expect(sources).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Invalid channel count"));

    // A subsequent valid chunk clears the error and plays.
    scheduler.schedule(makeChunk({}));
    expect(sources).toHaveLength(1);
    expect(onError).toHaveBeenLastCalledWith(undefined);
  });

  it("does not commit state when start() fails, and the next chunk schedules successfully", () => {
    const { api, sources, createBufferSource } = makeMockApi();
    let failNext = true;
    api.createBufferSource = () => {
      const source = createBufferSource();
      if (failNext) {
        failNext = false;
        source.start = jest.fn(() => {
          throw new Error("start boom");
        });
      }
      return source;
    };
    const onError = jest.fn();
    const scheduler = makeScheduler(api, onError);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) }));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("start boom"));

    // Nothing was committed: the next chunk anchors fresh at now + jitter instead of being
    // mapped/trimmed against the failed chunk.
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.5) }));
    expectStart(sources, 1, JITTER_BUFFER_SEC, 0, 0.4);
  });

  it("clears all state even when stop() throws, and seek flushes scheduled audio", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) }));
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.6) }));
    expectStart(sources, 1, 0.75, 0, 0.4);
    sources[0]!.stop = jest.fn(() => {
      throw new Error("stop boom");
    });

    scheduler.flush();
    expect(sources[0]!.stop).toHaveBeenCalled();
    expect(sources[1]!.stop).toHaveBeenCalled();
    // State cleared: a new chunk anchors fresh.
    scheduler.schedule(makeChunk({ timestamp: makeTime(1) }));
    expectStart(sources, 2, JITTER_BUFFER_SEC, 0, 0.4);
  });

  it("stops tracking sources once they fire onended", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);

    scheduler.schedule(makeChunk({ timestamp: makeTime(0) }));
    scheduler.schedule(makeChunk({ timestamp: makeTime(0.6) }));
    sources[0]!.onended?.();

    scheduler.flush();
    // The ended source was already removed from tracking; only the pending one is stopped.
    expect(sources[0]!.stop).not.toHaveBeenCalled();
    expect(sources[1]!.stop).toHaveBeenCalledTimes(1);
  });

  it("reports the scheduled mono samples through onScheduled", () => {
    const { api } = makeMockApi();
    const onScheduled = jest.fn();
    const scheduler = makeScheduler(api, undefined, onScheduled);

    scheduler.schedule(makeChunk({}));
    expect(onScheduled).toHaveBeenCalledTimes(1);
    const [samples, sampleRate] = onScheduled.mock.calls[0]!;
    expect(sampleRate).toBe(1000);
    expect((samples as Float32Array).length).toBe(400);
  });

  it("does not schedule after dispose", () => {
    const { api, sources } = makeMockApi();
    const scheduler = makeScheduler(api);
    scheduler.schedule(makeChunk({}));
    scheduler.dispose();
    scheduler.schedule(makeChunk({ timestamp: makeTime(1) }));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.stop).toHaveBeenCalled();
  });
});
