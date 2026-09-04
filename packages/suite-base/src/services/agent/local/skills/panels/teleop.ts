// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from TeleopConfig in panels/Teleop/types.ts, the per-button defaults in
 * panels/Teleop/TeleopPanel.tsx (publishRate 1, up/down linear-x ±1, left/right angular-z ±1),
 * the field options in panels/Teleop/constants.ts, and the publish capability gate in
 * TeleopPanel.tsx ("Connect to a data source that supports publishing"). Keep them in sync.
 */
export const PANEL_TELEOP_SKILL: Skill = {
  id: "panel-teleop",
  name: "Teleop panel: directional-pad command publishing",
  whenToUse: "Before proposing a layout that uses the Teleop panel — publish topic and buttons.",
  indexed: false,
  body: `# The \`Teleop\` panel

No data subscription of its own: it is a directional pad that repeatedly publishes a
\`geometry_msgs/Twist\` message on a configured topic while a button is held. The panel advertises
the topic itself.

**Live sources only.** Publishing requires a live, writable connection
(\`context.publish\`/\`advertise\`). On a recording or any read-only source the panel shows
"Connect to a data source that supports publishing" and sends nothing — a playback recording
cannot be published into. Do not propose \`Teleop\` for replay analysis.

\`\`\`json
{
  "lichtblickPanelTitle": "Drive",
  "topic": "/example/cmd_vel",
  "publishRate": 10,
  "upButton": { "field": "linear-x", "value": 1 },
  "downButton": { "field": "linear-x", "value": -1 },
  "leftButton": { "field": "angular-z", "value": 1 },
  "rightButton": { "field": "angular-z", "value": -1 }
}
\`\`\`

\`/example/cmd_vel\` is a placeholder — copy the real command topic byte-for-byte from the
catalog or the workspace summary. \`propose_layout\` does not check \`topic\` against the
catalog — it may be a new topic the panel advertises; still write the command topic the robot
actually subscribes to.

## Config reference

- \`topic\` (optional): the topic to publish on. Empty means no topic — the panel shows "Select a
  publish topic in the panel settings" until one is chosen. Pick the topic the robot actually
  subscribes to for velocity commands.
- \`publishRate\` (default \`1\`): messages per second while a button is held. \`0\` or negative
  disables publishing (treated as a config error).
- \`upButton\` / \`downButton\` / \`leftButton\` / \`rightButton\` (all optional): each is
  \`{ field, value }\`. \`field\` is one of \`linear-x\`, \`linear-y\`, \`linear-z\`,
  \`angular-x\`, \`angular-y\`, \`angular-z\` (nothing else). Defaults: up \`linear-x\` \`+1\`,
  down \`linear-x\` \`-1\`, left \`angular-z\` \`+1\`, right \`angular-z\` \`-1\`.

A bare \`{}\` config is valid and uses the defaults above (with no topic until the user picks
one in the settings).

## Traps

- \`field\` values are the six dash-separated names exactly; \`linear.x\` or \`x\` do nothing.
- \`value\` is the Twist component sent every cycle; pick magnitudes the robot's firmware
  accepts — the panel does not clamp them.
- The \`topic\` is where commands are published; do not confuse it with a topic the panel
  subscribes to (it subscribes to none).

Not supported (ignored if written): \`layout\`, \`buttonText\`, or other keys from unrelated
panels. For one-shot arbitrary JSON publishing use \`Publish\` (panel-publish); for ROS service
calls use \`CallService\` (panel-call-service).`,
};
