// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Indexed skill: the message-path grammar is shared by every path-based panel and by the paths a
 * user script consumer needs, so it is worth one index line. Grammar facts come from
 * packages/message-path/src/grammar.ne and the Plot math modifiers from
 * panels/Plot/utils/mathFunctions.ts; keep them in sync when either changes.
 */
export const MESSAGE_PATH_SKILL: Skill = {
  id: "message-path",
  name: "Message path syntax for panel configs",
  whenToUse: "Before writing a message path for any panel: syntax, filters, Plot modifiers.",
  body: `# Message paths

A message path selects a value out of a topic's messages. Every path-based panel (\`Plot\`,
\`StateTransitions\`, \`Gauge\`, \`Indicator\`, \`PieChart\`, \`Table\`, \`RawMessages\`,
\`RawMessagesVirtual\`) uses this grammar. There is no transform-function language beyond the
Plot-only math modifiers below: unit scaling, vector magnitude, quaternion to Euler, derivatives,
and combining topics are all user scripts (user-scripts skill).

## Grammar

\`\`\`text
/imu                          the whole message
/imu.orientation              a nested field
/imu.linear_acceleration.x    a scalar leaf
collectd/s100/cpu.payload     a topic without a leading slash is written as the catalog spells it
"topic with spaces".value     quote a topic or field name that has other characters
\`\`\`

- Names may contain letters, digits, \`_\` and \`-\`. Anything else must be double-quoted, whether
  it is the topic or a field.
- Copy the topic exactly as the catalog spells it: leading slash or none, case, punctuation.
  Nothing normalizes a path after it is written into a layout.

### Arrays

- \`[0]\` one element by index. Indexes count from 0; there is no negative indexing.
- \`[1:3]\` a range with both ends inclusive, \`[:]\` every element, \`[:2]\` and \`[2:]\` open ends.
  A range or \`[:]\` yields an array (Plot draws one series per element).
- One slice per path. Nested arrays cannot be addressed.

### Filters

- \`{field==value}\` after a name keeps only the elements (or messages) where the comparison
  holds: \`/diagnostics.status[:]{level==2}.name\`, \`/objects.items[:]{id==7}.x\`.
- Operators: \`==\`, \`!=\`, \`<\`, \`<=\`, \`>\`, \`>=\`.
- The left side is a simple dotted path such as \`{header.frame_id=="map"}\`; no slices or
  nested filters inside it.
- Values: an integer, a quoted string, \`true\`, \`false\`, or a global variable such as
  \`$selected\`. **A decimal literal does not parse**: \`{x>0.5}\` is an error. Compare
  integers, or move the threshold into a user script.
- Comparison is loose: \`{level==2}\` also matches the string "2", and \`{ok==true}\` matches 1.
- A filter placed directly on the topic, \`/odom{pose.pose.position.x>10}.twist\`, drops whole
  messages that fail it.

### Global variables

\`$name\` may stand in for a slice bound or a filter value (\`[$idx]\`, \`{id==$selected}\`) and
nowhere else. Values come from the layout's \`globalVariables\`.

### Plot math modifiers

Only the \`Plot\` panel honors a trailing modifier \`.@fn\` on a numeric leaf. The complete list:
\`abs\`, \`acos\`, \`asin\`, \`atan\`, \`ceil\`, \`cos\`, \`log\`, \`log1p\`, \`log2\`, \`log10\`,
\`round\`, \`sign\`, \`sin\`, \`sqrt\`, \`tan\`, \`trunc\`, \`negative\`, \`deg2rad\`, \`rad2deg\`.
Example: \`/imu.angular_velocity.z.@rad2deg\`. One modifier per path, applied after all field
access and slicing. There is no scaling, derivative, norm, or quaternion function; other panels do
not evaluate modifiers at all.

## What a path must end at

| Panel | Terminal value |
| --- | --- |
| \`Plot\` | a number, bool, time, duration, or string leaf; a sliced array of leaves draws one series each |
| \`StateTransitions\` | a number, string, bigint, or boolean leaf; never an array |
| \`Gauge\` | one numeric leaf |
| \`Indicator\` | one scalar leaf (\`/topic.data\`, not \`/topic\`) |
| \`PieChart\` | a \`float32[]\` field |
| \`Table\` | an object or an array of objects |
| \`RawMessages\`, \`RawMessagesVirtual\` | anything, including the bare topic |

A path that ends in a message object or an unsliced array is not plottable.

## Traps

- Paths are never validated when a layout is applied. One that does not resolve shows an in-panel
  error or an empty panel. Build every segment from the catalog datatypes, and when the structure
  is not visible read one message with \`read_messages\` and use the fields it really has.
- A \`Plot\` value that parses as a number is a horizontal reference line, not a series.
- \`/topic\` alone on \`Indicator\` or \`Gauge\` resolves to the message object and shows only the
  fallback state; name the field.
- ROS 2 renames fields between packages and versions; a path copied from a ROS 1 recording may
  not resolve on a ROS 2 one.

## Examples

\`\`\`text
/odom.twist.twist.linear.x                             scalar for Plot or Gauge
/nav/state.mode                                        enum for StateTransitions
/diagnostics.status[:]{hardware_id=="imu"}.level       filtered element for Indicator
/scan.ranges[0:9]                                      ten values, one Plot series each
collectd/s100/cpu.payload.cores[:]{core_id==0}.user    filter with an integer value
/imu.orientation.x.@abs                                Plot-only modifier
\`\`\``,
};
