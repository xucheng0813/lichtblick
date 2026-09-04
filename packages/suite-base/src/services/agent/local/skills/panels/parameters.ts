// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * The `Parameters` panel (panels/Parameters). Facts come from panels/Parameters/index.tsx:
 * the panel reads playerState.activeData.parameters and gates on the getParameters /
 * setParameters player capabilities, showing "Connect to a ROS source to view parameters"
 * otherwise. It consumes no topics and has no config keys.
 */
export const PANEL_PARAMETERS_SKILL: Skill = {
  id: "panel-parameters",
  name: "Parameters panel: live ROS parameter table",
  whenToUse: "Before proposing a layout that uses the Parameters panel — live-source constraint.",
  indexed: false,
  body: `# The \`Parameters\` panel

**No configuration:** the config must be \`{}\` except for the optional \`lichtblickPanelTitle\`.
Any other config key is ignored or rejected, so pass nothing else.

Lists the ROS parameters of the connected data source as a name/value table, with copy buttons
and — when the source allows it — editable values that are set back on the robot.

**Live sources only.** The panel reads parameters from the live connection's parameter server.
On a recording or any source without the \`getParameters\` capability it shows "Connect to a ROS
source to view parameters" and nothing else. Do not propose \`Parameters\` for replay analysis or
for sources that only stream topics.

\`\`\`json
{ "configById": { "Parameters!params": { "lichtblickPanelTitle": "Robot parameters" } } }
\`\`\`

## Traps

- Editing is only offered when the source also has the \`setParameters\` capability; a
  read-only parameter table is still useful for inspection.
- Values arrive as JSON types (strings, numbers, booleans, arrays, objects) and are shown as
  such — the panel does no unit conversion or formatting.
- The panel consumes no topics, so nothing about the catalog affects it; pair it with
  schema-driven panels for the topics themselves.

See the panel-catalog skill for when an orientation/inspection panel fits a layout.`,
};
