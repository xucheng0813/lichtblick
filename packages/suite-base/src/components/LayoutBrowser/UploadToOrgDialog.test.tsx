/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { useTranslation } from "react-i18next";

import { layoutBrowser as layoutBrowserZh } from "@lichtblick/suite-base/i18n/zh/layoutBrowser";

import { UploadToOrgDialog } from "./UploadToOrgDialog";

jest.mock("react-i18next", () => ({
  useTranslation: jest.fn(),
}));

(useTranslation as jest.Mock).mockReturnValue({
  t: (key: string) => (layoutBrowserZh as Record<string, string>)[key] ?? key,
});

describe("UploadToOrgDialog", () => {
  it("renders the original layout name and defaults to organization editable", () => {
    render(
      <UploadToOrgDialog
        layoutName="Device diagnostics"
        open
        onClose={jest.fn()}
        onUpload={jest.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "上传布局到组织" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "布局名称" })).toHaveValue(
      "Device diagnostics",
    );
    expect(screen.getByRole("radio", { name: "组织可编辑" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "组织只读" })).not.toBeChecked();
  });

  it("submits the edited name and selected permission", async () => {
    const onUpload = jest.fn().mockResolvedValue(false);
    render(
      <UploadToOrgDialog
        layoutName="Original"
        open
        onClose={jest.fn()}
        onUpload={onUpload}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "布局名称" }), {
      target: { value: "Read-only diagnostics" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "组织只读" }));
    fireEvent.click(screen.getByRole("button", { name: "上传" }));

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith({
        name: "Read-only diagnostics",
        permission: "ORG_READ",
      });
    });
  });

  it("shows loading state and prevents closing while uploading", async () => {
    let resolveUpload: (() => void) | undefined;
    const pendingUpload = new Promise<void>((resolve) => {
        resolveUpload = resolve;
    });
    const onUpload = jest.fn(async () => {
      await pendingUpload;
      return true;
    });
    const onClose = jest.fn();
    render(
      <UploadToOrgDialog
        layoutName="Original"
        open
        onClose={onClose}
        onUpload={onUpload}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "上传" }));

    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上传" })).toBeDisabled();

    await act(async () => {
      resolveUpload?.();
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
