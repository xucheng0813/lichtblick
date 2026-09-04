// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * The `TopicGraph` panel (panels/TopicGraph). Facts come from panels/TopicGraph/index.tsx:
 * `TopicGraph.defaultConfig = {}`, and the graph is built from
 * playerState.activeData.publishedTopics / subscribedTopics / services (node, topic, and service
 * vertices). With no connection information it shows "Waiting for data…". No config keys exist.
 */
export const PANEL_TOPIC_GRAPH_SKILL: Skill = {
  id: "panel-topic-graph",
  name: "TopicGraph panel: node/topic/service graph",
  whenToUse: "Before proposing a layout that uses the TopicGraph panel — live-source constraint.",
  indexed: false,
  body: `# The \`TopicGraph\` panel

**No configuration:** the config must be \`{}\` except for the optional \`lichtblickPanelTitle\`.
Any other config key is ignored or rejected, so pass nothing else.

Draws the ROS computation graph: nodes as rectangles, topics as diamonds, services as
round-rectangles, and the publish/subscribe/provide edges between them, with toolbar controls for
orientation, zoom-to-fit, service visibility, and published/subscribed/connected filtering.

**Live sources only (effectively).** The graph is built from the source's
\`publishedTopics\` / \`subscribedTopics\` / \`services\` connection metadata. A live ROS
connection provides all three; most recordings have none, and the panel then shows "Waiting for
data…" forever. Do not propose \`TopicGraph\` for replay analysis — use \`SourceInfo\` or the
catalog instead.

\`\`\`json
{ "configById": { "TopicGraph!graph": { "lichtblickPanelTitle": "System graph" } } }
\`\`\`

## Traps

- The graph reflects connection state, not the catalog: a topic with no publisher/subscriber
  currently connected is hidden by the connected filter. The topic list in the workspace summary
  is the authoritative topic inventory; the graph is for wiring topology.
- The visibility filters and orientation are panel UI state, not config keys — nothing about
  them can be written in the layout.
- The panel consumes no topic by name, so there is no topic string to verify; there is nothing
  to configure.

See the panel-catalog skill for when an orientation panel fits a layout.`,
};
