// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { envelopeToCanvasPoints, WaveformBuffer } from "./waveform";

describe("WaveformBuffer", () => {
  it("aggregates samples into min/max envelope buckets", () => {
    const buffer = new WaveformBuffer();
    buffer.push(new Float32Array([0.5, -0.5, 0.25, 1]), 1000);

    const buckets = buffer.getBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.min).toBe(-0.5);
    expect(buckets[0]!.max).toBe(1);
    expect(buckets[0]!.duration).toBeCloseTo(4 / 1000);
  });

  it("splits long input into fixed-size buckets", () => {
    const buffer = new WaveformBuffer();
    const samples = new Float32Array(512 * 2 + 100);
    buffer.push(samples, 1000);

    const buckets = buffer.getBuckets();
    expect(buckets).toHaveLength(3);
    expect(buckets[0]!.duration).toBeCloseTo(512 / 1000);
    expect(buckets[2]!.duration).toBeCloseTo(100 / 1000);
  });

  it("scrolls by dropping the oldest buckets once the window duration is exceeded", () => {
    const buffer = new WaveformBuffer();
    // 3000 samples at 1000 Hz = 3 s → 5 × 512-sample buckets + 1 × 440-sample bucket.
    const chunk = new Float32Array(3000);
    buffer.push(chunk, 1000);
    expect(buffer.getBuckets()).toHaveLength(6);
    // Pushing a second 3 s chunk gives 12 buckets / 6 s; the 5 s window keeps 10 buckets
    // (drops the two oldest 512-sample buckets: 6 - 1.024 = 4.976 s).
    buffer.push(chunk, 1000);
    expect(buffer.getBuckets()).toHaveLength(10);
  });

  it("keeps at least one bucket even when the window is smaller than a single bucket", () => {
    const buffer = new WaveformBuffer(0.01);
    buffer.push(new Float32Array(100), 1000); // 0.1 s > 0.01 s window
    expect(buffer.getBuckets()).toHaveLength(1);
    expect(buffer.isEmpty()).toBe(false);
  });

  it("ignores empty input and invalid sample rates", () => {
    const buffer = new WaveformBuffer();
    buffer.push(new Float32Array(0), 1000);
    buffer.push(new Float32Array(100), 0);
    buffer.push(new Float32Array(100), Number.NaN);
    expect(buffer.isEmpty()).toBe(true);
  });

  it("resets on demand (seek / topic switch)", () => {
    const buffer = new WaveformBuffer();
    buffer.push(new Float32Array([0.5, -0.5]), 1000);
    expect(buffer.isEmpty()).toBe(false);
    buffer.reset();
    expect(buffer.isEmpty()).toBe(true);
    expect(buffer.getBuckets()).toHaveLength(0);
  });
});

describe("envelopeToCanvasPoints", () => {
  it("renders positive amplitudes above the midline and negative below it", () => {
    const points = envelopeToCanvasPoints(
      [{ min: -1, max: 1, duration: 0.1 }],
      100,
      100,
    );
    expect(points).toHaveLength(1);
    expect(points[0]!.topY).toBeCloseTo(1, 5);
    expect(points[0]!.bottomY).toBeCloseTo(99, 5);
  });

  it("is symmetric around the midline for symmetric amplitude buckets", () => {
    const points = envelopeToCanvasPoints(
      [{ min: -1, max: 1, duration: 0.1 }],
      100,
      100,
    );
    const midY = 50;
    expect(midY - points[0]!.topY).toBeCloseTo(points[0]!.bottomY - midY, 5);

    const half = envelopeToCanvasPoints(
      [{ min: -0.5, max: 0.5, duration: 0.1 }],
      100,
      100,
    );
    expect(midY - half[0]!.topY).toBeCloseTo(half[0]!.bottomY - midY, 5);
    expect(half[0]!.topY).toBeCloseTo(25.5, 5);
    expect(half[0]!.bottomY).toBeCloseTo(74.5, 5);
  });

  it("clamps amplitudes to the [-1, 1] range and renders silence at the midline", () => {
    const clamped = envelopeToCanvasPoints(
      [{ min: -3, max: 2, duration: 0.1 }],
      100,
      100,
    );
    expect(clamped[0]!.topY).toBeCloseTo(1, 5);
    expect(clamped[0]!.bottomY).toBeCloseTo(99, 5);

    const silence = envelopeToCanvasPoints(
      [{ min: 0, max: 0, duration: 0.1 }],
      100,
      100,
    );
    expect(silence[0]!.topY).toBeCloseTo(50, 5);
    expect(silence[0]!.bottomY).toBeCloseTo(50, 5);
  });

  it("spaces buckets evenly across the width and returns nothing for empty input", () => {
    const points = envelopeToCanvasPoints(
      [
        { min: -1, max: 1, duration: 0.1 },
        { min: -0.5, max: 0.5, duration: 0.1 },
      ],
      200,
      100,
    );
    expect(points[0]!.x).toBeCloseTo(50, 5);
    expect(points[1]!.x).toBeCloseTo(150, 5);
    expect(envelopeToCanvasPoints([], 200, 100)).toHaveLength(0);
    expect(envelopeToCanvasPoints([{ min: -1, max: 1, duration: 0.1 }], 0, 100)).toHaveLength(0);
  });
});
