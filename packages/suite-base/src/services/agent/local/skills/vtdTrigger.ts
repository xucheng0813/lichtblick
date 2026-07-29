// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

export const VTD_TRIGGER_SKILL: Skill = {
  id: "vtd-trigger",
  name: "VTD trigger lookup: from a trigger id to its data",
  whenToUse: "When the user supplies a triggerId rather than a record id or a time range.",
  body: `# Looking up data by trigger id

A triggerId identifies an event reported by a robot. One trigger can have several data records and
app logs attached. \`vtd_trigger\` resolves a triggerId to those attachments.

Use this instead of \`vtd_search\` whenever the user quotes a trigger id — searching by time around
a trigger is guesswork when the exact link is available.

## Usage

\`\`\`json
{ "triggerId": "yD6gPR3MX" }
\`\`\`

By default the result is filtered to what is usually wanted: only full data (\`dataType\` 1) and
trigger data (\`dataType\` 2), with the \`bms\` and \`wokeup_sound_detected\` trigger types removed.

Set \`all: true\` to bypass that filtering and see every attached record, including simulation and
collected data. Reach for it when the default result is empty but the trigger is known to exist.

This tool is read-only and needs no confirmation.

## Result shape

The response is returned as received, without normalization, because its shape has no stable
contract yet. Read it rather than assuming field names, and quote back what you actually found.
Record ids taken from it can be passed to \`vtd_detail\`, \`vtd_topics\`, \`vtd_slice_store\`, and
\`vtd_presign\` as usual.

If the lookup fails, the trigger id most likely does not exist — check it with the user rather than
retrying with variations.`,
};
