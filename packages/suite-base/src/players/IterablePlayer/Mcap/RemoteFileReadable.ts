// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { McapTypes } from "@mcap/core";

import BrowserHttpReader from "@lichtblick/suite-base/util/BrowserHttpReader";
import CachedFilelike from "@lichtblick/suite-base/util/CachedFilelike";

import { BatchingReadable } from "./BatchingReadable";
import type { RemoteFileReadableOptions } from "./RemoteFileReadable.types";

const DEFAULT_CACHE_SIZE_BYTES = 1024 * 1024 * 500; // 500MiB

// MCAP remote default: 4 parallel download connections (TOS single connection ~1.5MiB/s vs ~4MiB/s
// with 4 concurrent connections). Kept at the RemoteFileReadable layer so other consumers of
// CachedFilelike (e.g. BagIterableSource) keep CachedFilelike's own default of 1.
const DEFAULT_PARALLEL_CONNECTIONS = 4;

export class RemoteFileReadable {
  readonly #remoteReader: CachedFilelike;
  readonly #batchingReadable: BatchingReadable;

  public constructor(url: string, options?: RemoteFileReadableOptions) {
    const fileReader = new BrowserHttpReader(url);
    this.#remoteReader = new CachedFilelike({
      fileReader,
      cacheSizeInBytes: options?.cacheSizeInBytes ?? DEFAULT_CACHE_SIZE_BYTES,
      readAheadEnabled: options?.readAheadEnabled,
      readAheadBufferBytes: options?.readAheadBufferBytes,
      // MCAP single-file default: 4 parallel connections. CachedFilelike slices segments at its
      // own safe 4MiB default whenever K > 1 and no explicit maxSegmentBytes is given (see ST8),
      // so no segment size needs to be threaded through here.
      parallelConnections: options?.parallelConnections ?? DEFAULT_PARALLEL_CONNECTIONS,
    });

    const inner: McapTypes.IReadable = {
      size: async () => BigInt(this.#remoteReader.size()),
      read: async (offset, size) => {
        if (offset + size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`Read too large: offset ${offset}, size ${size}`);
        }
        return await this.#remoteReader.read(Number(offset), Number(size));
      },
    };
    this.#batchingReadable = new BatchingReadable(inner);
  }

  public async open(): Promise<void> {
    await this.#remoteReader.open(); // Important that we call this first, because it might throw an error if the file can't be read.
  }

  public async size(): Promise<bigint> {
    return BigInt(this.#remoteReader.size());
  }
  public async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    return await this.#batchingReadable.read(offset, size);
  }

  public close(): void {
    this.#remoteReader.close();
  }
}
