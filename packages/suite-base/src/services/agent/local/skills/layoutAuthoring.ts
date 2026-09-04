// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  AGENT_SAFE_LAYOUT_MAX_COLLECTION_ENTRIES,
  AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES,
  AGENT_SAFE_LAYOUT_MAX_GRAPH_DEPTH,
  AGENT_SAFE_LAYOUT_MAX_GRAPH_NODES,
  AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH,
  AGENT_SAFE_LAYOUT_MAX_STRING_BYTES,
} from "@lichtblick/suite-base/services/agent/layoutSchema";

import type { Skill } from "./types";

/**
 * Pattern-library layouts for the layout-authoring skill. Each example is exercised through
 * validateLayoutProposalData in skills.test.ts, so keep them executable: every id in `layout`
 * needs a configById entry and vice versa, ids must be unique, and split percentages must be
 * 0–100. Topic names and message paths are placeholders — the agent replaces them from the
 * loaded catalog before proposing.
 */
export const ROBOT_DEBUG_LAYOUT = {
  configById: {
    "Quadruped Visualization.Quadruped Visualization!main": {
      lichtblickPanelTitle: "Robot view",
    },
    "Plot!state": {
      lichtblickPanelTitle: "State signals",
      paths: [
        {
          value: "/example/odom.twist.twist.linear.x",
          enabled: true,
          timestampMethod: "receiveTime",
          label: "vx",
        },
      ],
    },
    "StateTransitions!mode": {
      lichtblickPanelTitle: "Mode",
      paths: [{ value: "/example/nav/state.mode", timestampMethod: "receiveTime" }],
    },
  },
  globalVariables: {},
  userNodes: {},
  playbackConfig: { speed: 1 },
  layout: {
    direction: "row",
    first: "Quadruped Visualization.Quadruped Visualization!main",
    second: {
      direction: "column",
      first: "Plot!state",
      second: "StateTransitions!mode",
      splitPercentage: 65,
    },
    splitPercentage: 65,
  },
};

export const SENSOR_MONITORING_LAYOUT = {
  configById: {
    "Image!front": {
      lichtblickPanelTitle: "Front camera",
      imageMode: {
        imageTopic: "/example/camera/front/image_raw",
        calibrationTopic: "/example/camera/front/camera_info",
      },
    },
    "Image!rear": {
      lichtblickPanelTitle: "Rear camera",
      imageMode: {
        imageTopic: "/example/camera/rear/image_raw",
        calibrationTopic: "/example/camera/rear/camera_info",
      },
    },
    "Plot!imu": {
      lichtblickPanelTitle: "IMU acceleration",
      paths: [
        {
          value: "/example/imu/data.linear_acceleration.x",
          enabled: true,
          timestampMethod: "receiveTime",
          label: "ax",
        },
      ],
    },
    "Gauge!battery": {
      lichtblickPanelTitle: "Battery voltage",
      path: "/example/bms_state.voltage",
      minValue: 0,
      maxValue: 60,
      colorMode: "colormap",
      colorMap: "red-yellow-green",
      gradient: ["#ff0000", "#00ff00"],
      reverse: false,
    },
  },
  globalVariables: {},
  userNodes: {},
  playbackConfig: { speed: 1 },
  layout: {
    direction: "row",
    first: {
      direction: "column",
      first: "Image!front",
      second: "Image!rear",
      splitPercentage: 50,
    },
    second: {
      direction: "column",
      first: "Plot!imu",
      second: "Gauge!battery",
      splitPercentage: 60,
    },
    splitPercentage: 65,
  },
};

export const LOG_TROUBLESHOOTING_LAYOUT = {
  configById: {
    "RosOut!log": {
      lichtblickPanelTitle: "Logs",
      searchTerms: [],
      minLogLevel: 1,
      topicToRender: "/example/rosout",
    },
    "Plot!health": {
      lichtblickPanelTitle: "Battery voltage",
      paths: [
        {
          value: "/example/bms_state.voltage",
          enabled: true,
          timestampMethod: "receiveTime",
          label: "voltage",
        },
      ],
    },
    "StateTransitions!mode": {
      lichtblickPanelTitle: "Navigation mode",
      paths: [{ value: "/example/nav/state.mode", timestampMethod: "receiveTime" }],
    },
  },
  globalVariables: {},
  userNodes: {},
  playbackConfig: { speed: 1 },
  layout: {
    direction: "column",
    first: "RosOut!log",
    second: {
      direction: "row",
      first: "Plot!health",
      second: "StateTransitions!mode",
      splitPercentage: 50,
    },
    splitPercentage: 60,
  },
};

