// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Router/summary skill for panel selection. The per-panel detail lives in the `panel-*` skills
 * (indexed: false, reached through this body); this skill carries the selection rules, the
 * schema-to-panel decision table, and the catalog-evidence rules (T2) that decide when
 * get_data_catalog is actually needed.
 */
export const PANEL_CATALOG_SKILL: Skill = {
  id: "panel-catalog",
  name: "Panel catalog: choosing the right panel",
  whenToUse:
    "Before choosing panels: schema-to-panel routing and the panel-* skill to load.",
  body: `# Panel catalog

This is the router for panel selection. It tells you which panel fits a topic's schema and which
per-panel skill to load before proposing that panel. The complete live panel inventory in the
system context under "Available panels" is authoritative for which panel types can be proposed —
including runtime extension panels, whose schemas metadata is the authority for what they accept.
\`list_panels\` returns the same inventory on demand (each panel's type, title, description, and
\`skillId\`); for panel types without a \`panel-*\` skill it is your only evidence of what they
do and accept. Extension panels ship no config documentation — prefer copying the complete config
of a same-type panel from \`get_current_layout\`; when there is no template, propose \`{}\` and
tell the user to pick topics in the panel settings. Never guess config keys.

## Base every choice on current catalog evidence

Your evidence is the per-turn workspace summary and the catalog-ready injection. Prefer them over
memory of what a robot "usually" publishes, and use \`get_data_catalog\` freely — it lists topics
as \`{ name, schemaName }\` pairs and never truncates into a raw JSON prefix. Before building a
layout, call \`get_data_catalog({ query })\` with a keyword (\`log\`, \`image\`, \`imu\`, \`bms\`,
…) to find topics, then \`describe_topic({ topics: [...] })\` to get a datatype's field structure
— a field chain — for every message path you write.

Never brute-force topic names with \`read_messages\`; the catalog is the lookup table. A large
catalog truncates at a fixed byte budget, so fetch it minimally: one call per need, not one per
panel. When a result is marked \`truncated\`, narrow it — a more specific \`query\` or the
\`schema\` filter — instead of concluding "there is no such topic". Only when no catalog answer
can be obtained at all do you fall back to schema-driven panels and \`RawMessages\`, and ask the
user rather than guessing paths (see below).

## Two more skills to load

- Whenever a panel takes a message path (every MessagePath-based panel below), load the
  message-path skill for the grammar, the filter and modifier rules, and what each panel needs the
  path to end at.
- When the user reports a panel that shows nothing, a topic that seems empty, or values that look
  wrong, load the data-diagnosis skill before changing any config.

## How panels select data

Panels take data in one of two ways. Confusing the two is the most common layout failure.

- **Topic-based** (\`3D\`, \`Image\`, \`map\`, \`RosOut\`, \`Audio\`): configured with topic names. The panel decides what to
  do with a topic based on its schema.
- **MessagePath-based** (\`Plot\`, \`StateTransitions\`, \`Gauge\`, \`Indicator\`, \`PieChart\`,
  \`Table\`, \`RawMessages\`, \`RawMessagesVirtual\`): configured with message-path strings such as
  \`/imu/data.linear_acceleration.x\`. The path must resolve to a value of the type the panel wants.
- **No configuration** (\`SourceInfo\`): config must be \`{}\` except for the optional
  \`lichtblickPanelTitle\`.

## Schema name variants

A schema is accepted under several spellings. When matching a catalog topic against the lists
below, treat these as equivalent:

- ROS \`pkg/Type\` also matches \`pkg/msg/Type\` and \`ros.pkg.Type\`.
- Foxglove \`foxglove.Type\` also matches \`foxglove_msgs/Type\`, \`foxglove_msgs/msg/Type\`, and
  \`foxglove::Type\`.

A topic also qualifies if the schema appears in its \`convertibleTo\` list, not only as its native
schema name. **RosOut is the exception:** it matches its eight schema names exactly and ignores
\`convertibleTo\` — see the panel-rosout skill for the exact list.

## Matching schema and goal to candidate panels

The rows below are **candidates, not hard rules**: the same schema can feed several panels, and
the user's goal decides between them. "Available panels" / \`list_panels\` always wins when it
disagrees.

| Schema / field shape | User goal | Candidate panels |
| --- | --- | --- |
| \`sensor_msgs/Image\`, \`CompressedImage\`, \`foxglove.RawImage\`, \`CompressedImage\`, \`CompressedVideo\` (+ \`CameraInfo\` / \`CameraCalibration\`) | view a camera feed | \`Image\`, \`3D\` (image on a plane in the scene) |
| \`PointCloud2\`, \`foxglove.PointCloud\`, \`Marker\`/\`MarkerArray\`, \`SceneUpdate\`, \`LaserScan\`, \`OccupancyGrid\`, \`Pose*\`, \`Path\`, \`PolygonStamped\`, \`JointState\`, URDF \`std_msgs/String\` | 3D scene | \`3D\` |
| \`FrameTransform\`/\`FrameTransforms\`, \`tf2_msgs/TFMessage\`, \`TransformStamped\` | transforms | \`3D\` — but transforms alone never show geometry; there must also be a renderable topic marked \`visible: true\` |
| numeric field (\`float32\`/\`float64\`/int/uint/\`bool\`/\`time\`/\`duration\`) | trend over time | \`Plot\` |
| discrete field (number, string, boolean) | state changes / modes / enums over time | \`StateTransitions\` |
| boolean, number, or string field (scalar path; for \`std_msgs/Bool\` and similar use \`/topic.data\` — a topic root resolves to the message object, and the panel then shows only the fallback) | status light | \`Indicator\` |
| single numeric field | dial readout | \`Gauge\` |
| \`float32[]\` array field | distribution | \`PieChart\` — only \`float32[]\`, nothing else |
| object or array-of-objects path | structured detail | \`Table\` |
| any topic, no path needed | raw message inspection | \`RawMessages\`, \`RawMessagesVirtual\` |
| \`NavSatFix\`, \`foxglove.LocationFix\`, \`foxglove.GeoJSON\` | geographic position | \`map\` |
| one of the eight exact Log schema names | log messages | \`RosOut\` |
| \`foxglove.RawAudio\` (\`pcm-s16\` encoding) | listen to audio | \`Audio\` |
| \`diagnostic_msgs/DiagnosticArray\` (also \`diagnostic_msgs/msg/DiagnosticArray\`, \`ros.diagnostic_msgs.DiagnosticArray\`) | robot diagnostics overview | \`DiagnosticSummary\`; detail view of one entry → \`DiagnosticStatusPanel\` |
| any topic or none (user wants several pages or groups in one tile) | paging / grouping | \`Tab\` |
| any topic or none (user wants a draggable knob that drives paths or scripts) | interactive global variable | \`GlobalVariableSliderPanel\` |
| nothing needed | data source context | \`SourceInfo\` |

## The two robot panels

Two purpose-built robot panels ship with the application
(\`Quadruped Visualization.Quadruped Visualization\` and
\`Humanoid Visualization.Humanoid Visualization\`). When a layout needs a 3D view of a robot,
**read the robot-viz skill** before choosing between them and the generic \`3D\` panel — the
quadruped panel is the default.

## Load the per-panel skill before using a panel

Before proposing any of the panels below, load its \`panel-*\` skill — it documents the exact
config keys, defaults, and the constraints that layout validation cannot enforce.

| Panel type | Skill to load |
| --- | --- |
| \`3D\` | \`panel-3d\` |
| \`Plot\` | \`panel-plot\` |
| \`Image\` | \`panel-image\` |
| \`RawMessages\` | \`panel-raw-messages\` |
| \`RawMessagesVirtual\` | \`panel-raw-messages-virtual\` |
| \`Table\` | \`panel-table\` |
| \`Gauge\` | \`panel-gauge\` |
| \`map\` | \`panel-map\` |
| \`StateTransitions\` | \`panel-state-transitions\` |
| \`Indicator\` | \`panel-indicator\` |
| \`PieChart\` | \`panel-pie-chart\` |
| \`SourceInfo\` | \`panel-source-info\` |
| \`RosOut\` | \`panel-rosout\` |
| \`Audio\` | \`panel-audio\` |
| \`DiagnosticSummary\` | \`panel-diagnostic-summary\` |
| \`DiagnosticStatusPanel\` | \`panel-diagnostic-status\` |
| \`Tab\` | \`panel-tab\` |
| \`GlobalVariableSliderPanel\` | \`panel-variable-slider\` |
| \`Teleop\` | \`panel-teleop\` |
| \`Publish\` | \`panel-publish\` |
| \`CallService\` | \`panel-call-service\` |
| \`Parameters\` | \`panel-parameters\` |
| \`TopicGraph\` | \`panel-topic-graph\` |
| \`PlaybackPerformance\` | \`panel-playback-performance\` |
| \`NodePlayground\` | \`panel-user-script-editor\` |

The two robot panels are covered by the robot-viz skill instead.

## Never guess fields or paths

\`propose_layout\` now checks topic names and message paths against the catalog and rejects
unknown topics with a \`did you mean\` suggestion — but validation cannot catch every typo, so
only build paths from topics and fields actually present in the loaded catalog.

- When a datatype's fields are not visible in your evidence (the catalog lists a schema name but
  not its structure), **never guess a field name or a messagePath**; call \`describe_topic\`
  instead.
- Instead, choose a schema-driven panel that needs no path — \`Image\`, \`map\`, \`3D\`, \`RosOut\`
  — or \`RawMessages\`/\`RawMessagesVirtual\`, which need only a topic name.
- Or read one real message with \`read_messages\` and build the path from the fields it actually
  contains (message-path skill).
- Or ask the user which field to show. A guessed path that renders nothing is worse than one
  clarifying question.

Topic names are guessed just as easily: this applies to topic-based panels too. 3D \`topics\`
keys, Image \`imageMode.imageTopic\`, map \`followTopic\`, RosOut \`topicToRender\`, and Audio
\`topicPath\` are all topic names — copy them byte-for-byte from catalog results (leading slash
or none, case, punctuation) and never invent one.

## Live sources

When the workspace summary line reads \`Source kind: live\`, \`read_messages\` and
\`search_messages\` cannot be used — do not call them, do not retry, and do not pretend data was
read. Drive the layout from the schema directly (\`describe_topic\` works on the catalog) and
tell the user that field-level verification needs a recording file.

## Making a layout that actually shows data

Layout validation is deliberately permissive: a missing config field passes validation and the
panel falls back to its defaults. That means a layout can be fully valid and still render nothing.
Validation will not catch these, so check them yourself (each is spelled out in the per-panel
skill):

- \`Plot\` paths carry \`enabled: true\`.
- \`Plot\` / \`StateTransitions\` \`paths\` is non-empty.
- \`Indicator\` \`rules\` is non-empty and \`rawValue\`s are strings.
- \`Gauge\` \`minValue\`/\`maxValue\` match the signal range.
- \`Gauge\` / \`Indicator\` / \`PieChart\` \`path\`, \`Table\` / \`RawMessages\` \`topicPath\`, and
  \`Image\` \`imageMode.imageTopic\` are non-empty.
- \`3D\` has at least one topic marked \`visible: true\`.
- Every panel config carries a non-empty \`lichtblickPanelTitle\` (see the layout-authoring
  skill for the rule and its Table/RawMessages/RawMessagesVirtual exceptions).
- \`PieChart\` is only used for a \`float32[]\` field.
- \`RosOut\` \`topicToRender\` names a topic whose schema is one of the eight exact Log schemas
  (\`convertibleTo\` does not qualify).

## Platform conventions

For Vita/aorta recordings, load the \`vita-data-conventions\` skill before writing any topic
name: that fleet mixes slash-prefixed and slash-less topic spellings in one recording, and has
specific log, audio, GNSS, joint, collectd, and battery topics with sharp edges.`,
};
