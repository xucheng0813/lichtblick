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
import * as _ from "lodash-es";

import Logger from "@lichtblick/log";
import { Filelike } from "@lichtblick/rosbag";

import type { FileReader, FileStream, ILogger } from "./CachedFilelike.types";
import VirtualLRUBuffer from "./VirtualLRUBuffer";
import { getNewConnection } from "./getNewConnection";
import { isRangeCoveredByRanges, missingRanges, Range } from "./ranges";

// CachedFilelike is a streamed Filelike backed by a VirtualLRUBuffer.
// It serves requested byte ranges from an in-memory LRU cache, keeps a pool of at most K underlying
// fetches active, and optionally uses bounded read-ahead/reconnect behavior for remote readers.

const LOGGING_INTERVAL_IN_BYTES = 1024 * 1024 * 300; // Log every 300MiB to avoid cluttering the logs too much.
const CACHE_BLOCK_SIZE = 1024 * 1024 * 10; // 10MiB blocks.
// Don't start a new connection if we're 5MiB away from downloading the requested byte.
const CLOSE_ENOUGH_BYTES_TO_NOT_START_NEW_CONNECTION = 1024 * 1024 * 5;
// Upper bound for the normalized parallelConnections option.
const MAX_PARALLEL_CONNECTIONS = 8;
// Safe default segment size when K > 1 without an explicit maxSegmentBytes. A 4MiB segment spans at
// most two 10MiB cache blocks, which keeps the admission-control accounting well defined.
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;

const log = Logger.getLogger(__filename);

type RouteId = number;

// A route is a logical download unit identified by a stable routeId. A route may be served by a
// sequence of connections (the original connection plus replacement connections after failures);
// the routeId survives across replacements so retries never race with new tasks.
type RouteRecord = {
  routeId: RouteId;
  // The full original segment this route is responsible for, including the already-downloaded
  // prefix. Completion is determined by `hasData(originalRange)` and in-flight routes protect it.
  originalRange: Range;
  // The not-yet-downloaded part, advanced as data arrives. Used by the retry queue.
  remainingRange: Range;
  lastErrorTime?: number;
  reconnectingReported: boolean;
};

// An active connection entry in the connection pool.
type ConnectionEntry = {
  routeId: RouteId;
  stream: FileStream;
  // The full original segment of the route (including the already-downloaded prefix for retries).
  originalRange: Range;
  // The remaining part this connection is still expected to deliver, advanced as data arrives.
  remainingRange: Range;
  bytesRead: number;
  startTime: number;
  lastReportedBytesRead: number;
};

export default class CachedFilelike implements Filelike {
  #fileReader: FileReader;
  #cacheSizeInBytes: number = Infinity;
  readonly #readAheadEnabled: boolean = true;
  readonly #readAheadBufferBytes: number | undefined;
  #fileSize?: number;
  #virtualBuffer: VirtualLRUBuffer;
  #log: ILogger;
  #closed: boolean = false;
  // In-flight uncached reads, tracked so close() can destroy streams and reject promises.
  readonly #activeUncachedReads = new Set<{ cancel: (err: Error) => void }>();
  // eslint-disable-next-line @lichtblick/no-boolean-parameters
  #keepReconnectingCallback?: (reconnecting: boolean) => void;
  // The last boolean value reported to #keepReconnectingCallback, to only call on transitions.
  #lastReportedReconnecting: boolean = false;

  // Normalized parallelism: finite positive input floored, capped at MAX_PARALLEL_CONNECTIONS;
  // anything else falls back to 1 (with a warning for non-finite/zero/negative input).
  #parallelConnections: number;
  // The raw (unnormalized) maxSegmentBytes option, normalized in open() once the effective K is known.
  readonly #rawMaxSegmentBytes: number | undefined;
  // Effective parallelism: clamp(1, floor(numberOfBlocks / 2), #parallelConnections), set in open().
  #effectiveParallelConnections: number = 1;
  // Normalized segment cap: undefined means "no slicing" (K = 1 without an explicit cap);
  // with K > 1 it is always a valid positive value (defaulting to DEFAULT_SEGMENT_BYTES).
  #maxSegmentBytes: number | undefined;
  #numberOfBlocks: number = Infinity;
  #blockSize: number = CACHE_BLOCK_SIZE;