export const REPLAY_ANALYSIS_LAYOUT = {
  configById: {
    "Plot!cmd": {
      lichtblickPanelTitle: "Command velocity",
      paths: [
        {
          value: "/example/cmd_vel.linear.x",
          enabled: true,
          timestampMethod: "receiveTime",
          label: "cmd vx",
        },
      ],
    },
    "StateTransitions!mode": {
      lichtblickPanelTitle: "Navigation mode",
      paths: [{ value: "/example/nav/state.mode", timestampMethod: "receiveTime" }],
    },
    "RawMessages!detail": {
      lichtblickPanelTitle: "Command message",
      topicPath: "/example/cmd_vel",
    },
  },
  globalVariables: {},
  userNodes: {},
  playbackConfig: { speed: 1 },
  layout: {
    direction: "column",
    first: "Plot!cmd",
    second: {
      direction: "row",
      first: "StateTransitions!mode",
      second: "RawMessages!detail",
      splitPercentage: 50,
    },
    splitPercentage: 50,
  },
};

export const LAYOUT_AUTHORING_SKILL: Skill = {
  id: "layout-authoring",
  name: "Layout authoring: AgentSafeLayoutData structure",
  whenToUse: "Before propose_layout: exact JSON shape, limits, worked examples.",
  body: `# Layout authoring

\`propose_layout\` takes \`{ name, summary?, data }\` where \`data\` is AgentSafeLayoutData. A
proposal is never applied automatically — the user reviews and applies it.

## Submit one complete proposal

Build the entire layout internally before showing anything to the user: choose every panel, finish
each panel's config, and assemble the complete mosaic tree. Call \`propose_layout\` once with that
finished layout.

Never submit a skeleton, placeholder, or partial layout first and follow it with a fuller proposal.
If topic or panel availability is still unknown, inspect \`get_data_catalog\`.
Use the **Available panels** section of the system context instead of a half-built proposal to probe
what is available.

\`propose_layout\` validates the proposal against the catalog and may reject it — an unknown
topic, a field chain that does not exist, or an arithmetic path. Take the rejection's
\`did you mean\` suggestion, correct the proposal, and re-propose. Re-propose at most 2 times
within the same request; if the proposal is still rejected, tell the user briefly which parts you
could not resolve instead of re-submitting endlessly. Never relay the raw rejection text to the
user.

Only propose again within the same request when the user explicitly asked to revise a layout that
was already applied, or when \`propose_layout\` rejected your proposal as above. Even then,
submit one complete revised version at a time.

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

Every id is \`<type>!<suffix>\`, where suffix is any short unique string (\`3D!main\`,
\`Plot!imu\`).

Any panel type listed in the **Available panels** section of the system context, or returned by
\`list_panels\`, may be proposed. Panels without a \`panel-*\` skill: call \`list_panels\` first
and use its description (and \`skillId\`). Extension panels ship no config documentation — prefer
copying the complete config of a same-type panel from \`get_current_layout\`; when there is no
template, propose \`{}\` and tell the user to pick topics in the panel settings. Never guess
config keys.

Three rules that are enforced and will reject the proposal:
1. Every id appearing in \`layout\` must have a \`configById\` entry.
2. Every \`configById\` entry must appear in \`layout\` — no orphans.
3. No id may appear twice in \`layout\`.

## Panel titles

**Every panel config in a proposal must include \`lichtblickPanelTitle\`**: a short description in
the user's language of what the panel is for ("Left front wheel speed", not "Plot").
\`propose_layout\` checks this and returns a warning for every panel without one — write the
title up front. The panel toolbar shows this title instead of the panel type, so the user can
tell panels apart at a glance. Prefer the user's own words; never use a panel type name as the
title.

Exceptions — these panels render a custom toolbar and do not display the title, so it may be
omitted:

- \`Table\`
- \`RawMessages\`
- \`RawMessagesVirtual\`

Extension panels (for example the robot visualization panels) should carry a title too; whether
it renders depends on the extension's toolbar, which is not visible in the panel inventory, so
write one anyway.

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

Every example in this skill uses \`/example/...\` placeholder topics — replace them with real
names from the catalog before proposing.

## Example: single 3D scene

\`\`\`json
{
  "configById": {
    "3D!main": { "lichtblickPanelTitle": "Scene", "topics": { "/example/points": { "visible": true }, "/example/tf": { "visible": true } } }
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
    "3D!scene": { "lichtblickPanelTitle": "Scene", "topics": { "/example/points": { "visible": true } } },
    "Plot!speed": {
      "lichtblickPanelTitle": "Forward speed",
      "paths": [
        { "value": "/example/odom.twist.twist.linear.x", "enabled": true, "timestampMethod": "receiveTime", "label": "vx" }
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
      "lichtblickPanelTitle": "Battery voltage",
      "paths": [
        { "value": "/example/bms_state.voltage", "enabled": true, "timestampMethod": "receiveTime" }
      ]
    },
    "StateTransitions!mode": {
      "lichtblickPanelTitle": "Navigation mode",
      "paths": [{ "value": "/example/nav/state.mode", "timestampMethod": "receiveTime" }]
    },
    "Indicator!health": {
      "lichtblickPanelTitle": "System health",
      "path": "/example/system/healthy.data",
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

## Layout pattern library

A proven starting point for common requests. Each pattern lists when it fits, a complete layout,
and suggested proportions. Panel counts and split percentages are **suggestions, not hard
limits** — the layouts below pass the same validation that \`propose_layout\` applies, and every
topic or path in them is a placeholder (the \`/example/\` prefix) to replace from the loaded
catalog.

All patterns use 2–4 panels and at most 3 levels of nesting, far inside the budgets listed under
"Budget boundaries" below. If no pattern fits, use one of the single- or two-panel examples above
and ask the user rather than stacking more panels.

### Robot debugging

**When to use**: the user is debugging motion, perception, or planning on a robot, and the
catalog has transform topics plus at least one renderable topic (point cloud, markers, path,
occupancy grid). Default to the quadruped panel unless the user names the humanoid or the
built-in 3D panel — see the robot-viz skill.

**What**: one dominant scene view with a signal column beside it. 3 panels: robot view, one
Plot, one StateTransitions. Suggested split: scene 60–70%, signal column 30–40% (Plot above,
StateTransitions below, 65/35 inside the column).

Topic names below are placeholders — replace every one with a real name from the catalog before
proposing.

\`\`\`json
${JSON.stringify(ROBOT_DEBUG_LAYOUT, null, 2)}
\`\`\`

**Not a fit**: no transforms or renderable topics → propose a Plot-only layout or ask; user
wants the generic 3D panel → swap the robot panel for \`3D!scene\` and mark every topic
\`visible: true\`.

### Sensor monitoring

**When to use**: several camera topics (or one camera with multiple channels) plus numeric
signals (IMU, temperature, battery). Prefer adding \`calibrationTopic\` whenever camera
calibration exists — without it the Image panel draws no 3D overlays.

**What**: a camera wall with a numeric column. 4 panels: two Images, one Plot, one Gauge.
Suggested split: camera column 60–70% (two Images at 50/50), numeric column 30–40% (Plot above,
Gauge below). For compressed-video topics, reduce to a single video panel — decoding several
video streams at once degrades playback.

Topic names below are placeholders — replace every one with a real name from the catalog before
proposing.

\`\`\`json
${JSON.stringify(SENSOR_MONITORING_LAYOUT, null, 2)}
\`\`\`

**Not a fit**: no image topics → drop to a numeric-only layout (Plot + Gauge); more than two
Gauges → use one Plot instead; more than three cameras → ask the user which camera matters most.

### Log troubleshooting

**When to use**: the user is investigating errors, warnings, or node behavior, and the catalog
has a topic with one of the exact Log schemas the RosOut panel accepts (see the panel-catalog
skill — \`convertibleTo\` does not qualify). Log filtering works for live and recorded data
alike.

**What**: the log list with correlated signals. 3 panels: RosOut, one Plot, one
StateTransitions. Suggested split: log 55–60% on top, signal row 40–45% below (Plot and
StateTransitions at 50/50).

Topic names below are placeholders — replace every one with a real name from the catalog before
proposing.

\`\`\`json
${JSON.stringify(LOG_TROUBLESHOOTING_LAYOUT, null, 2)}
\`\`\`

**Not a fit**: no Log-schema topic → ask for the log topic or fall back to Plot +
StateTransitions; live data → Plot/StateTransitions click-to-seek is unavailable (recorded data
only) — say so instead of promising timeline navigation.

### Replay analysis

**When to use**: recorded data (bag, MCAP, ULog) and the user wants to walk through behavior,
find event times, or compare signals. Plot and StateTransitions support click-to-seek on
recorded data; the RawMessages panel shows the latest message for a topic (with optional diff
mode) — it has no per-message stepping.

**What**: a time-series comparison with a detail panel. 3 panels: Plot, StateTransitions,
RawMessages. Suggested split: Plot 45–50% on top, StateTransitions and RawMessages at 50/50
below.

Topic names below are placeholders — replace every one with a real name from the catalog before
proposing.

\`\`\`json
${JSON.stringify(REPLAY_ANALYSIS_LAYOUT, null, 2)}
\`\`\`

**Not a fit**: live data → click-to-seek is unavailable; when the user wants to see the scene,
add a 3D or robot panel instead of a fourth analysis panel; object-list inspection → swap the
Plot for a Table (topicPath pointing at an object array).

### Budget boundaries

\`propose_layout\` data is validated against hard budgets, all exported from layoutSchema:

- At most ${String(AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES)} panels in \`configById\`.
- Mosaic tree depth under ${String(AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH)}.
- At most ${String(AGENT_SAFE_LAYOUT_MAX_COLLECTION_ENTRIES)} entries in any JSON collection.
- At most ${String(AGENT_SAFE_LAYOUT_MAX_GRAPH_DEPTH)} levels of nesting anywhere in the data.
- At most ${String(AGENT_SAFE_LAYOUT_MAX_GRAPH_NODES)} total values.
- Any single string at most ${String(AGENT_SAFE_LAYOUT_MAX_STRING_BYTES)} bytes.

The patterns above stay far below every budget (≤ 4 panels, ≤ 3 nesting levels), so following a
pattern cannot hit a budget by itself — only the paths and configs added on top of one can.

## Extending the layout the user has open

When the user asks to add panels to the layout they have open, extend it in place:

1. Call \`get_current_layout({})\` first and copy it verbatim: every existing panel's
   \`configById\` entry with its original id, plus all top-level fields — \`globalVariables\`,
   \`userNodes\`, \`playbackConfig\`, \`savedProps\`, and \`version\`.
2. Append only the new panels to the **root mosaic**, next to the existing top-level nodes.
   Panels added inside a Tab are not applied in place — put them at the root instead.
3. Never rewrite or drop an existing panel config, and never mint fresh ids for panels that
   already exist. The proposal is applied in place only when it is exactly the open layout plus
   the appended panels; anything else is saved as a new layout. Say "adds panels" or "new
   layout" only as the card shows it, and never claim the layout was applied.

When \`get_current_layout\` returns \`tooLarge: true\`, the open layout cannot be extended in
place — propose a new layout instead, or ask the user which panels to keep.

## Topic verification

\`propose_layout\` now checks every topic the proposal **reads** — subscription topics and
message paths — against the loaded catalog: unknown topics are rejected with a
\`did you mean "…"\` suggestion. Pass on the first try:

1. Topic names are opaque strings — copy them **byte for byte** from \`get_data_catalog\`,
   \`describe_topic\`, or \`read_messages\` results. Never add or remove a leading \`/\`, never
   change case, never "fix" punctuation: one recording can mix slash-prefixed and slash-less
   spellings, and they are different names.
2. Before proposing, list every topic the layout **reads** and confirm each one in this turn's
   tool results. If \`propose_layout\` rejects a topic, take the \`did you mean\` suggestion,
   correct the proposal yourself, and call \`propose_layout\` again — do not relay the raw
   error to the user.
3. Only fields that appear in this turn's \`describe_topic\` or \`read_messages\` results may be
   called "confirmed". A result marked \`truncated\` proves nothing about what is absent — never
   conclude "there is no X topic" from a truncated result; narrow the query instead
   (\`get_data_catalog({ query })\` or \`describe_topic\`).
4. Script outputs are another exception: every real **input** topic must come from the catalog,
   but a \`userNodes\` script in the **same proposal** declares \`export const output =
   "/studio_script/..."\`, and \`propose_layout\` accepts that virtual topic for the panels of
   this proposal (it adds legal script outputs to a virtual catalog for validation). A virtual
   topic is not a catalog topic — it never appears in \`get_data_catalog\` and cannot be read
   with \`read_messages\`. A \`/studio_script/\` topic that is not declared by a script in this
   same proposal is rejected like any unknown topic — never reference one.
5. Output panels are exempt from the existence check: the target names of publishing panels —
   \`Publish\` \`topicName\`, \`Teleop\` \`topic\`, \`CallService\` \`serviceName\` — may be
   topics or services that do not exist in the loaded source (the panel advertises them itself).
   \`Publish\` \`datatype\` is different: it must be a schema name present in the catalog
   datatypes, spelled exactly as the catalog spells it.

## Plot rules

- A \`[:]\` slice produces **one legend entry**, not one per element. When the user wants one
  line per array element (one curve per joint, per core, …), expand the slice into \`[0]\`,
  \`[1]\`, … \`[N-1]\` paths, each with its own \`label\` (e.g. \`joint 0\`) and its own
  \`color\`; take N from one real message (\`read_messages\`).
- Every curve in one Plot must have a pairwise **different** \`color\` — assign an explicit
  \`color\` to each path instead of letting them share a default.
- Message paths do no arithmetic and no function calls: \`100 - …idle\` is not evaluated. To
  show CPU usage, plot the raw fields (\`….cpu.payload.cores[…].user\` plus \`.system\`); any
  computation beyond the Plot \`.@\` modifiers is a user script (user-scripts skill).

## Before proposing

Load the message-path skill for every path you write. Build paths and topic names only from the
loaded catalog — never from memory of what a robot "usually" publishes. Pull field trees with
\`describe_topic({ topics })\` and verify every topic per "Topic verification" above. Load the
panel-catalog skill if unsure which panel accepts a given schema, and check the per-panel
requirements there that validation does not enforce. Say briefly why the chosen panels answer
the user's question.`,
};
