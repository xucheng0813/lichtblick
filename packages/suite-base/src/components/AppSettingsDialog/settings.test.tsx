/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { useAppConfigurationValue } from "@lichtblick/suite-base/hooks/useAppConfigurationValue";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

import { AutoUpdate, ExtensionAutoUpdateOrgSetting, LayoutAutoSaveToCloudSetting, StepSize, VizServerSettings } from "./settings";

jest.mock("@lichtblick/suite-base/hooks/useAppConfigurationValue", () => ({
  useAppConfigurationValue: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/services/http/httpBaseUrl", () => ({
  setHttpBaseUrl: jest.fn(),
}));

describe("StepSize component", () => {
  const mockSetStepSize = jest.fn();

  beforeEach(() => {
    (useAppConfigurationValue as jest.Mock).mockReturnValue([100, mockSetStepSize]);
    mockSetStepSize.mockClear();
  });

  it("renders the step size input field with default value", () => {
    render(<StepSize />);
    const input = screen.getByRole("spinbutton");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(100);
  });

  it("calls setStepSize when user types a new number", () => {
    render(<StepSize />);
    const input = screen.getByRole("spinbutton");

    fireEvent.change(input, { target: { value: "250" } });

    expect(mockSetStepSize).toHaveBeenCalledWith(250);
  });
});

describe("AutoUpdate component", () => {
  it("should render update.enable as false by default", () => {
    (useAppConfigurationValue as jest.Mock).mockReturnValue([undefined, jest.fn()]);

    render(<AutoUpdate />);
    const input: HTMLInputElement = screen.getByRole("checkbox");
    expect(input.checked).toBe(false);
  });

  it("should render a checked checkbox when update.enable is true", () => {
    (useAppConfigurationValue as jest.Mock).mockReturnValue([true, jest.fn()]);

    render(<AutoUpdate />);
    const input: HTMLInputElement = screen.getByRole("checkbox");
    expect(input.checked).toBe(true);
  });
});

describe("ExtensionAutoUpdateOrgSetting component", () => {
  const mockSetEnabled = jest.fn();
  beforeEach(() => {
    jest.mocked(useAppConfigurationValue).mockClear();
    mockSetEnabled.mockClear();
  });

  it("reads the EXTENSION_AUTO_UPDATE_ORG key and defaults to enabled", () => {
    (useAppConfigurationValue as jest.Mock).mockReturnValue([undefined, mockSetEnabled]);
    render(<ExtensionAutoUpdateOrgSetting />);
    expect(jest.mocked(useAppConfigurationValue)).toHaveBeenCalledWith(
      AppSetting.EXTENSION_AUTO_UPDATE_ORG,
    );
    const input: HTMLInputElement = screen.getByRole("checkbox");
    expect(input.checked).toBe(true);
  });

  it("persists the toggle", () => {
    (useAppConfigurationValue as jest.Mock).mockReturnValue([true, mockSetEnabled]);
    render(<ExtensionAutoUpdateOrgSetting />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
  });
});

describe("LayoutAutoSaveToCloudSetting component", () => {
  const mockSetEnabled = jest.fn();
  beforeEach(() => {
    jest.mocked(useAppConfigurationValue).mockClear();
    mockSetEnabled.mockClear();
  });

  it("reads the LAYOUT_AUTO_SAVE_TO_CLOUD key and defaults to disabled", () => {
    (useAppConfigurationValue as jest.Mock).mockReturnValue([undefined, mockSetEnabled]);
    render(<LayoutAutoSaveToCloudSetting />);
    expect(jest.mocked(useAppConfigurationValue)).toHaveBeenCalledWith(
      AppSetting.LAYOUT_AUTO_SAVE_TO_CLOUD,
    );
    const input: HTMLInputElement = screen.getByRole("checkbox");
    expect(input.checked).toBe(false);
  });

  it("persists the toggle", () => {
    (useAppConfigurationValue as jest.Mock).mockReturnValue([false, mockSetEnabled]);
    render(<LayoutAutoSaveToCloudSetting />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(mockSetEnabled).toHaveBeenCalledWith(true);
  });
});

describe("VizServerSettings component", () => {
  const mockSetVizServerUrl = jest.fn();
  const mockSetVizServerWorkspace = jest.fn();

  beforeEach(() => {
    jest.mocked(setHttpBaseUrl).mockClear();
    mockSetVizServerUrl.mockClear();
    mockSetVizServerWorkspace.mockClear();
    jest.mocked(useAppConfigurationValue).mockImplementation((setting) => {
      if (setting === AppSetting.VIZ_SERVER_URL) {
        return ["http://localhost:9903/lichtblick", mockSetVizServerUrl];
      }
      return ["default-workspace", mockSetVizServerWorkspace];
    });
  });

  it("updates the runtime URL and persists both settings", () => {
    render(<VizServerSettings />);

    fireEvent.change(screen.getByLabelText("可视化服务地址"), {
      target: { value: "http://viz.example.com:9903/lichtblick" },
    });
    fireEvent.change(screen.getByLabelText("工作区"), {
      target: { value: "robot-team" },
    });

    expect(setHttpBaseUrl).toHaveBeenCalledWith("http://viz.example.com:9903/lichtblick");
    expect(mockSetVizServerUrl).toHaveBeenCalledWith("http://viz.example.com:9903/lichtblick");
    expect(mockSetVizServerWorkspace).toHaveBeenCalledWith("robot-team");
    expect(screen.getAllByText("修改后需重新加载应用生效。")).toHaveLength(2);
  });
});
