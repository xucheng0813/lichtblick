// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { useEffect } from "react";

import * as PanelAPI from "@lichtblick/suite-base/PanelAPI";
import { useStructuredItemsByPath } from "@lichtblick/suite-base/components/MessagePathSyntax/useStructureItemsByPath";
import {
  autoSeedPlotPaths,
  NUMERIC_PLOTABLE_ROS_TYPES,
} from "@lichtblick/suite-base/panels/Plot/utils/autoSeedPaths";
import type { PlotConfig } from "@lichtblick/suite-base/panels/Plot/utils/config";
import type { SaveConfig } from "@lichtblick/suite-base/types/panels";

export default function useAutoSeedPlotPaths(
  config: PlotConfig,
  saveConfig: SaveConfig<PlotConfig>,
): void {
  const structureItemsByPath = useStructuredItemsByPath({
    validTypes: NUMERIC_PLOTABLE_ROS_TYPES,
  });
  const { topics } = PanelAPI.useDataSourceInfo();

  useEffect(() => {
    if (config.paths.length > 0 || config.autoSeeded === true || topics.length === 0) {
      return;
    }
    const paths = autoSeedPlotPaths(structureItemsByPath, topics);
    if (paths.length === 0) {
      return;
    }
    saveConfig({ paths, autoSeeded: true });
  }, [config.autoSeeded, config.paths.length, saveConfig, structureItemsByPath, topics]);
}
