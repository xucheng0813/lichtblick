// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * The `PlaybackPerformance` panel (panels/PlaybackPerformance). Facts come from
 * panels/PlaybackPerformance/index.tsx: `PlaybackPerformance.defaultConfig = {}`, and the panel
 * plots playback speed, framerate, bag-frame time, and Mbps sparklines over a rolling 5 s window
 * from the player state. No config keys exist.
 */
export const PANEL_PLAYBACK_PERFORMANCE_SKILL: Skill = {
  id: "panel-playback-performance",
  name: "PlaybackPerformance panel: playback diagnostics",
  whenToUse: "Before proposing a layout that uses the PlaybackPerformance panel — debug-only constraint.",
  indexed: false,
  body: `# The \`PlaybackPerformance\` panel

**No configuration:** the config must be \`{}\` except for the optional \`lichtblickPanelTitle\`.
Any other config key is ignored or rejected, so pass nothing else.

A diagnostics panel showing playback health as four sparklines over the last 5 seconds:
playback speed (\`×realtime\`), UI framerate (\`fps\`), per-frame bag time (\`ms bag frame\`),
and received data rate (\`Mbps\`), each with its current value and average.

\`\`\`json
{ "configById": { "PlaybackPerformance!perf": { "lichtblickPanelTitle": "Playback perf" } } }
\`\`\`

## When to propose it

This panel is for debugging playback itself — the user reports stuttering, slow seeking, or
suspect frame pacing and wants the numbers. Do not add it to a routine monitoring layout: it
shows nothing about the robot's data and takes space better spent on a signal panel. It is
meaningful only while a recording is playing; on an idle or live source the sparklines stay
empty.

## Traps

- All measurements come from the player state; the panel subscribes to no topic and has no
  settings, so there is nothing to configure or verify.
- The rolling window is fixed at 5 seconds — not a config key, and not something a layout can
  change.
- If playback speed is \`0\` while paused, the speed and framerate lines flatline; that is
  expected behavior, not a broken panel.

Not supported (ignored if written): any config key besides \`lichtblickPanelTitle\`.`,
};
