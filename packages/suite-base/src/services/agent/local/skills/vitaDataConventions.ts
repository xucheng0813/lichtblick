// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Platform conventions for Vita/aorta recordings, distilled from the recorded agent sessions
 * (see the project plan D7 table for the per-conversation provenance). These are observations
 * about one robot fleet's data, not application behavior — every rule below exists because a
 * past session failed by violating it.
 */
export const VITA_DATA_CONVENTIONS_SKILL: Skill = {
  id: "vita-data-conventions",
  name: "Vita/aorta data conventions",
  whenToUse: "Vita/aorta recordings: topic naming, log/audio/GNSS topics, analysis recipes.",
  body: `# Vita/aorta data conventions

Fleet-specific facts about Vita/aorta recordings. Load this whenever the workspace is a Vita or
aorta recording and you are about to name a topic, filter a message path, or run a fall/joystick
analysis. Every rule below is a past failure that this skill prevents.

## Topic naming: two conventions coexist

aorta topics are mostly written with **no leading slash** — \`odometry\`,
\`lowlevel/low_state\`, \`locomotion/velocity_command\`, \`fsm/context_snapshot\` — yet the very
same recording also contains slash-prefixed names such as \`/bms_state\` and \`/gnss/fix\`. Both
spellings can appear in one source. **Copy the topic byte-for-byte from the catalog, never add or
remove a leading slash** — \`/odometry\` does not equal \`odometry\`, and inventing the slash
turns a working path into a dead one.

## Log topics

Log traffic lives on \`s100/vlog\`, \`x5/vlog_batch\`, \`x5/static_syslog\`, and
\`aorta/default/pub/log\`. Only topics whose schema is one of the eight Log-family names can feed
\`RosOut\` (panel-rosout). Never hunt for log topics by guessing names like \`…/log/x5\` or
\`…/rosout/x5\` with \`read_messages\` — call \`get_data_catalog({query:"log"})\` instead: the
query is a case-insensitive substring (it does not support \`|\` alternation). When you need a
log message's field tree, use \`describe_topic({topics:["lowlevel/low_state"]})\` rather than
guessing fields.

## Audio

- \`raw_audio_dump\` carries \`foxglove.RawAudio\` (pcm-s16, 16 kHz) and is what the \`Audio\`
  panel plays (panel-audio).
- \`/speech_dog_to_phone\` is a \`speech_msgs/…\` schema — not RawAudio, so the \`Audio\` panel
  cannot play it; inspect it with \`RawMessages\` only.
- Speaker-box state lives in \`aorta/default/ctx/audio/external_speaker/{state,last_error,output_ready}\`.

## ContextValue, GNSS, and cameras

- \`aorta.ctx.ContextValue\` messages pick their payload by the \`kind\` field: read
  \`.string_value\`, \`.bool_value\`, \`.f64_value\`, or \`.i64_value\` accordingly. \`Indicator\`
  rules must use \`rawValue\` strings even for numeric kinds.
- \`gnss/fix\` (\`NavSatFix\`) is the map-able GNSS topic; \`gnss/fusion\`
  (\`gnss.GnssFusion\`) cannot feed \`map\` — chart it with \`Plot\` or inspect it raw.
- \`image_left_raw/h265_quarter\` and \`image_right_raw/h265_quarter\` are H.265 streams; the
  built-in \`Image\` panel may not decode them. When the runtime has the \`H.265 Video\`
  extension panel, prefer it. Extension panels have no config documentation: copy the full config
  of a same-type panel from the current layout (\`get_current_layout\`) when one exists; with no
  template propose \`{}\` and tell the user to pick the topic in the panel settings — never guess
  config keys.

## Joints, collectd, battery

- Joint torque lives in \`lowlevel/low_state.motor_state[]\`. When the user wants one line per
  joint, expand \`motor_state[0]…[N-1].tau_est\` into N paths, each with its own \`label\` (e.g.
  "joint 0") and a distinct \`color\`; take N from an actual message. The \`[:]\` slice produces
  a single legend entry, not one per element.
- collectd paths are \`aorta/default/pub/collectd/{x5,s100}/cpu.payload.cores[:]{core_id==N}.user\`;
  the \`{zone=="mcu_0"}\` filter exists only for s100, not x5. Before writing filters,
  \`read_messages\` to enumerate the actual \`core_id\`/\`device\`/\`zone\`/\`name\` values. For
  CPU occupancy plot \`.user\` plus \`.system\` — message paths do no arithmetic, so
  \`100 - …idle\` is not an option.
- Battery voltage is \`bms_state.voltage_mv\` in millivolts (both \`bms_state\` and
  \`/bms_state\` spellings have appeared). A \`Gauge\` range must come from real message values —
  never guess min/max.

## Analysis recipes

- **Fall analysis:** \`search_messages\` on \`s100/vlog\` for \`fallen\` / level error to locate
  the moment → read \`lowlevel/low_state.imu_state\` attitude over the surrounding 1–2 s (windows
  of at least 50 ms, never 1 ms) → cross-check \`locomotion/velocity_command\` and
  \`fsm/context_snapshot.dag.emergency_stop_active\`.
- **Joystick lag:** follow the causal chain with \`search_messages\`: lidar hardware fault →
  empty point cloud → SLAM degradation → missing transforms → pilot command downgrade → PTP.
  Search along the chain instead of guessing a single root cause.`,
};
