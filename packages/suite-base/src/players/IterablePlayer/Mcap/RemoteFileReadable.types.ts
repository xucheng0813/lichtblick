// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export type RemoteFileReadableOptions = {
  cacheSizeInBytes?: number;
  readAheadEnabled?: boolean;
  readAheadBufferBytes?: number;
  // Number of parallel download connections used by the underlying CachedFilelike. MCAP defaults
  // to 4 here (single-file remote playback benefits ~2.7x with 4 HTTP/1.1 connections); an
  // explicit value wins, including 0/1 to disable parallel downloads. CachedFilelike normalizes
  // invalid values (CachedFilelike's own default is 1, so other consumers are unaffected).
  parallelConnections?: number;
};
