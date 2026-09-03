// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/** Config facts come from panels/Map/config.ts. Keep them in sync. */
export const PANEL_MAP_SKILL: Skill = {
  id: "panel-map",
  name: "map panel: geographic position and GeoJSON overlays",
  whenToUse: "Before proposing a layout that uses the map panel — layer and follow rules.",
  indexed: false,
  body: `# The \`map\` panel

Topic-based panel: geographic positions and GeoJSON overlays. The panel type is lowercase
\`map\` even though the UI shows "Map". Accepts exactly these schemas (with their name variants):
\`sensor_msgs/NavSatFix\`, \`foxglove.LocationFix\`, \`foxglove.GeoJSON\`.

All eligible topics are drawn unless listed in \`disabledTopics\`.

\`\`\`json
{ "lichtblickPanelTitle": "GPS position", "layer": "map", "followTopic": "/gps/fix", "disabledTopics": [], "topicColors": {} }
\`\`\`

## Config reference

- \`layer\`: \`"map"\` (street tiles), \`"satellite"\`, or \`"custom"\`. With \`"custom"\`,
  \`customTileUrl\` is required and may only contain \`{x}\`, \`{y}\`, \`{z}\` placeholders;
  \`maxNativeZoom\` caps tile zoom.
- \`followTopic\`: the topic the view centers on; it cannot be a GeoJSON topic.
- \`disabledTopics\`: topic names to hide. \`topicColors\`: topic name → CSS color.
- \`center\` \`{ "lat", "lon" }\` and \`zoomLevel\`: initial view when not following.
- Points are plotted only when latitude and longitude are finite.

Not supported (ignored if written): \`topicConfig\`, \`followFrame\`, \`layers\`, per-topic history
or point-style settings, and the layer names \`"street"\` or \`"shaded-relief"\`.

For robot localization, prefer pairing the \`map\` panel with a \`3D\` or robot panel rather than
overloading one view — see the panel-catalog skill.`,
};
