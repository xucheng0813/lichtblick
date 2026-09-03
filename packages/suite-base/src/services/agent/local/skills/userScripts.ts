// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Risk decision (recorded per plan2 N7): user scripts execute through `new Function` inside a
 * SharedWorker without CPU or loop limits. This batch deliberately adds no execution timeout and
 * accepts the residual DoS risk — the user reviews the source in the layout card before applying.
 * The self-containment rules below (no fetch/network/external storage) are behavior conventions,
 * not security controls.
 *
 * Compiler facts (error codes, allowed imports, output datatype naming) come from
 * players/UserScriptPlayer/constants.ts, transformerWorker/typescript/projectConfig.ts, and
 * transformerWorker/typescript/ast.ts. Keep them in sync.
 */
export const USER_SCRIPTS_SKILL: Skill = {
  id: "user-scripts",
  name: "User scripts: deriving topics the panels need",
  whenToUse: "When a derived or converted topic is needed that no panel or path can give.",
  body: `# User scripts

When no panel answers the question from the raw topics alone, propose a layout that includes a
user script. Scripts run inside the app's UserScriptPlayer: they subscribe to real topics and
publish derived messages under an output topic that the panels in the same layout consume.

## When to write a script

Message paths have no transform functions apart from the Plot-only math modifiers (message-path
skill), so a script is the tool for:

- unit conversion or scaling outside Plot's \`.@\` functions (m/s → km/h, bytes → MB),
- vector magnitude, quaternion → roll/pitch/yaw, rates of change over time,
- combining several topics, keeping state across messages, custom filtering,
- republishing under a schema a renderer understands (\`SceneUpdate\`, \`LocationFix\`, ...).

Do not write a script for something a path already expresses: field access, array slices,
\`{}\` filters, or a Plot \`.@rad2deg\`.

## Format

Every script has this shape:

\`\`\`ts
import { Input, Message } from "./types";

type Odom = Message<"nav_msgs/Odometry">;

type Output = {
  speedKmh: number;
};

export const inputs = ["/odom"];

export const output = "/studio_script/speed_kmh";

export default function script(event: Input<"/odom">): Output {
  const odom: Odom = event.message;
  return { speedKmh: odom.twist.twist.linear.x * 3.6 };
}
\`\`\`

Three exports, all required:

- \`inputs\` must name real topics from the loaded catalog, spelled exactly as they appear
  there, and the array must be non-empty (compile errors \`NO_INPUTS_EXPORT\`, \`EMPTY_INPUTS_EXPORT\`, \`NO_TOPIC_AVAIL\`). Never a topic
  guessed from memory.
- \`output\` must start with \`/studio_script/\`, be unique among the layout's scripts, and
  not collide with an existing data-source topic (\`NO_OUTPUTS\`, \`NOT_UNIQUE\`, \`EXISTING_TOPIC\`). The prefix
  exists exactly to prevent collisions.
- A default-exported function \`(event, globalVars) => Output | undefined\`. \`event\` carries
  \`topic\`, \`receiveTime\`, and \`message\`; returning \`undefined\` skips publishing for that
  message; \`globalVars\` is the layout's global variables object. Both arguments are read-only.

\`Message<"schema">\` and \`Input<"/topic">\` are type helpers generated from the loaded catalog,
so the schema string must match the catalog exactly (\`sensor_msgs/Image\` and
\`sensor_msgs/msg/Image\` are different names). They are types only, not runtime imports.

## The return type is the output schema

The compiler derives the output datatype from the return type, and schema-driven panels match on
that name:

- \`Message<"pkg/Type">\` → the output carries \`pkg/Type\`; \`3D\`, \`Image\`, \`map\`, and \`RosOut\`
  accept it like any source topic.
- A type imported from \`@foxglove/schemas\` (\`SceneUpdate\`, \`LocationFix\`, \`Log\`, ...) →
  \`foxglove.<Type>\`; same effect.
- A hand-written object type → an opaque datatype named after the script. Path-based panels
  (\`Plot\`, \`StateTransitions\`, \`Gauge\`, \`Indicator\`, \`Table\`, \`RawMessages\`) read it fine;
  \`3D\`, \`Image\`, \`map\`, and \`RosOut\` silently ignore it.

So when the consumer is a renderer, return the imported schema type directly, never a wrapper
around it, and supply every field (schema types have no optional fields; pass empty arrays).

Rules the datatype extractor enforces, each a compile error with the code shown: the function
must return an object with at least one field (\`BAD_TYPE_RETURN\`, \`NO_TYPE_RETURN\`; a bare \`number\`
or \`string\` is rejected — wrap it as \`{ value: number }\`); no unions inside it (\`NO_UNIONS\`)
and only \`T | undefined\` at the top (\`LIMITED_UNIONS\`); no literal types
(\`NO_TYPE_LITERALS\`), tuples (\`NO_TUPLES\`), intersections (\`NO_INTERSECTION_TYPES\`), mapped
types such as \`Record\` or \`Partial\` (\`NO_MAPPED_TYPES\`), classes or functions (\`NO_CLASSES\`,
\`NO_FUNCTIONS\`), \`typeof\` (\`NO_TYPEOF\`), indexed access types (\`INVALID_INDEXED_ACCESS\`), or
nested \`any\` (\`NO_NESTED_ANY\`); write arrays as \`T[]\` (\`PREFER_ARRAY_LITERALS\`).

## Imports

Only these resolve; anything else fails to compile:

- \`./types\`: \`Input\`, \`Message\`, and shared shapes (\`Header\`, \`Time\`, \`Point\`, \`Pose\`,
  \`Quaternion\`, \`Transform\`, \`RGBA\`).
- \`./time\` (\`compare\`, \`subtractTimes\`, \`areSame\`), \`./vectors\` (\`dot\`, \`cross\`,
  \`rotate\`), \`./quaternions\` (\`quaternionToEuler\`, \`eulerToQuaternion\`), \`./pointClouds\`
  (\`readPoints\`, \`norm\`), \`./readers\` (typed readers for raw byte fields), \`./markers\`
  (\`buildRosMarker\`, \`MarkerTypes\`).
- \`@foxglove/schemas\`: every Foxglove schema type.

No npm packages, no Node built-ins, no \`fetch\`, network, or storage. This is a
behavior convention, not a security control.

## Multiple inputs and state

Union the input types and branch on \`event.topic\`; keep cross-message state in module scope:

\`\`\`ts
import { Input } from "./types";

export const inputs = ["/odom", "/imu"];
export const output = "/studio_script/fused";

let lastYawRate = 0;

export default function script(
  event: Input<"/odom"> | Input<"/imu">,
): { speed: number; yawRate: number } | undefined {
  if (event.topic === "/imu") {
    lastYawRate = event.message.angular_velocity.z;
    return undefined;
  }
  return { speed: event.message.twist.twist.linear.x, yawRate: lastYawRate };
}
\`\`\`

When the output schema has a timestamp, fill it from the input's own \`header.stamp\` (or
\`timestamp\`); fall back to \`event.receiveTime\` only when the input has none. \`log(...)\` inside
the function prints to the script's log in the User Scripts sidebar; it cannot take a function
argument, and it runs per message, so keep it off high-rate topics.

## Proposing a layout with scripts

Scripts travel in the \`userNodes\` field of the layout proposal, keyed by a short unique id,
each with \`name\` and \`sourceCode\`:

\`\`\`json
"userNodes": {
  "speed-converter": { "name": "Speed km/h", "sourceCode": "…" }
}
\`\`\`

Layout validation enforces exactly \`{ name, sourceCode }\` per node — anything else is
rejected. When a proposal includes a script, also add panels that consume its \`output\` topic
(for example a Plot with a path starting with \`/studio_script/...\`), so the user sees the
derived value immediately. A proposal that carries scripts is always saved as a new layout;
scripts cannot be added to the open layout in place. The user reviews the script source in the
layout card before applying, and can edit it later in the NodePlayground editor.

## Verifying before you propose

There is no compile result you can read: the script compiles when the user applies the layout,
and errors appear in the User Scripts sidebar. So check the list above yourself before proposing
— every input in the catalog, output prefix and uniqueness, an object return type with no unions
or mapped types, only the imports listed, a consuming panel in the same proposal — and say in the
summary what the script computes and which panel shows it. When the user reports "the script ran
but the panel is empty", walk them through: a \`RawMessages\` panel on the output topic (is data
flowing?), then the return-type rule above (does the renderer know the schema?), then the input
data itself with \`read_messages\` (is the source what the script expects?).

## Never propose the NodePlayground panel

The NodePlayground editor panel is not on the panel allowlist and must never be proposed:
scripts execute without it, and the user opens NodePlayground themselves when they want to
edit or debug a script. Propose layouts, not editors.

## Risk note

Scripts execute in a SharedWorker via \`new Function\` without CPU or loop limits, so a script
can stall or consume CPU. Never generate code that loops without bound; keep the source short
enough to review in the layout card before applying.`,
};
