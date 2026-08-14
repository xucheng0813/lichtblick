// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2019-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import VirtualLRUBuffer from "./VirtualLRUBuffer";

describe("VirtualLRUBuffer", () => {
  describe("constructor", () => {
    it("returns an instance with the requested bytes", () => {
      const vb = new VirtualLRUBuffer({ size: 50, blockSize: 10 });
      expect(vb.byteLength).toEqual(50);
    });
  });

  describe("#copyFrom", () => {
    it("lets you copy a buffer into a single block", () => {
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10 });
      vb.copyFrom(Buffer.from(new Array(25).fill(0)), 0);
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 2);
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 12);
      //                <--------- block 1 -------->  <--------- block 2 -------->  <-- block 3 ->
      const expected = [0, 0, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      expect([...vb.slice(0, 10), ...vb.slice(10, 20), ...vb.slice(20, 25)]).toEqual(expected);
    });

    it("lets you copy a buffer spread over two blocks", () => {
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10 });
      vb.copyFrom(Buffer.from(new Array(25).fill(0)), 0);
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 8);
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 18);
      //                <--------- block 1 -------->  <--------- block 2 -------->  <-- block 3 ->
      const expected = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0];
      expect([...vb.slice(0, 10), ...vb.slice(10, 20), ...vb.slice(20, 25)]).toEqual(expected);
    });

    it("lets you copy a buffer spread over three blocks", () => {
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10 });
      vb.copyFrom(Buffer.from(new Array(25).fill(0)), 0);
      vb.copyFrom(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5]), 8);
      //                <--------- block 1 -------->  <--------- block 2 -------->  <-- block 3 ->
      const expected = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 0, 0, 0];
      expect([...vb.slice(0, 10), ...vb.slice(10, 20), ...vb.slice(20, 25)]).toEqual(expected);
    });
  });

  describe("#hasData", () => {
    it("gets set when copying in data", () => {
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10 });
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 2);
      expect(vb.hasData(0, 4)).toEqual(false);
      expect(vb.hasData(2, 6)).toEqual(true);
    });

    it("evicts old blocks if numberOfBlocks is set", () => {
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10, numberOfBlocks: 1 });
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 2);
      expect(vb.hasData(2, 6)).toEqual(true);
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 12);
      expect(vb.hasData(2, 6)).toEqual(false);
      expect(vb.hasData(12, 16)).toEqual(true);
    });
  });

  describe("#setProtectedRanges", () => {
    it("keeps protected blocks alive across interleaved writes and eviction", () => {
      // GIVEN: a 2-block buffer where the oldest block becomes protected.
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10, numberOfBlocks: 2 });
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 2); // block 0
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 12); // block 1
      vb.setProtectedRanges([{ start: 0, end: 4 }]); // block 0 is now protected

      // WHEN: a third block is allocated, forcing an eviction.
      vb.copyFrom(Buffer.from([9, 9, 9, 9, 9]), 20); // block 2

      // THEN: the protected block survives; the oldest non-protected block is evicted instead.
      expect(vb.hasData(2, 6)).toEqual(true);
      expect(vb.hasData(12, 16)).toEqual(false);
      expect(vb.hasData(20, 25)).toEqual(true);
    });

    it("evicts the least recently used block anyway when all blocks are protected (defensive path)", () => {
      // GIVEN: a 1-block buffer whose only block is protected.
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10, numberOfBlocks: 1 });
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 2); // block 0
      vb.setProtectedRanges([{ start: 0, end: 25 }]); // every block is protected

      // WHEN: a new block must be allocated.
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 12); // block 1

      // THEN: allocation still makes progress by evicting the oldest block, and the defensive
      // path logs a warning (asserted and cleared per the test-framework convention).
      expect(vb.hasData(2, 6)).toEqual(false);
      expect(vb.hasData(12, 16)).toEqual(true);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("all other blocks are protected"),
      );
      (console.warn as jest.Mock).mockClear();
    });

    it("never evicts the just-allocated block when all older blocks are protected", () => {
      // GIVEN: a full 2-block buffer where every older block is protected.
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10, numberOfBlocks: 2 });
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 2); // block 0
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 12); // block 1
      vb.setProtectedRanges([{ start: 0, end: 20 }]); // blocks 0 and 1 are protected

      // WHEN: a new (unprotected) block must be allocated. The candidate scan must not pick the
      // just-allocated block itself (its data is not written yet); the defensive path evicts the
      // oldest protected block instead.
      vb.copyFrom(Buffer.from([9, 8, 7, 6, 5]), 20); // block 2

      // THEN: the new block's data survives and can be sliced back out; the oldest protected
      // block was evicted via the defensive path (with a warning).
      expect([...vb.slice(20, 25)]).toEqual([9, 8, 7, 6, 5]);
      expect(vb.hasData(2, 6)).toEqual(false);
      expect(vb.hasData(12, 16)).toEqual(true);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("all other blocks are protected"),
      );
      (console.warn as jest.Mock).mockClear();
    });

    it("behaves like an unprotected buffer with an empty protection set", () => {
      // GIVEN: a buffer with protected ranges explicitly cleared.
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10, numberOfBlocks: 1 });
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 2);
      vb.setProtectedRanges([{ start: 0, end: 4 }]);
      vb.setProtectedRanges([]);

      // WHEN: a new block is allocated.
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 12);

      // THEN: the now-unprotected oldest block is evicted as usual.
      expect(vb.hasData(2, 6)).toEqual(false);
      expect(vb.hasData(12, 16)).toEqual(true);
    });
  });

  describe("#slice", () => {
    // single block case covered above in .copyFrom tests.

    it("lets you slice a buffer spread over two blocks", () => {
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10 });
      vb.copyFrom(Buffer.from([1, 2, 3, 4]), 8);
      vb.copyFrom(Buffer.from([5, 6, 7, 8]), 18);
      expect([...vb.slice(8, 12)]).toEqual([1, 2, 3, 4]);
      expect([...vb.slice(18, 22)]).toEqual([5, 6, 7, 8]);
    });

    it("lets you slice a buffer spread over three blocks", () => {
      const vb = new VirtualLRUBuffer({ size: 25, blockSize: 10 });
      vb.copyFrom(Buffer.from(new Array(25).fill(0)), 0);
      vb.copyFrom(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5]), 8);
      //                <--------- block 1 -------->  <--------- block 2 -------->  <-- block 3 ->
      const expected = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 0, 0, 0];
      expect([...vb.slice(0, 25)]).toEqual(expected);
    });
  });
});
