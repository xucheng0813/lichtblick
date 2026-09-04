// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { TFunction } from "i18next";

import { BUILTIN_PANEL_TYPES } from "./builtinPanelTypes";
import { getBuiltin } from "./index";

describe("builtinPanelTypes", () => {
  it("matches the built-in panel registry exactly and in order", () => {
    // The i18n function is stubbed to echo keys: the registry's titles/descriptions are
    // irrelevant to the type list. Jest already mocks thumbnail .png imports.
    const t = ((key: string) => key) as unknown as TFunction<"panels">;

    expect(getBuiltin(t).map((panel) => panel.type)).toEqual([...BUILTIN_PANEL_TYPES]);
  });
});
