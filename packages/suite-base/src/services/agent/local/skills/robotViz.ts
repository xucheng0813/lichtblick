// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  HUMANOID_VIZ_PANEL_TYPE,
  QUADRUPED_VIZ_PANEL_TYPE,
} from "@lichtblick/suite-base/services/agent/layoutSchema";

import type { Skill } from "./types";

export const ROBOT_VIZ_SKILL: Skill = {
  id: "robot-viz",
  name: "Robot visualization panels: choosing between them",
  whenToUse: "Whenever a layout needs a 3D robot view; read before picking a 3D panel.",
  body: `# Robot visualization panels

Two purpose-built robot panels ship with this application, alongside the generic built-in \`3D\`
panel. They render a rigged robot model driven by the recording rather than a generic scene.

| Panel type | Robot |
| --- | --- |
| \`${QUADRUPED_VIZ_PANEL_TYPE}\` | Vita01b2 quadruped ("robot dog") |
| \`${HUMANOID_VIZ_PANEL_TYPE}\` | Vita vt_human humanoid |
| \`3D\` | Generic scene — no robot model |

Note the panel type repeats the name on both sides of the dot. That is how extension panel types
are formed and it is not a typo; use the string exactly as written above.

## Which one to use

**Default to the quadruped panel.** When a layout needs a 3D robot view, use
\`${QUADRUPED_VIZ_PANEL_TYPE}\` unless the user has told you otherwise.

Use a different panel only on an explicit request:

- The user asks for the humanoid, the vt_human, or a human-shaped robot → use
  \`${HUMANOID_VIZ_PANEL_TYPE}\`.
- The user asks for the built-in, default, generic, or standard 3D panel → use \`3D\`.

If the user names a robot you cannot map to either panel, ask rather than guessing. Do not infer
the robot type from topic names or from the recording's bot name; those are not reliable signals,
and picking the wrong model produces a confidently wrong visualization.

## Configuration

Both panels take their own configuration and an empty object is valid:

\`\`\`json
{ "configById": { "${QUADRUPED_VIZ_PANEL_TYPE}!main": { "lichtblickPanelTitle": "Robot view" } } }
\`\`\`

They subscribe to the topics they need on their own, so unlike the built-in \`3D\` panel you do not
have to mark topics visible for anything to appear. Keep their config minimal — pass only
\`lichtblickPanelTitle\` (plus any setting the user asked for), since these panels' option names
are not documented here and a guessed key is silently ignored. The title renders in the toolbar
for these panels unless the extension uses a custom one, so write it anyway.

## Combining with other panels

These are robot views, not general-purpose scene panels. Pair them with \`Plot\`,
\`StateTransitions\`, or \`Indicator\` for the signals behind the motion, exactly as you would with
the built-in \`3D\` panel. See the panel-catalog and layout-authoring skills for those.`,
};
