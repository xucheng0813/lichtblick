// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * A progressively-disclosed reference document for the agent.
 *
 * Only `whenToUse` is carried in the system prompt; `body` is returned exclusively by the
 * `load_skill` tool. This keeps the base prompt small enough that a short conversation does not
 * pay for reference material it never consults.
 */
export type Skill = {
  /** Stable kebab-case identifier. This is the `load_skill` argument and the tool schema enum. */
  id: string;
  /** Human-readable title, used in the loaded document header. */
  name: string;
  /** One line describing when the agent should load this skill. Goes in the system prompt index. */
  whenToUse: string;
  /** Full document text. Only materialized into the conversation when explicitly loaded. */
  body: string;
};
