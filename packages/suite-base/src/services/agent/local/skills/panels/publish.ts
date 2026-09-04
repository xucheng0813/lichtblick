// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from PublishConfig and defaultConfig in panels/Publish/types.ts and
 * panels/Publish/settings.ts, and the advertise-capability gate in panels/Publish/index.tsx.
 * Keep them in sync.
 */
export const PANEL_PUBLISH_SKILL: Skill = {
  id: "panel-publish",
  name: "Publish panel: one-shot JSON message publishing",
  whenToUse: "Before proposing a layout that uses the Publish panel — topic, schema, payload.",
  indexed: false,
  body: `# The \`Publish\` panel

No data subscription of its own: a button that publishes one JSON message to a topic when
clicked. The panel advertises the topic itself. Good for commands, triggers, and toggles the user
fires manually.

**Live sources only.** Publishing requires the data source's advertise capability. On a
recording or read-only source the panel shows a message that publishing is not supported and the
button does nothing — never propose \`Publish\` for replay analysis.

\`\`\`json
{
  "lichtblickPanelTitle": "Trigger command",
  "topicName": "/example/command",
  "datatype": "std_msgs/String",
  "buttonText": "Send",
  "buttonTooltip": "Publishes the command",
  "buttonColor": "#4caf50",
  "advancedView": true,
  "value": "{\\n  \\"data\\": \\"go\\"\\n}"
}
\`\`\`

\`/example/command\` is a placeholder — copy the real topic name byte-for-byte from the catalog
or the workspace summary, and take the schema name from the catalog entry for that topic.
\`propose_layout\` does not check \`topicName\` against the catalog — it may be a new topic the
panel advertises; \`datatype\` must be a schema name present in the catalog datatypes, spelled
exactly as the catalog spells it.

## Config reference

- \`topicName\` (optional): the topic to publish on. The settings autocomplete offers the loaded
  topics; picking one also fills its schema. A custom name advertises a new topic.
- \`datatype\` (optional): the schema name of the published message; must be a schema present in
  the loaded source, spelled exactly as the catalog spells it.
- \`buttonText\` (default \`"Publish"\`), \`buttonTooltip\` (default \`""\`),
  \`buttonColor\` (optional CSS color): button presentation.
- \`advancedView\` (default \`true\`): JSON editing mode toggle.
- \`value\` (default \`"{}"\`): the JSON message body as a string. When the user picks a topic
  in the settings the panel fills a sample message for the schema; in a fresh layout write the
  JSON yourself matching the schema's fields.

## Traps

- \`value\` must be valid JSON text and must match the message shape of \`datatype\` — a body
  with the wrong fields still publishes, and the consumer drops or misreads it.
- The topic name you write is what gets advertised; check it against the catalog (the exact
  leading-slash spelling matters) so the robot's subscriber receives it.

Not supported (ignored if written): \`rate\` (no periodic republish — \`Publish\` is one-shot per
click; for continuous commands use \`Teleop\`), \`layout\`, or service keys (use \`CallService\`).`,
};
