/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useTranslation } from "react-i18next";

import { LayoutID } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import * as LayoutManagerContext from "@lichtblick/suite-base/context/LayoutManagerContext";
import * as useConfirmModule from "@lichtblick/suite-base/hooks/useConfirm";
import { layoutBrowser as layoutBrowserZh } from "@lichtblick/suite-base/i18n/zh/layoutBrowser";
import LayoutBuilder from "@lichtblick/suite-base/testing/builders/LayoutBuilder";
import { BasicBuilder } from "@lichtblick/test-builders";

import LayoutRow from "./LayoutRow";

// Mocks
jest.mock("react-i18next", () => ({
  useTranslation: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/context/LayoutManagerContext", () => ({
  useLayoutManager: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/hooks/useConfirm", () => ({
  useConfirm: jest.fn(),
}));
jest.mock("./LayoutRow.style", () => ({
  StyledListItem: ({ children, secondaryAction }: any) => (
    <div data-testid="styled-list-item">
      {children}
      {secondaryAction}
    </div>
  ),
  StyledMenuItem: ({ children, disabled, ...props }: any) =>
    disabled === true ? (
      <button data-testid={props["data-testid"] ?? "styled-menu-item"} disabled>
        {children}
      </button>
    ) : (
      <button data-testid={props["data-testid"] ?? "styled-menu-item"} {...props}>
        {children}
      </button>
    ),
}));

const mockLayoutManager = {
  isOnline: true,
  supportsSharing: true,
  on: jest.fn(),
  off: jest.fn(),
};
const mockConfirm = jest.fn();
const mockConfirmModal = <div data-testid="confirm-modal" />;
(LayoutManagerContext.useLayoutManager as jest.Mock).mockReturnValue(mockLayoutManager);
(useConfirmModule.useConfirm as jest.Mock).mockReturnValue([mockConfirm, mockConfirmModal]);
(useTranslation as jest.Mock).mockReturnValue({
  t: (key: string, options?: { layoutName?: string }) =>
    (layoutBrowserZh as Record<string, string>)[key]?.replace(
      "{{layoutName}}",
      options?.layoutName ?? "{{layoutName}}",
    ) ?? key,
});

const layoutId = BasicBuilder.string();
const layoutName = BasicBuilder.string();
const defaultLayout = LayoutBuilder.layout({
  id: layoutId as LayoutID,
  name: layoutName,
  permission: "CREATOR_WRITE",
});

const renderComponent = (props = {}) =>
  render(
    <LayoutRow
      layout={defaultLayout}
      anySelectedModifiedLayouts={false}
      multiSelectedIds={[]}
      selected={false}
      onSelect={jest.fn()}
      onRename={jest.fn()}
      onDuplicate={jest.fn()}
      onDelete={jest.fn()}
      onShare={jest.fn()}
      onExport={jest.fn()}
      onOverwrite={jest.fn()}
      onRevert={jest.fn()}
      onMakePersonalCopy={jest.fn()}
      {...props}
    />,
  );

