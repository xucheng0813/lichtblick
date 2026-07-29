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

export const VTD_ORDER_DIRECTIONS = ["ASC", "DESC"] as const;
export type VtdOrderDirection = (typeof VTD_ORDER_DIRECTIONS)[number];

/**
 * The `vtd list` filter surface. This mirrors the sidecar command spec rather than the complete
 * CLI: options that write to disk or open a GUI are deliberately unreachable from the app.
 */
export type VtdSearchParams = {
  id?: string;
  botSn?: string;
  botSnExact?: string;
  botName?: string;
  triggerType?: string;
  dataType?: string;
  inspection?: string;
  fixData?: string;
  start?: string;
  end?: string;
  at?: string;
  triggerTime?: string;
  queryStart?: string;
  queryEnd?: string;
  queryTime?: string;
  dataDay?: string;
  dataTos?: string;
  orderBy?: string;
  orderDir?: VtdOrderDirection;
  page?: number;
  pageSize?: number;
};

export type VtdTriggerParams = {
  triggerId: string;
  all?: boolean;
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
  /**
   * Reverse-lookup of the data records and app logs attached to one triggerId. Read-only: the
   * download and GUI options of the underlying CLI command are not exposed.
   *
   * The response shape has no stable contract yet, so it is returned unnormalized.
   */
  trigger(params: VtdTriggerParams, signal?: AbortSignal): Promise<unknown>;
}
