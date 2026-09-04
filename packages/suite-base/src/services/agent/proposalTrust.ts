// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Process-local trust side channel between the built-in local agent runtime and the Agent Chat
 * provider, keyed by proposal **object identity**.
 *
 * The local orchestrator already validated the proposal against one host snapshot (installed
 * panel types + catalog). It registers that information on the exact proposal object it emits,
 * so the provider can reuse the same snapshot for its own validation, mode computation, and
 * apply instead of taking a second one.
 *
 * This channel is writable only in-process: proposals from remote agent clients were
 * deserialized into fresh objects and can never have an entry here, and the wire event payload
 * never carries these fields.
 */
export type TrustedProposalInfo = {
  installedPanelTypes: ReadonlySet<string>;
  catalogChecked: true;
};

const trustedProposals = new WeakMap<object, TrustedProposalInfo>();

export function registerTrustedProposal(proposal: object, info: TrustedProposalInfo): void {
  trustedProposals.set(proposal, info);
}

/**
 * Returns the trust info registered for this proposal object and consumes the entry, so a
 * proposal object can be trusted at most once. Returns undefined for unregistered (remote)
 * proposals.
 */
export function takeTrustedProposal(proposal: object): TrustedProposalInfo | undefined {
  const info = trustedProposals.get(proposal);
  if (info != undefined) {
    trustedProposals.delete(proposal);
  }
  return info;
}
