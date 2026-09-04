// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from PlotConfig / PlotPath in panels/Plot/utils/config.ts, TimestampMethod in
 * util/time.ts, and the modifier list in panels/Plot/utils/mathFunctions.ts. Keep them in sync.
 */
export const PANEL_PLOT_SKILL: Skill = {
  id: "panel-plot",
  name: "Plot panel: time-series configuration",
  whenToUse: "Before proposing a layout that uses the Plot panel — path rules and axis config.",
  indexed: false,
  body: `# The \`Plot\` panel

MessagePath-based panel: configured with message-path strings such as
\`/imu/data.linear_acceleration.x\` (message-path skill). The path must resolve to a value of the
type the panel wants.

Time-series lines from numeric message paths.

Value types: \`bool\`, \`int8\`–\`int64\`, \`uint8\`–\`uint64\`, \`float32\`, \`float64\`, \`string\`,
\`time\`, \`duration\`. Fields that terminate in a message or an unsliced array are not plottable.

**Every path must be self-contained.** The \`paths\` array replaces the default wholesale; it is not
merged per-field. A path missing \`enabled\` is falsy and draws nothing.

\`\`\`json
{
  "lichtblickPanelTitle": "IMU acceleration",
  "paths": [
    { "value": "/imu/data.linear_acceleration.x", "enabled": true, "timestampMethod": "receiveTime", "label": "ax" }
  ],
  "minYValue": -20,
  "maxYValue": 20,
  "yAxisLabel": "m/s²"
}
\`\`\`

## Config reference

Per path: \`value\`, \`enabled\` (must be \`true\`), \`timestampMethod\` (\`"receiveTime"\` or
\`"headerStamp"\`; nothing else), \`label\`, \`color\` (CSS color), \`showLine\` (\`false\` for
points only), \`lineSize\`.

Panel-level: \`xAxisVal\` (\`"timestamp"\` default; \`"index"\` plots the latest message's array by
index; \`"custom"\` and \`"currentCustom"\` plot y against \`xAxisPath\` \`{ value, enabled }\`),
\`minXValue\` / \`maxXValue\`, \`minYValue\` / \`maxYValue\` (numbers or numeric strings),
\`xAxisLabel\` / \`yAxisLabel\`, \`showXAxisLabels\` / \`showYAxisLabels\`, \`showLegend\`,
\`legendDisplay\` (\`"floating"\`, \`"top"\`, \`"left"\`, \`"none"\`), \`showPlotValuesInLegend\`,
\`sidebarDimension\` (legend size in px), \`followingViewWidth\` (seconds kept in view while
playing), \`isSynced\` (share pan and zoom with other synced panels).

Not supported (ignored if written): \`secondaryAxes\` / \`yAxisId\`, \`timeWindowMode\`,
\`lineStyle\`, \`publishTime\` or \`customField\` timestamp methods, \`dynamicLabelField\`,
\`xAxisDisplayMethod\`.

## Math modifiers

A path may end in one modifier: \`.@abs\`, \`.@negative\`, \`.@rad2deg\`, \`.@deg2rad\`,
\`.@round\`, \`.@ceil\`, \`.@trunc\`, \`.@sign\`, \`.@sqrt\`, \`.@sin\`, \`.@cos\`, \`.@tan\`,
\`.@asin\`, \`.@acos\`, \`.@atan\`, \`.@log\`, \`.@log1p\`, \`.@log2\`, \`.@log10\`. Anything else
(scaling, derivatives, vector norm, quaternion to Euler) needs a user script. Only \`Plot\`
honors modifiers.

**Trap:** a \`value\` that parses as a number is treated as a horizontal reference line, not a
series. Use a real message path.

**Multiple curves:** prefer one Plot panel with all series in its \`paths\` array (one entry per
curve). Split into several Plot panels only when the series have conflicting units, value ranges,
or axis semantics that cannot share one panel. Every curve in one panel must have a pairwise
**different** \`color\` — assign an explicit \`color\` to each path; a set of curves that all
default to the same color is unreadable.

**Array slices:** \`[:]\` produces **one legend entry** for the whole array, not one per element.
When the user wants one line per element (one curve per joint, per core, …), expand the slice
into \`[0]\`, \`[1]\`, … \`[N-1]\` paths, each with its own \`label\` (e.g. \`joint 0\`) and its
own \`color\`; take N from one real message (\`read_messages\`).

**No arithmetic:** paths do no arithmetic and no function calls — \`100 - …idle\` is not
evaluated. To show CPU usage, plot the raw \`.user\` and \`.system\` fields as separate curves;
any computation beyond the \`.@\` modifiers is a user script.

**Trap:** a path that resolves to a \`string\` draws a line only when the string values are
plottable as discrete labels; for enums and modes prefer \`StateTransitions\` (see
panel-state-transitions).`,
};
