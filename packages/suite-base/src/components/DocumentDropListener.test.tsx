/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { SnackbarProvider } from "notistack";
import { act } from "react";
import { createRoot } from "react-dom/client";

import DocumentDropListener from "@lichtblick/suite-base/components/DocumentDropListener";
import ThemeProvider from "@lichtblick/suite-base/theme/ThemeProvider";

let mockWorkspace: string | undefined;
let mockHttpBaseUrl: string | undefined = "https://api.example.com";

jest.mock("@lichtblick/suite-base/services/http/httpBaseUrl", () => ({
  getHttpBaseUrl: () => mockHttpBaseUrl,
}));

jest.mock("@lichtblick/suite-base/util/vizServerParams", () => ({
  resolveWorkspaceBestEffort: () => mockWorkspace,
  resolveVizServerConfigured: (workspace: string | undefined) =>
    workspace != undefined && workspace !== "" && mockHttpBaseUrl != undefined,
}));

describe("<DocumentDropListener>", () => {
  let wrapper: HTMLDivElement;
  let windowDragoverHandler: typeof jest.fn;

  beforeEach(() => {
    mockWorkspace = undefined;
    mockHttpBaseUrl = "https://api.example.com";
    windowDragoverHandler = jest.fn();
    window.addEventListener("dragover", windowDragoverHandler);

    wrapper = document.createElement("div");
    document.body.appendChild(wrapper);

    const root = createRoot(wrapper);
    root.render(
      <div>
        <SnackbarProvider>
          <ThemeProvider isDark={false}>
            <DocumentDropListener allowedExtensions={[]} />
          </ThemeProvider>
        </SnackbarProvider>
      </div>,
    );

    (console.error as jest.Mock).mockClear();
  });

  it("allows the event to bubble if the dataTransfer has no files", async () => {
    // The event should bubble up from the document to the window
    act(() => {
      document.dispatchEvent(new CustomEvent("dragover", { bubbles: true, cancelable: true }));
    });
    expect(windowDragoverHandler).toHaveBeenCalled();
  });

  it("prevents the event from bubbling if the dataTransfer contains Files", async () => {
    // DragEvent is not defined in jsdom at the moment, so simulate one using a MouseEvent
    const event = new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
    });
    (event as any).dataTransfer = {
      types: ["Files"],
    };
    document.dispatchEvent(event); // The event should NOT bubble up from the document to the window

    expect(windowDragoverHandler).not.toHaveBeenCalled();
  });

  afterEach(() => {
    wrapper.remove();
    window.removeEventListener("dragover", windowDragoverHandler);
  });
});

describe("<DocumentDropListener> enhanced functionality", () => {
  it("should render without crashing with enhanced features", () => {
    const onDrop = jest.fn();

    const wrapper = document.createElement("div");
    document.body.appendChild(wrapper);

    let root: ReturnType<typeof createRoot> | undefined;
    expect(() => {
      root = createRoot(wrapper);
      root.render(
        <div>
          <SnackbarProvider>
            <ThemeProvider isDark={false}>
              <DocumentDropListener
                allowedExtensions={[".json", ".foxe", ".mcap"]}
                onDrop={onDrop}
              />
            </ThemeProvider>
          </SnackbarProvider>
        </div>,
      );
    }).not.toThrow();

    root?.unmount();
    wrapper.remove();
  });
});

