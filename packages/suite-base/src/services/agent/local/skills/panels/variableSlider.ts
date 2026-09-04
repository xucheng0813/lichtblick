// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from VariableSliderConfig in panels/VariableSlider/types.ts and the
 * defaultConfig (min 0 / max 10 / step 1) and settings tree in panels/VariableSlider/index.tsx
 * and settings.ts. Global-variable path usage is documented in the message-path skill.
 * Keep them in sync.
 */
export const PANEL_VARIABLE_SLIDER_SKILL: Skill = {
  id: "panel-variable-slider",
  name: "GlobalVariableSliderPanel: draggable global variable",
  whenToUse: "Before proposing a layout that uses the GlobalVariableSliderPanel panel — variable wiring.",
  indexed: false,
  body: `# The \`GlobalVariableSliderPanel\` panel

No data configuration of its own: the panel is a draggable slider bound to one global variable.
Use it when the user wants a knob that interactively changes what other panels show — the variable
is referenced from message paths as \`$name\` in slice bounds and filter values (see the
message-path skill; e.g. \`/objects.items[$idx].x\` or \`{id==$selected}\`).

\`\`\`json
{
  "configById": {
    "GlobalVariableSliderPanel!speed": {
      "lichtblickPanelTitle": "Speed limit",
      "globalVariableName": "speed_limit",
      "sliderProps": { "min": 0, "max": 10, "step": 1 }
    },
    "Plot!speed": {
      "lichtblickPanelTitle": "Speed",
      "paths": [{ "value": "/example/odom.twist.linear.x", "enabled": true }]
    }
  },
  "globalVariables": { "speed_limit": 5 }
}
\`\`\`

## Config reference

- \`globalVariableName\` (required): the key in the layout's \`globalVariables\` object that the
  slider reads and writes.
- \`sliderProps\` (required): \`{ min, max, step }\` numbers; defaults are \`min: 0\`,
  \`max: 10\`, \`step: 1\` when a key is omitted. All three keys are optional individually.

## Traps

- The variable only affects panels that actually reference it. Declare the same key in the
  layout's \`globalVariables\` with a sane initial value so panels render sensibly before the
  user touches the slider, and mention in the summary which paths use it.
- \`$name\` is only legal in a slice bound or a filter value — it cannot replace a field name or
  a topic name, and no arithmetic is evaluated (\`$a + $b\` does not compute; use a user script).
- A slider on a variable nothing consumes is a dead control — check the paths before proposing.

Not supported (ignored if written): \`label\`, \`unit\`, \`onChange\`-style keys, or anything
besides the two keys above.`,
};
