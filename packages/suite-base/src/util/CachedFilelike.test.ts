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

import { unify } from "intervals-fn";

import delay from "@lichtblick/suite-base/util/delay";

import CachedFilelike from "./CachedFilelike";
import type { FileReader, FileStream } from "./CachedFilelike.types";

const MEBIBYTE = 1024 * 1024;

class InMemoryFileReader implements FileReader {
  #buffer: Uint8Array;

  public constructor(bufferObj: Uint8Array) {
    this.#buffer = bufferObj;
  }

  public async open() {
    return { size: this.#buffer.byteLength };
  }

  public fetch(offset: number, length: number): FileStream {
    if (offset + length > this.#buffer.byteLength) {
      throw new Error(
        `Read offset=${offset} length=${length} past buffer length ${this.#buffer.byteLength}`,
      );
    }
    return {
      on: (
        type: "data" | "error" | "end",
        callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
      ) => {
        if (type === "data") {
          setTimeout(() => {
            callback(this.#buffer.slice(offset, offset + length));
          }, 0);
        }
      },
      destroy() {
        // no-op
      },
    };
  }
}

const log = {
  debug: (..._args: unknown[]) => {},
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
};

// A fetch mock that delivers each requested range as a single chunk, and records every fetch.
function makeDeliveringFetch() {
  const fetch = jest.fn(
    (_offset: number, length: number): FileStream => ({
      on: (
        type: "data" | "error" | "end",
        callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
      ) => {
        if (type === "data") {
          setTimeout(() => {
            callback(new Uint8Array(length));
          }, 0);
        }
      },
      destroy() {
        // no-op
      },
    }),
  );
  return fetch;
}

describe("CachedFilelike", () => {
  describe("#size", () => {
    it("returns the size from the underlying FileReader", async () => {
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      const cachedFileReader = new CachedFilelike({ fileReader, log });
      await cachedFileReader.open();
      expect(cachedFileReader.size()).toEqual(4);
    });

    it("does not throw when the size is 0", async () => {
      const fileReader = new InMemoryFileReader(new Uint8Array([]));
      const cachedFileReader = new CachedFilelike({ fileReader, log });
      await cachedFileReader.open();
      expect(cachedFileReader.size()).toEqual(0);
    });
  });

  describe("#read", () => {
    it("returns data from the underlying FileReader", async () => {
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      const cachedFileReader = new CachedFilelike({ fileReader, log });
      await expect(cachedFileReader.read(1, 2)).resolves.toEqual(new Uint8Array([1, 2]));
      await expect(cachedFileReader.read(2, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    });

    it("requests only the exact range when read-ahead is disabled", async () => {
      // GIVEN: a file that fits entirely in the cache.
      const fileReader = new InMemoryFileReader(new Uint8Array(100));
      const fetch = jest.spyOn(fileReader, "fetch");
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100,
        readAheadEnabled: false,
        log,
      });

      // WHEN: reading a small range.
      await expect(cachedFileReader.read(0, 10)).resolves.toEqual(new Uint8Array(10));

      // THEN: no speculative whole-file or look-ahead fetch is made.
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(0, 10);
    });

    it("bounds speculative fetch length with readAheadBufferBytes", async () => {
      // GIVEN: a large remote-like file with a small cache budget and a much smaller read-ahead cap.
      const readAheadBufferBytes = 2 * 1024 * 1024;
      const fetch = jest.fn(
        (_offset: number, length: number): FileStream => ({
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              setTimeout(() => {
                callback(new Uint8Array(length));
              }, 0);
            }
          },
          destroy() {
            // no-op
          },
        }),
      );
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * 1024 * 1024 }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 10 * 1024 * 1024,
        readAheadBufferBytes,
        log,
      });

      // WHEN: reading a small initial range.
      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));

