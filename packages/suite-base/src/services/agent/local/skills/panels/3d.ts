// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from panels/ThreeDeeRender/IRenderer.ts (RendererConfig, FollowMode) and
 * panels/ThreeDeeRender/camera.ts (CameraState, DEFAULT_CAMERA_STATE). Keep them in sync.
 */
export const PANEL_3D_SKILL: Skill = {
  id: "panel-3d",
  name: "3D panel: scene rendering and configuration",
  whenToUse: "Before proposing a layout that uses the 3D panel — exact schema rules and config.",
  indexed: false,
  body: `# The \`3D\` panel

Topic-based panel: configured with topic names; the panel decides what to draw from each topic's
schema. **If the scene is a robot, read the robot-viz skill first** — two purpose-built robot
panels ship with the application and should be the default for robot views; \`3D\` is only correct
when the user explicitly asks for the built-in/default 3D panel, or when the scene is not a robot
model.

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
\`sensor_msgs/PointCloud\` (v1) has no renderer.

**Required to show anything:** a topic is only subscribed when it is marked visible. Transforms
alone never produce geometry — there must also be a renderable topic (marker, point cloud, pose,
path, ...) with \`visible: true\`.

## Config reference

\`\`\`json
{
  "lichtblickPanelTitle": "Point cloud scene",
  "topics": { "/points": { "visible": true }, "/plan": { "visible": true } },
  "followTf": "base_link",
  "followMode": "follow-pose",
  "cameraState": { "perspective": true, "distance": 20, "phi": 60, "thetaOffset": 45 }
}
\`\`\`

- \`topics\`: an **object keyed by topic name**, never an array. \`{ "visible": true }\` is the
  minimum. Other per-topic keys (point size, color mode, decay) depend on the schema and are not
  documented here; set only \`visible\` unless the user names a setting.
- Topic names are copied byte-for-byte from the catalog (\`get_data_catalog\`/\`describe_topic\`
  results): leading slash or none, case, punctuation — never "fix" a name. \`propose_layout\`
  validates the \`topics\` keys against the catalog and rejects unknown names with a
  \`did you mean\` suggestion; correct the proposal and re-submit.
- \`followTf\`: the frame id the camera tracks. \`followMode\`: \`"follow-pose"\` (position and
  orientation), \`"follow-position"\` (position only, world-aligned view), \`"follow-none"\` (the
  camera stays where it is). There is no \`"follow-heading"\`.
- \`cameraState\` (partial objects are fine, missing keys take the defaults): \`perspective\`
  (default \`true\`), \`distance\` in meters (default 20), \`phi\` in degrees from top-down (0 looks
  straight down, 90 along the horizon; default 60), \`thetaOffset\` in degrees, the azimuth around
  the target (default 45), \`targetOffset\` \`[x, y, z]\`, \`fovy\` (default 45), \`near\`, \`far\`.
- \`scene\`: \`backgroundColor\`, \`labelScaleFactor\`, \`meshUpAxis\` (\`"y_up"\` or \`"z_up"\`),
  \`ignoreColladaUpAxis\`, \`enableStats\`, \`syncCamera\`, and a nested \`transforms\` object
  (\`showLabel\`, \`labelSize\`, \`axisScale\`, \`lineWidth\`, \`lineColor\`, \`editable\`,
  \`enablePreloading\`) for how frame axes are drawn.
- Top-level \`transforms\`: per-frame visibility keyed by frame id, \`{ "odom": { "visible": false } }\`;
  distinct from \`scene.transforms\`.
- \`layers\`, \`publish\`, \`imageMode\`: leave out unless the user asks. Guessed keys anywhere in
  this config are silently ignored.

## Camera recipes

- Top-down view that travels with the robot: \`"cameraState": { "perspective": false, "phi": 0 }\`,
  \`followTf\` set to the robot frame, \`"followMode": "follow-position"\`.
- Chase view: \`"followMode": "follow-pose"\`, \`phi\` between 45 and 70, \`distance\` scaled to the
  robot (a few meters for a quadruped, tens for a vehicle). \`thetaOffset\` moves the camera around
  the robot; in this renderer's convention 90 places it behind a +X-forward robot and -90 in front.
  Nothing here can see the rendered result, so tell the user which side you assumed.

An empty config \`{}\` is valid but renders an empty scene. See the panel-catalog skill for how to
choose between \`3D\`, the robot panels, and the \`Image\` panel (the same renderer in image mode).`,
};
