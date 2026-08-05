/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";

import {
  type ExtensionCatalog,
  useExtensionCatalog,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { usePanelCatalog } from "@lichtblick/suite-base/context/PanelCatalogContext";

import PanelCatalogProvider from "./PanelCatalogProvider";

jest.mock("react-i18next", () => ({ useTranslation: jest.fn() }));
jest.mock("@lichtblick/suite-base/context/ExtensionCatalogContext", () => ({
  ...jest.requireActual(
    "@lichtblick/suite-base/context/ExtensionCatalogContext",
  ),
  useExtensionCatalog: jest.fn(),
}));
jest.mock("@lichtblick/suite-base/panels", () => ({
  getBuiltin: jest.fn(() => []),
}));

describe("PanelCatalogProvider", () => {
  it("uses panel metadata before falling back to the extension description", () => {
    (useTranslation as jest.Mock).mockReturnValue({ t: (key: string) => key });
    (useExtensionCatalog as jest.Mock).mockImplementation(
      (
        selector: (state: Pick<ExtensionCatalog, "installedPanels">) => unknown,
      ) =>
        selector({
          installedPanels: {
            "Acme.Camera": {
              extensionDescription: "Acme visualization panels.",
              extensionId: "acme",
              extensionName: "Acme",
              meta: { description: "Shows camera images." },
              registration: { name: "Camera", initPanel: jest.fn() },
            },
            "Acme.Status": {
              extensionDescription: "Acme visualization panels.",
              extensionId: "acme",
              extensionName: "Acme",
              registration: { name: "Status", initPanel: jest.fn() },
            },
          },
        }),
    );
    const wrapper = ({ children }: PropsWithChildren) => (
      <PanelCatalogProvider>{children}</PanelCatalogProvider>
    );

    const { result } = renderHook(() => usePanelCatalog().getPanels(), {
      wrapper,
    });

    expect(
      result.current.map(({ type, description }) => ({ type, description })),
    ).toEqual([
      { type: "Acme.Camera", description: "Shows camera images." },
      { type: "Acme.Status", description: "Acme visualization panels." },
    ]);
  });
});
