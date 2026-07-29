// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Panel capabilities as implemented, not as documented upstream. Every claim here was read out of
 * the panel sources; where the settings-tree filter disagrees with what actually renders (PieChart)
 * this documents the rendering behavior, because that is what determines whether a proposed layout
 * shows data.
 */
export const PANEL_CATALOG_SKILL: Skill = {
  id: "panel-catalog",
  name: "Panel catalog: what each panel can render",
  whenToUse:
    "Before choosing panels for a layout, or when unsure which panel fits a topic's schema.",
  body: `# Panel catalog

Every panel below is on the layout allowlist. Panels not listed here cannot be proposed.

## How panels select data

Panels take data in one of two ways. Confusing the two is the most common layout failure.

- **Topic-based** (\`3D\`, \`Image\`, \`map\`): configured with topic names. The panel decides what to
  do with a topic based on its schema.
- **MessagePath-based** (\`Plot\`, \`StateTransitions\`, \`Gauge\`, \`Indicator\`, \`PieChart\`,
  \`Table\`, \`RawMessages\`, \`RawMessagesVirtual\`): configured with message-path strings such as
  \`/imu/data.linear_acceleration.x\`. The path must resolve to a value of the type the panel wants.
- **No configuration** (\`SourceInfo\`): config must be \`{}\`.

## Schema name variants

A schema is accepted under several spellings. When matching a catalog topic against the lists
below, treat these as equivalent:

- ROS \`pkg/Type\` also matches \`pkg/msg/Type\` and \`ros.pkg.Type\`.
- Foxglove \`foxglove.Type\` also matches \`foxglove_msgs/Type\`, \`foxglove_msgs/msg/Type\`, and
  \`foxglove::Type\`.

A topic also qualifies if the schema appears in its \`convertibleTo\` list, not only as its native
schema name.

---

## 3D

**Before using this panel, read the robot-viz skill.** Two purpose-built robot panels ship with the
application, and a 3D view of a robot should default to the quadruped one — this generic panel is
only correct when the user explicitly asks for the built-in/default 3D panel, or when the scene is
not a robot model.

Renders a 3D scene from many topic kinds at once. Supported schemas, by what they draw:

| Draws | Schemas |
| --- | --- |
| Markers | \`visualization_msgs/Marker\`, \`visualization_msgs/MarkerArray\` |
| Scene entities | \`foxglove.SceneUpdate\` |
| Point clouds | \`sensor_msgs/PointCloud2\`, \`foxglove.PointCloud\` |
| Laser scans | \`sensor_msgs/LaserScan\`, \`foxglove.LaserScan\` |
| Velodyne scans | \`velodyne_msgs/VelodyneScan\` |
| Occupancy grids | \`nav_msgs/OccupancyGrid\` |
| Grids | \`foxglove.Grid\` |
| Poses | \`geometry_msgs/PoseStamped\`, \`geometry_msgs/PoseWithCovarianceStamped\`, \`foxglove.PoseInFrame\` |
| Pose arrays and paths | \`geometry_msgs/PoseArray\`, \`nav_msgs/Path\`, \`foxglove.PosesInFrame\` |
| Polygons | \`geometry_msgs/PolygonStamped\` |
| Camera frustums | \`sensor_msgs/CameraInfo\`, \`foxglove.CameraCalibration\` |
| Images on planes | \`sensor_msgs/Image\`, \`sensor_msgs/CompressedImage\`, \`foxglove.RawImage\`, \`foxglove.CompressedImage\`, \`foxglove.CompressedVideo\` |
| Robot model | \`sensor_msgs/JointState\`; URDF-as-string only from \`std_msgs/String\` |

Transforms are always subscribed: \`foxglove.FrameTransform\`, \`foxglove.FrameTransforms\`,
\`tf2_msgs/TFMessage\`, \`tf/tfMessage\`, \`geometry_msgs/TransformStamped\`.

**Required to show anything:** a topic is only subscribed when it is marked visible.

\`\`\`json
{ "topics": { "/points": { "visible": true }, "/tf": { "visible": true } } }
\`\`\`

An empty config \`{}\` is valid but renders an empty scene. Camera and scene settings can be omitted;
they have working defaults.

## Image

The same renderer in image mode. Configure under \`imageMode\`.

- Image topics: \`sensor_msgs/Image\`, \`sensor_msgs/CompressedImage\`, \`foxglove.RawImage\`,
  \`foxglove.CompressedImage\`, \`foxglove.CompressedVideo\`.
- Calibration topics: \`sensor_msgs/CameraInfo\`, \`foxglove.CameraCalibration\`.
- Annotation topics: \`foxglove.ImageAnnotations\`, \`visualization_msgs/ImageMarker\`,
  \`visualization_msgs/ImageMarkerArray\`.

\`\`\`json
{ "imageMode": { "imageTopic": "/camera/image_raw", "calibrationTopic": "/camera/camera_info" } }
\`\`\`

**Constraint:** without \`calibrationTopic\` the panel runs image-only and 3D overlays are not drawn.
Set it whenever calibration exists and annotations or projected geometry are wanted.

## Plot

Time-series lines from numeric message paths.

Value types: \`bool\`, \`int8\`–\`int64\`, \`uint8\`–\`uint64\`, \`float32\`, \`float64\`, \`string\`,
\`time\`, \`duration\`.

**Every path must be self-contained.** The \`paths\` array replaces the default wholesale; it is not
merged per-field. A path missing \`enabled\` is falsy and draws nothing.

\`\`\`json
{
  "paths": [
    { "value": "/imu/data.linear_acceleration.x", "enabled": true, "timestampMethod": "receiveTime" }
  ]
}
\`\`\`

Useful optional fields: \`label\`, \`color\`, \`lineSize\`, \`showLine\`. Panel-level: \`xAxisVal\`
(\`"timestamp"\` default, or \`"index"\`, \`"custom"\`, \`"currentCustom"\`), \`showLegend\`,
\`legendDisplay\`, \`minYValue\`, \`maxYValue\`.

**Trap:** a \`value\` that parses as a number is treated as a horizontal reference line, not a
series. Use a real message path.

## StateTransitions

Shows how a discrete value changes over time. Same \`paths\` shape as Plot.

Accepted values: number, string, bigint, boolean. A path that resolves to an array is invalid.
Best suited to enums, modes, and status flags.

\`\`\`json
{ "paths": [{ "value": "/nav/state.mode", "timestampMethod": "receiveTime" }] }
\`\`\`

\`enabled\` is optional here; \`timestampMethod\` should still be set.

## Gauge

One numeric value on a dial. Single path.

\`\`\`json
{ "path": "/battery.percentage", "minValue": 0, "maxValue": 100, "colorMode": "colormap", "colorMap": "red-yellow-green" }
\`\`\`

**Always set \`minValue\` and \`maxValue\` to the signal's real range.** They default to 0 and 1, so
any signal with a larger range pins the needle.

\`colorMap\` is one of \`"red-yellow-green"\`, \`"rainbow"\`, \`"turbo"\`. \`gradient\` (exactly two
color strings) applies only when \`colorMode\` is \`"gradient"\`. Values must be numbers or numeric
strings.

## Indicator

A colored state light driven by rules. Single path.

Accepts boolean, number, string, bigint — or a message with a \`data\` field of those types, so a
\`std_msgs/Bool\` topic can be pointed at directly without \`.data\`.

\`\`\`json
{
  "path": "/system/healthy",
  "style": "bulb",
  "fallbackColor": "#a0a0a0",
  "fallbackLabel": "Unknown",
  "rules": [
    { "operator": "=", "rawValue": "true", "color": "#68e24a", "label": "Healthy" },
    { "operator": "=", "rawValue": "false", "color": "#e2564a", "label": "Fault" }
  ]
}
\`\`\`

**\`rawValue\` is always a string**, including for numeric comparisons — write \`"0.5"\`, not \`0.5\`.
Operators: \`=\`, \`<\`, \`<=\`, \`>\`, \`>=\`. Rules are evaluated in order and the first match wins;
if none match, the fallback color and label show. \`style\` is \`"bulb"\` or \`"background"\`.

## PieChart

**Strongest constraint of any panel: the path must resolve to a \`float32[]\` array.** Anything
else — a plain number, a \`float64[]\`, an \`int32[]\` — renders an empty chart. Do not propose this
panel unless the catalog shows a \`float32\` array field.

Values are normalized to percentages of their sum. Slice labels come from \`legend1\`…\`legendN\`.

\`\`\`json
{ "path": "/diagnostics.distribution", "title": "Fault distribution", "legend1": "Nav", "legend2": "Perception" }
\`\`\`

## Table

Latest message rendered as a table. The path must resolve to an **object or an array of objects**;
a scalar renders an empty table.

\`\`\`json
{ "topicPath": "/diagnostics.status" }
\`\`\`

## RawMessages / RawMessagesVirtual

Any schema, no type restriction. Shows the full message tree. \`RawMessagesVirtual\` is the
virtualized variant — prefer it for large messages. Identical config.

\`\`\`json
{ "topicPath": "/nav/odom" }
\`\`\`

Optional diffing: \`diffEnabled\`, \`diffMethod\` (\`"custom"\` or \`"previous message"\`),
\`diffTopicPath\`, \`showFullMessageForDiff\`.

## map

Geographic positions and GeoJSON overlays. Accepts exactly these schemas:
\`sensor_msgs/NavSatFix\`, \`foxglove.LocationFix\`, \`foxglove.GeoJSON\` (with their name variants).

All eligible topics are drawn unless listed in \`disabledTopics\`.

\`\`\`json
{ "layer": "map", "followTopic": "/gps/fix", "disabledTopics": [], "topicColors": {} }
\`\`\`

\`layer\` is \`"map"\`, \`"satellite"\`, or \`"custom"\`. With \`"custom"\`, \`customTileUrl\` may only
contain \`{x}\`, \`{y}\`, \`{z}\` placeholders. \`followTopic\` cannot be a GeoJSON topic. Points are
plotted only when latitude and longitude are finite.

## SourceInfo

Lists the data source, time range, and topic table. Config must be \`{}\`. Useful as a small
orientation panel when the user is exploring an unfamiliar recording.

---

## Making a layout that actually shows data

Layout validation is deliberately permissive: a missing config field passes validation and the
panel falls back to its defaults. That means a layout can be fully valid and still render nothing.
Validation will not catch these, so check them yourself:

- \`Plot\` paths carry \`enabled: true\`.
- \`Plot\` / \`StateTransitions\` \`paths\` is non-empty.
- \`Indicator\` \`rules\` is non-empty and \`rawValue\`s are strings.
- \`Gauge\` \`minValue\`/\`maxValue\` match the signal range.
- \`Gauge\` / \`Indicator\` / \`PieChart\` \`path\`, \`Table\` / \`RawMessages\` \`topicPath\`, and
  \`Image\` \`imageMode.imageTopic\` are non-empty.
- \`3D\` has at least one topic marked \`visible: true\`.
- \`PieChart\` is only used for a \`float32[]\` field.

Message paths are never validated. An unresolvable path surfaces as an in-panel error at runtime,
so only build paths from topics and fields present in the loaded catalog.`,
};
