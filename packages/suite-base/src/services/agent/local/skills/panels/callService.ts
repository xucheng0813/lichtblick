// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from Config and defaultConfig in panels/CallService/types.ts and
 * panels/CallService/settings.ts, and the callService capability gate in
 * panels/CallService/CallService.tsx. Keep them in sync.
 */
export const PANEL_CALL_SERVICE_SKILL: Skill = {
  id: "panel-call-service",
  name: "CallService panel: ROS service call button",
  whenToUse: "Before proposing a layout that uses the CallService panel — service name and request payload.",
  indexed: false,
  body: `# The \`CallService\` panel

No data subscription of its own: a button that calls a ROS service with a JSON request payload
and shows the response. Good for on-demand actions that are exposed as services (trigger, reset,
query).

**Live sources only.** Calling requires a live connection with the \`callService\` capability.
On a recording or read-only source the panel reports that calling services is not supported and
the button does nothing — never propose \`CallService\` for replay analysis.

\`\`\`json
{
  "lichtblickPanelTitle": "Reset odometry",
  "serviceName": "/example/reset_odometry",
  "requestPayload": "{}",
  "layout": "vertical",
  "buttonText": "Call",
  "buttonTooltip": "Calls the reset service"
}
\`\`\`

\`/example/reset_odometry\` is a placeholder — copy the real service name byte-for-byte from the
live source's service list (the settings autocomplete offers it), including or excluding the
leading slash exactly as listed.

## Config reference

- \`serviceName\` (optional): the service to call. Empty shows a settings error until one is
  chosen. Pick a service that actually exists in the live source.
- \`requestPayload\` (default \`"{}"\`): the JSON request body. Must match the service's request
  schema — an empty \`{}\` works only for services whose request has no required fields.
- \`layout\` (default \`"vertical"\`): \`"vertical"\` or \`"horizontal"\` arrangement of the
  button and response area.
- \`buttonText\` (optional), \`buttonTooltip\` (optional), \`buttonColor\` (optional CSS color):
  button presentation.

## Traps

- The request payload is the service **request**, not a topic message; read the service's request
  schema (from the live connection's service information) before writing fields into it.
- Responses appear in the panel only; to chart a response field, the service would have to
  publish it on a topic, which this panel does not do.

Not supported (ignored if written): \`topicName\`, \`datatype\`, \`value\`, or \`publishRate\`
keys from other panels (use \`Publish\`/panel-publish or \`Teleop\`/panel-teleop for topic
publishing).`,
};
