// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Time, toSec } from "@lichtblick/rostime";

// First-chunk anchor jitter: the first playable chunk is scheduled a short time after it is
// received so the audio clock does not start in the past while the browser ramps up.
export const JITTER_BUFFER_SEC = 0.15;
// Never schedule audio further ahead than this on the audio clock. Dropped/trimmed chunks keep
// the scheduler from accumulating a backlog when playback falls behind (e.g. slow data source).
export const MAX_SCHEDULE_AHEAD_SEC = 2;
// Media-time gap beyond which consecutive chunks are considered a jump (seek in the data, or a
// sparse topic) and the timeline is re-anchored to the newer chunk.
const JUMP_GAP_SEC = 2;
const BYTES_PER_SAMPLE = 2;
export const SUPPORTED_AUDIO_FORMAT = "pcm-s16";

/** Minimal buffer surface the scheduler writes PCM into (injected so tests stay pure). */
export type AudioPlaybackBuffer = {
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
};

/** Minimal source node surface the scheduler drives (injected so tests stay pure). */
export type AudioPlaybackSource = {
  buffer?: AudioPlaybackBuffer;
  connect(destination: unknown): void;
  start(when?: number, offset?: number, duration?: number): void;
  stop(): void;
  onended: (() => void) | undefined;
};

/** Minimal audio-context surface the scheduler needs. */
export type AudioPlaybackApi = {
  getCurrentTime(): number;
  destination: unknown;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioPlaybackBuffer;
  createBufferSource(): AudioPlaybackSource;
};

export type AudioChunk = {
  timestamp: Time;
  data: Uint8Array;
  format: string;
  sampleRate: number;
  numberOfChannels: number;
};

export type AudioPlaybackStats = {
  /** Chunks dropped because they mapped into the past while audio was still queued. */
  lateDropped: number;
  /** Chunks dropped because they mapped beyond the scheduling bound. */
  upperBoundDropped: number;
  /** Chunks dropped because their overlap trim consumed the whole chunk. */
  overlapDropped: number;
  /** Chunks skipped by validation (non-finite timestamp, malformed data). */
  skipped: number;
  /** Chunks whose trailing partial frame was truncated. */
  truncated: number;
};

export type AudioPlaybackScheduler = {
  schedule(chunk: AudioChunk): void;
  flush(): void;
  dispose(): void;
  getStats(): AudioPlaybackStats;
};

export type AudioPlaybackSchedulerOptions = {
  /** Reports non-fatal errors (or undefined when the error clears). */
  onError?: (message: string | undefined) => void;
  /** Reports the mono samples actually scheduled, for waveform display. */
  onScheduled?: (samples: Float32Array, sampleRate: number) => void;
};

/**
 * Decode little-endian interleaved signed-16 PCM into a mono Float32Array (v1 downmixes every
 * channel by averaging). Trailing bytes that do not form a whole frame are dropped. Uses an
 * explicit little-endian DataView read so views with a non-aligned byteOffset (e.g. Uint8Array
 * subarrays) never throw. Returns undefined for non-Uint8Array data.
 */
export function decodePcmToMono(
  data: Uint8Array,
  numberOfChannels: number,
): Float32Array | undefined {
  if (!(data instanceof Uint8Array)) {
    return undefined;
  }
  const bytesPerFrame = BYTES_PER_SAMPLE * numberOfChannels;
  const frameCount = Math.floor(data.byteLength / bytesPerFrame);
  const samples = new Float32Array(frameCount);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let channel = 0; channel < numberOfChannels; channel++) {
      sum += view.getInt16((frame * numberOfChannels + channel) * BYTES_PER_SAMPLE, true);
    }
    samples[frame] = sum / (numberOfChannels * 32768);
  }
  return samples;
}

/**
 * Sliding-window audio scheduler for a single multi-file source's playback. Chunks are mapped
 * onto the audio clock via a media-time anchor and scheduled ahead of playback; branch decisions
 * follow a fixed priority order (validate → backward/jump → too late → overlap trim → upper
 * bound). State is only committed after a successful `source.start()`, so failed starts never
 * poison later branch decisions.
 */