      // THEN: the initial underlying fetch uses the bounded read-ahead size instead of 50 MiB.
      expect(fetch).toHaveBeenNthCalledWith(1, 0, readAheadBufferBytes);
    });

    it("resolves a later overlapping read instead of hanging when a small read-ahead buffer trails cached bytes", async () => {
      // GIVEN: a file where an earlier 2 MiB speculative fetch is still in flight when a later
      // 4 MiB read arrives, matching the production hang scenario exposed by a 2 MiB buffer.
      const fetch = jest.fn(
        (_offset: number, length: number): FileStream => ({
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              setTimeout(() => {
                callback(new Uint8Array(length));
              }, 25);
            }
          },
          destroy() {
            // no-op
          },
        }),
      );
      const fileReader: FileReader = {
        open: async () => ({ size: 8 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 6 * MEBIBYTE,
        readAheadBufferBytes: 2 * MEBIBYTE,
        log,
      });

      const firstReadPromise = cachedFileReader.read(0, 1);
      await delay(10);
      expect(fetch).toHaveBeenCalledTimes(1);

      // WHEN: a larger overlapping read needs bytes beyond the already cached 2 MiB prefix.
      const secondReadPromise = cachedFileReader.read(0, 4 * MEBIBYTE);

      // THEN: the second fetch makes forward progress by requesting the missing 2 MiB tail
      // instead of issuing a degenerate 2 MiB-2 MiB range and hanging forever.
      await expect(firstReadPromise).resolves.toEqual(new Uint8Array([0]));
      await expect(secondReadPromise).resolves.toEqual(new Uint8Array(4 * MEBIBYTE));
      expect(fetch.mock.calls.slice(0, 2)).toEqual([
        [0, 2 * MEBIBYTE],
        [2 * MEBIBYTE, 2 * MEBIBYTE],
      ]);
    }, 2000);

    it("ignores a degenerate zero-width idle connection instead of fetching it", async () => {
      jest.resetModules();
      const getNewConnection = jest
        .fn()
        .mockReturnValueOnce({ start: 0, end: 4 })
        .mockReturnValueOnce({ start: 4, end: 4 })
        .mockReturnValue(undefined);
      jest.doMock("./getNewConnection", () => ({
        getNewConnection,
      }));
      const { default: MockedCachedFilelike } = await import("./CachedFilelike");

      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      const fetch = jest.spyOn(fileReader, "fetch");
      const debug = jest.fn();
      const cachedFileReader = new MockedCachedFilelike({
        fileReader,
        log: { ...log, debug },
      });

      try {
        await expect(cachedFileReader.read(0, 4)).resolves.toEqual(new Uint8Array([0, 1, 2, 3]));
        await delay(10);

        expect(getNewConnection).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(0, 4);
        expect(debug).toHaveBeenCalledWith(expect.stringContaining("Ignoring degenerate"));
      } finally {
        jest.dontMock("./getNewConnection");
        jest.resetModules();
      }
    });

    it("reads the exact range uncached when a single read exceeds the cache size", async () => {
      // GIVEN: a source allocated a small cache (mirrors a many-file remote session where each
      // source receives only the 10 MiB minimum floor) backed by a larger file.
      const sourceData = Uint8Array.from({ length: 100 }, (_, index) => index);
      const fileReader = new InMemoryFileReader(sourceData);
      const cachedFileReader = new CachedFilelike({ fileReader, cacheSizeInBytes: 10, log });

      // WHEN: a chunk read is larger than the cache.
      const result = await cachedFileReader.read(0, 20);

      // THEN: the exact bytes are returned via the uncached path.
      expect(result).toEqual(sourceData.slice(0, 20));
    });

    it("rejects when an uncached read exceeds the file size", async () => {
      // GIVEN: a small file and a cache smaller than the requested read.
      const fileReader = new InMemoryFileReader(new Uint8Array(10));
      const cachedFileReader = new CachedFilelike({ fileReader, cacheSizeInBytes: 5, log });

      // WHEN/THEN: an oversized read that extends past EOF still rejects with the normal
      // out-of-bounds error.
      await expect(cachedFileReader.read(0, 1000)).rejects.toThrow("CachedFilelike#read past size");
    });

    it("returns an error in the callback if the FileReader keeps returning errors", async () => {
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      let interval: any;
      let destroyed: any;
      jest.spyOn(fileReader, "fetch").mockImplementation(() => {
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "error") {
              interval = setInterval(() => {
                callback(new Error("Dummy error"));
              }, 20);
            }
          },
          destroy() {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            clearInterval(interval);
            destroyed = true;
          },
        };
      });
      const cachedFileReader = new CachedFilelike({ fileReader, log });
      await expect(cachedFileReader.read(1, 2)).rejects.toThrow("Dummy error");
      expect(destroyed).toEqual(true);
    });

    it("keeps reconnecting when keepReconnectingCallback is set", async () => {
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      let dataCallback: ((_: Uint8Array) => void) | undefined;
      let errorCallback: ((_: Error) => void) | undefined;
      let destroyed: any;
      const mockFetch = jest.spyOn(fileReader, "fetch").mockImplementation(() => {
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              dataCallback = callback;
            }
            if (type === "error") {
              errorCallback = callback;
            }
          },
          destroy() {
            destroyed = true;
          },
        };
      });

      const keepReconnectingCallback = jest.fn();
      const cachedFileReader = new CachedFilelike({ fileReader, log, keepReconnectingCallback });

      const readerPromise = cachedFileReader.read(1, 2);

      await delay(10);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      if (!dataCallback || !errorCallback) {
        throw new Error("dataCallback not set");
      }
      errorCallback(new Error("Dummy error"));
      await delay(10);
      expect(keepReconnectingCallback.mock.calls).toEqual([[true]]);

      dataCallback(new Uint8Array([1, 2]));
      const data = await readerPromise;
      expect(keepReconnectingCallback.mock.calls).toEqual([[true], [false]]);
      expect([...data]).toEqual([1, 2]);
      expect(destroyed).toBe(true);
    });

    it("returns an empty buffer when requesting size 0 (does not throw an error)", async () => {
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      const cachedFileReader = new CachedFilelike({ fileReader, log });
      await expect(cachedFileReader.read(1, 0)).resolves.toEqual(new Uint8Array([]));
    });

    it("rejects instead of hanging when a cached connection ends before the requested range is fully downloaded", async () => {
      // GIVEN: a cached read whose underlying stream ends early twice in a row.
      const fetch = jest.fn(
        (_offset: number, length: number): FileStream => ({
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data" && length > 1) {
              setTimeout(() => {
                callback(new Uint8Array(length - 1));
              }, 0);
            }
            if (type === "end") {
              setTimeout(() => {
                callback();
              }, 1);
            }
          },
          destroy() {
            // no-op
          },
        }),
      );
      const fileReader: FileReader = {
        open: async () => ({ size: 100 }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        readAheadEnabled: false,
        log,
      });

      // WHEN / THEN: the read rejects after the early EOF retry path rather than staying
      // pending forever with no further network activity.
      await expect(cachedFileReader.read(0, 10)).rejects.toThrow(/ended before download completed/);
      expect(fetch).toHaveBeenCalledTimes(2);
    }, 1000);
  });

  describe("#close", () => {
    it("rejects reads after close()", async () => {
      // GIVEN: an opened reader.
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      const cachedFileReader = new CachedFilelike({ fileReader, log });
      await cachedFileReader.open();

      // WHEN: the reader is closed.
      cachedFileReader.close();

      // THEN: subsequent reads reject with the closed error.
      await expect(cachedFileReader.read(0, 2)).rejects.toThrow("CachedFilelike is closed");
    });

    it("is idempotent when called twice", () => {
      // GIVEN: a reader.
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      const cachedFileReader = new CachedFilelike({ fileReader, log });

      // WHEN/THEN: closing twice does not throw.
      expect(() => {
        cachedFileReader.close();
        cachedFileReader.close();
      }).not.toThrow();
    });

    it("rejects an in-flight pending read request", async () => {
      // GIVEN: a file reader whose fetch never delivers data, so the read stays pending.
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      jest.spyOn(fileReader, "fetch").mockImplementation(() => ({
        on: () => {
          // Never emits "data" or "error", leaving the read request pending.
        },
        destroy() {
          // no-op
        },
      }));
      const cachedFileReader = new CachedFilelike({ fileReader, log });

      // WHEN: a read is started (and stays pending) and then the reader is closed.
      const readPromise = cachedFileReader.read(0, 2);
      await delay(10);
      cachedFileReader.close();

      // THEN: the pending read rejects with the closed error.
      await expect(readPromise).rejects.toThrow("CachedFilelike is closed");
    });

    it("rejects an oversized uncached read when closed", async () => {
      // GIVEN: a small cache and a fetch that never delivers data, so an oversized (uncached)
      // read stays pending.
      const fileReader = new InMemoryFileReader(new Uint8Array(100));
      jest.spyOn(fileReader, "fetch").mockImplementation(() => ({
        on: () => {
          // Never emits "data", "end", or "error", leaving the uncached read pending.
        },
        destroy() {
          // no-op
        },
      }));
      const cachedFileReader = new CachedFilelike({ fileReader, cacheSizeInBytes: 10, log });
      await cachedFileReader.open();

      // WHEN: an oversized read (larger than the cache budget) is started, then the reader closes.
      const readPromise = cachedFileReader.read(0, 50);
      await delay(10);
      cachedFileReader.close();

      // THEN: the oversized uncached read settles by rejecting with the closed error.
      await expect(readPromise).rejects.toThrow("CachedFilelike is closed");
    });

    it("destroys the active connection when two quick stream errors trigger the fatal close path", async () => {
      // GIVEN: a read that reconnects once and then hits the fatal double-error close path.
      const fileReader = new InMemoryFileReader(new Uint8Array([0, 1, 2, 3]));
      const streams: Array<{ destroy: jest.Mock; error?: (_error: Error) => void }> = [];
      jest.spyOn(fileReader, "fetch").mockImplementation(() => {
        const stream = { destroy: jest.fn() };
        streams.push(stream);
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "error") {
              streams[streams.length - 1]!.error = callback;
            }
          },
          destroy: stream.destroy,
        };
      });
      let now = 1_000;
      const dateNow = jest.spyOn(Date, "now").mockImplementation(() => now);
      const cachedFileReader = new CachedFilelike({ fileReader, log });

      try {
        // WHEN: two connection errors happen within the fatal 100ms window.
        const readPromise = cachedFileReader.read(0, 2);
        await delay(10);

        now = 1_010;
        streams[0]!.error?.(new Error("transient"));
        await delay(10);

        now = 1_050;
        const fatalError = new Error("fatal");
        streams[1]!.error?.(fatalError);

        // THEN: the read rejects, and the active connection is destroyed as part of full cleanup.
        await expect(readPromise).rejects.toThrow("fatal");
        expect(streams[1]!.destroy).toHaveBeenCalledTimes(1);
      } finally {
        dateNow.mockRestore();
      }
    });
  });

  describe("K-way parallel connections", () => {
    it("deducts claimed in-flight ranges from a read-ahead candidate before dispatching (no overlap)", async () => {
      jest.resetModules();
      const getNewConnection = jest
        .fn()
        // 第一个连接认领 [2MiB, 4MiB)。
        .mockReturnValueOnce({ start: 2 * MEBIBYTE, end: 4 * MEBIBYTE })
        // read-ahead 尾部扩展会覆盖在途区间;二次扣除后应只派发 [0, 2MiB)。
        .mockReturnValueOnce({ start: 0, end: 50 * MEBIBYTE })
        .mockReturnValue(undefined);
      jest.doMock("./getNewConnection", () => ({
        getNewConnection,
      }));
      const { default: MockedCachedFilelike } = await import("./CachedFilelike");

      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new MockedCachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        log,
      });

      try {
        await expect(cachedFileReader.read(0, 1)).resolves.toEqual(new Uint8Array(1));

        // 分派区间与在途区间无重叠:[0, 2MiB),而不是带 read-ahead 的 [0, 50MiB)。
        expect(fetch.mock.calls).toEqual([
          [2 * MEBIBYTE, 2 * MEBIBYTE],
          [0, 2 * MEBIBYTE],
        ]);
        cachedFileReader.close();
      } finally {
        jest.dontMock("./getNewConnection");
        jest.resetModules();
      }
    });

    it("dispatches a later uncovered request while an earlier request is covered by an in-flight connection (Phase 0)", async () => {
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        readAheadEnabled: false,
        log,
      });

      const firstRead = cachedFileReader.read(0, 1);
      const secondRead = cachedFileReader.read(2 * MEBIBYTE, 1);
      await delay(10);

      // 第一个请求仍被在途连接覆盖时,第二个请求已开始下载。
      expect(fetch).toHaveBeenCalledTimes(2);
      await expect(firstRead).resolves.toEqual(new Uint8Array(1));
      await expect(secondRead).resolves.toEqual(new Uint8Array(1));
    });

    it("retries a failed connection without disturbing other in-flight connections", async () => {
      const streams: Array<{
        data?: (_: Uint8Array) => void;
        error?: (_: Error) => void;
        destroy: jest.Mock;
      }> = [];
      const fetch = jest.fn((_offset: number, _length: number): FileStream => {
        const entry = {
          data: undefined as ((_: Uint8Array) => void) | undefined,
          error: undefined as ((_: Error) => void) | undefined,
          destroy: jest.fn(),
        };
        streams.push(entry);
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              entry.data = callback;
            }
            if (type === "error") {
              entry.error = callback;
            }
          },
          destroy: entry.destroy,
        };
      });
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        readAheadEnabled: false,
        log,
      });

      const firstRead = cachedFileReader.read(0, 1);
      const secondRead = cachedFileReader.read(2 * MEBIBYTE, 1);
      await delay(10);
      expect(fetch).toHaveBeenCalledTimes(2);

      // 第一路失败:重试启动新连接;第二路不受影响。
      streams[0]!.error?.(new Error("transient"));
      await delay(10);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(streams[1]!.destroy).not.toHaveBeenCalled();

      // 第二路正常完成;第一路的替代连接随后完成。
      streams[1]!.data?.(new Uint8Array(1));
      await expect(secondRead).resolves.toEqual(new Uint8Array(1));
      streams[2]!.data?.(new Uint8Array(1));
      await expect(firstRead).resolves.toEqual(new Uint8Array(1));
    });

    it("destroys every active connection when closed", async () => {
      const streams: Array<{ destroy: jest.Mock }> = [];
      const fetch = jest.fn((_offset: number, _length: number): FileStream => {
        const stream = { destroy: jest.fn() };
        streams.push(stream);
        return {
          on: () => {
            // Never emits data/error/end: the reads stay pending until close().
          },
          destroy: stream.destroy,
        };
      });
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        log,
      });

      const readPromise = cachedFileReader.read(0, 1);
      await delay(10);
      cachedFileReader.close();

      await expect(readPromise).rejects.toThrow("CachedFilelike is closed");
      expect(streams.length).toBeGreaterThanOrEqual(2);
      for (const stream of streams) {
        expect(stream.destroy).toHaveBeenCalledTimes(1);
      }
    });

    it("handles a stream that invokes the data listener synchronously on registration", async () => {
      const fetch = jest.fn((_offset: number, _length: number): FileStream => ({
        on: (
          type: "data" | "error" | "end",
          callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
        ) => {
          if (type === "data") {
            // 注册即同步回调:保护集必须先于 listener 注册更新。
            callback(new Uint8Array(_length));
          }
        },
        destroy() {
          // no-op
        },
      }));
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        log,
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      expect(fetch).toHaveBeenCalled();
      cachedFileReader.close();
    });

    it("does not retry when a destroyed stream emits a late end after successful completion", async () => {
      let emitLateEnd: (() => void) | undefined;
      const fetch = jest.fn((_offset: number, _length: number): FileStream => ({
        on: (
          type: "data" | "error" | "end",
          callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
        ) => {
          if (type === "data") {
            callback(new Uint8Array(_length));
          }
          if (type === "end") {
            emitLateEnd = callback;
          }
        },
        destroy() {
          // 完成后 destroy 才发出迟到的 end。
          if (emitLateEnd) {
            setTimeout(() => {
              emitLateEnd?.();
            }, 5);
          }
        },
      }));
      const fileReader: FileReader = {
        open: async () => ({ size: 100 }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        readAheadEnabled: false,
        log,
      });

      await expect(cachedFileReader.read(0, 10)).resolves.toEqual(new Uint8Array(10));
      await delay(20);

      // 迟到的 end 被忽略,不触发重试。
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("keeps reconnecting on rapid repeated failures of the same route when keepReconnectingCallback is set", async () => {
      const streams: Array<{
        data?: (_: Uint8Array) => void;
        error?: (_: Error) => void;
      }> = [];
      const fetch = jest.fn((_offset: number, _length: number): FileStream => {
        const entry = {
          data: undefined as ((_: Uint8Array) => void) | undefined,
          error: undefined as ((_: Error) => void) | undefined,
        };
        streams.push(entry);
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              entry.data = callback;
            }
            if (type === "error") {
              entry.error = callback;
            }
          },
          destroy() {
            // no-op
          },
        };
      });
      const fileReader: FileReader = {
        open: async () => ({ size: 100 }),
        fetch,
      };
      const keepReconnectingCallback = jest.fn();
      const cachedFileReader = new CachedFilelike({
        fileReader,
        readAheadEnabled: false,
        log,
        keepReconnectingCallback,
      });

      const readPromise = cachedFileReader.read(1, 2);
      await delay(10);
      streams[0]!.error?.(new Error("first"));
      await delay(10);
      // 同一 routeId 的替代连接在 100ms 内再次失败:callback 模式下永不致命。
      streams[1]!.error?.(new Error("second"));
      await delay(10);

      expect(keepReconnectingCallback.mock.calls).toEqual([[true]]);
      streams[2]!.data?.(new Uint8Array([1, 2]));
      await expect(readPromise).resolves.toEqual(new Uint8Array([1, 2]));
      expect(keepReconnectingCallback.mock.calls).toEqual([[true], [false]]);
    });

    it("retries a route with the same routeId after a temporary admission rejection", async () => {
      // 构造:30MiB 缓存(5 块,有效 K = 2);read-ahead 关闭以获得精确区间。
      // 读请求 [2,28)MiB(块 0-2)+ [40,41)MiB(块 4)→ 保护集 4 块;任何新段都被准入拒绝,
      // 只在无在途连接时经保底路径启动。
      const streams: Array<{
        data?: (_: Uint8Array) => void;
        error?: (_: Error) => void;
      }> = [];
      const fetch = jest.fn((_offset: number, length: number): FileStream => {
        const index = streams.length;
        const entry = {
          data: undefined as ((_: Uint8Array) => void) | undefined,
          error: undefined as ((_: Error) => void) | undefined,
        };
        streams.push(entry);
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              entry.data = callback;
              if (index >= 2) {
                // 第 3 个连接起自动投喂完整数据。
                setTimeout(() => {
                  callback(new Uint8Array(length));
                }, 0);
              }
            }
            if (type === "error") {
              entry.error = callback;
            }
          },
          destroy() {
            // no-op
          },
        };
      });
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const keepReconnectingCallback = jest.fn();
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 30 * MEBIBYTE,
        parallelConnections: 4,
        readAheadEnabled: false,
        keepReconnectingCallback,
        log,
      });

      const readA = cachedFileReader.read(2 * MEBIBYTE, 26 * MEBIBYTE);
      const readB = cachedFileReader.read(40 * MEBIBYTE, 1 * MEBIBYTE);
      await delay(10);
      expect(fetch).toHaveBeenCalledTimes(2); // [2,6) 和 [6,10) 两路在途

      // 第一路部分数据后失败 → 进入重试队列。
      streams[0]!.data?.(new Uint8Array(2 * MEBIBYTE));
      await delay(10);
      streams[0]!.error?.(new Error("interrupted"));
      await delay(10);

      // 重试因准入被暂时拒绝(保护集 4 块 + 新段 > numberOfBlocks - 1,且仍有在途连接):
      // route 必须留在队内,不得丢失。
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(keepReconnectingCallback.mock.calls).toEqual([[true]]);

      // 第二路完成 → 无在途连接 → 保底路径以同一 routeId 重试剩余 [4,6)MiB。
      streams[1]!.data?.(new Uint8Array(4 * MEBIBYTE));
      await delay(10);
      expect(fetch.mock.calls[2]).toEqual([4 * MEBIBYTE, 2 * MEBIBYTE]);

      // 全部请求最终收敛。
      const results = await Promise.all([readA, readB]);
      expect(results.map((result) => result.byteLength)).toEqual([26 * MEBIBYTE, 1 * MEBIBYTE]);
      expect(keepReconnectingCallback.mock.calls.at(-1)).toEqual([false]);
      cachedFileReader.close();
    });

    it("inherits the routeId on retry without merging a concurrent new request into the same route", async () => {
      const streams: Array<{ data?: (_: Uint8Array) => void; error?: (_: Error) => void }> = [];
      const fetch = jest.fn((_offset: number, _length: number): FileStream => {
        const entry = {
          data: undefined as ((_: Uint8Array) => void) | undefined,
          error: undefined as ((_: Error) => void) | undefined,
        };
        streams.push(entry);
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              entry.data = callback;
            }
            if (type === "error") {
              entry.error = callback;
            }
          },
          destroy() {
            // no-op
          },
        };
      });
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        maxSegmentBytes: 8 * MEBIBYTE,
        readAheadEnabled: false,
        log,
      });

      const readA = cachedFileReader.read(0, 8 * MEBIBYTE);
      await delay(10);
      // 部分数据后失败。
      streams[0]!.data?.(new Uint8Array(4 * MEBIBYTE));
      await delay(10);
      streams[0]!.error?.(new Error("interrupted"));
      await delay(10);
      // 失败后插入新请求。
      const newRead = cachedFileReader.read(10 * MEBIBYTE, 1024);
      await delay(10);

      // 替代连接只取剩余 [4MiB, 8MiB)(继承 routeId,不重下前缀);新请求是独立的一路。
      expect(fetch.mock.calls).toEqual([
        [0, 8 * MEBIBYTE],
        [4 * MEBIBYTE, 4 * MEBIBYTE],
        [10 * MEBIBYTE, 1024],
      ]);

      streams[1]!.data?.(new Uint8Array(4 * MEBIBYTE));
      streams[2]!.data?.(new Uint8Array(1024));
      await expect(readA).resolves.toEqual(new Uint8Array(8 * MEBIBYTE));
      await expect(newRead).resolves.toEqual(new Uint8Array(1024));
    });

    it("converges under admission control with a near-cache-size non-aligned request and out-of-order chunk completion", async () => {
      const fetch = jest.fn((offset: number, length: number): FileStream => ({
        on: (
          type: "data" | "error" | "end",
          callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
        ) => {
          if (type === "data") {
            // 每个 fetch 一个与 offset 相关的确定性延迟,制造乱序完成。
            const delayMs = 2 + ((offset / MEBIBYTE) % 5) * 3;
            setTimeout(() => {
              callback(new Uint8Array(length));
            }, delayMs);
          }
        },
        destroy() {
          // no-op
        },
      }));
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      // 30MiB 缓存 → 5 块 → 有效 K = min(4, floor(5/2)) = 2;K>1 无显式 segment → 4MiB。
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 30 * MEBIBYTE,
        parallelConnections: 4,
        log,
      });

      // 非对齐、接近 cacheSize 的队首请求 + 持续后续小请求。
      const reads = [
        cachedFileReader.read(2 * MEBIBYTE, 26 * MEBIBYTE),
        cachedFileReader.read(40 * MEBIBYTE, 1 * MEBIBYTE),
        cachedFileReader.read(60 * MEBIBYTE, 2 * MEBIBYTE),
      ];
      const results = await Promise.all(reads);
      // 全部请求最终 resolve,且数据完整(避免对 27MB 数组做全量 toEqual 的深度比较)。
      expect(results.map((result) => result.byteLength)).toEqual([
        26 * MEBIBYTE,
        1 * MEBIBYTE,
        2 * MEBIBYTE,
      ]);
      expect(results[0]![0]).toBe(0);
      expect(results[0]![26 * MEBIBYTE - 1]).toBe(0);
      await delay(50);
      cachedFileReader.close();

      // 所有 fetch 区间无重复覆盖:unify 后总长度 === 各段长度之和。
      const ranges = fetch.mock.calls.map(([offset, length]) => ({
        start: offset,
        end: offset + length,
      }));
      const unified = unify(ranges, []);
      const totalFetched = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
      const unifiedTotal = unified.reduce((sum, range) => sum + (range.end - range.start), 0);
      expect(totalFetched).toBe(unifiedTotal);
    }, 5000);

    it("deterministically triggers the all-victims-protected defensive eviction and converges with bounded re-downloads", async () => {
      // 构造:30MiB 缓存(5 块),K = 1,不切片 —— 单条覆盖 read-ahead 的 route [2,52)MiB。
      // route 下载 8MiB 后失败 → 替代连接(携带同一 routeId 与完整原始段保护集)写入第 6 个
      // 不同块时,所有已分配块都受保护 → 防御分支逐出最旧受保护块;被逐出的空洞随后由
      // idle read-ahead 有界修复(恰好一次)并最终收敛。
      const streams: Array<{
        data?: (_: Uint8Array) => void;
        error?: (_: Error) => void;
        end?: () => void;
        destroy: jest.Mock;
      }> = [];
      const fetch = jest.fn((_offset: number, _length: number): FileStream => {
        const entry = {
          data: undefined as ((_: Uint8Array) => void) | undefined,
          error: undefined as ((_: Error) => void) | undefined,
          end: undefined as (() => void) | undefined,
          destroy: jest.fn(),
        };
        streams.push(entry);
        return {
          on: (
            type: "data" | "error" | "end",
            callback: ((_: Uint8Array) => void) & ((_: Error) => void) & (() => void),
          ) => {
            if (type === "data") {
              entry.data = callback;
            }
            if (type === "error") {
              entry.error = callback;
            }
            if (type === "end") {
              entry.end = callback;
            }
          },
          destroy: entry.destroy,
        };
      });
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      // 仅用于关闭致命重连路径(替代连接的 early-EOF 会发生在 100ms 致命窗口内)。
      const keepReconnectingCallback = jest.fn();
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 30 * MEBIBYTE,
        keepReconnectingCallback,
        log,
      });

      const readPromise = cachedFileReader.read(2 * MEBIBYTE, 24 * MEBIBYTE);
      await delay(10);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]).toEqual([2 * MEBIBYTE, 50 * MEBIBYTE]);

      // 部分数据后失败 → 重试队列。
      streams[0]!.data?.(new Uint8Array(8 * MEBIBYTE)); // {2,10}
      await delay(10);
      streams[0]!.error?.(new Error("interrupted"));
      await delay(10);
      // 替代连接继承 routeId,只取剩余 [10,52)MiB。
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]).toEqual([10 * MEBIBYTE, 42 * MEBIBYTE]);

      // 替代连接写入第 6 个不同块时,所有已分配块都受保护 → 防御分支逐出最旧受保护块。
      streams[1]!.data?.(new Uint8Array(30 * MEBIBYTE)); // {10,40}:至此读请求已被覆盖并解析
      await delay(10);
      streams[1]!.data?.(new Uint8Array(10 * MEBIBYTE)); // {40,50}
      await delay(10);
      // {50,52} 是第 6 个不同块:防御分支逐出最旧受保护块。读请求解析时的 slice 把块 0-2
      // 重新排到 LRU 末尾,因此最旧的是块 3({30,40})。
      streams[1]!.data?.(new Uint8Array(2 * MEBIBYTE)); // {50,52} → 防御逐出 block 3
      await delay(10);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("all other blocks are protected"),
      );
      (console.warn as jest.Mock).mockClear();

      // 被逐出的块使完成判定失败 → 替代连接 early-EOF → route 退化清除。
      streams[1]!.end?.();
      await delay(10);
      expect(streams[1]!.destroy).toHaveBeenCalledTimes(1);

      // 空洞 {30,40}MiB 由 idle read-ahead 启动修复(该区间唯一一次)。
      expect(fetch.mock.calls[2]).toEqual([30 * MEBIBYTE, 10 * MEBIBYTE]);

      // 喂 data 到修复 route 完成:断言其完成并销毁,证明收敛而非永久挂起。
      streams[2]!.data?.(new Uint8Array(10 * MEBIBYTE)); // {30,40}
      await delay(10);
      expect(streams[2]!.destroy).toHaveBeenCalledTimes(1);

      // [30,40)MiB 在该有界场景中只修复一次(后续 read-ahead 不再重复该区间;
      // 不依赖可能继续产生的后续 fetch 总数)。
      const repairFetches = fetch.mock.calls.filter(
        ([offset, length]) => offset === 30 * MEBIBYTE && length === 10 * MEBIBYTE,
      );
      expect(repairFetches).toHaveLength(1);

      const result = await readPromise;
      expect(result.byteLength).toBe(24 * MEBIBYTE);
      cachedFileReader.close();
    });
  });

  describe("parallelConnections and maxSegmentBytes normalization", () => {
    it("does not slice with K = 1 and no explicit maxSegmentBytes (legacy read-ahead semantics)", async () => {
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      // 60MiB 缓存足以容纳整段 50MiB read-ahead,不触发驱逐。构造方式与 BagIterableSource
      // 相同:不传 parallelConnections / maxSegmentBytes。
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 60 * MEBIBYTE,
        log,
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      await delay(10);

      // Bag 语义回归:fetch 序列与旧行为逐项一致——整段 50MiB read-ahead,之后仅按
      // lastResolvedCallbackEnd 继续 50MiB 窗口的缺失尾部,绝不被拆成 4MiB 段。
      expect(fetch.mock.calls).toEqual([
        [0, 50 * MEBIBYTE],
        [50 * MEBIBYTE, 1024],
      ]);
      cachedFileReader.close();
    });

    it("defaults to 4MiB segments with K > 1 and no explicit maxSegmentBytes", async () => {
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        log,
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      await delay(10);

      expect(fetch.mock.calls[0]).toEqual([0, 4 * MEBIBYTE]);
      cachedFileReader.close();
    });

    it("does not slice and warns for a fractional maxSegmentBytes when K = 1", async () => {
      // 0.5 → floor 后为 0 → 非法:回落不切片(旧行为)+ warn,绝不产生零长段。
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const warn = jest.fn();
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 60 * MEBIBYTE,
        maxSegmentBytes: 0.5,
        log: { ...log, warn },
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      await delay(10);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid maxSegmentBytes 0.5"));
      expect(fetch.mock.calls[0]).toEqual([0, 50 * MEBIBYTE]);
      cachedFileReader.close();
    });

    it("falls back to 4MiB segments with a warning for an invalid maxSegmentBytes when K > 1", async () => {
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const warn = jest.fn();
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        maxSegmentBytes: -5,
        log: { ...log, warn },
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      await delay(10);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid maxSegmentBytes -5"));
      expect(fetch.mock.calls[0]).toEqual([0, 4 * MEBIBYTE]);
      cachedFileReader.close();
    });

    it("falls back to 4MiB segments and warns for a fractional maxSegmentBytes when K > 1", async () => {
      // 0.5 → floor 后为 0 → 非法:回落 4MiB + warn,绝不产生零长段。
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const warn = jest.fn();
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        maxSegmentBytes: 0.5,
        log: { ...log, warn },
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      await delay(10);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid maxSegmentBytes 0.5"));
      expect(fetch.mock.calls[0]).toEqual([0, 4 * MEBIBYTE]);
      cachedFileReader.close();
    });

    it("uses an explicit maxSegmentBytes with K > 1, clamped to the cache block size", async () => {
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 100 * MEBIBYTE,
        parallelConnections: 2,
        maxSegmentBytes: 8 * MEBIBYTE,
        log,
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      await delay(10);
      expect(fetch.mock.calls[0]).toEqual([0, 8 * MEBIBYTE]);
      cachedFileReader.close();
    });

    it("falls back to 1 with a warning for an invalid parallelConnections", async () => {
      const fetch = makeDeliveringFetch();
      const fileReader: FileReader = {
        open: async () => ({ size: 100 * MEBIBYTE }),
        fetch,
      };
      const warn = jest.fn();
      const cachedFileReader = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: 60 * MEBIBYTE,
        parallelConnections: 0,
        log: { ...log, warn },
      });

      await expect(cachedFileReader.read(0, 1024)).resolves.toEqual(new Uint8Array(1024));
      await delay(10);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid parallelConnections 0"));
      // 回落 1 后不切片:仍是整段 50MiB read-ahead。
      expect(fetch.mock.calls[0]).toEqual([0, 50 * MEBIBYTE]);
      cachedFileReader.close();
    });
  });
});
