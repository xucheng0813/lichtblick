/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import "@testing-library/jest-dom";
import { fireEvent, render } from "@testing-library/react";
import { useContext } from "react";
import { type StoreApi } from "zustand";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import MockMessagePipelineProvider from "@lichtblick/suite-base/components/MessagePipeline/MockMessagePipelineProvider";
import MultiProvider from "@lichtblick/suite-base/components/MultiProvider";
import StudioToastProvider from "@lichtblick/suite-base/components/StudioToastProvider";
import AppConfigurationContext from "@lichtblick/suite-base/context/AppConfigurationContext";
import LayoutManagerContext from "@lichtblick/suite-base/context/LayoutManagerContext";
import {
  WorkspaceContext,
  type WorkspaceContextStore,
} from "@lichtblick/suite-base/context/Workspace/WorkspaceContext";
import MockCurrentLayoutProvider from "@lichtblick/suite-base/providers/CurrentLayoutProvider/MockCurrentLayoutProvider";
import TimelineInteractionStateProvider from "@lichtblick/suite-base/providers/TimelineInteractionStateProvider";
import WorkspaceContextProvider from "@lichtblick/suite-base/providers/WorkspaceContextProvider";
import MockLayoutManager from "@lichtblick/suite-base/services/LayoutManager/MockLayoutManager";
import ThemeProvider from "@lichtblick/suite-base/theme/ThemeProvider";
import { makeMockAppConfiguration } from "@lichtblick/suite-base/util/makeMockAppConfiguration";

import { AppBar } from ".";

function Wrapper({
  agentEnabled,
  children,
}: React.PropsWithChildren<{ agentEnabled?: boolean }>): React.JSX.Element {
  const appConfiguration = makeMockAppConfiguration(
    agentEnabled == undefined ? [] : [[AppSetting.AGENT_ENABLED, agentEnabled]],
  );
  const providers = [
    /* eslint-disable react/jsx-key */
    <WorkspaceContextProvider />,
    <AppConfigurationContext.Provider value={appConfiguration} />,
    <StudioToastProvider />,
    <TimelineInteractionStateProvider />,
    <MockMessagePipelineProvider />,
    <MockCurrentLayoutProvider />,
    <ThemeProvider isDark />,
    <LayoutManagerContext.Provider value={new MockLayoutManager()} />,
    /* eslint-enable react/jsx-key */
  ];
  return <MultiProvider providers={providers}>{children}</MultiProvider>;
}

describe("<AppBar />", () => {
  it("hides the agent entry by default and when explicitly disabled", () => {
    const root = render(
      <Wrapper>
        <AppBar />
      </Wrapper>,
    );

    expect(root.queryByTestId("agent-chat-button")).toBeNull();

    root.rerender(
      <Wrapper agentEnabled={false}>
        <AppBar />
      </Wrapper>,
    );
    expect(root.queryByTestId("agent-chat-button")).toBeNull();
  });

  it("renders the agent entry when enabled", () => {
    let workspaceStore: StoreApi<WorkspaceContextStore> | undefined;
    function CaptureWorkspaceStore(): null {
      workspaceStore = useContext(WorkspaceContext);
      return null;
    }
    const root = render(
      <Wrapper agentEnabled>
        <CaptureWorkspaceStore />
        <AppBar />
      </Wrapper>,
    );

    const button = root.getByTestId("agent-chat-button");
    fireEvent.click(button);

    expect(workspaceStore?.getState().sidebars.right).toMatchObject({
      item: "agent-chat",
      open: true,
    });
    expect(button).toHaveClass("Mui-selected");
  });

  it("calls functions for custom window controls", async () => {
    const mockMinimize = jest.fn();
    const mockMaximize = jest.fn();
    const mockUnmaximize = jest.fn();
    const mockClose = jest.fn();

    const root = render(
      <Wrapper>
        <AppBar
          showCustomWindowControls
          onMinimizeWindow={mockMinimize}
          onMaximizeWindow={mockMaximize}
          onUnmaximizeWindow={mockUnmaximize}
          onCloseWindow={mockClose}
        />
      </Wrapper>,
    );

    const minButton = await root.findByTestId("win-minimize");
    minButton.click();
    expect(mockMinimize).toHaveBeenCalled();

    const maxButton = await root.findByTestId("win-maximize");
    maxButton.click();
    expect(mockMaximize).toHaveBeenCalled();
    expect(mockUnmaximize).not.toHaveBeenCalled();

    root.rerender(
      <Wrapper>
        <AppBar
          showCustomWindowControls
          onMinimizeWindow={mockMinimize}
          onMaximizeWindow={mockMaximize}
          onUnmaximizeWindow={mockUnmaximize}
          onCloseWindow={mockClose}
          isMaximized
          initialZoomFactor={1}
        />
      </Wrapper>,
    );
    maxButton.click();
    expect(mockUnmaximize).toHaveBeenCalled();

    const closeButton = await root.findByTestId("win-close");
    closeButton.click();
    expect(mockClose).toHaveBeenCalled();

    root.unmount();
  });
});
