// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

// Duration of the waveform window (most recent audio shown).
export const WAVEFORM_WINDOW_SEC = 5;
// Samples aggregated into one min/max envelope bucket.
const ENVELOPE_BUCKET_SAMPLES = 512;

export type WaveformBucket = {
  min: number;
  max: number;
  duration: number;
};

export type WaveformCanvasPoint = {
  x: number;
  /** Canvas Y of the envelope top (driven by the max amplitude). */
  topY: number;
  /** Canvas Y of the envelope bottom (driven by the min amplitude). */
  bottomY: number;
};

/**
 * Convert envelope buckets into canvas coordinates for a width × height canvas. Canvas Y grows
 * downward: positive amplitudes render above the vertical midline, negative amplitudes below it.
 * Amplitudes are clamped to [-1, 1].
 */
export function envelopeToCanvasPoints(
  buckets: readonly WaveformBucket[],
  width: number,
  height: number,
): WaveformCanvasPoint[] {
  if (buckets.length === 0 || width <= 0 || height <= 0) {
    return [];
  }
  const midY = height / 2;
  const scaleY = Math.max(0, height / 2 - 1);
  const bucketWidth = width / buckets.length;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return buckets.map((bucket, index) => {
    const x = (index + 0.5) * bucketWidth;
    const topY = midY - clamp(bucket.max) * scaleY;
    const bottomY = midY - clamp(bucket.min) * scaleY;
    return { x, topY, bottomY };
  });
}

/**
 * Ring buffer of min/max envelope buckets over the most recent ~`windowDuration` seconds of
 * audio. New audio is appended as fixed-size buckets; once the total duration exceeds the
 * window, the oldest buckets are dropped so the display keeps scrolling.
 */
export class WaveformBuffer {
  private readonly windowDuration: number;
  private buckets: WaveformBucket[] = [];
  private totalDuration = 0;

  public constructor(windowDuration = WAVEFORM_WINDOW_SEC) {
    this.windowDuration = windowDuration;
  }

  public push(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return;
    }
    for (let start = 0; start < samples.length; start += ENVELOPE_BUCKET_SAMPLES) {
      const end = Math.min(start + ENVELOPE_BUCKET_SAMPLES, samples.length);
      let min = Infinity;
      let max = -Infinity;
      for (let i = start; i < end; i++) {
        const value = samples[i]!;
        if (value < min) {
          min = value;
        }
        if (value > max) {
          max = value;
        }
      }
      const duration = (end - start) / sampleRate;
      this.buckets.push({ min, max, duration });
      this.totalDuration += duration;
    }
    // Scroll: drop the oldest buckets until the window fits again (keep at least one bucket).
    while (this.totalDuration > this.windowDuration && this.buckets.length > 1) {
      const oldest = this.buckets.shift()!;
      this.totalDuration -= oldest.duration;
    }
  }

  public reset(): void {
    this.buckets = [];
    this.totalDuration = 0;
  }

  public getBuckets(): readonly WaveformBucket[] {
    return this.buckets;
  }

  public isEmpty(): boolean {
    return this.buckets.length === 0;
  }
}
