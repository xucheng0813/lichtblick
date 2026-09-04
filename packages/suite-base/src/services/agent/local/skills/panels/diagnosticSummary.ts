// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from DiagnosticSummaryConfig in panels/DiagnosticSummary/types.ts and
 * DEFAULT_CONFIG / LEVELS / ALLOWED_DATATYPES / DEFAULT_SECONDS_UNTIL_STALE in
 * panels/DiagnosticSummary/constants.ts. Keep them in sync.
 */
export const PANEL_DIAGNOSTIC_SUMMARY_SKILL: Skill = {
  id: "panel-diagnostic-summary",
  name: "DiagnosticSummary panel: robot diagnostics overview",
  whenToUse: "Before proposing a layout that uses the DiagnosticSummary panel — DiagnosticArray topics and filtering.",
  indexed: false,
  body: `# The \`DiagnosticSummary\` panel

Topic-based panel: configured with a topic name, not a message path. It lists every diagnostic
status entry of a robot diagnostics topic as one row, color-coded by level, with pinning and
click-through to a detail panel.

**Accepted schemas** (exactly these three names):
\`diagnostic_msgs/DiagnosticArray\`, \`diagnostic_msgs/msg/DiagnosticArray\`,
\`ros.diagnostic_msgs.DiagnosticArray\`.

\`\`\`json
{
  "lichtblickPanelTitle": "Diagnostics",
  "topicToRender": "/example/diagnostics",
  "minLevel": 0,
  "pinnedIds": [],
  "hardwareIdFilter": "",
  "sortByLevel": true,
  "secondsUntilStale": 5
}
\`\`\`

\`/example/diagnostics\` is a placeholder — copy the real topic name byte-for-byte from the
catalog or the workspace summary.

## Config reference

- \`topicToRender\` (required, default \`"/diagnostics"\`): the DiagnosticArray topic.
- \`minLevel\` (default \`0\`): only entries with level \`>=\` this value are shown. Levels:
  OK=0, WARN=1, ERROR=2, STALE=3. \`0\` shows everything, \`1\` hides the OK noise,
  \`2\` shows only errors and stale entries.
- \`pinnedIds\` (default \`[]\`): entry ids (strings) pinned to the top of the list.
- \`hardwareIdFilter\` (default \`""\`): substring filter on the hardware id.
- \`sortByLevel\` (optional, default \`true\`): sort by severity instead of arrival order.
- \`secondsUntilStale\` (optional, default \`5\`): entries with no fresh message for this many
  seconds are marked stale (STALE=3).

## Traps

- The topic's schema must be one of the three names above — a topic that merely converts to
  DiagnosticArray does not qualify.
- \`minLevel\` is a number, not the level-name strings; write \`1\` for warn and above.
- \`pinnedIds\` entries that match nothing are harmless but pin nothing; they come from the
  \`hardware_id\`/name pair shown in the panel, so do not guess them when writing a fresh layout.

Not supported (ignored if written): keys such as \`collapsedSections\`, \`maxStringLength\`, or
per-row styling from other tools. For the detail view of a single diagnostic, pair this panel
with \`DiagnosticStatusPanel\` (panel-diagnostic-status) — clicking a row opens it.`,
};