describe("<DocumentDropListener> onDrop useCallback", () => {
  let wrapper: HTMLDivElement;
  let onDropSpy: jest.Mock;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    onDropSpy = jest.fn();
    wrapper = document.createElement("div");
    document.body.appendChild(wrapper);
    root = createRoot(wrapper);
  });

  afterEach(() => {
    root.unmount();
    wrapper.remove();
    jest.clearAllMocks();
  });

  it("should not call onDrop when no dataTransfer is present", async () => {
    // Given
    root.render(
      <SnackbarProvider>
        <ThemeProvider isDark={false}>
          <DocumentDropListener allowedExtensions={[".json"]} onDrop={onDropSpy} />
        </ThemeProvider>
      </SnackbarProvider>,
    );

    // When - drop event without dataTransfer
    const dropEvent = new MouseEvent("drop", { bubbles: true, cancelable: true });

    await act(async () => {
      document.dispatchEvent(dropEvent);
    });

    // Then
    expect(onDropSpy).not.toHaveBeenCalled();
  });

  it("should not call onDrop when no allowedExtensions are provided", async () => {
    // Given
    root.render(
      <SnackbarProvider>
        <ThemeProvider isDark={false}>
          <DocumentDropListener onDrop={onDropSpy} />
        </ThemeProvider>
      </SnackbarProvider>,
    );

    // When - drop event with dataTransfer but no allowed extensions
    const dropEvent = new MouseEvent("drop", { bubbles: true, cancelable: true });
    (dropEvent as any).dataTransfer = {
      items: [
        {
          getAsFile: () => new File(["content"], "test.json", { type: "application/json" }),
          webkitGetAsEntry: () => ({ isFile: true }),
        },
      ],
    };

    await act(async () => {
      document.dispatchEvent(dropEvent);
    });

    // Then
    expect(onDropSpy).not.toHaveBeenCalled();
  });

  it("shows the namespace selection modal for a layout drop when workspace is configured via app settings", async () => {
    // Given - workspace configured via app settings (no ?workspace= URL parameter)
    mockWorkspace = "configured-workspace";
    mockHttpBaseUrl = "https://api.example.com";

    root.render(
      <SnackbarProvider>
        <ThemeProvider isDark={false}>
          <DocumentDropListener allowedExtensions={[".json"]} onDrop={onDropSpy} />
        </ThemeProvider>
      </SnackbarProvider>,
    );

    // Wait for React to commit and attach the document listeners
    await new Promise((resolve) => setTimeout(resolve, 0));

    // When - drop a layout file
    const dropEvent = new MouseEvent("drop", { bubbles: true, cancelable: true });
    (dropEvent as any).dataTransfer = {
      items: [
        {
          getAsFile: () => new File(["content"], "test.json", { type: "application/json" }),
          webkitGetAsEntry: () => ({ isFile: true }),
        },
      ],
    };

    await act(async () => {
      document.dispatchEvent(dropEvent);
    });

    // Then - the drop is not handled as a local open, the namespace modal is shown instead
    expect(onDropSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Choose Installation Location");
  });

  it("does not show the namespace selection modal when no workspace is configured", async () => {
    // Given - no workspace configured anywhere
    mockWorkspace = undefined;
    mockHttpBaseUrl = undefined;

    root.render(
      <SnackbarProvider>
        <ThemeProvider isDark={false}>
          <DocumentDropListener allowedExtensions={[".json"]} onDrop={onDropSpy} />
        </ThemeProvider>
      </SnackbarProvider>,
    );

    // Wait for React to commit and attach the document listeners
    await new Promise((resolve) => setTimeout(resolve, 0));

    // When - drop a layout file
    const dropEvent = new MouseEvent("drop", { bubbles: true, cancelable: true });
    (dropEvent as any).dataTransfer = {
      items: [
        {
          getAsFile: () => new File(["content"], "test.json", { type: "application/json" }),
          webkitGetAsEntry: () => ({ isFile: true }),
        },
      ],
    };

    await act(async () => {
      document.dispatchEvent(dropEvent);
    });

    // Then - the file is opened locally without the namespace modal
    expect(onDropSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "local" }),
    );
    expect(document.body.textContent).not.toContain("Choose Installation Location");
    expect(document.querySelector("input[type='checkbox']")).toBeNull();
  });

  it("installs locally and then uploads the extension when the option is checked", async () => {
    mockWorkspace = "configured-workspace";
    mockHttpBaseUrl = "https://api.example.com";
    onDropSpy.mockResolvedValue(undefined);

    root.render(
      <SnackbarProvider>
        <ThemeProvider isDark={false}>
          <DocumentDropListener allowedExtensions={[".foxe"]} onDrop={onDropSpy} />
        </ThemeProvider>
      </SnackbarProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const extensionFile = new File(["content"], "extension.foxe");
    const dropEvent = new MouseEvent("drop", { bubbles: true, cancelable: true });
    (dropEvent as any).dataTransfer = {
      items: [
        {
          getAsFile: () => extensionFile,
          webkitGetAsEntry: () => ({ isFile: true }),
        },
      ],
    };
    await act(async () => {
      document.dispatchEvent(dropEvent);
    });

    const checkbox = document.querySelector<HTMLInputElement>("input[type='checkbox']");
    const installButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Install",
    );
    expect(checkbox).not.toBeNull();
    expect(installButton).toBeDefined();
    await act(async () => {
      checkbox?.click();
      installButton?.click();
      await Promise.resolve();
    });
    expect(onDropSpy).toHaveBeenCalledTimes(2);
    expect(onDropSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ files: [extensionFile], namespace: "local" }),
    );
    expect(onDropSpy.mock.calls[1]?.[0]).toEqual({
      files: [extensionFile],
      namespace: "org",
    });
    expect(onDropSpy.mock.invocationCallOrder[0]).toBeLessThan(
      onDropSpy.mock.invocationCallOrder[1]!,
    );
  });

  it("only installs locally when organization upload is not checked", async () => {
    mockWorkspace = "configured-workspace";
    mockHttpBaseUrl = "https://api.example.com";
    onDropSpy.mockResolvedValue(undefined);

    root.render(
      <SnackbarProvider>
        <ThemeProvider isDark={false}>
          <DocumentDropListener allowedExtensions={[".foxe"]} onDrop={onDropSpy} />
        </ThemeProvider>
      </SnackbarProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const extensionFile = new File(["content"], "extension.foxe");
    const dropEvent = new MouseEvent("drop", { bubbles: true, cancelable: true });
    (dropEvent as any).dataTransfer = {
      items: [
        {
          getAsFile: () => extensionFile,
          webkitGetAsEntry: () => ({ isFile: true }),
        },
      ],
    };
    await act(async () => {
      document.dispatchEvent(dropEvent);
    });
    const installButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Install",
    );
    expect(installButton).toBeDefined();
    await act(async () => {
      installButton?.click();
      await Promise.resolve();
    });
    expect(onDropSpy).toHaveBeenCalledTimes(1);
    expect(onDropSpy).toHaveBeenCalledWith(
      expect.objectContaining({ files: [extensionFile], namespace: "local" }),
    );
  });
});
