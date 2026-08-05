/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSnackbar } from "notistack";
import { useTranslation } from "react-i18next";
import "@testing-library/jest-dom";
import { AsyncState } from "react-use/lib/useAsyncFn";

import ExtensionsAPI from "@lichtblick/suite-base/api/extensions/ExtensionsAPI";
import useExtensionSettings from "@lichtblick/suite-base/components/ExtensionsSettings/hooks/useExtensionSettings";
import { UseExtensionSettingsHook } from "@lichtblick/suite-base/components/ExtensionsSettings/types";
import { useAppConfiguration } from "@lichtblick/suite-base/context/AppConfigurationContext";
import { useExtensionCatalog } from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { ExtensionMarketplaceDetail } from "@lichtblick/suite-base/context/ExtensionMarketplaceContext";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";
import type { ExtensionInfo } from "@lichtblick/suite-base/types/Extensions";
import { makeMockAppConfiguration } from "@lichtblick/suite-base/util/makeMockAppConfiguration";
import { BasicBuilder } from "@lichtblick/test-builders";

import ExtensionsSettings from "./index";

jest.mock("@lichtblick/suite-base/context/ExtensionCatalogContext", () => ({
  useExtensionCatalog: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/context/AppConfigurationContext", () => ({
  useAppConfiguration: jest.fn(),
}));

jest.mock("notistack", () => ({
  useSnackbar: jest.fn(),
}));

const mockInstallingStore = {
  setInstallingProgress: jest.fn(),
  startInstallingProgress: jest.fn(),
  resetInstallingProgress: jest.fn(),
  installingProgress: { installed: 0, total: 0, inProgress: false },
};

jest.mock("@lichtblick/suite-base/hooks/useInstallingExtensionsStore", () => ({
  useInstallingExtensionsStore: (
    selector: (state: typeof mockInstallingStore) => unknown,
  ) => selector(mockInstallingStore),
}));

const mockInstallExtensions = jest.fn();
const enqueueSnackbarMock = jest.fn();
const mockListOrganizationExtensions = jest.fn();
const mockLoadOrganizationExtension = jest.fn();

jest.mock("@lichtblick/suite-base/api/extensions/ExtensionsAPI", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    list: mockListOrganizationExtensions,
    loadContent: mockLoadOrganizationExtension,
  })),
}));

jest.mock(
  "@lichtblick/suite-base/components/ExtensionsSettings/hooks/useExtensionSettings",
);
jest.mock("react-i18next");

jest.mock("@lichtblick/suite-base/components/ExtensionDetails", () => ({
  ExtensionDetails: ({ extension, onClose }: any) => {
    return (
      <div data-testid="mock-extension-details">
        <p>{extension.name}</p>
        <button data-testid="mockCloseExtension" onClick={onClose}>
          Close
        </button>
      </div>
    );
  },
}));

