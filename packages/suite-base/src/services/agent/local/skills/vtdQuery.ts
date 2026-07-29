// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

export const VTD_QUERY_SKILL: Skill = {
  id: "vtd-query",
  name: "VTD query: finding and inspecting records",
  whenToUse:
    "Before searching VTD, when a search returns too many or too few records, or to interpret record fields.",
  body: `# Finding and inspecting VTD records

VTD is the recording archive. A record is one uploaded MCAP file plus its metadata.

## vtd_search

Results come back newest first, by trigger time. All filters combine with AND.

### Identity filters

| Parameter | Meaning |
| --- | --- |
| \`id\` | Exact record id. Use when the user quotes an id. |
| \`botSn\` | Bot SN **suffix / alias** match — partial input is fine. |
| \`botSnExact\` | Full exact Bot SN. Use when you have the complete SN. |
| \`botName\` | Fuzzy bot-name match. Names may be non-ASCII. |

Prefer \`botSnExact\` when the user gives a complete SN such as \`8010006BHQ26E8A0072\`; use
\`botSn\` when they give a fragment.

### Classification filters

| Parameter | Values |
| --- | --- |
| \`triggerType\` | Free string, e.g. \`bms\`, \`nav\`, \`crash_report\`, \`wokeup_sound_detected\` |
| \`dataType\` | \`"1"\` full data, \`"2"\` trigger data, \`"3"\` simulation, \`"4"\` collected |
| \`inspection\` | \`"0"\` not inspected, \`"1"\` passed, \`"2"\` failed |
| \`fixData\` | \`"0"\` not repaired, \`"1"\` repaired, \`"2"\` repair failed |

These are strings, not numbers. Do not guess a \`triggerType\` — if the user describes an event in
prose, search without it first and read back the trigger types that actually occur.

### Time filters

Two different clocks, and choosing the wrong one is a common mistake:

- **Trigger time** — when the event fired: \`start\`, \`end\`, \`at\`, \`triggerTime\`.
- **Data coverage** — the span the recording covers: \`queryStart\`, \`queryEnd\`, \`queryTime\`.

Use \`queryTime\` for "what was recorded at 14:30" and \`at\` for "what triggered around 14:30".
\`at\` is a ±5 second shortcut and overrides \`start\`/\`end\`. \`dataDay\` filters by recording day as
\`YYYYMMDD\`.

Accepted time formats: \`"2026-07-27 15:04:05"\`, \`"2026-07-27"\`, \`"2026/07/27 15:04:05"\`,
RFC 3339, or a bare integer timestamp (unit inferred from digit count).

### Paging and ordering

\`page\` from 1, \`pageSize\` up to 100. \`orderBy\` names a field; \`orderDir\` is \`"ASC"\` or
\`"DESC"\`. Start with a small \`pageSize\` while narrowing, and report the total so the user knows
how much was matched.

## Reading results

Each record carries \`id\`, \`botName\`, \`botSn\`, \`triggerType\`, \`dataType\`, \`triggerTime\`, and
\`sizeBytes\`. The full upstream object is under \`raw\`, including fields not surfaced as named
properties — \`data_day\`, \`data_tos\`, \`is_inspection\`, \`is_fix_data\`, and the data start/end
timestamps. Read \`raw\` before telling the user something is unavailable.

Sizes matter: records are frequently multiple gigabytes. Check \`sizeBytes\` before opening a whole
recording, and prefer a slice when the user cares about a short window.

## vtd_detail and vtd_topics

- \`vtd_detail\` returns the complete metadata for one record, including its data start and end
  times — needed to compute a slice window.
- \`vtd_topics\` returns topic names with message counts. Always call this before proposing a
  layout or a topic-filtered slice; never assume which topics a recording contains.

## Working method

1. Search broadly, read back what matched, then narrow with the user.
2. Inspect the chosen record with \`vtd_detail\` and \`vtd_topics\`.
3. Slice if the window is small (see the vtd-slice skill), otherwise get a URL for the full file.
4. Open the data source, wait for the catalog, then propose a layout.

Never invent record ids, topic names, or trigger types. If a search returns nothing, say so and
suggest which filter to relax.`,
};
