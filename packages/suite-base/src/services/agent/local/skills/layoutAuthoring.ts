// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES,
  AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH,
  ALLOWED_PANEL_TYPES,
} from "@lichtblick/suite-base/services/agent/layoutSchema";

import type { Skill } from "./types";

export const LAYOUT_AUTHORING_SKILL: Skill = {
  id: "layout-authoring",
  name: "Layout authoring: AgentSafeLayoutData structure",
  whenToUse: "Before calling propose_layout, for the exact JSON structure and worked examples.",
  body: `# Layout authoring

\`propose_layout\` takes \`{ name, summary?, data }\` where \`data\` is AgentSafeLayoutData. A
proposal is never applied automatically — the user reviews and applies it.

## Submit one complete proposal

Build the entire layout internally before showing anything to the user: choose every panel, finish
each panel's config, and assemble the complete mosaic tree. Call \`propose_layout\` exactly once
with that finished layout.

Never submit a skeleton, placeholder, or partial layout first and follow it with a fuller proposal.
If topic or panel availability is still unknown, inspect \`get_data_catalog\`.
Use the **Available panels** section of the system context instead of a half-built proposal to probe
what is available.

Only propose again within the same request when the user explicitly asked to revise a layout that
was already applied. Even then, submit one complete revised version at a time.

## Structure

\`\`\`json
{
  "configById": { "<panel-id>": { /* panel config */ } },
  "globalVariables": {},
  "userNodes": {},
  "playbackConfig": { "speed": 1 },
  "layout": "<mosaic tree>"
}
\`\`\`

\`configById\`, \`globalVariables\`, \`userNodes\`, and \`playbackConfig.speed\` are all required.
\`layout\` and \`version\` are optional but a layout without \`layout\` shows no panels. No other
top-level fields are accepted.

## Panel ids

Every id is \`<type>!<suffix>\`, where type is on the allowlist and suffix is any short unique
string (\`3D!main\`, \`Plot!imu\`).

Allowed types: ${ALLOWED_PANEL_TYPES.join(", ")}.

Three rules that are enforced and will reject the proposal:
1. Every id appearing in \`layout\` must have a \`configById\` entry.
2. Every \`configById\` entry must appear in \`layout\` — no orphans.
3. No id may appear twice in \`layout\`.

## Mosaic tree

A tree node is either a panel id string, or a split:

\`\`\`json
{ "direction": "row", "first": <node>, "second": <node>, "splitPercentage": 50 }
\`\`\`

\`direction\` is \`"row"\` (side by side) or \`"column"\` (stacked). \`splitPercentage\` is 0–100 and
gives the share taken by \`first\`. Only these four fields are allowed on a split node.

## Limits

At most ${String(AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES)} panels and a tree depth under
${String(AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH)}. Practical layouts use 2–5 panels; more than that is
harder to read than it is informative. Keep configs minimal — set what the user asked for and let
defaults handle the rest.

## Example: single 3D scene

\`\`\`json
{
  "configById": {
    "3D!main": { "topics": { "/points": { "visible": true }, "/tf": { "visible": true } } }
  },
  "globalVariables": {},
  "userNodes": {},
  "playbackConfig": { "speed": 1 },
  "layout": "3D!main"
}
\`\`\`

## Example: 3D beside a plot

\`\`\`json
{
  "configById": {
    "3D!scene": { "topics": { "/points": { "visible": true } } },
    "Plot!speed": {
      "paths": [
        { "value": "/odom.twist.twist.linear.x", "enabled": true, "timestampMethod": "receiveTime", "label": "vx" }
      ]
    }
  },
  "globalVariables": {},
  "userNodes": {},
  "playbackConfig": { "speed": 1 },
  "layout": { "direction": "row", "first": "3D!scene", "second": "Plot!speed", "splitPercentage": 60 }
}
\`\`\`

## Example: diagnostics column beside a plot

\`\`\`json
{
  "configById": {
    "Plot!battery": {
      "paths": [
        { "value": "/bms_state.voltage", "enabled": true, "timestampMethod": "receiveTime" }
      ]
    },
    "StateTransitions!mode": {
      "paths": [{ "value": "/nav/state.mode", "timestampMethod": "receiveTime" }]
    },
    "Indicator!health": {
      "path": "/system/healthy",
      "style": "bulb",
      "fallbackColor": "#a0a0a0",
      "fallbackLabel": "Unknown",
      "rules": [
        { "operator": "=", "rawValue": "true", "color": "#68e24a", "label": "Healthy" }
      ]
    }
  },
  "globalVariables": {},
  "userNodes": {},
  "playbackConfig": { "speed": 1 },
  "layout": {
    "direction": "row",
    "first": "Plot!battery",
    "second": {
      "direction": "column",
      "first": "StateTransitions!mode",
      "second": "Indicator!health",
      "splitPercentage": 65
    },
    "splitPercentage": 55
  }
}
\`\`\`

## Before proposing

Build paths and topic names only from the loaded catalog — never from memory of what a robot
"usually" publishes. Load the panel-catalog skill if unsure which panel accepts a given schema, and
check the per-panel requirements there that validation does not enforce. Say briefly why the chosen
panels answer the user's question.`,
};
