/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { render } from "@testing-library/react";
import { useNetworkState } from "react-use";

import { NetworkStatusIndicator } from "@lichtblick/suite-base/components/AppBar/NetworkStatusIndicator";
import { BasicBuilder } from "@lichtblick/test-builders";

const API_URL = "https://api.test.com";
let mockWorkspace: string | undefined;
let mockHttpBaseUrl: string | undefined = API_URL;

jest.mock("react-use", () => ({
  useNetworkState: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/services/http/httpBaseUrl", () => ({
  getHttpBaseUrl: () => mockHttpBaseUrl,
}));

jest.mock("@lichtblick/suite-base/util/vizServerParams", () => ({
  resolveWorkspaceBestEffort: () => mockWorkspace,
  resolveVizServerConfigured: (workspace: string | undefined) =>
    workspace != undefined && workspace !== "" && mockHttpBaseUrl != undefined,
}));

const setMockWorkspace = (workspace: string | undefined) => {
  mockWorkspace = workspace;
};

const setMockHttpBaseUrl = (url: string | undefined) => {
  mockHttpBaseUrl = url;
};

const mockT = jest.fn();
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}));

describe("NetworkStatusIndicator", () => {
  const originalLocation = window.location;
  const originalURL = global.URL;

  beforeEach(() => {
    setMockWorkspace(undefined);
    setMockHttpBaseUrl(API_URL);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete (window as any).location;
    (window as any).location = originalLocation;
    global.URL = originalURL;
  });

  const mockURL = (href: string): void => {
    global.URL = jest.fn().mockImplementation((url: string) => {
      if (url === window.location.href || url === href) {
        const realUrl = new originalURL(href);
        return realUrl;
      }
      return new originalURL(url);
    }) as any;
  };

  it("should not render when no workspace is configured", () => {
    mockURL(API_URL);
    setMockWorkspace(undefined);
    (useNetworkState as jest.Mock).mockReturnValue({ online: false });

    const { container } = render(<NetworkStatusIndicator />);

    expect(container.firstChild).toBeNull();
  });

  it("should not render when online", () => {
    const url = `${API_URL}/?workspace=${BasicBuilder.string()}`;
    mockURL(url);
    setMockWorkspace(BasicBuilder.string());
    (useNetworkState as jest.Mock).mockReturnValue({ online: true });

    const { container } = render(<NetworkStatusIndicator />);

    expect(container.firstChild).toBeNull();
  });

  it("should render when offline with a workspace from the URL", () => {
    const url = `${API_URL}/?workspace=${BasicBuilder.string()}`;
    mockURL(url);
    setMockWorkspace(BasicBuilder.string());
    (useNetworkState as jest.Mock).mockReturnValue({ online: false });

    const { container } = render(<NetworkStatusIndicator />);

    expect(container.firstChild).not.toBeNull();
  });

  it("should render when offline with a workspace configured via app settings", () => {
    mockURL(API_URL);
    setMockWorkspace("configured-workspace");
    (useNetworkState as jest.Mock).mockReturnValue({ online: false });

    const { container } = render(<NetworkStatusIndicator />);

    expect(container.firstChild).not.toBeNull();
    expect(mockT).toHaveBeenCalledWith("networkStatusOfflineDescription", {
      workspace: "configured-workspace",
    });
  });
});
