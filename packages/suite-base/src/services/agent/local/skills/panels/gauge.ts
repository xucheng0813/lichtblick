// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/** Config facts come from GaugeConfig in panels/Gauge/types.ts. Keep them in sync. */
export const PANEL_GAUGE_SKILL: Skill = {
  id: "panel-gauge",
  name: "Gauge panel: single-value dial configuration",
  whenToUse: "Before proposing a layout that uses the Gauge panel — range and color config.",
  indexed: false,
  body: `# The \`Gauge\` panel

MessagePath-based panel: one numeric value on a dial. Single path (message-path skill).

\`\`\`json
{ "lichtblickPanelTitle": "Battery level", "path": "/battery.percentage", "minValue": 0, "maxValue": 100, "colorMode": "colormap", "colorMap": "red-yellow-green" }
\`\`\`

**Always set \`minValue\` and \`maxValue\` to the signal's real range — never guess it.** They
default to 0 and 1, so any signal with a larger range pins the needle. Read actual messages
(\`read_messages\`) and take the range from the values the field really reaches, minding the unit
(battery voltage in mV is thousands, not 0–100). Enum or status fields (\`network_state\` and
similar) are not gauge material even when the user says "仪表盘": explain briefly and use
\`StateTransitions\` or \`Indicator\` instead.

## Config reference

- \`path\`: the message path; it must resolve to a single numeric field. An array or object field
  renders nothing, and \`/topic\` alone resolves to the message object.
- \`minValue\`, \`maxValue\`: numbers.
- \`colorMode\`: \`"colormap"\` (default) or \`"gradient"\`. With \`"colormap"\`, \`colorMap\` is one of
  \`"red-yellow-green"\`, \`"rainbow"\`, \`"turbo"\`. With \`"gradient"\`, \`gradient\` is exactly two
  color strings.
- \`reverse\` (boolean) mirrors the colors so the start color sits at the high end of the dial;
  the pointer position is unaffected.
- Values must be numbers or numeric strings.

Not supported (ignored if written): \`style\`, \`tickInterval\`, \`showTicks\`, \`reverseDirection\`,
\`min\` / \`max\` (the keys are \`minValue\` / \`maxValue\`).`,
};
