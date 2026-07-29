// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

export const VTD_SLICE_SKILL: Skill = {
  id: "vtd-slice",
  name: "VTD slicing: extracting a subset before opening",
  whenToUse:
    "When a recording is large or the user cares about specific topics or a short time window.",
  body: `# Slicing a recording

Records are often multiple gigabytes. Slicing extracts just the topics and time window that matter
and stores the result, so playback starts quickly.

## When to slice

Slice when the user names specific topics, or names a time window much shorter than the recording.
Do not slice when they want a broad look at a small recording — opening it directly is simpler and
avoids a confirmation step.

## vtd_slice_store

\`\`\`json
{ "id": "693500", "topics": ["/imu/data", "/odom"], "startNs": "1717214400000000000", "endNs": "1717214460000000000" }
\`\`\`

- \`id\` is required; \`topics\`, \`startNs\`, and \`endNs\` are optional and default to everything.
- **Nanosecond timestamps must be decimal strings**, never JSON numbers — they exceed the exact
  integer range of a double and would be silently corrupted.
- Get the recording's real time bounds from \`vtd_detail\` first. Do not invent a window.
- Get topic names from \`vtd_topics\` first. A misspelled topic yields an empty slice, not an error.

**This tool writes to storage and waits for explicit user confirmation.** Say what will be sliced
and why before calling it. Because it is a confirmation gate, do not batch it speculatively.

The result carries \`mcapSliceId\`. Slicing is idempotent — the same source, window, and topic set
always produce the same slice id, so re-requesting an identical slice is cheap and safe.

## Getting a playable URL

- \`vtd_presign\` with \`sliceId\` returns a temporary URL for a stored slice.
- \`vtd_presign\` with \`id\` returns a temporary URL for a complete record.

Then call \`open_data_source\` with that URL.

## Sequencing

Loading is asynchronous and the ordering is enforced:

1. \`vtd_presign\` → URL.
2. \`open_data_source\` → **end the tool turn here**.
3. Wait for the catalog-ready follow-up.
4. Only then \`get_data_catalog\` or \`propose_layout\`.

Calling \`get_data_catalog\`, \`propose_layout\`, or a second \`open_data_source\` in the same tool
batch as \`open_data_source\` is rejected. The catalog does not exist yet at that point.`,
};
