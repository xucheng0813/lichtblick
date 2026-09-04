// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  registerTrustedProposal,
  takeTrustedProposal,
} from "./proposalTrust";

describe("proposalTrust", () => {
  it("returns registered trust info for the exact proposal object identity", () => {
    const proposal = { name: "n", data: { layout: "Plot!p" } };
    const info = {
      installedPanelTypes: new Set(["Acme.Panel"]),
      catalogChecked: true as const,
    };
    registerTrustedProposal(proposal, info);

    expect(takeTrustedProposal(proposal)).toBe(info);
  });

  it("does not match structurally equal but distinct objects", () => {
    const original = { name: "n", data: { layout: "Plot!p" } };
    registerTrustedProposal(original, {
      installedPanelTypes: new Set(["Acme.Panel"]),
      catalogChecked: true,
    });
    const clone = { ...original, data: { ...original.data } };

    expect(takeTrustedProposal(clone)).toBeUndefined();
    // The original entry was not consumed by the failed lookup.
    expect(takeTrustedProposal(original)).toBeDefined();
  });

  it("consumes the entry on take, so a proposal can be trusted at most once", () => {
    const proposal = { name: "n" };
    registerTrustedProposal(proposal, {
      installedPanelTypes: new Set<string>(),
      catalogChecked: true,
    });

    expect(takeTrustedProposal(proposal)).toBeDefined();
    expect(takeTrustedProposal(proposal)).toBeUndefined();
  });
});
