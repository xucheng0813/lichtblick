// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from AudioConfig / DEFAULT_CONFIG in panels/Audio/types.ts, the
 * RAW_AUDIO_SCHEMA_NAME topic filter in panels/Audio/settings.ts, and the playback scheduler in
 * panels/Audio/audioPlayback.ts (pcm-s16 only, seek flushes). Keep them in sync.
 */
export const PANEL_AUDIO_SKILL: Skill = {
  id: "panel-audio",
  name: "Audio panel: raw PCM audio playback",
  whenToUse: "Before proposing a layout that uses the Audio panel — RawAudio topics and volume config.",
  indexed: false,
  body: `# The \`Audio\` panel

Topic-based panel: configured with a topic name, not a message path. It renders an audio player
with a waveform and plays the PCM samples of one \`foxglove.RawAudio\` topic through the browser.

**Accepted schema:** exactly \`foxglove.RawAudio\` (the settings picker only offers topics with
that schema name, and the panel never decodes anything else). A topic whose schema merely converts
to RawAudio does not qualify. The only audio encoding the playback pipeline handles is
\`pcm-s16\`; the \`foxglove.RawAudio\` messages must carry that \`encoding\`.

\`\`\`json
{ "lichtblickPanelTitle": "Robot audio", "topicPath": "/example/raw_audio", "volume": 1, "muted": false }
\`\`\`

\`/example/raw_audio\` is a placeholder — copy the real topic name byte-for-byte from the catalog
or the workspace summary.

## Config reference

- \`topicPath\` (required, default \`""\`): the topic to play. An empty or unknown topic plays
  nothing; pick the catalog topic whose schema is \`foxglove.RawAudio\`.
- \`volume\` (default \`1\`): 0–1, step 0.05.
- \`muted\` (default \`false\`).

These three keys are the whole config.

## Playback behavior

Audio follows the playhead like any data panel: it plays while playback advances and is silent
while paused. Seeking flushes the audio scheduler and re-anchors the audio clock at the new
position, so a freshly sought position starts quiet until the next audio chunk is received. Expect
a short ramp-up after a seek rather than instant sound.

## Traps

- A speech or music topic that is not \`foxglove.RawAudio\` (for example a \`speech_msgs/...\`
  message) cannot feed this panel — inspect it with \`RawMessages\` instead.
- The topic must actually exist in the loaded source; write its name exactly as the catalog
  spells it, including or excluding a leading slash (see the vita-data-conventions skill).

Not supported (ignored if written): keys from other tools such as \`topic\`,
\`slidingViewWidth\`, or per-message volume control.`,
};
