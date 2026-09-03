// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "./types";

/**
 * Indexed skill: symptom-driven recipes for "nothing shows" and "the data looks wrong". Every
 * recipe is written against the tools this agent actually has (workspace summary,
 * get_data_catalog, vtd_topics, vtd_detail, read_messages, search_messages, playback_control).
 * There is deliberately no screenshot or file-system step: none exists.
 */
export const DATA_DIAGNOSIS_SKILL: Skill = {
  id: "data-diagnosis",
  name: "Diagnosing empty panels and wrong data",
  whenToUse: "When a panel or topic shows nothing or data looks wrong; before claiming no data.",
  body: `# Data diagnosis

Use this when a panel shows nothing, a topic seems missing or empty, values or times look wrong,
playback is slow, or before telling the user "there is no data". Every answer comes from tool
results. There is no screenshot, no file access, and no shell; when a question needs one of those,
say so.

## Where the evidence is

| Question | Source |
| --- | --- |
| What is loaded, which topics, which schemas | the per-turn workspace summary; \`get_data_catalog\` when it is truncated, a topic is missing from it, or you need a datatype's fields |
| How many messages a topic has | \`vtd_topics\` for a VTD record (per-topic counts). The loaded catalog carries no counts |
| The recording's time coverage | \`vtd_detail\` (data start and end) |
| What a message really contains | \`read_messages({ topic, limit })\`; one real sample beats any schema guess |
| Where an error or a text occurs | \`search_messages({ topic, text?, level? })\`; every hit carries \`receiveTimeNs\` |
| Playback position | \`playback_control\` seek returns \`acceptedTimeNs\`; there is no "current time" query, so reason from the times you seeked to |

Only iterable recordings support \`read_messages\` and \`search_messages\`; a live source returns
an error. Report that instead of retrying.

## Message counts

- \`vtd_topics\` count \`0\`: the channel exists but has no messages. Treat it as empty.
- No count field: the count is unknown. Never call that empty; read a window instead.
- A positive count proves messages exist somewhere in the record, not that they cover the window
  the user is looking at.

## Recipes

### "The panel shows nothing"

1. Does the topic exist? Compare the config's topic against the catalog character by character:
   leading slash, case, namespace (\`/robot1/imu\` vs \`/imu\`), and schema-name variants
   (\`pkg/Type\`, \`pkg/msg/Type\`, \`ros.pkg.Type\`; \`foxglove.Type\`, \`foxglove_msgs/Type\`).
2. Is the config the right shape? The silent failures, by panel:
   - \`3D\`: \`topics\` must be an object keyed by topic name with \`visible: true\`; an array
     renders nothing, and transforms alone draw no geometry.
   - \`Plot\`: every path is an object with \`enabled: true\`; a numeric-looking \`value\` is a
     reference line.
   - \`StateTransitions\`, \`Gauge\`, \`Indicator\`: the path must end at a scalar; \`/topic\` alone
     shows the fallback.
   - \`Gauge\`: \`minValue\` / \`maxValue\` default to 0 and 1 and pin the needle.
   - \`Indicator\`: empty \`rules\`, or a \`rawValue\` that is not a string, shows only the fallback.
   - \`PieChart\`: the field must be \`float32[]\`.
   - \`Image\`: the topic lives under \`imageMode.imageTopic\`; overlays need \`calibrationTopic\`.
   - \`RosOut\`: only the eight exact Log schema names; \`convertibleTo\` does not qualify.
   - \`map\`: only NavSatFix, LocationFix, and GeoJSON schemas; \`followTopic\` cannot be GeoJSON.
   Load the panel-* skill and compare key by key.
3. Is there data at the playback time? \`read_messages\` with \`start\` and \`end\` around the
   moment the user is looking at. An empty result with \`scanned: 0\` means nothing in that
   window; check the record's coverage from \`vtd_detail\`.
4. Does the path resolve? Read one message and walk the fields. A renamed field (ROS 1 vs ROS 2)
   or a missing array index is the usual cause; message paths are never validated on apply.

### Before saying "there is no data"

Confirm all three: the topic is in the catalog, the window lies inside the record's coverage,
and \`read_messages\` for that window returned nothing with \`truncated: false\`. A
\`truncated: true\` result means the scan stopped early (50,000 messages or the byte budget), so
narrow the window and read again before concluding.

### "Values look wrong / units"

Read a few messages and state the stored unit before interpreting a number. Radians vs degrees,
m/s vs km/h, bytes vs kB, and per-core vs total percentages are the usual culprits; the
collectd-metrics skill covers host metrics. A \`Plot\` path can apply \`.@rad2deg\`, \`.@abs\`, and
the other math modifiers (message-path skill); any other conversion is a user script.

### "Gaps / dropped messages / rate"

\`read_messages\` on a narrow window with a high \`limit\`, then compare consecutive
\`receiveTimeNs\` values: the typical gap is the period, outliers are gaps. Repeat in two or three
windows before generalizing. Causes are recording-side (network, disk, publisher stalled); no
layout setting fixes them.

### "Timestamps look wrong / playback jumps"

\`receiveTimeNs\` is player time and what seeking uses. A message's own \`header.stamp\` (or
\`timestamp\`) can differ: \`sec: 0\` means the publisher never filled the header, a large offset
means sim time vs wall time. \`Plot\` and \`StateTransitions\` pick one with \`timestampMethod\`
(\`"receiveTime"\` or \`"headerStamp"\`); switch to \`"receiveTime"\` when header stamps are broken.

### "Recording is huge / playback is slow"

\`vtd_search\` and \`vtd_detail\` report \`sizeBytes\`. Image, video, and point-cloud topics
dominate size, and several simultaneously decoded video panels degrade playback. Prefer a slice
(vtd-slice skill) over the full record when the user cares about a short window or a few topics,
and keep \`3D\` \`topics\` limited to what is needed.

### "Transforms are wrong / the 3D scene is empty"

Confirm a transform topic exists (\`tf2_msgs/TFMessage\`, \`tf2_msgs/msg/TFMessage\`,
\`foxglove.FrameTransform\`, \`foxglove.FrameTransforms\`, \`geometry_msgs/TransformStamped\`) and
that at least one renderable topic is \`visible: true\`. Read one transform message to see the
real \`frame_id\` / \`child_frame_id\` names; a \`followTf\` naming a frame outside the tree leaves
the camera on the root frame. For a robot view prefer the robot panels (robot-viz skill), which
subscribe on their own.

## Common schema names

| Logical type | ROS 1 | ROS 2 | Foxglove |
| --- | --- | --- | --- |
| Image | \`sensor_msgs/Image\`, \`sensor_msgs/CompressedImage\` | \`sensor_msgs/msg/Image\`, \`sensor_msgs/msg/CompressedImage\` | \`foxglove.RawImage\`, \`foxglove.CompressedImage\`, \`foxglove.CompressedVideo\` |
| Calibration | \`sensor_msgs/CameraInfo\` | \`sensor_msgs/msg/CameraInfo\` | \`foxglove.CameraCalibration\` |
| Point cloud | \`sensor_msgs/PointCloud2\` | \`sensor_msgs/msg/PointCloud2\` | \`foxglove.PointCloud\` |
| Laser scan | \`sensor_msgs/LaserScan\` | \`sensor_msgs/msg/LaserScan\` | \`foxglove.LaserScan\` |
| IMU | \`sensor_msgs/Imu\` | \`sensor_msgs/msg/Imu\` | — |
| Odometry | \`nav_msgs/Odometry\` | \`nav_msgs/msg/Odometry\` | — |
| GPS | \`sensor_msgs/NavSatFix\` | \`sensor_msgs/msg/NavSatFix\` | \`foxglove.LocationFix\` |
| Transforms | \`tf2_msgs/TFMessage\` | \`tf2_msgs/msg/TFMessage\` | \`foxglove.FrameTransform\`, \`foxglove.FrameTransforms\` |
| Markers | \`visualization_msgs/MarkerArray\` | \`visualization_msgs/msg/MarkerArray\` | \`foxglove.SceneUpdate\` |
| Log | \`rosgraph_msgs/Log\` | \`rcl_interfaces/msg/Log\` | \`foxglove.Log\` |

\`sensor_msgs/PointCloud\` (v1) has no renderer; only \`PointCloud2\` and \`foxglove.PointCloud\`
draw. A schema with no renderer needs a user script that republishes under a supported one.

## Reporting

Give the finding, the evidence (topic, count, window, sample values), and the fix, in that order.
Name a moment as local time plus its \`receiveTimeNs\`, and seek there with \`playback_control\`
when the user wants to look at it. State explicitly what you could not verify; rendering is
never verifiable from here.`,
};