  // The pool of active connections, keyed by routeId.
  #connections = new Map<RouteId, ConnectionEntry>();
  // Route records for every route (active or awaiting retry), keyed by routeId.
  #routes = new Map<RouteId, RouteRecord>();
  // FIFO of routes whose connection failed and need a replacement connection.
  #retryQueue: RouteRecord[] = [];
  #nextRouteId: RouteId = 0;

  // A list of read requests and associated ranges for all read requests, in order.
  #readRequests: {
    range: Range;
    resolve: (_: Uint8Array) => void;
    reject: (_: Error) => void;
    requestTime: number;
  }[] = [];

  // The range.end of the last read request that we resolved. Useful for reading ahead a bit.
  #lastResolvedCallbackEnd?: number;

  public constructor(options: {
    fileReader: FileReader;
    cacheSizeInBytes?: number;
    readAheadEnabled?: boolean;
    readAheadBufferBytes?: number;
    parallelConnections?: number;
    maxSegmentBytes?: number;
    log?: ILogger;
    // eslint-disable-next-line @lichtblick/no-boolean-parameters
    keepReconnectingCallback?: (reconnecting: boolean) => void;
  }) {
    this.#fileReader = options.fileReader;
    this.#cacheSizeInBytes = options.cacheSizeInBytes ?? this.#cacheSizeInBytes;
    this.#readAheadEnabled = options.readAheadEnabled ?? this.#readAheadEnabled;
    this.#readAheadBufferBytes = options.readAheadBufferBytes;
    this.#keepReconnectingCallback = options.keepReconnectingCallback;
    this.#rawMaxSegmentBytes = options.maxSegmentBytes;
    this.#log = options.log ?? log;
    this.#virtualBuffer = new VirtualLRUBuffer({ size: 0 });

    const rawParallelConnections = options.parallelConnections;
    if (rawParallelConnections == undefined) {
      this.#parallelConnections = 1;
    } else if (!Number.isFinite(rawParallelConnections) || rawParallelConnections < 1) {
      this.#log.warn(
        `Invalid parallelConnections ${rawParallelConnections}; falling back to 1`,
      );
      this.#parallelConnections = 1;
    } else {
      this.#parallelConnections = Math.min(MAX_PARALLEL_CONNECTIONS, Math.floor(rawParallelConnections));
    }
  }

  public async open(): Promise<void> {
    if (this.#fileSize != undefined) {
      return;
    }
    const { size } = await this.#fileReader.open();
    this.#fileSize = size;
    if (this.#cacheSizeInBytes >= size) {
      // If we have a cache limit that exceeds the file size, then we don't need to limit ourselves
      // to small blocks. This way `VirtualLRUBuffer#slice` will be faster since we'll almost always
      // not need to copy from multiple blocks into a new `Buffer` instance.
      this.#virtualBuffer = new VirtualLRUBuffer({ size });
      this.#numberOfBlocks = Infinity;
      this.#blockSize = CACHE_BLOCK_SIZE;
    } else {
      const numberOfBlocks = Math.ceil(this.#cacheSizeInBytes / CACHE_BLOCK_SIZE) + 2;
      this.#virtualBuffer = new VirtualLRUBuffer({
        size,
        blockSize: CACHE_BLOCK_SIZE,
        // Rather create too many blocks than too few (Math.ceil), and always add one block,
        // to allow for a read range not starting or ending perfectly at a block boundary.
        numberOfBlocks,
      });
      this.#numberOfBlocks = numberOfBlocks;
      this.#blockSize = CACHE_BLOCK_SIZE;
    }

    // Effective K: clamp(1, floor(numberOfBlocks / 2), normalized parallelConnections). The
    // number-of-blocks cap keeps small caches single-connection, so their precise legacy behavior
    // (and fetch sequences) is preserved.
    this.#effectiveParallelConnections = Math.max(
      1,
      Math.min(this.#parallelConnections, Math.floor(this.#numberOfBlocks / 2)),
    );

    // Normalize the segment cap. Validation is based on the FLOORED value: a positive fraction
    // like 0.5 floors to 0 and must be treated as invalid instead of producing zero-length
    // segments. K = 1 without a valid explicit cap means no slicing (legacy behavior, with a
    // warning for an invalid explicit cap); with K > 1 a valid positive cap is always used,
    // defaulting to DEFAULT_SEGMENT_BYTES.
    const explicitSegmentBytes = this.#rawMaxSegmentBytes;
    let normalizedSegmentBytes: number | undefined;
    if (explicitSegmentBytes != undefined && Number.isFinite(explicitSegmentBytes)) {
      const floored = Math.floor(explicitSegmentBytes);
      if (floored > 0) {
        normalizedSegmentBytes = Math.min(CACHE_BLOCK_SIZE, floored);
      }
    }
    if (this.#effectiveParallelConnections > 1) {
      if (normalizedSegmentBytes != undefined) {
        this.#maxSegmentBytes = normalizedSegmentBytes;
      } else {
        if (explicitSegmentBytes != undefined) {
          this.#log.warn(`Invalid maxSegmentBytes ${explicitSegmentBytes}; using default 4MiB`);
        }
        this.#maxSegmentBytes = DEFAULT_SEGMENT_BYTES;
      }
    } else if (normalizedSegmentBytes != undefined) {
      this.#maxSegmentBytes = normalizedSegmentBytes;
    } else {
      if (explicitSegmentBytes != undefined) {
        this.#log.warn(`Invalid maxSegmentBytes ${explicitSegmentBytes}; not slicing`);
      }
      this.#maxSegmentBytes = undefined;
    }

    this.#log.info(`Opening file with size ${bytesToMiB(this.#fileSize)}MiB`);
  }

  // Get the file size. Requires a call to `open()` or `read()` first.
  public size(): number {
    if (this.#fileSize == undefined) {
      throw new Error("CachedFilelike has not been opened");
    }
    return this.#fileSize;
  }

  // Potentially performance-sensitive; await can be expensive
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  public read(offset: number, length: number): Promise<Uint8Array> {
    if (this.#closed) {
      return Promise.reject(new Error("CachedFilelike is closed"));
    }
    if (length === 0) {
      return Promise.resolve(new Uint8Array());
    }

    const range = { start: offset, end: offset + length };

    if (offset < 0 || length < 0) {
      throw new Error("CachedFilelike#read invalid input");
    }
    if (length > this.#cacheSizeInBytes) {
      // A single read larger than the LRU cache budget (e.g. an MCAP summary/index section that
      // exceeds a small per-source cache slice in a many-file remote session) cannot be served
      // through the VirtualLRUBuffer. Rather than failing, fetch the exact range directly without
      // caching. Memory stays transient and the cache budget is unchanged.
      return this.#readUncached(range);
    }

    // Potentially performance-sensitive; await can be expensive
    return new Promise((resolve, reject) => {
      this.open()
        .then(() => {
          const size = this.size();
          if (range.end > size) {
            reject(new Error(`CachedFilelike#read past size`));
            return;
          }

          this.#readRequests.push({ range, resolve, reject, requestTime: Date.now() });
          this.#updateState();
        })
        .catch((err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  // Terminal close: abort downloads, reject pending reads, and release cache blocks promptly.
  public close(): void {
    this.#closeWithError(new Error("CachedFilelike is closed"));
  }

  // Shared terminal-close path for close() and fatal connection errors. Iterating
  // #activeUncachedReads is safe because cancel() is synchronous and only removes the current Set
  // entry. All state is cleared first, then every stream is destroyed (a late "end" from a
  // destroyed stream then finds no matching entry and is ignored).
  #closeWithError(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const streams = [...this.#connections.values()].map((entry) => entry.stream);
    this.#connections.clear();
    this.#routes.clear();
    this.#retryQueue = [];
    this.#lastReportedReconnecting = false;
    for (const stream of streams) {
      stream.destroy();
    }
    for (const request of this.#readRequests) {
      request.reject(error);
    }
    this.#readRequests = [];
    for (const active of this.#activeUncachedReads) {
      active.cancel(error);
    }
    this.#virtualBuffer = new VirtualLRUBuffer({ size: 0 });
  }

  // Reads a byte range directly from the underlying file reader without caching. Used for single
  // reads larger than the LRU cache budget, which cannot be represented in the VirtualLRUBuffer.
  async #readUncached(range: Range): Promise<Uint8Array> {
    await this.open();
    if (this.#closed) {
      throw new Error("CachedFilelike is closed");
    }
    if (range.end > this.size()) {
      throw new Error(`CachedFilelike#read past size`);
    }

    const length = range.end - range.start;
    return await new Promise<Uint8Array>((resolve, reject) => {
      const result = new Uint8Array(length);
      let bytesRead = 0;
      let settled = false;
      const stream = this.#fileReader.fetch(range.start, length);

      // Registered so close() can destroy the stream and reject this read.
      const active: { cancel: (err: Error) => void } = { cancel: () => {} };
      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.#activeUncachedReads.delete(active);
        stream.destroy();
        action();
      };
      active.cancel = (err: Error) => {
        finish(() => {
          reject(err);
        });
      };
      this.#activeUncachedReads.add(active);

      stream.on("error", (error: Error) => {
        finish(() => {
          reject(error);
        });
      });

      // A stream that ends before `length` bytes were received must reject, not hang forever.
      stream.on("end", () => {
        finish(() => {
          reject(
            new Error(
              `CachedFilelike#readUncached stream ended after ${bytesRead}/${length} bytes`,
            ),
          );
        });
      });

      stream.on("data", (chunk: Uint8Array) => {
        if (settled) {
          return;
        }
        if (bytesRead + chunk.byteLength > length) {
          finish(() => {
            reject(new Error("CachedFilelike#readUncached received more data than requested"));
          });
          return;
        }
        result.set(chunk, bytesRead);
        bytesRead += chunk.byteLength;
        if (bytesRead === length) {
          finish(() => {
            resolve(result);
          });
        }
      });
    });
  }

  // Gets called any time our connection or read requests change.
  #updateState(): void {
    if (this.#closed) {
      return;
    }

    this.#readRequests = this.#readRequests.filter(({ range, resolve }) => {
      if (!this.#virtualBuffer.hasData(range.start, range.end)) {
        return true;
      }

      this.#lastResolvedCallbackEnd = range.end;
      const buffer = this.#virtualBuffer.slice(range.start, range.end);

      resolve(buffer);
      return false;
    });

    // The pending request set changed; keep the buffer's protection in sync.
    this.#refreshProtectedRanges();

    this.#dispatch();
  }

  /**
   * Dispatch loop. Retry-queue routes are prioritized over new candidates, and each dispatched
   * segment is clamped and admission-checked. Keeps at most #effectiveParallelConnections
   * connections active.
   */
  #dispatch(): void {
    while (!this.#closed) {
      if (this.#connections.size >= this.#effectiveParallelConnections) {
        break;
      }

      const claimed = this.#claimedRanges();

      // Phase 0: pick the first pending request that is not yet covered by (downloaded ∪ in-flight
      // claimed) ranges, instead of always taking the first pending request.
      const readRequestRange = this.#readRequests.find(
        (request) => !isRangeCoveredByRanges(request.range, claimed),
      )?.range;

      let segment: Range | undefined;
      let routeId: RouteId | undefined;

      // Retries take priority over new tasks: reuse the failed route's remaining range. The route
      // is only dequeued once the segment is confirmed to start; if admission fails or the range
      // is degenerate, the route stays in the queue so a later #updateState can retry it (an early
      // dequeue would silently lose the route and leave the reconnecting state stuck).
      const pendingRetry = this.#retryQueue[0];
      if (pendingRetry != undefined) {
        const missing = missingRanges(pendingRetry.remainingRange, claimed)[0];
        if (missing == undefined || missing.end <= missing.start) {
          // The route's remaining range has been fully downloaded by other routes (or degenerated
          // to zero width): dequeue it and clear the route record and its fault state.
          this.#retryQueue.shift();
          this.#routes.delete(pendingRetry.routeId);
          this.#updateReconnectingState();
          continue;
        }
        segment = missing;
        routeId = pendingRetry.routeId;
      } else {
        const candidate = getNewConnection({
          currentRemainingRange: undefined,
          readRequestRange,
          downloadedRanges: claimed,
          lastResolvedCallbackEnd: this.#lastResolvedCallbackEnd,
          maxRequestSize: this.#cacheSizeInBytes,
          fileSize: this.size(),
          continueDownloadingThreshold: CLOSE_ENOUGH_BYTES_TO_NOT_START_NEW_CONNECTION,
          readAheadEnabled: this.#readAheadEnabled,
          readAheadBufferBytes: this.#readAheadBufferBytes,
        });
        if (candidate == undefined) {
          break;
        }
        if (candidate.end <= candidate.start) {
          // Prevent an invalid/inverted HTTP Range header (for example "bytes=100-99") and the 416
          // response it would trigger; keep this defense-in-depth even though getNewConnection guards it.
          this.#log.debug(
            `Ignoring degenerate zero-width connection range @ ${rangeToString(candidate)}`,
          );
          break;
        }
        // getNewConnection's read-ahead tail extension does not subtract `claimed` a second time
        // (it can extend into ranges already claimed by in-flight connections); subtract again here.
        const missing = missingRanges(candidate, claimed)[0];
        if (missing == undefined || missing.end <= missing.start) {
          break;
        }
        segment = missing;
      }

      const clamped = this.#clampSegment(segment);
      if (clamped.end <= clamped.start) {
        this.#log.debug(
          `Ignoring degenerate zero-width connection range @ ${rangeToString(clamped)}`,
        );
        break;
      }

      // Admission control: only start a new segment when the protected blocks plus the new
      // segment's blocks fit within numberOfBlocks - 1 (in-flight original segments are already
      // part of the protected set and are not double-counted). If admission fails, do not dispatch
      // this round — unless there are no in-flight connections at all, in which case one clamped
      // segment is started anyway (equivalent to the legacy single-connection behavior) so the
      // reader never stalls.
      if (!this.#canAdmit(clamped) && this.#connections.size > 0) {
        // Admission failed: do not dispatch this round. A peeked retry route stays in the queue
        // and will be retried by the next #updateState.
        break;
      }

      if (pendingRetry != undefined) {
        // The segment is confirmed to start: dequeue the retry route now.
        this.#retryQueue.shift();
      }
      this.#startConnection(clamped, routeId);
    }
  }

  // All ranges that are either downloaded or claimed by an in-flight connection.
  #claimedRanges(): Range[] {
    return unify(
      [
        ...this.#virtualBuffer.getRangesWithData(),
        ...[...this.#connections.values()].map((entry) => entry.remainingRange),
      ],
      [],
    );
  }

  // The protection set: all pending read request ranges plus every in-flight route's full original
  // segment (including the already-downloaded prefix, on which the hasData(originalRange)
  // completion check depends).
  #computeProtectedRanges(): Range[] {
    return unify(
      [
        ...this.#readRequests.map((request) => request.range),
        ...[...this.#connections.values()].map((entry) => entry.originalRange),
      ],
      [],
    );
  }

  #refreshProtectedRanges(): void {
    this.#virtualBuffer.setProtectedRanges(this.#computeProtectedRanges());
  }

  // Admission formula: blocks(protected set) + blocks(new segment) <= numberOfBlocks - 1.
  #canAdmit(segment: Range): boolean {
    const protectedBlocks = this.#blocksTouched(this.#computeProtectedRanges());
    const segmentBlocks = this.#blocksTouched([segment]);
    return protectedBlocks + segmentBlocks <= this.#numberOfBlocks - 1;
  }

  // Number of distinct LRU blocks touched by the given byte ranges (clipped to the file).
  #blocksTouched(ranges: readonly Range[]): number {
    const fileSize = this.#fileSize ?? 0;
    const blockIndices = new Set<number>();
    for (const range of ranges) {
      const start = Math.max(0, Math.min(range.start, fileSize));
      const end = Math.max(start, Math.min(range.end, fileSize));
      if (end <= start) {
        continue;
      }
      const firstBlock = Math.floor(start / this.#blockSize);
      const lastBlock = Math.floor((end - 1) / this.#blockSize);
      for (let blockIndex = firstBlock; blockIndex <= lastBlock; blockIndex++) {
        blockIndices.add(blockIndex);
      }
    }
    return blockIndices.size;
  }

  // Slice a segment down to the normalized segment cap. No-op when slicing is disabled.
  #clampSegment(segment: Range): Range {
    const maxSegmentBytes = this.#maxSegmentBytes;
    if (maxSegmentBytes == undefined) {
      return segment;
    }
    const length = segment.end - segment.start;
    if (length <= maxSegmentBytes) {
      return segment;
    }
    return { start: segment.start, end: segment.start + maxSegmentBytes };
  }

  // Start a connection for `range`. When `routeId` is provided (retry), the connection replaces
  // the failed connection of that route and inherits the route's full original range.
  #startConnection(range: Range, routeId?: RouteId): void {
    if (range.end <= range.start) {
      // Prevent an invalid/inverted HTTP Range header (for example "bytes=100-99") and the 416
      // response it would trigger; keep this defense-in-depth even though the dispatch loop guards it.
      this.#log.debug(`Ignoring degenerate zero-width connection range @ ${rangeToString(range)}`);
      return;
    }

    const id = routeId ?? ++this.#nextRouteId;
    let route = this.#routes.get(id);
    if (route == undefined) {
      route = {
        routeId: id,
        originalRange: range,
        remainingRange: range,
        lastErrorTime: undefined,
        reconnectingReported: false,
      };
      this.#routes.set(id, route);
    }

    const stream = this.#fileReader.fetch(range.start, range.end - range.start);
    const entry: ConnectionEntry = {
      routeId: id,
      stream,
      // A replacement connection covers the route's full original segment (including the
      // already-downloaded prefix) for protection and completion checks.
      originalRange: route.originalRange,
      remainingRange: range,
      bytesRead: 0,
      startTime: Date.now(),
      lastReportedBytesRead: 0,
    };

    // Atomic update point: write the Map entries and refresh the protected ranges BEFORE
    // registering the stream listeners — a FileStream may invoke callbacks synchronously on
    // registration, so the first copyFrom must already run under the new protection set.
    this.#connections.set(id, entry);
    this.#refreshProtectedRanges();

    stream.on("error", (error: Error) => {
      this.#handleConnectionInterrupted(entry, error, "threw error");
    });
    stream.on("data", (chunk: Uint8Array) => {
      this.#handleConnectionData(entry, chunk);
    });
    stream.on("end", () => {
      this.#handleConnectionEnd(entry);
    });
  }

  #handleConnectionData(entry: ConnectionEntry, chunk: Uint8Array): void {
    const current = this.#connections.get(entry.routeId);
    if (entry.stream !== current?.stream) {
      return; // Ignore data from old streams.
    }

    const route = this.#routes.get(entry.routeId);
    if (route?.reconnectingReported === true) {
      // A replacement connection of this route received data: clear this route's fault state.
      // Healthy routes receiving data do not clear other routes' state.
      route.reconnectingReported = false;
      route.lastErrorTime = undefined;
      this.#updateReconnectingState();
    } else if (route?.lastErrorTime != undefined) {
      route.lastErrorTime = undefined;
    }

    this.#virtualBuffer.copyFrom(Buffer.from(chunk), entry.remainingRange.start);
    entry.bytesRead += chunk.byteLength;

    // Every now and then, do some logging of the current download speed.
    if (entry.bytesRead - entry.lastReportedBytesRead > LOGGING_INTERVAL_IN_BYTES) {
      entry.lastReportedBytesRead = entry.bytesRead;
      const sec = (Date.now() - entry.startTime) / 1000;

      const mibibytes = bytesToMiB(entry.bytesRead);
      const speed = _.round(mibibytes / sec, 2);
      this.#log.debug(
        `Connection @ ${rangeToString(entry.remainingRange)} downloading at ${speed} MiB/s`,
      );
    }

    if (this.#virtualBuffer.hasData(entry.originalRange.start, entry.originalRange.end)) {
      // If the requested range has been downloaded, we're done!
      this.#log.info(`Connection @ ${rangeToString(entry.remainingRange)} finished!`);
      this.#finishRoute(entry);
    } else {
      entry.remainingRange = {
        start: entry.remainingRange.start + chunk.byteLength,
        end: entry.originalRange.end,
      };
    }

    // Always call #updateState() so it can resolve requests and decide on the next connection.
    this.#updateState();
  }

  // Complete a route successfully: remove it from all tracking first, then destroy the stream so
  // a late "end" event from the destroyed stream is not mistaken for an early EOF and retried.
  #finishRoute(entry: ConnectionEntry): void {
    this.#connections.delete(entry.routeId);
    this.#routes.delete(entry.routeId);
    this.#retryQueue = this.#retryQueue.filter((route) => route.routeId !== entry.routeId);
    entry.stream.destroy();
    this.#updateReconnectingState();
    this.#refreshProtectedRanges();
  }

  #handleConnectionEnd(entry: ConnectionEntry): void {
    const current = this.#connections.get(entry.routeId);
    if (entry.stream !== current?.stream) {
      return; // Late end from an already-finished/destroyed stream: ignore, do not retry.
    }

    if (this.#virtualBuffer.hasData(entry.originalRange.start, entry.originalRange.end)) {
      this.#log.info(`Connection @ ${rangeToString(entry.remainingRange)} finished!`);
      this.#finishRoute(entry);
      this.#updateState();
      return;
    }

    this.#handleConnectionInterrupted(
      entry,
      new Error(`Connection ended before download completed @ ${rangeToString(entry.originalRange)}`),
      "ended early",
    );
  }

  #handleConnectionInterrupted(entry: ConnectionEntry, error: Error, reason: string): void {
    const current = this.#connections.get(entry.routeId);
    if (entry.stream !== current?.stream) {
      return;
    }

    const route = this.#routes.get(entry.routeId);
    const now = Date.now();

    // Fatal determination (only when no keepReconnectingCallback is set, preserving the current
    // callback precondition): if this routeId's replacement connection fails again within 100ms,
    // resolve all remaining callbacks with errors and close out. Failures of different routeIds
    // are never fatal to each other.
    if (this.#keepReconnectingCallback == undefined) {
      const lastErrorTime = route?.lastErrorTime;
      if (lastErrorTime != undefined && now - lastErrorTime < 100) {
        this.#log.error(
          `Connection @ ${rangeToString(entry.originalRange)} ${reason} again; closing: ${error.toString()}`,
        );

        this.#closeWithError(error);
        return;
      }
    }

    // Mark the connection interrupted and let #updateState() decide whether to retry.
    this.#log.info(
      `Connection @ ${rangeToString(entry.originalRange)} ${reason}; trying to continue: ${error.toString()}`,
    );
    if (route != undefined) {
      route.lastErrorTime = now;
      route.reconnectingReported = true;
      // Record the not-yet-downloaded part so the retry queue can dispatch a replacement.
      route.remainingRange = entry.remainingRange;
    }
    this.#updateReconnectingState();

    // Remove the entry first, then destroy the stream, so a late "end" event is not mistaken for
    // an early EOF and retried.
    this.#connections.delete(entry.routeId);
    entry.stream.destroy();
    this.#refreshProtectedRanges();

    // The route record enters the retry queue.
    if (route != undefined && !this.#retryQueue.includes(route)) {
      this.#retryQueue.push(route);
    }
    this.#updateState();
  }

  // Aggregate keepReconnecting callback: true while any route is reconnecting, false when all
  // routes are healthy. Only called on transitions.
  #updateReconnectingState(): void {
    const callback = this.#keepReconnectingCallback;
    if (callback == undefined) {
      return;
    }
    const anyReconnecting = [...this.#routes.values()].some(
      (route) => route.reconnectingReported,
    );
    if (this.#lastReportedReconnecting !== anyReconnecting) {
      this.#lastReportedReconnecting = anyReconnecting;
      callback(anyReconnecting);
    }
  }
}

function bytesToMiB(bytes: number) {
  return _.round(bytes / 1024 / 1024, 3);
}
function rangeToString(range: Range) {
  return `${bytesToMiB(range.start)}-${bytesToMiB(range.end)}MiB`;
}