describe("LayoutRow rendering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("Given default props, when rendered, then displays the layout name", () => {
    renderComponent();
    expect(screen.getByText(layoutName)).toBeInTheDocument();
  });

  it("Given selected=true, when rendered, then the list item is marked as selected", () => {
    renderComponent({ selected: true });
    expect(screen.getByTestId("layout-list-item")).toHaveClass("Mui-selected");
  });

  it("Given a layout with a different name, when rendered, then displays that name", () => {
    renderComponent({ layout: { ...defaultLayout, name: "Another Layout" } });
    expect(screen.getByText("Another Layout")).toBeInTheDocument();
  });

  it("Given multiSelectedIds includes layout id, when rendered, then the list item is marked as selected", () => {
    renderComponent({ multiSelectedIds: [layoutId] });
    expect(screen.getByTestId("layout-list-item")).toHaveClass("Mui-selected");
  });

  it("when menu button is clicked then menu opens and menu items are rendered", () => {
    renderComponent();
    fireEvent.click(screen.getByTestId("layout-actions"));
    expect(screen.getByTestId("rename-layout")).toBeInTheDocument();
    expect(screen.getByText("Export…")).toBeInTheDocument();
    expect(screen.getByTestId("delete-layout")).toBeInTheDocument();
  });

  it("opens the upload-to-organization dialog from the personal layout menu", () => {
    renderComponent();

    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByTestId("upload-layout-to-org"));

    expect(screen.getByRole("dialog", { name: "上传布局到组织" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "布局名称" })).toHaveValue(layoutName);
    expect(screen.getByRole("radio", { name: "组织可编辑" })).toBeChecked();
  });

  it("shows edit description only for a synced remote layout when viz-server is configured", () => {
    const remoteLayout = {
      ...defaultLayout,
      externalId: "remote-layout",
      syncInfo: { status: "tracked" as const, lastRemoteSavedAt: undefined },
    };
    let rendered = renderComponent({
      layout: remoteLayout,
      descriptionEditingEnabled: false,
      onSetDescription: jest.fn(),
    });
    fireEvent.click(screen.getByTestId("layout-actions"));
    expect(screen.queryByTestId("edit-layout-description")).not.toBeInTheDocument();
    rendered.unmount();

    rendered = renderComponent({
      layout: { ...remoteLayout, externalId: undefined, syncInfo: undefined },
      descriptionEditingEnabled: true,
      onSetDescription: jest.fn(),
    });
    fireEvent.click(screen.getByTestId("layout-actions"));
    expect(screen.queryByTestId("edit-layout-description")).not.toBeInTheDocument();
    rendered.unmount();

    renderComponent({
      layout: remoteLayout,
      descriptionEditingEnabled: true,
      onSetDescription: jest.fn(),
    });
    fireEvent.click(screen.getByTestId("layout-actions"));
    expect(screen.getByTestId("edit-layout-description")).toBeInTheDocument();
  });

  it("shows edit description for a remote personal layout without sync info", () => {
    renderComponent({
      layout: {
        ...defaultLayout,
        externalId: "remote-personal-layout",
        permission: "CREATOR_WRITE",
        syncInfo: undefined,
      },
      descriptionEditingEnabled: true,
      onSetDescription: jest.fn(),
    });

    fireEvent.click(screen.getByTestId("layout-actions"));

    expect(screen.getByTestId("edit-layout-description")).toBeInTheDocument();
  });

  it("submits the description from the dialog with the layout id", async () => {
    const onSetDescription = jest.fn().mockResolvedValue(true);
    const remoteLayout = {
      ...defaultLayout,
      externalId: "remote-layout",
      syncInfo: { status: "tracked" as const, lastRemoteSavedAt: undefined },
    };
    renderComponent({
      layout: remoteLayout,
      descriptionEditingEnabled: true,
      onSetDescription,
    });

    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByTestId("edit-layout-description"));
    fireEvent.change(screen.getByRole("textbox", { name: "布局描述" }), {
      target: { value: "用于查看设备诊断数据" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onSetDescription).toHaveBeenCalledWith(
        remoteLayout.id,
        "用于查看设备诊断数据",
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "编辑布局描述" })).not.toBeInTheDocument();
    });
  });

  it("when rename menu item is clicked then text field for editing name appears", async () => {
    renderComponent();
    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByTestId("rename-layout"));
    await waitFor(() => {
      const input = screen.getByTestId("layout-list-item").querySelector('input[type="text"]');
      expect(input).toBeInTheDocument();
    });
  });

  it("disables write actions for an ORG_READ layout", () => {
    const readOnlyLayout = {
      ...defaultLayout,
      externalId: "read-only-layout",
      permission: "ORG_READ" as const,
      working: defaultLayout.baseline,
      syncInfo: { status: "tracked" as const, lastRemoteSavedAt: undefined },
    };
    renderComponent({
      layout: readOnlyLayout,
      descriptionEditingEnabled: true,
      onSetDescription: jest.fn(),
    });

    fireEvent.click(screen.getByTestId("layout-actions"));

    expect(screen.getByTestId("rename-layout")).toBeDisabled();
    expect(screen.getByTestId("delete-layout")).toBeDisabled();
    expect(screen.getByText("Save changes").closest("button")).toBeDisabled();
    expect(screen.queryByTestId("edit-layout-description")).not.toBeInTheDocument();
    expect(screen.queryByText("上传到组织…")).not.toBeInTheDocument();
    expect(screen.getByTestId("duplicate-layout")).toBeEnabled();
    expect(screen.getAllByText("只读布局")).toHaveLength(3);
  });

  it.each(["CREATOR_WRITE", "ORG_WRITE"] as const)(
    "keeps write actions enabled for a %s layout",
    (permission) => {
      const writableLayout = {
        ...defaultLayout,
        externalId: "writable-layout",
        permission,
        working: defaultLayout.baseline,
        syncInfo: { status: "tracked" as const, lastRemoteSavedAt: undefined },
      };
      renderComponent({
        layout: writableLayout,
        descriptionEditingEnabled: true,
        onSetDescription: jest.fn(),
      });

      fireEvent.click(screen.getByTestId("layout-actions"));

      expect(screen.getByTestId("rename-layout")).toBeEnabled();
      expect(screen.getByTestId("delete-layout")).toBeEnabled();
      expect(screen.getByText("Save changes").closest("button")).toBeEnabled();
      expect(screen.getByTestId("edit-layout-description")).toBeInTheDocument();
      expect(screen.queryByText("只读布局")).not.toBeInTheDocument();
      expect(
        screen.queryByText("上传到组织…")?.closest("button")?.hasAttribute("disabled"),
      ).toBe(permission === "CREATOR_WRITE" ? false : undefined);
    },
  );

  it("when delete menu item is clicked then confirm modal is triggered", async () => {
    mockConfirm.mockResolvedValue("ok");
    const onDelete = jest.fn();
    renderComponent({ onDelete });
    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByTestId("delete-layout"));
    await waitFor(() => {
      expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    });
  });

  it("when layout has modifications then unsaved changes header and related menu items are shown", () => {
    renderComponent({ layout: { ...defaultLayout, working: {}, syncInfo: undefined } });
    fireEvent.click(screen.getByTestId("layout-actions"));
    expect(screen.getByText("This layout has unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("Save changes")).toBeInTheDocument();
    expect(screen.getByText("Revert")).toBeInTheDocument();
  });

  it("when multi-selection is active then certain actions are disabled", () => {
    renderComponent({ multiSelectedIds: [BasicBuilder.string(), BasicBuilder.string()] });
    fireEvent.click(screen.getByTestId("layout-actions"));
    expect(screen.getByTestId("rename-layout")).toBeDisabled();
    expect(screen.getByTestId("export-layout")).toBeDisabled();
    expect(screen.getByTestId("delete-layout")).toBeEnabled();
  });

  it("Given a layout with modifications, when Revert is clicked and confirmed, then onRevert is called", async () => {
    const onRevert = jest.fn();
    // Simulate confirm dialog returning "ok"
    mockConfirm.mockResolvedValue("ok");
    renderComponent({ layout: { ...defaultLayout, working: {}, syncInfo: undefined }, onRevert });

    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByText("Revert"));

    await waitFor(() => {
      expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    });

    // Wait to ensure onRevert is called
    await waitFor(() => {
      expect(onRevert).toHaveBeenCalled();
    });
  });

  it("Given a layout with modifications, when Revert is clicked and cancelled, then onRevert is not called", async () => {
    const onRevert = jest.fn();
    // Simulate confirm dialog returning "cancel"
    mockConfirm.mockResolvedValue("cancel");
    renderComponent({ layout: { ...defaultLayout, working: {}, syncInfo: undefined }, onRevert });

    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByText("Revert"));

    await waitFor(() => {
      expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    });

    // Wait to ensure onRevert is not called
    await waitFor(() => {
      expect(onRevert).not.toHaveBeenCalled();
    });
  });

  it("Given a layout, when Rename is clicked and input is blurred, then onRename is called with the new name", async () => {
    const onRename = jest.fn();
    renderComponent({ onRename });

    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByTestId("rename-layout"));

    const input = await waitFor(() =>
      screen.getByTestId("layout-list-item").querySelector('input[type="text"]'),
    );
    const inputValue = BasicBuilder.string();
    fireEvent.change(input!, { target: { value: inputValue } });

    // Simulate blur event
    fireEvent.blur(input!);

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: layoutId }), inputValue);
    });
  });

  it("Given a shared layout, when Duplicate is clicked, then onMakePersonalCopy is called", () => {
    const onMakePersonalCopy = jest.fn();
    const sharedLayout = { ...defaultLayout, permission: "ORG_READ" as const };
    renderComponent({ layout: sharedLayout, onMakePersonalCopy });

    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByTestId("duplicate-layout"));

    expect(onMakePersonalCopy).toHaveBeenCalledWith(sharedLayout);
  });

  it("Given a personal layout, when Duplicate is clicked, then onDuplicate is called", () => {
    const onDuplicate = jest.fn();
    const personalLayout = {
      ...defaultLayout,
      working: undefined,
      permission: "CREATOR_WRITE",
    };
    renderComponent({ layout: personalLayout, onDuplicate });

    fireEvent.click(screen.getByTestId("layout-actions"));
    fireEvent.click(screen.getByTestId("duplicate-layout"));

    expect(onDuplicate).toHaveBeenCalledWith(personalLayout);
  });

  it("Given a layout with modifications, when menu is opened, then duplicate option is not shown", () => {
    const layoutWithModifications = {
      ...defaultLayout,
      working: {},
      syncInfo: undefined,
      permission: "CREATOR_WRITE" as const,
    };
    renderComponent({ layout: layoutWithModifications });

    fireEvent.click(screen.getByTestId("layout-actions"));

    expect(screen.queryByTestId("duplicate-layout")).not.toBeInTheDocument();
  });

  it("Given a shared layout, when menu is opened, then duplicate option is shown", () => {
    const sharedLayout = { ...defaultLayout, permission: "ORG_READ" as const };
    renderComponent({ layout: sharedLayout });

    fireEvent.click(screen.getByTestId("layout-actions"));

    expect(screen.getByTestId("duplicate-layout")).toBeInTheDocument();
  });
});
