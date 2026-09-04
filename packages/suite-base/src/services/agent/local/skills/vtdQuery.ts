// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Semantics come from vtd-cli/docs/README.md (`vtd list`, `detail`, `topics`) and from the
 * sidecar whitelist in vtd-sidecar/server.mjs (which flags are reachable, page/size caps, the
 * fixed `--count` on topics). The normalized record shape comes from services/vtd/HttpVtdClient.
 * Keep all three in sync.
 */
export const VTD_QUERY_SKILL: Skill = {
  id: "vtd-query",
  name: "Finding and inspecting VTD records",
  whenToUse:
    "Only for finding new VTD recordings; already-loaded data never needs it.",
  body: `# Finding and inspecting VTD records

VTD is the recording archive. A record is one uploaded MCAP file plus its metadata. The
\`vtd_*\` tools are a whitelisted front for the \`vtd\` command-line tool: \`vtd_search\` runs
\`vtd list\`, \`vtd_detail\` runs \`vtd detail\`, \`vtd_topics\` runs \`vtd topics --count\`, always
in JSON mode and against the environment the deployment was configured with (you cannot switch
between prod and test).

## vtd_search

Results come back newest first, by trigger time. All filters combine with AND. \`pageSize\` is
1–100 (the CLI default is 15) and \`page\` starts at 1.

### Identity filters

| Parameter | Meaning |
| --- | --- |
| \`id\` | Exact record id. Use when the user quotes an id. |
| \`botSn\` | Legacy alias / suffix match on the SN **or the bot name** — partial input is fine. |
| \`botSnExact\` | Full exact Bot SN. Use when you have the complete SN. |
| \`botName\` | Fuzzy bot-name match. Names may be non-ASCII. |

Prefer \`botSnExact\` when the user gives a complete SN such as \`8010006BHQ26E8A0072\`; use
\`botSn\` when they give a fragment or you are not sure whether it is an SN or a name.

### Classification filters

| Parameter | Values |
| --- | --- |
| \`triggerType\` | Free string, e.g. \`bms\`, \`nav\`, \`crash_report\`, \`wokeup_sound_detected\` |
| \`dataType\` | \`"1"\` full data, \`"2"\` trigger data, \`"3"\` simulation, \`"4"\` collection |
| \`inspection\` | \`"0"\` not inspected, \`"1"\` passed, \`"2"\` failed |
| \`fixData\` | \`"0"\` not fixed, \`"1"\` fixed, \`"2"\` fix failed |

These are strings, not numbers. Do not guess a \`triggerType\` — if the user describes an event in
prose, search without it first and read back the trigger types that actually occur.

### Time filters

Two different clocks, and choosing the wrong one is a common mistake:

- **Trigger time** — when the event fired: \`start\`, \`end\`, \`at\`, \`triggerTime\`.
- **Data coverage** — the span the recording covers: \`queryStart\`, \`queryEnd\`, \`queryTime\`.

Choose the clock from what the user means, not merely from the presence of a timestamp:

- For "data at a particular time", "data during this interval", "the N seconds before and after",
  or "what happened during this period", use \`queryStart\`/\`queryEnd\`. These questions ask which
  recordings' data coverage overlaps the requested interval. Never use \`start\`/\`end\` for them.
- For "what triggered at this time" or "which trigger events fired during this interval", use
  \`start\`/\`end\` or \`at\`. These questions explicitly ask about trigger time.

Use \`queryTime\` for a single instant such as "what was recorded at 14:30" and \`at\` for "what
triggered around 14:30". \`at\` is a ±5 second shortcut and overrides \`start\`/\`end\`. \`dataDay\`
filters by recording day as \`YYYYMMDD\`.

Verified counterexample: for bot \`8010006CHQ26FAA0212\` and local window
\`2026-08-04 15:58:50\`–\`16:00:50\`, \`start\`/\`end\` returned 0 records. The correct
\`queryStart\`/\`queryEnd\` search returned 6 records whose nanosecond \`data_st\`/\`data_et\`
coverage overlapped the window: \`wokeup_sound_detected\`, \`app_report_abnormal\`, \`teleop\`,
\`avatar_teleop\`, \`avatar\`, and \`bms\`.

### Time formats

Always pass a datetime string: \`"2026-07-27 15:04:05"\` (local time), \`"2026-07-27"\`,
\`"2026/07/27 15:04:05"\`, or RFC 3339. Raw integers are accepted too, but their unit depends on
the filter family — the trigger-time filters read milliseconds, the coverage filters read
nanoseconds, and \`start\`/\`end\`/\`at\` guess the unit from the digit count — so an integer is an
easy way to get zero results. Use the string form.

For relative dates such as "yesterday", "today", or "last week" (including "昨天", "今天", and
"上周"), use the current time and browser timezone from the system prompt to resolve an absolute
local date range first. Pass
\`YYYY-MM-DD HH:MM:SS\` local-time values to \`start\`, \`end\`, or \`at\`, and derive \`dataDay\` as
\`YYYYMMDD\` from that local date. Never pass relative-date words directly to a tool.

### Other filters, paging, ordering

\`dataTos\` matches an exact TOS path. \`orderBy\` names a record field and \`orderDir\` is
\`"ASC"\` or \`"DESC"\`; without them the order is trigger time, newest first. Start with a small
\`pageSize\` while narrowing, and report \`total\` so the user knows how much was matched.

## Reporting search results

Search results are presented to the user automatically in an interactive list card, with paging,
sorting, loading, and slicing handled inside the card. Never enumerate matching records one by one
in your reply. Instead, keep the textual summary brief — 1-3 sentences covering the total number
of matches, the time span they cover, the dominant trigger types or bot distribution, and any
notable anomalies worth flagging. Expand a record's details only when the user asks about that
specific record.

## Reading results

Each record carries \`id\`, \`botName\`, \`botSn\`, \`triggerType\`, \`dataType\`, \`triggerTime\`,
\`dataStartNs\`, \`dataEndNs\` (the coverage bounds, decimal nanoseconds, taken from the upstream
\`data_st\`/\`data_et\`), and \`sizeBytes\`. The full upstream object is under \`raw\`, including
\`data_day\`, \`data_tos\`, \`is_inspection\`, \`is_fix_data\`, and \`data_topic_info\`; \`raw\` is
dropped when a large result has to be compacted, so fall back to \`vtd_detail\` for those fields
rather than telling the user something is unavailable. \`total\` is the match count across all
pages.

Sizes matter: records are frequently multiple gigabytes. Check \`sizeBytes\` before opening a whole
recording, and prefer a slice when the user cares about a short window (vtd-slice skill).

## vtd_detail and vtd_topics

- \`vtd_detail\` returns the complete metadata for one record, including its data start and end
  times (\`data_st\`/\`data_et\`, nanoseconds) and the full topic list — needed to compute a slice
  window when the search record lacks \`dataStartNs\`/\`dataEndNs\`.
- \`vtd_topics\` returns a map of topic name → message count for every topic in the record,
  sorted alphabetically. A count of 0 is an empty channel. Always call this before proposing a
  layout or a topic-filtered slice; never assume which topics a recording contains.

## Not available through these tools

The CLI has more commands than the agent can reach: \`vtd sn <SN>\` (device, product, and OTA
info), \`vtd alog\` (application logs by module around a trigger), \`vtd trigger status\` (issue
pipeline stage), \`vtd trigger --nearby\`, \`vtd mcapinfo\`, \`vtd slice-list\` / \`slice-source\` /
\`slice-reslice\`, \`vtd download\`, and \`vtd csv\`. When the user needs one of them, say so and
name the command to run locally; do not improvise a substitute with \`vtd_search\`.

## Errors

Transient upstream failures and rate limits are retried automatically. A \`timeout\` means the CLI
took longer than 30 s — narrow the filters or reduce \`pageSize\` and try once more; then report.

### \`vtd_search\` 502

A \`vtd_search\` call can fail with HTTP 502. Handle it in this order:

1. Retry the identical call once.
2. Still 502: switch to \`dataDay\` per-day queries, or drop \`queryStart\`/\`queryEnd\` and
   search by trigger time instead.
3. Only when both alternatives fail, report the search as failed — and say which filters you
   tried.

## Working method

1. Search broadly, read back what matched, then narrow with the user.
2. Inspect the chosen record with \`vtd_detail\` and \`vtd_topics\`.
3. Slice if the window is small (see the vtd-slice skill), otherwise get a URL for the full file.
4. Open the data source, wait for the catalog, then propose a layout.

Never invent record ids, topic names, or trigger types. If a search returns nothing, say so and
suggest which filter to relax.`,
};
