// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Semantics come from vtd-cli/docs/README.md (`vtd trigger`). The sidecar exposes only the
 * `--all` flag; `--nearby`, `--download`, `--out`, `--foxglove`, and `vtd trigger status` are not
 * reachable from the agent.
 */
export const VTD_TRIGGER_SKILL: Skill = {
  id: "vtd-trigger",
  name: "Looking up data by trigger id",
  whenToUse:
    "When the user gives a triggerId rather than a record id or time range.",
  body: `# Looking up data by trigger id

A triggerId identifies an event reported by a robot (ids look like \`EA006126032817555872\` or
\`yD6gPR3MX\`). One trigger can have several data records and app logs attached. \`vtd_trigger\`
runs \`vtd trigger <triggerId>\` and resolves the id to those attachments.

Use this instead of \`vtd_search\` whenever the user quotes a trigger id — searching by time around
a trigger is guesswork when the exact link is available.

## Usage

\`\`\`json
{ "triggerId": "yD6gPR3MX" }
\`\`\`

By default the result is filtered to what is usually wanted: only full data (\`dataType\` 1) and
trigger data (\`dataType\` 2), with \`bms\` and \`wokeup_sound_detected\` records removed, and any
record that carries one topic or none dropped as well.

Set \`all: true\` to bypass that filtering and see every attached record, including simulation and
collected data and the single-topic ones. Reach for it when the default result is empty but the
trigger is known to exist.

This tool is read-only and needs no confirmation.

## Result shape

The response is returned as received, without normalization, because its shape has no stable
contract yet. As documented for the CLI it carries the trigger header (trigger id, device id,
SN, bot name, alarm time, owner) and three arrays:

- \`matches\`: the data records (data id, trigger type, data type, TOS path, download link),
- \`log_matches\`: log archive records from the log warehouse,
- \`app_logs\`: application log files with download links.

Read it rather than assuming field names, and quote back what you actually found. Record ids
taken from \`matches\` can be passed to \`vtd_detail\`, \`vtd_topics\`, \`vtd_slice_store\`, and
\`vtd_presign\` as usual. The download links inside \`matches\` are presigned and short-lived;
to open a record in Lichtblick, get a fresh URL with \`vtd_presign\` and then
\`open_data_source\`.

## Related questions this tool does not answer

- "Which other triggers fired on this robot around the same time": the CLI's \`--nearby\` is not
  exposed. Use \`vtd_search\` with \`botSnExact\` from the trigger header and \`at\` (±5 s) or a
  \`start\`/\`end\` window of a few minutes around the alarm time.
- "Was an issue or Jira created for this trigger": that is \`vtd trigger status <triggerId>\` in
  the CLI, not reachable from here; name the command for the user.
- App-log contents by module: \`vtd alog --trigger <id>\` in the CLI.

If the lookup fails, the trigger id most likely does not exist — check it with the user rather than
retrying with variations.`,
};