export function createAudioPlaybackScheduler(
  api: AudioPlaybackApi,
  options: AudioPlaybackSchedulerOptions = {},
): AudioPlaybackScheduler {
  const { onError, onScheduled } = options;

  // Anchor: media time of the chunk that established the current timeline, mapped to the audio
  // context time it was scheduled at. Later chunks map to anchor.ctxTime + media delta.
  let anchor: { mediaTime: number; ctxTime: number } | undefined;
  // Latest audio-context time at which an actually-started source ends (0 when nothing plays).
  let scheduledEnd = 0;
  // Media times of the last successfully scheduled chunk (start, and the end of what plays).
  let lastMediaTimestamp: number | undefined;
  let lastMediaEnd: number | undefined;

  const activeSources = new Set<AudioPlaybackSource>();
  const stats: AudioPlaybackStats = {
    lateDropped: 0,
    upperBoundDropped: 0,
    overlapDropped: 0,
    skipped: 0,
    truncated: 0,
  };
  let error: string | undefined;
  let disposed = false;

  const setError = (message: string | undefined) => {
    if (error !== message) {
      error = message;
      onError?.(message);
    }
  };

  const stopActiveSources = () => {
    for (const source of activeSources) {
      try {
        source.stop();
      } catch {
        // Non-fatal: the source may already be stopped or ended.
      }
    }
    activeSources.clear();
  };

  // Stop every active source and clear the scheduling state. stop() throwing must not prevent
  // the bookkeeping from being cleared.
  const resetState = () => {
    try {
      stopActiveSources();
    } finally {
      anchor = undefined;
      scheduledEnd = 0;
      lastMediaTimestamp = undefined;
      lastMediaEnd = undefined;
    }
  };

  const schedule = (chunk: AudioChunk): void => {
    if (disposed) {
      return;
    }
    const mediaSec = toSec(chunk.timestamp);
    if (!Number.isFinite(mediaSec)) {
      // Never start a source with a NaN/infinite schedule time.
      stats.skipped++;
      return;
    }
    if (chunk.format !== SUPPORTED_AUDIO_FORMAT) {
      resetState();
      setError(
        `Unsupported audio format "${chunk.format}" (expected "${SUPPORTED_AUDIO_FORMAT}")`,
      );
      return;
    }
    if (
      !Number.isFinite(chunk.numberOfChannels) ||
      !Number.isInteger(chunk.numberOfChannels) ||
      chunk.numberOfChannels < 1
    ) {
      resetState();
      setError(`Invalid channel count: ${chunk.numberOfChannels}`);
      return;
    }
    if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0) {
      resetState();
      setError(`Invalid sample rate: ${chunk.sampleRate}`);
      return;
    }
    setError(undefined);

    // Decode (downmixed to mono); trailing partial frames are truncated by the decoder. A
    // non-zero remainder (data.byteLength % bytesPerFrame) counts as a truncation warning,
    // whether or not whole frames remain.
    const mono = decodePcmToMono(chunk.data, chunk.numberOfChannels);
    if (mono == undefined) {
      stats.skipped++;
      return;
    }
    if (mono.length === 0) {
      // Nothing playable: a partial frame was dropped (counted below); truly empty whole-frame
      // input is a validation skip rather than a truncation.
      if (chunk.data.byteLength % (BYTES_PER_SAMPLE * chunk.numberOfChannels) !== 0) {
        stats.truncated++;
      } else {
        stats.skipped++;
      }
      return;
    }
    if (chunk.data.byteLength % (BYTES_PER_SAMPLE * chunk.numberOfChannels) !== 0) {
      stats.truncated++;
    }

    let mappedStart: number;
    let reanchor: { mediaTime: number; ctxTime: number } | undefined;

    // Branch 1 (highest priority after validation): backward/jump detection.
    if (anchor == undefined) {
      // First valid chunk: establish the anchor at the next jitter point.
      reanchor = { mediaTime: mediaSec, ctxTime: api.getCurrentTime() + JITTER_BUFFER_SEC };
    } else if (
      lastMediaTimestamp != undefined &&
      (mediaSec < lastMediaTimestamp ||
        mediaSec - (lastMediaEnd ?? lastMediaTimestamp) > JUMP_GAP_SEC)
    ) {
      // The chunk is older than the last committed chunk, or the media gap from the end of
      // what last played exceeds the jump threshold: flush and re-anchor at this chunk.
      resetState();
      reanchor = { mediaTime: mediaSec, ctxTime: api.getCurrentTime() + JITTER_BUFFER_SEC };
    }
    mappedStart = reanchor != undefined ? reanchor.ctxTime : anchor!.ctxTime + (mediaSec - anchor!.mediaTime);

    const reanchorAt = (mediaTime: number, ctxTime: number) => {
      resetState();
      reanchor = { mediaTime, ctxTime };
      mappedStart = ctxTime;
    };

    // Branch 2: the chunk maps into the past.
    if (mappedStart < api.getCurrentTime()) {
      if (scheduledEnd <= api.getCurrentTime()) {
        // Underrun: nothing is queued ahead — re-anchor at the next jitter point and play.
        reanchorAt(mediaSec, api.getCurrentTime() + JITTER_BUFFER_SEC);
      } else {
        // Late / out-of-order: future audio is still queued — drop.
        stats.lateDropped++;
        return;
      }
    }

    // Branch 3: overlap trim against the *actual* scheduled end, rounded up to whole frames so
    // two sources never overlap on the audio clock.
    let offsetFrames = 0;
    let startTime = mappedStart;
    if (startTime < scheduledEnd) {
      const overlapFrames = Math.ceil((scheduledEnd - startTime) * chunk.sampleRate);
      if (overlapFrames >= mono.length) {
        stats.overlapDropped++;
        return;
      }
      offsetFrames = overlapFrames;
      startTime = mappedStart + overlapFrames / chunk.sampleRate;
    }

    // Branch 4: upper bound — never schedule further ahead than the bound.
    const upperBound = api.getCurrentTime() + MAX_SCHEDULE_AHEAD_SEC;
    let playFrames = mono.length - offsetFrames;
    const chunkEnd = startTime + playFrames / chunk.sampleRate;
    if (chunkEnd > upperBound) {
      if (startTime >= upperBound && scheduledEnd > api.getCurrentTime()) {
        // Too far ahead while future audio is still queued: drop.
        stats.upperBoundDropped++;
        return;
      }
      if (startTime >= upperBound) {
        // Nothing queued: re-anchor at the next jitter point (fast-degradation recovery) so
        // the timeline cannot drift into permanent silence; the tail trim below keeps the
        // re-anchored chunk within the bound.
        reanchorAt(mediaSec, api.getCurrentTime() + JITTER_BUFFER_SEC);
        startTime = mappedStart;
        offsetFrames = 0;
        playFrames = mono.length;
      }
      // Trim the tail to the bound: keep at most the frames that fit before the bound, so the
      // scheduled end never exceeds it even when the excess is less than one frame.
      const allowedFrames = Math.max(
        0,
        Math.floor((upperBound - startTime) * chunk.sampleRate),
      );
      playFrames = Math.min(playFrames, allowedFrames);
      if (playFrames === 0) {
        stats.upperBoundDropped++;
        return;
      }
    }

    // Create the buffer and start the source. Only a successful start() commits any state, so a
    // failed start can never pollute later branch decisions.
    let bufferSource: AudioPlaybackSource | undefined;
    try {
      const buffer = api.createBuffer(1, playFrames, chunk.sampleRate);
      buffer.getChannelData(0).set(mono.subarray(offsetFrames, offsetFrames + playFrames));
      bufferSource = api.createBufferSource();
      bufferSource.buffer = buffer;
      bufferSource.connect(api.destination);
      bufferSource.onended = () => {
        activeSources.delete(bufferSource!);
      };
      bufferSource.start(startTime, 0, playFrames / chunk.sampleRate);
    } catch (err) {
      if (reanchor != undefined) {
        // A re-anchor already stopped the previous sources; make sure the failed chunk never
        // becomes the new timeline anchor.
        resetState();
      }
      try {
        bufferSource?.stop();
      } catch {
        // The source never started; nothing to stop.
      }
      setError(
        `Failed to schedule audio: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (reanchor != undefined) {
      anchor = reanchor;
    }
    scheduledEnd = startTime + playFrames / chunk.sampleRate;
    lastMediaTimestamp = mediaSec;
    lastMediaEnd = mediaSec + (offsetFrames + playFrames) / chunk.sampleRate;
    activeSources.add(bufferSource);
    onScheduled?.(mono.subarray(offsetFrames, offsetFrames + playFrames), chunk.sampleRate);
  };

  const flush = (): void => {
    resetState();
    stats.lateDropped = 0;
    stats.upperBoundDropped = 0;
    stats.overlapDropped = 0;
    stats.skipped = 0;
    stats.truncated = 0;
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    resetState();
  };

  return {
    schedule,
    flush,
    dispose,
    getStats: () => stats,
  };
}
