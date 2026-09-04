// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from Config and the panel's defaultConfig in
 * panels/UserScriptEditor/Config.ts and panels/UserScriptEditor/index.tsx (panelType
 * "NodePlayground": selectedNodeId, autoFormatOnSave; the editorForStorybook /
 * additionalBackStackItems keys are storybook-only). Script bodies live in the layout's
 * userNodes, documented by the user-scripts skill. Keep them in sync.
 */
export const PANEL_USER_SCRIPT_EDITOR_SKILL: Skill = {
  id: "panel-user-script-editor",
  name: "NodePlayground panel: user script editor",
  whenToUse: "Before proposing a layout that uses the NodePlayground panel — editor, not the scripts.",
  indexed: false,
  body: `# The \`NodePlayground\` panel

The code editor for user scripts. It shows the layout's scripts in a sidebar, lets the user edit
their TypeScript source with diagnostics and logs, and saves edits back into the layout.

**The scripts themselves are not panel config.** Script bodies live in the layout's
\`userNodes\` field, each entry exactly \`{ name, sourceCode }\` (see the user-scripts skill for
the script format, input/output rules, and how panels consume a script's output topic). The
\`NodePlayground\` panel is only the editor surface over them; it adds no computation by itself.

\`\`\`json
{
  "configById": {
    "NodePlayground!editor": {
      "lichtblickPanelTitle": "Scripts",
      "selectedNodeId": "speed-converter",
      "autoFormatOnSave": true
    },
    "Plot!speed": {
      "lichtblickPanelTitle": "Speed km/h",
      "paths": [{ "value": "/studio_script/speed_kmh.speedKmh", "enabled": true }]
    }
  },
  "layout": {
    "direction": "row",
    "first": "Plot!speed",
    "second": "NodePlayground!editor",
    "splitPercentage": 60
  },
  "globalVariables": {},
  "playbackConfig": { "speed": 0.2 },
  "userNodes": {
    "speed-converter": {
      "name": "Speed km/h",
      "sourceCode": "import { Input, Message } from \\"./types\\";\\n\\ntype Odom = Message<\\"nav_msgs/Odometry\\">;\\n\\ntype Output = {\\n  speedKmh: number;\\n};\\n\\nexport const inputs = [\\"/example/odom\\"];\\n\\nexport const output = \\"/studio_script/speed_kmh\\";\\n\\nexport default function script(event: Input<\\"/example/odom\\">): Output {\\n  const odom: Odom = event.message;\\n  return { speedKmh: odom.twist.twist.linear.x * 3.6 };\\n}"
    }
  }
}
\`\`\`

\`/example/odom\` is a placeholder — copy the real input topic byte-for-byte from the catalog or
the workspace summary.

## Config reference

- \`selectedNodeId\` (optional): id of the \`userNodes\` entry the editor opens on load. This is
  a **cross-field constraint**: the value must be a key of the **same layout's** \`userNodes\`
  object — the panel config and the layout-level \`userNodes\` travel in one proposal and are
  written together. Defaults to none, in which case the panel shows a welcome screen with a
  "New script" button.
- \`autoFormatOnSave\` (optional, default \`true\`): whether saving reformats the code.
- \`editorForStorybook\` / \`additionalBackStackItems\` are storybook test hooks — never write
  them into a layout.

## Traps

- An editor panel over an empty \`userNodes\` (or one with no consuming panels for the scripts'
  outputs) is a dead tile. When you propose \`NodePlayground\`, also propose the \`userNodes\`
  entries and the panels that consume their output topics — see the user-scripts skill.
- \`selectedNodeId\` must match a \`userNodes\` key **in the same layout proposal**, or the
  editor opens with nothing selected — the key exists only where you write it.
- The user edits scripts in the layout card after applying; the agent cannot read compile errors
  from here, so check the user-scripts skill's self-review list before proposing.

Not supported (ignored if written): \`sourceCode\`, \`inputs\`, \`output\` on the panel config —
those belong to \`userNodes\` entries, never to the panel.`,
};