describe("ExtensionsSettings", () => {
  const mockSetUndebouncedFilterText = jest.fn();
  const mockRefreshMarketplaceEntries = jest.fn();

  function organizationExtension(id: string, version: string): ExtensionInfo {
    return {
      changelog: "",
      description: `Description for ${id}`,
      displayName: `Cloud ${id}`,
      externalId: `remote-${id}`,
      homepage: "",
      id,
      keywords: [],
      license: "MPL-2.0",
      name: id,
      namespace: "org",
      publisher: "Cloud Publisher",
      qualifiedName: `Cloud ${id}`,
      readme: "",
      version,
    };
  }

  function configureVizServer() {
    globalThis.history.replaceState({}, "", "/?workspace=test-workspace");
    setHttpBaseUrl("http://viz.example.com:9903/lichtblick");
  }

  function setCatalogState(
    installedExtensions: ExtensionInfo[],
    loadedExtensionIds: string[],
  ) {
    (useExtensionCatalog as jest.Mock).mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          installExtensions: mockInstallExtensions,
          installedExtensions,
          loadedExtensions: new Set(loadedExtensionIds),
        }),
    );
  }

  function setUpHook(props?: Partial<UseExtensionSettingsHook>) {
    (useExtensionSettings as jest.Mock).mockReturnValue({
      setUndebouncedFilterText: mockSetUndebouncedFilterText,
      marketplaceEntries: { error: undefined },
      refreshMarketplaceEntries: mockRefreshMarketplaceEntries,
      undebouncedFilterText: "",
      namespacedData: [
        {
          namespace: "org",
          entries: [
            {
              id: "1",
              name: "Extension",
              description: "Description of Extension 1",
              publisher: "Publisher 1",
              version: "1.0.0",
              qualifiedName: "org.extension1",
              homepage: BasicBuilder.string(),
              license: BasicBuilder.string(),
            },
          ],
        },
        { namespace: "Org2", entries: [] },
      ],
      groupedMarketplaceData: [{ namespace: "MarketPlace", entries: [] }],
      debouncedFilterText: "",
      ...props,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.history.replaceState({}, "", "/");
    setHttpBaseUrl(undefined);
    setUpHook();
    mockListOrganizationExtensions.mockReset().mockResolvedValue([]);
    mockLoadOrganizationExtension.mockReset();

    (useTranslation as jest.Mock).mockReturnValue({
      t: (key: string, options?: { reason?: string }) =>
        options?.reason == undefined ? key : `${key}: ${options.reason}`,
    });
    (useAppConfiguration as jest.Mock).mockReturnValue(
      makeMockAppConfiguration(),
    );
    setCatalogState([], []);
    (useSnackbar as jest.Mock).mockReturnValue({
      enqueueSnackbar: enqueueSnackbarMock,
      closeSnackbar: jest.fn(),
    });
  });

  it("renders the search bar and three extension lists", () => {
    render(<ExtensionsSettings />);

    expect(screen.getByTestId("SearchBarComponent")).toBeInTheDocument();

    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByText("Org2")).toBeInTheDocument();
    expect(screen.getByText("MarketPlace")).toBeInTheDocument();
  });

  it("handles search bar input", async () => {
    render(<ExtensionsSettings />);

    const searchInput = screen.getByPlaceholderText("searchExtensions");
    await userEvent.type(searchInput, "test");

    expect(mockSetUndebouncedFilterText).toHaveBeenCalledWith("t");
    expect(mockSetUndebouncedFilterText).toHaveBeenCalledWith("e");
    expect(mockSetUndebouncedFilterText).toHaveBeenCalledWith("s");
    expect(mockSetUndebouncedFilterText).toHaveBeenCalledWith("t");
  });

  it("should clear text when onClose() is called", async () => {
    setUpHook({ debouncedFilterText: BasicBuilder.string() });
    render(<ExtensionsSettings />);

    const clearSearchButton = screen.getByTestId("ClearIcon");
    await userEvent.click(clearSearchButton);

    expect(mockSetUndebouncedFilterText).toHaveBeenCalledWith("");
  });

  it("displays an error alert when marketplaceEntries.error is set", () => {
    setUpHook({
      marketplaceEntries: { error: true } as unknown as AsyncState<
        ExtensionMarketplaceDetail[]
      >,
    });

    render(<ExtensionsSettings />);

    expect(
      screen.getByText("failedToRetrieveMarketplaceExtensions"),
    ).toBeInTheDocument();

    const retryButton = screen.getByText("Retry");
    fireEvent.click(retryButton);

    expect(mockRefreshMarketplaceEntries).toHaveBeenCalledTimes(1);
  });

  it("should render ExtensionDetails component if focusedExtension is defined and close it", async () => {
    render(<ExtensionsSettings />);
    const listItem = screen.getByText("Extension");

    await userEvent.click(listItem);
    expect(screen.queryByTestId("mock-extension-details")).toBeInTheDocument();

    const closeExtensionButton = screen.getByTestId("mockCloseExtension");
    await userEvent.click(closeExtensionButton);
    expect(
      screen.queryByTestId("mock-extension-details"),
    ).not.toBeInTheDocument();
  });

  describe("upload extension to organization", () => {
    it("does not render the upload button when the viz server is not configured", () => {
      render(<ExtensionsSettings />);

      expect(
        screen.queryByTestId("upload-extension-button"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("upload-extension-input"),
      ).not.toBeInTheDocument();
    });

    it("renders the upload button when the viz server is configured", async () => {
      configureVizServer();
      render(<ExtensionsSettings />);

      expect(screen.getByTestId("upload-extension-button")).toBeInTheDocument();
      expect(screen.getByTestId("upload-extension-input")).toBeInTheDocument();
      expect(
        await screen.findByText("noOrganizationExtensions"),
      ).toBeInTheDocument();
    });

    it("installs a selected .foxe file into the org namespace and shows a success snackbar", async () => {
      configureVizServer();
      mockInstallExtensions.mockResolvedValue([
        {
          success: true,
          extensionName: "test-extension",
          loaderResults: [
            { loaderType: "browser", success: true },
            { loaderType: "server", success: true },
          ],
        },
      ]);
      render(<ExtensionsSettings />);

      const file = new File(
        [new Uint8Array([1, 2, 3])],
        "test-extension.foxe",
        {
          type: "application/octet-stream",
        },
      );
      file.arrayBuffer = async () => new Uint8Array([1, 2, 3]).buffer;
      fireEvent.change(screen.getByTestId("upload-extension-input"), {
        target: { files: [file] },
      });

      await waitFor(() => {
        expect(mockInstallExtensions).toHaveBeenCalledTimes(1);
      });
      expect(mockInstallExtensions).toHaveBeenCalledWith("org", [
        expect.any(Object),
      ]);
      const installedExtension = mockInstallExtensions.mock
        .calls[0]?.[1]?.[0] as
        { buffer: Uint8Array; file?: File; namespace?: string } | undefined;
      expect(installedExtension?.file).toBe(file);
      expect(installedExtension?.namespace).toBe("org");
      expect(installedExtension?.buffer).toEqual(new Uint8Array([1, 2, 3]));

      await waitFor(() => {
        expect(enqueueSnackbarMock).toHaveBeenCalledWith(
          "Successfully installed all 1 extensions.",
          expect.objectContaining({ variant: "success" }),
        );
      });
    });

    it("shows an error snackbar and does not install when a non-foxe file is selected", async () => {
      configureVizServer();
      render(<ExtensionsSettings />);

      fireEvent.change(screen.getByTestId("upload-extension-input"), {
        target: { files: [new File(["hello"], "notes.txt")] },
      });

      await waitFor(() => {
        expect(enqueueSnackbarMock).toHaveBeenCalledWith(
          "uploadExtensionOnlyFoxe",
          {
            variant: "error",
          },
        );
      });
      expect(mockInstallExtensions).not.toHaveBeenCalled();
    });

    it("shows an error snackbar when reading the selected extension file fails", async () => {
      configureVizServer();
      render(<ExtensionsSettings />);

      const file = new File([new Uint8Array([1])], "unreadable.foxe");
      file.arrayBuffer = async () => {
        throw new Error("read failed");
      };
      fireEvent.change(screen.getByTestId("upload-extension-input"), {
        target: { files: [file] },
      });

      await waitFor(() => {
        expect(enqueueSnackbarMock).toHaveBeenCalledWith(
          "uploadExtensionReadFailed",
          {
            variant: "error",
          },
        );
      });
      expect(mockInstallExtensions).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
      (console.error as jest.Mock).mockClear();
    });

    it("shows an error snackbar when the installation fails", async () => {
      configureVizServer();
      mockInstallExtensions.mockResolvedValue([
        {
          success: false,
          extensionName: "test-extension.foxe",
          loaderResults: [
            {
              loaderType: "browser",
              success: false,
              error: new Error("Cache error"),
            },
            {
              loaderType: "server",
              success: false,
              error: new Error("Network error"),
            },
          ],
        },
      ]);
      render(<ExtensionsSettings />);

      const file = new File([new Uint8Array([1])], "test-extension.foxe");
      file.arrayBuffer = async () => new Uint8Array([1]).buffer;
      fireEvent.change(screen.getByTestId("upload-extension-input"), {
        target: { files: [file] },
      });

      await waitFor(() => {
        expect(enqueueSnackbarMock).toHaveBeenCalledWith(
          "Failed to install all 1 extensions.",
          expect.objectContaining({ variant: "error" }),
        );
      });
      expect(enqueueSnackbarMock).toHaveBeenCalledWith(
        "Details: 1 could not be saved to cache, 1 could not be synced to server.",
        expect.objectContaining({ variant: "error", persist: true }),
      );
    });
  });

  describe("organization cloud extensions", () => {
    it("does not request or render the cloud section without viz-server configuration", () => {
      render(<ExtensionsSettings />);

      expect(
        screen.queryByTestId("organization-extensions-section"),
      ).not.toBeInTheDocument();
      expect(mockListOrganizationExtensions).not.toHaveBeenCalled();
    });

    it("renders installed, update, and not-installed states", async () => {
      configureVizServer();
      const installed = organizationExtension("installed", "1.0.0");
      const update = organizationExtension("update", "2.0.0");
      const missing = organizationExtension("missing", "1.0.0");
      mockListOrganizationExtensions.mockResolvedValue([
        installed,
        update,
        missing,
      ]);
      setCatalogState(
        [installed, { ...update, namespace: "local", version: "1.0.0" }],
        [installed.id, update.id],
      );

      render(<ExtensionsSettings />);

      const section = await screen.findByTestId(
        "organization-extensions-section",
      );
      expect(ExtensionsAPI).toHaveBeenCalledWith("test-workspace");
      expect(
        within(section).getByTestId("organization-extension-row-installed"),
      ).toHaveTextContent("organizationExtensionInstalled");
      expect(
        within(section).getByTestId("organization-extension-row-update"),
      ).toHaveTextContent("organizationExtensionUpdateAvailable");
      expect(
        within(section).getByTestId("organization-extension-row-missing"),
      ).toHaveTextContent("organizationExtensionNotInstalled");
      expect(
        within(section).getAllByRole("button", {
          name: "installOrganizationExtension",
        }),
      ).toHaveLength(2);
    });

    it("downloads and installs a cloud extension into the local org cache", async () => {
      configureVizServer();
      const extension = organizationExtension("missing", "1.0.0");
      const content = new Uint8Array([1, 2, 3]);
      mockListOrganizationExtensions.mockResolvedValue([extension]);
      mockLoadOrganizationExtension.mockResolvedValue(content);
      mockInstallExtensions.mockResolvedValue([
        {
          info: extension,
          loaderResults: [{ loaderType: "browser", success: true }],
          success: true,
        },
      ]);

      render(<ExtensionsSettings />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "installOrganizationExtension",
        }),
      );

      await waitFor(() => {
        expect(mockLoadOrganizationExtension).toHaveBeenCalledWith(
          extension.id,
        );
        expect(mockInstallExtensions).toHaveBeenCalledWith("org", [
          { buffer: content, namespace: "org" },
        ]);
      });
      expect(mockLoadOrganizationExtension).not.toHaveBeenCalledWith(
        extension.externalId,
      );
    });

    it("shows the download failure reason when cloud content is missing", async () => {
      configureVizServer();
      const extension = organizationExtension("missing-content", "1.0.0");
      mockListOrganizationExtensions.mockResolvedValue([extension]);
      mockLoadOrganizationExtension.mockResolvedValue(undefined);

      render(<ExtensionsSettings />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "installOrganizationExtension",
        }),
      );

      await waitFor(() => {
        expect(enqueueSnackbarMock).toHaveBeenCalledWith(
          "organizationExtensionInstallFailed: 404",
          { variant: "error" },
        );
      });
      expect(mockInstallExtensions).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
      (console.error as jest.Mock).mockClear();
    });

    it("refreshes the cloud list", async () => {
      configureVizServer();
      const extension = organizationExtension("new-cloud-extension", "1.0.0");
      mockListOrganizationExtensions
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([extension]);

      render(<ExtensionsSettings />);
      expect(
        await screen.findByText("noOrganizationExtensions"),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "refreshOrganizationExtensions" }),
      );

      expect(
        await screen.findByText(extension.displayName),
      ).toBeInTheDocument();
      expect(mockListOrganizationExtensions).toHaveBeenCalledTimes(2);
    });

    it("shows a retryable error when the cloud list fails", async () => {
      configureVizServer();
      const extension = organizationExtension("recovered", "1.0.0");
      mockListOrganizationExtensions
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce([extension]);

      render(<ExtensionsSettings />);
      expect(
        await screen.findByText("organizationExtensionsLoadFailed"),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "retryOrganizationExtensions" }),
      );

      expect(
        await screen.findByText(extension.displayName),
      ).toBeInTheDocument();
      expect(mockListOrganizationExtensions).toHaveBeenCalledTimes(2);
    });
  });
});
