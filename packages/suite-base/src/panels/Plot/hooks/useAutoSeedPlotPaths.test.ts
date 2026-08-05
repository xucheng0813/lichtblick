/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { renderHook } from "@testing-library/react";

import type { MessagePathStructureItem } from "@lichtblick/message-path";
import * as PanelAPI from "@lichtblick/suite-base/PanelAPI";
import { useStructuredItemsByPath } from "@lichtblick/suite-base/components/MessagePathSyntax/useStructureItemsByPath";
import { DEFAULT_PLOT_CONFIG } from "@lichtblick/suite-base/panels/Plot/constants";
import type { PlotConfig } from "@lichtblick/suite-base/panels/Plot/utils/config";
import type { Topic } from "@lichtblick/suite-base/players/types";

import useAutoSeedPlotPaths from "./useAutoSeedPlotPaths";

jest.mock("@lichtblick/suite-base/PanelAPI", () => ({
  useDataSourceInfo: jest.fn(),
}));

jest.mock(
  "@lichtblick/suite-base/components/MessagePathSyntax/useStructureItemsByPath",
  () => ({ useStructuredItemsByPath: jest.fn() }),
);

const numericLeaf: MessagePathStructureItem = {
  structureType: "primitive",
  primitiveType: "float64",
  datatype: "float64",
};
const stringLeaf: MessagePathStructureItem = {
  structureType: "primitive",
  primitiveType: "string",
  datatype: "string",
};
const topics: Topic[] = [{ name: "/odometry", schemaName: "nav_msgs/Odometry" }];
const seededPath = {
  value: "/odometry.twist.twist.linear.x",
  enabled: true,
  timestampMethod: "receiveTime" as const,
  label: "vx",
};

function config(overrides: Partial<PlotConfig> = {}): PlotConfig {
  return { ...DEFAULT_PLOT_CONFIG, paths: [], ...overrides };
}

function mockCatalog(
  items: ReadonlyMap<string, MessagePathStructureItem>,
  catalogTopics: readonly Topic[] = topics,
): void {
  (useStructuredItemsByPath as jest.Mock).mockReturnValue(items);
  (PanelAPI.useDataSourceInfo as jest.Mock).mockReturnValue({ topics: catalogTopics });
}

describe("useAutoSeedPlotPaths", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCatalog(new Map([[seededPath.value, numericLeaf]]));
  });

  it("saves numeric paths once when an empty unseeded plot receives a catalog", () => {
    const saveConfig = jest.fn();
    const initialConfig = config();

    renderHook(() => {
      useAutoSeedPlotPaths(initialConfig, saveConfig);
    });

    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledWith({ paths: [seededPath], autoSeeded: true });
  });

  it("does not seed plots with paths, plots already marked as seeded, or catalogs without topics", () => {
    const saveConfig = jest.fn();
    const { rerender } = renderHook(
      ({ plotConfig }) => {
        useAutoSeedPlotPaths(plotConfig, saveConfig);
      },
      {
        initialProps: {
          plotConfig: config({ paths: [seededPath] }),
        },
      },
    );

    rerender({ plotConfig: config({ autoSeeded: true }) });
    mockCatalog(new Map([[seededPath.value, numericLeaf]]), []);
    rerender({ plotConfig: config() });

    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("does not mark the plot when the catalog has no numeric paths", () => {
    mockCatalog(new Map([["/odometry.child_frame_id", stringLeaf]]));
    const saveConfig = jest.fn();

    renderHook(() => {
      useAutoSeedPlotPaths(config(), saveConfig);
    });

    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("retries when topics arrive after mount", () => {
    const items = new Map([[seededPath.value, numericLeaf]]);
    mockCatalog(items, []);
    const saveConfig = jest.fn();
    const initialConfig = config();
    const { rerender } = renderHook(() => {
      useAutoSeedPlotPaths(initialConfig, saveConfig);
    });
    expect(saveConfig).not.toHaveBeenCalled();

    mockCatalog(items, topics);
    rerender();

    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it("does not seed again after the user clears previously seeded paths", () => {
    const saveConfig = jest.fn();
    const initialConfig = config();
    const { rerender } = renderHook(
      ({ plotConfig }) => {
        useAutoSeedPlotPaths(plotConfig, saveConfig);
      },
      { initialProps: { plotConfig: initialConfig } },
    );
    expect(saveConfig).toHaveBeenCalledTimes(1);

    rerender({ plotConfig: config({ paths: [seededPath], autoSeeded: true }) });
    rerender({ plotConfig: config({ paths: [], autoSeeded: true }) });

    expect(saveConfig).toHaveBeenCalledTimes(1);
  });
});
