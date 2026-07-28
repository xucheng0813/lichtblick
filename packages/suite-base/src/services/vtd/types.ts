// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export type VtdRecord = {
  id: string;
  botName?: string;
  botSn?: string;
  triggerType?: string;
  dataType?: string;
  triggerTime?: string;
  sizeBytes?: number;
  raw: unknown;
};

export type VtdSearchParams = {
  botSn?: string;
  botName?: string;
  triggerType?: string;
  start?: string;
  end?: string;
  at?: string;
  page?: number;
  pageSize?: number;
};

export type VtdSliceParams = {
  id: string;
  topics?: string[];
  startNs?: string;
  endNs?: string;
};

export interface IVtdClient {
  search(
    params: VtdSearchParams,
    signal?: AbortSignal,
  ): Promise<{ records: VtdRecord[]; total?: number }>;
  detail(id: string, signal?: AbortSignal): Promise<unknown>;
  topics(id: string, signal?: AbortSignal): Promise<Record<string, number>>;
  sliceStore(
    params: VtdSliceParams,
    signal?: AbortSignal,
  ): Promise<{ mcapSliceId: string; raw: unknown }>;
  sliceGet(
    sliceId: string,
    signal?: AbortSignal,
  ): Promise<{ downloadUrl: string; raw: unknown }>;
  url(id: string, signal?: AbortSignal): Promise<{ downloadUrl: string }>;
}
