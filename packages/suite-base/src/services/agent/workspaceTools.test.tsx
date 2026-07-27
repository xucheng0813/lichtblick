/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { renderHook } from "@testing-library/react";

import { useDataSourceInfo } from "@lichtblick/suite-base/PanelAPI";
import { useCurrentLayoutActions } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import { usePlayerSelection } from "@lichtblick/suite-base/context/PlayerSelectionContext";

import { useAgentWorkspaceTools } from "./workspaceTools";

jest.mock("@lichtblick/suite-base/PanelAPI", () => ({
  useDataSourceInfo: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/CurrentLayoutContext", () => ({
  useCurrentLayoutActions: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/LayoutManagerContext", () => ({
  useLayoutManager: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/PlayerSelectionContext", () => ({
  usePlayerSelection: jest.fn(),
}));

describe("useAgentWorkspaceTools", () => {
  const selectSource = jest.fn();
  const saveNewLayout = jest.fn();
  const setSelectedLayoutId = jest.fn();
  const getCurrentLayoutState = jest.fn();
  const topics = [{ name: "/camera", schemaName: "sensor_msgs/Image" }];
  const datatypes = new Map([["sensor_msgs/Image", { definitions: [] }]]);

  beforeEach(() => {
    jest.resetAllMocks();

    (usePlayerSelection as jest.Mock).mockReturnValue({ selectSource });
    (useLayoutManager as jest.Mock).mockReturnValue({ saveNewLayout });
    (useCurrentLayoutActions as jest.Mock).mockReturnValue({
      getCurrentLayoutState,
      setSelectedLayoutId,
    });
    (useDataSourceInfo as jest.Mock).mockReturnValue({ topics, datatypes });
  });

  it("opens remote URLs through the remote-file data source", () => {
    const { result } = renderHook(() => useAgentWorkspaceTools());

    result.current.openDataSource([
      "https://example.com/first.mcap",
      "https://example.com/second.mcap",
    ]);

    expect(selectSource).toHaveBeenCalledWith("remote-file", {
      type: "connection",
      params: {
        url: "https://example.com/first.mcap,https://example.com/second.mcap",
      },
    });
  });

  it("rejects an empty remote URL list", () => {
    const { result } = renderHook(() => useAgentWorkspaceTools());

    expect(() => {
      result.current.openDataSource([]);
    }).toThrow("Agent data source must include at least one URL");
    expect(selectSource).not.toHaveBeenCalled();
  });

  it("rejects remote URLs containing literal commas", () => {
    const { result } = renderHook(() => useAgentWorkspaceTools());

    expect(() => {
      result.current.openDataSource(["https://example.com/segment,part.mcap"]);
    }).toThrow(
      "Agent data source URLs must not contain literal commas; encode commas as %2C",
    );
    expect(selectSource).not.toHaveBeenCalled();
  });

  it("returns the current data source catalog", () => {
    const { result } = renderHook(() => useAgentWorkspaceTools());

    expect(result.current.getCatalog()).toEqual({ topics, datatypes });
  });

  it("saves a creator-owned layout and selects it", async () => {
    const layoutData = {
      configById: {},
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {},
    };
    const layout = { id: "layout-id" };
    saveNewLayout.mockResolvedValue(layout);
    const { result } = renderHook(() => useAgentWorkspaceTools());

    await result.current.applyLayout("Agent layout", layoutData);

    expect(saveNewLayout).toHaveBeenCalledWith({
      name: "Agent layout",
      data: layoutData,
      permission: "CREATOR_WRITE",
    });
    expect(setSelectedLayoutId).toHaveBeenCalledWith(layout.id);
  });

  it("rejects invalid layout data before saving", async () => {
    const { result } = renderHook(() => useAgentWorkspaceTools());

    await expect(
      result.current.applyLayout("Invalid layout", {
        configById: {},
        globalVariables: {},
        playbackConfig: {},
        userNodes: {},
      }),
    ).rejects.toThrow("playbackConfig.speed must be a finite number");
    expect(saveNewLayout).not.toHaveBeenCalled();
    expect(setSelectedLayoutId).not.toHaveBeenCalled();
  });

  it("propagates layout save failures without selecting a layout", async () => {
    const error = new Error("IndexedDB unavailable");
    saveNewLayout.mockRejectedValue(error);
    const { result } = renderHook(() => useAgentWorkspaceTools());

    await expect(
      result.current.applyLayout("Agent layout", {
        configById: {},
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
      }),
    ).rejects.toBe(error);
    expect(setSelectedLayoutId).not.toHaveBeenCalled();
  });

  it("does not await the publicly void layout selection API", async () => {
    const layout = { id: "layout-id" };
    saveNewLayout.mockResolvedValue(layout);
    setSelectedLayoutId.mockReturnValue(undefined);
    const { result } = renderHook(() => useAgentWorkspaceTools());

    await result.current.applyLayout("Agent layout", {
      configById: {},
      globalVariables: {},
      playbackConfig: { speed: 1 },
      userNodes: {},
    });

    expect(setSelectedLayoutId).toHaveBeenCalledWith(layout.id);
    expect(getCurrentLayoutState).not.toHaveBeenCalled();
  });

  it("returns the selected layout data", () => {
    const layoutData = { layout: "Plot!agent" };
    getCurrentLayoutState.mockReturnValue({
      selectedLayout: { id: "layout-id", data: layoutData },
    });
    const { result } = renderHook(() => useAgentWorkspaceTools());

    expect(result.current.getCurrentLayout()).toBe(layoutData);
  });
});
