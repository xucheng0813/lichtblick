// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Semantics come from vtd-cli/docs/README.md (`vtd slice-store`, `slice-get`, `url`) and the
 * sidecar whitelist in vtd-sidecar/server.mjs (topics 1–200, int64 nanosecond bounds, no
 * download or Foxglove options). The batch playbook wording is pinned by skills.test.ts.
 */
export const VTD_SLICE_SKILL: Skill = {
  id: "vtd-slice",
  name: "Slicing a recording",
  whenToUse:
    "When a record is large or only some topics or a short window matter.",
  body: `# Slicing a recording

Records are often multiple gigabytes. Slicing extracts just the topics and time window that matter
and stores the result, so playback starts quickly. \`vtd_slice_store\` runs \`vtd slice-store\`,
\`vtd_presign\` runs \`vtd slice-get\` (for a slice) or \`vtd url\` (for a whole record).

## When to slice

Slice when the user names specific topics, or names a time window much shorter than the recording.
Do not slice when they want a broad look at a small recording — opening it directly is simpler and
avoids a confirmation step.

## vtd_slice_store

\`\`\`json
{ "id": "693500", "topics": ["/imu/data", "/odom"], "startNs": "1717214400000000000", "endNs": "1717214460000000000" }
\`\`\`

- \`id\` is required; \`topics\`, \`startNs\`, and \`endNs\` are optional and default to all topics
  and the full data range.
- \`topics\`: 1–200 names, spelled exactly as \`vtd_topics\` returned them (topics without a leading
  slash, such as \`collectd/...\`, are real and must be kept as is). A misspelled topic yields an
  empty slice, not an error.
- **Nanosecond timestamps must be decimal strings**, never JSON numbers — they exceed the exact
  integer range of a double and would be silently corrupted.
- Get the recording's real time bounds first: \`dataStartNs\`/\`dataEndNs\` on the search record,
  or \`data_st\`/\`data_et\` from \`vtd_detail\`. Do not invent a window.

**This tool writes to storage and waits for explicit user confirmation.** Say what will be sliced
and why before calling it. Because it is a confirmation gate, do not batch it speculatively.

The result carries \`mcapSliceId\` (the CLI's \`mcap_slice_id\`, shaped like
\`20250314_SN001_<startMs>_<endMs>_<hash>\`) plus the source and sliced TOS paths under \`raw\`.
The id is derived from date, source, time window, and topic set, so re-requesting an identical
slice is cheap and returns the same id.

## Batch time-window slicing and loading

When the user asks to find every recording for a robot around a precise time, slice that window,
and load the results together, follow this playbook exactly:

1. Resolve the user's time and ±N-second offset into one absolute local-time window. Use the
   current time and browser timezone injected by the system prompt for relative-time conversion,
   then convert both bounds to decimal nanosecond strings.
2. Call \`vtd_search\` with \`botSnExact\` plus \`queryStart\` and \`queryEnd\` to find every record
   whose **data coverage** overlaps the window. Do not substitute trigger-time \`start\`/\`end\`.
3. Call \`request_batch_consent\` exactly once with \`action: "slice_and_load"\`, the matched record
   count in \`itemCount\`, and the complete human-readable plan in \`summary\`: include "M records
   matched", their trigger types and durations, the requested time window, and that the expected
   outputs are stored slices loaded together. If it returns \`approved: false\`, stop the plan and
   briefly say it was cancelled. If it returns \`approved: true\`, continue immediately; never ask
   for consent again in conversational text.
4. After approval, call \`vtd_slice_store\` for every matched record. Set \`startNs\` to the maximum
   of the requested start and that record's \`dataStartNs\` (\`data_st\`); set \`endNs\` to the
   minimum of the requested end and its \`dataEndNs\` (\`data_et\`).
   This intersection prevents out-of-range slices. Skip an empty intersection and record the
   reason.
   Omit \`topics\` to keep all topics by default; if the user specified topics, pass that same
   list to every applicable slice. A session-scoped approval from \`request_batch_consent\` authorizes these slice calls, so
   do not request another confirmation.
5. Call \`vtd_presign\` for every successful \`mcapSliceId\` and collect all \`downloadUrl\` values.
   After every URL is ready, call \`open_data_source\` exactly once with the complete URL array so
   all sources load together. Never open each URL separately.
6. Briefly report the final counts: X slices succeeded, Y records were skipped, and the reason for
   every skip.

## Getting a playable URL

- \`vtd_presign\` with \`sliceId\` returns a temporary URL for a stored slice (the CLI's
  \`download_url\`, alongside \`sliced_data_tos\` under \`raw\`).
- \`vtd_presign\` with \`id\` returns a temporary URL for a complete record.

URLs are presigned and expire. Presign right before opening; if a load fails later in the
conversation, presign again rather than reusing an old URL. Then call \`open_data_source\` with
that URL, or with all collected URLs for the batch playbook.

## Sequencing

Loading is asynchronous and the ordering is enforced:

1. \`vtd_presign\` → URL.
2. \`open_data_source\` → **end the tool turn here**.
3. Wait for the catalog-ready follow-up.
4. Only then \`get_data_catalog\` or \`propose_layout\`.

Calling \`get_data_catalog\`, \`propose_layout\`, or a second \`open_data_source\` in the same tool
batch as \`open_data_source\` is rejected. The catalog does not exist yet at that point.

## Not available through these tools

\`vtd slice\` (download to disk), \`vtd slice-list\`, \`slice-source\`, \`slice-reslice\`, and the
\`--foxglove\` / \`--out\` options are not exposed. If the user wants to re-slice after a source file
was fixed, or list earlier slices, name the CLI command for them.`,
};
