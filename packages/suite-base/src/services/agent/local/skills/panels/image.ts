// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from ImageModeConfig in panels/ThreeDeeRender/IRenderer.ts and
 * ColorModeSettings in panels/ThreeDeeRender/renderables/colorMode.ts. Keep them in sync.
 */
export const PANEL_IMAGE_SKILL: Skill = {
  id: "panel-image",
  name: "Image panel: camera view configuration",
  whenToUse: "Before proposing a layout that uses the Image panel — image and calibration topics.",
  indexed: false,
  body: `# The \`Image\` panel

Topic-based panel: configured with topic names. It is the same renderer as the \`3D\` panel in
image mode; the difference is only which config keys are used. If the scene is a robot, read the
robot-viz skill first.

Schemas:

- Image topics: \`sensor_msgs/Image\`, \`sensor_msgs/CompressedImage\`, \`foxglove.RawImage\`,
  \`foxglove.CompressedImage\`, \`foxglove.CompressedVideo\`.
- Calibration topics: \`sensor_msgs/CameraInfo\`, \`foxglove.CameraCalibration\`.
- Annotation topics: \`foxglove.ImageAnnotations\`, \`visualization_msgs/ImageMarker\`,
  \`visualization_msgs/ImageMarkerArray\`.

\`\`\`json
{ "lichtblickPanelTitle": "Front camera", "imageMode": { "imageTopic": "/camera/image_raw", "calibrationTopic": "/camera/camera_info" } }
\`\`\`

## Config reference: everything image-specific lives under \`imageMode\`

- \`imageTopic\`: required to show anything.
- \`calibrationTopic\`: required for any projected geometry or annotation; **without it the panel
  runs image-only and 3D overlays are not drawn.** Set it whenever calibration exists.
- \`annotations\`: \`{ "/camera/annotations": { "visible": true } }\`.
- \`synchronize\` (boolean): only draw annotations whose stamp matches the image.
- \`rotation\` (\`0\`, \`90\`, \`180\`, \`270\`), \`flipHorizontal\`, \`flipVertical\`, \`brightness\`,
  \`contrast\`.
- Single-channel images (depth, mono16, 32FC1): \`colorMode\` (\`"flat"\`, \`"gradient"\`,
  \`"colormap"\`, \`"rgb"\`, \`"rgba"\`, \`"rgba-fields"\`), \`colorMap\` (\`"turbo"\`, \`"rainbow"\`),
  \`gradient\` (two colors), \`flatColor\`, \`colorField\`, and \`minValue\` / \`maxValue\` for the
  black and white bounds.

Not supported (ignored if written): a top-level \`topic\`, \`cameraTopic\`, or \`imageTopic\`;
\`overlayTopics\`; \`rectifyImage\`; \`imageSchemaName\`.

The panel also accepts the \`3D\` panel's \`topics\`, \`transforms\`, \`layers\`, and \`scene\` keys
to project markers or point clouds onto the image; those need \`calibrationTopic\` and a transform
chain to the camera frame.

For a camera wall with several feeds, prefer one \`Image\` panel per camera in a Mosaic column.
For compressed-video topics, keep the number of simultaneously decoded video panels low — decoding
several video streams at once degrades playback.

See the panel-catalog skill for how \`Image\` competes with \`3D\` and the robot panels when the
user asks for a camera view.`,
};
