// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from DiagnosticStatusConfig in panels/DiagnosticStatus/types.ts and
 * DEFAULT_CONFIG / MIN_SPLIT_FRACTION in panels/DiagnosticStatus/constants.ts; the schema
 * allowlist is shared with DiagnosticSummary (panels/DiagnosticSummary/constants.ts). Keep them in
 * sync.
 */
export const PANEL_DIAGNOSTIC_STATUS_SKILL: Skill = {
  id: "panel-diagnostic-status",
  name: "DiagnosticStatusPanel: single diagnostic detail",
  whenToUse: "Before proposing a layout that uses the DiagnosticStatusPanel panel — drill-down config.",
  indexed: false,
  body: `# The \`DiagnosticStatusPanel\` panel

Topic-based panel: configured with a topic name, not a message path. It shows the detail of
diagnostic status entries — key/value pairs, level, message — either as a list/split view of the
whole array or pinned to one entry. DiagnosticSummary rows open this panel on click.

**Accepted schemas** (exactly these three names):
\`diagnostic_msgs/DiagnosticArray\`, \`diagnostic_msgs/msg/DiagnosticArray\`,
\`ros.diagnostic_msgs.DiagnosticArray\`.

\`\`\`json
{
  "lichtblickPanelTitle": "IMU diagnostics",
  "topicToRender": "/example/diagnostics",
  "selectedHardwareId": "imu",
  "selectedName": "imu_status",
  "splitFraction": 0.4,
  "numericPrecision": 3,
  "secondsUntilStale": 5
}
\`\`\`

\`/example/diagnostics\` is a placeholder — copy the real topic name byte-for-byte from the
catalog or the workspace summary.

## Config reference

- \`topicToRender\` (required, default \`"/diagnostics"\`): the DiagnosticArray topic.
- \`selectedHardwareId\` (optional): hardware id of the single entry to show; omitted, the panel
  lists all entries.
- \`selectedName\` (optional): entry name of the single entry to show, normally used together
  with \`selectedHardwareId\`.
- \`splitFraction\` (optional, range \`0.1\`–\`0.9\`): split-pane proportion when both the
  list and a detail pane are visible. The runtime limits it to \`MIN_SPLIT_FRACTION\` = \`0.1\`
  on the low end and \`1 - MIN_SPLIT_FRACTION\` = \`0.9\` on the high end.
- \`numericPrecision\` (optional): decimal places for numeric values in the detail view.
- \`secondsUntilStale\` (optional, default \`5\`): entries with no fresh message for this many
  seconds are marked stale.

## Traps

- \`selectedHardwareId\`/\`selectedName\` values must match entries that actually exist in the
  topic — read one message with \`read_messages\` before pinning them; guessed ids show an empty
  detail pane.
- The schema must be one of the three names above, exactly; \`convertibleTo\` does not qualify.

Not supported (ignored if written): \`collapsedSections\`, \`minLevel\`, \`pinnedIds\`, and other
DiagnosticSummary-only keys. For the overview list use \`DiagnosticSummary\`
(panel-diagnostic-summary).`,
};
