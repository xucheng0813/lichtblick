// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Skill } from "../types";

/**
 * Config facts come from TabPanelConfig / TabConfig in types/layouts.ts, validateTabPanelConfig
 * and getPanelIdsInsideTabPanels in util/layout.ts, and the Tab panel (TAB_PANEL_TYPE in
 * util/constants.ts). Layout validation validates Tab leaves with the same panelIds set as the
 * root mosaic. Keep them in sync.
 */
export const PANEL_TAB_SKILL: Skill = {
  id: "panel-tab",
  name: "Tab panel: paged layouts inside one tile",
  whenToUse: "Before proposing a layout that uses the Tab panel — nested layout and id rules.",
  indexed: false,
  body: `# The \`Tab\` panel

No data configuration: the \`Tab\` panel is a layout container, not a data panel. Its config is a
\`TabPanelConfig\` \`{ activeTabIdx, tabs: [{ title, layout }] }\` where each tab's \`layout\` is a
Mosaic node (a leaf panel id, or a \`{ direction, first, second, splitPercentage }\` branch) of
the panels shown on that tab. Use it when the user wants multiple pages or groupings inside one
tile instead of more top-level splits.

## Config reference

- \`activeTabIdx\` (required): integer index of the visible tab. Proposal validation accepts
  \`-1 <= activeTabIdx < tabs.length\`. \`-1\` only means "no tab active yet" and pairs with an
  empty \`tabs\` array — an empty \`tabs\` is only valid with \`activeTabIdx: -1\`:

  \`\`\`json
  { "activeTabIdx": -1, "tabs": [] }
  \`\`\`

  With a non-empty \`tabs\`, use \`0 <= activeTabIdx < tabs.length\` (e.g. \`0\` for two tabs).
- \`tabs\` (required): array of \`{ title, layout }\`; \`title\` is the tab label and
  \`layout\` the tab's Mosaic node (it may be omitted for an empty tab). Empty \`[]\` is only
  valid together with \`activeTabIdx: -1\`.

Every leaf panel id inside every tab's \`layout\` must also have a \`configById\` entry in the
layout, exactly like root panels — a leaf missing its config is rejected. All leaf ids share one
global namespace: ids used inside tabs must not collide with root panels or with ids inside other
tabs. The panels inside tabs are configured with their own panel types (e.g. \`Plot\`) using the
other panel-* skills; only the \`Tab\` panel itself carries \`TabPanelConfig\`.

Two-tab example:

\`\`\`json
{
  "configById": {
    "Tab!main": {
      "lichtblickPanelTitle": "Views",
      "activeTabIdx": 0,
      "tabs": [
        {
          "title": "Overview",
          "layout": {
            "direction": "column",
            "first": "Plot!overview",
            "second": "Indicator!status",
            "splitPercentage": 70
          }
        },
        { "title": "Details", "layout": "RawMessages!detail" }
      ]
    },
    "Plot!overview": {
      "lichtblickPanelTitle": "Velocity",
      "paths": [{ "value": "/example/odom.twist.linear.x", "enabled": true }]
    },
    "Indicator!status": {
      "lichtblickPanelTitle": "Healthy",
      "path": "/example/health.data",
      "rules": [{ "operator": "=", "rawValue": "true", "color": "#4caf50", "label": "ok" }]
    },
    "RawMessages!detail": {}
  }
}
\`\`\`

Topics above are placeholders — copy the real ones byte-for-byte from the catalog or the
workspace summary.

## Traps

- \`activeTabIdx\` outside \`-1 <= activeTabIdx < tabs.length\` (for example \`2\` with two
  tabs, \`-1\` with a non-empty \`tabs\`, or a non-integer) makes the Tab panel unusable and
  fails validation — always check it against the tab count you wrote.
- **Adding a panel into a Tab that already exists does not go through in-place incremental
  apply.** Incremental layout apply only looks at the root mosaic. To extend a layout that has a
  Tab, put the new panel at the root mosaic, as a sibling of the \`Tab\` tile — not inside one of
  its tabs. If the user insists on a panel inside a tab, it has to be part of a complete new
  layout proposal.
- Nested \`Tab\` inside a tab is possible but rarely useful; prefer flat tabs per tile.

Not supported (ignored if written): \`direction\`, \`splitPercentage\` at the \`TabPanelConfig\`
level (they belong to Mosaic nodes inside \`tabs[].layout\`), or any data-panel config keys.`,
};
