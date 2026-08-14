/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import "@testing-library/jest-dom";

import { act, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { MosaicNode } from "react-mosaic-component";
import { StoreApi, createStore } from "zustand";

import { MessagePipelineProvider } from "@lichtblick/suite-base/components/MessagePipeline";
import Panel from "@lichtblick/suite-base/components/Panel";
import AppConfigurationContext from "@lichtblick/suite-base/context/AppConfigurationContext";
import {
  ExtensionCatalog,
  ExtensionCatalogContext,
  RegisteredPanel,
  useExtensionCatalog,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import PanelCatalogContext, {
  PanelCatalog,
  PanelComponent,
  PanelInfo,
} from "@lichtblick/suite-base/context/PanelCatalogContext";
import TabPanel from "@lichtblick/suite-base/panels/Tab";
import MockCurrentLayoutProvider from "@lichtblick/suite-base/providers/CurrentLayoutProvider/MockCurrentLayoutProvider";
import ExtensionCatalogProvider from "@lichtblick/suite-base/providers/ExtensionCatalogProvider/ExtensionCatalogProvider";
import { PanelStateContextProvider } from "@lichtblick/suite-base/providers/PanelStateContextProvider";
import WorkspaceContextProvider from "@lichtblick/suite-base/providers/WorkspaceContextProvider";
import { PanelConfig } from "@lichtblick/suite-base/types/panels";
import { makeMockAppConfiguration } from "@lichtblick/suite-base/util/makeMockAppConfiguration";

import PanelLayout, { UnconnectedPanelLayout } from "./PanelLayout";

class MockPanelCatalog implements PanelCatalog {
  public constructor(private allPanels: PanelInfo[]) {}
  public getPanels(): readonly PanelInfo[] {
    return this.allPanels;
  }
  public getPanelByType(type: string): PanelInfo | undefined {
    return this.allPanels.find((panel) => !panel.config && panel.type === type);
  }
}

describe("UnconnectedPanelLayout", () => {
  beforeEach(() => {
    // jsdom can't parse our @container CSS so we have to silence console.error for this test.
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (console.error as jest.Mock).mockRestore();
  });

  it("does not remount panels when changing split percentage", async () => {
    // jest.spyOn(console, "error").mockImplementation(() => undefined);

    const renderA = jest.fn().mockReturnValue(<>A</>);
    const moduleA = jest.fn().mockResolvedValue({
      default: Panel(Object.assign(renderA, { panelType: "a", defaultConfig: {} })),
    });

    const renderB = jest.fn().mockReturnValue(<>B</>);
    const moduleB = jest.fn().mockResolvedValue({
      default: Panel(Object.assign(renderB, { panelType: "b", defaultConfig: {} })),
    });

    const renderC = jest.fn().mockReturnValue(<>C</>);
    const moduleC = jest.fn().mockResolvedValue({
      default: Panel(Object.assign(renderC, { panelType: "c", defaultConfig: {} })),
    });

    const panels: PanelInfo[] = [
      { title: "A", type: "a", module: moduleA },
      { title: "B", type: "b", module: moduleB },
      { title: "C", type: "c", module: moduleC },
    ];

    const panelCatalog = new MockPanelCatalog(panels);

    const onChange = () => {
      throw new Error("unexpected call to onChange");
    };
    const { rerender, unmount } = render(
      <UnconnectedPanelLayout
        layout={{ first: "a", second: "b", direction: "row", splitPercentage: 50 }}
        onChange={onChange}
      />,
      {
        wrapper: function Wrapper({ children }: React.PropsWithChildren) {
          const [config] = useState(() => makeMockAppConfiguration());

          return (
            <DndProvider backend={HTML5Backend}>
              <WorkspaceContextProvider>
                <AppConfigurationContext.Provider value={config}>
                  <MockCurrentLayoutProvider>
                    <MessagePipelineProvider>
                      <PanelStateContextProvider>
                        <ExtensionCatalogProvider loaders={[]}>
                          <PanelCatalogContext.Provider value={panelCatalog}>
                            {children}
                          </PanelCatalogContext.Provider>
                        </ExtensionCatalogProvider>
                      </PanelStateContextProvider>
                    </MessagePipelineProvider>
                  </MockCurrentLayoutProvider>
                </AppConfigurationContext.Provider>
              </WorkspaceContextProvider>
            </DndProvider>
          );
        },
      },
    );

    await waitFor(() => {
      expect(renderA).toHaveBeenCalled();
    });
    // Each panel module should have only been loaded once
    expect(moduleA).toHaveBeenCalledTimes(1);
    expect(moduleB).toHaveBeenCalledTimes(1);
    expect(moduleC).toHaveBeenCalledTimes(0);
    expect(renderA).toHaveBeenCalledTimes(2);
    expect(renderB).toHaveBeenCalledTimes(2);
    expect(renderC).toHaveBeenCalledTimes(0);

    rerender(
      <UnconnectedPanelLayout
        layout={{ first: "a", second: "c", direction: "row", splitPercentage: 40 }}
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(renderC).toHaveBeenCalledTimes(2);
    });
    // Each panel module should have only been loaded once; panels A and B should not render again
    expect(moduleA).toHaveBeenCalledTimes(1);
    expect(moduleB).toHaveBeenCalledTimes(1);
    expect(moduleC).toHaveBeenCalledTimes(1);
    expect(renderA).toHaveBeenCalledTimes(2);
    expect(renderB).toHaveBeenCalledTimes(2);
    expect(renderC).toHaveBeenCalledTimes(2);

    unmount();
  });
});

// Creates a zustand store backed ExtensionCatalogContext with controllable `installedExtensions`
// state, so tests can simulate the extension catalog still loading (`undefined`) or ready (`[]`).
function createExtensionCatalogStore(
  initial?: Partial<ExtensionCatalog>,
): StoreApi<ExtensionCatalog> {
  return createStore<ExtensionCatalog>()(() => ({
    downloadExtension: async () => new Uint8Array(),
    installExtensions: async () => [],
    getExtensionPackage: async () => undefined,
    isExtensionInstalled: () => false,
    markExtensionAsInstalled: () => {},
    mergeState: () => {},
    refreshAllExtensions: async () => {},
    uninstallExtension: async () => {},
    unMarkExtensionAsInstalled: () => {},
    loadedExtensions: new Set<string>(),
    installedExtensions: [],
    installedPanels: {},
    installedMessageConverters: [],
    installedTopicAliasFunctions: [],
    installedCameraModels: new Map(),
    panelSettings: {},
    ...initial,
  }));
}

function makeMockPanel(type: string, label: string): {
  renderFn: jest.Mock;
  moduleFn: jest.Mock;
  panelInfo: PanelInfo;
} {
  const renderFn = jest.fn().mockReturnValue(<>{label}</>);
  // The module returns a synchronously-resolving thenable so React.lazy resolves it during the
  // first render and the panel mounts without suspending. This keeps tests deterministic: in
  // jsdom, Suspense retries for lazy panels nested inside a mosaic (e.g. a Tab panel's inner
  // layout) loop forever re-mounting the tile, which is unrelated to PanelLayout's behavior.
  const moduleFn = jest.fn().mockImplementation(() => ({
    then: (resolve: (moduleObject: { default: PanelComponent }) => void) => {
      resolve({
        default: Panel(Object.assign(renderFn, { panelType: type, defaultConfig: {} })),
      });
    },
  }));
  return {
    renderFn,
    moduleFn,
    panelInfo: {
      title: label,
      type,
      // The thenable is not a real Promise; the assertion documents the Promise contract
      // React.lazy consumes.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      module: moduleFn as unknown as PanelInfo["module"],
    },
  };
}

// Like makeMockPanel, but for the real Tab panel (already wrapped with Panel()).
function makeMockTabModule(): jest.Mock {
  const moduleFn = jest.fn().mockImplementation(() => ({
    then: (resolve: (moduleObject: { default: PanelComponent }) => void) => {
      resolve({ default: TabPanel });
    },
  }));
  return moduleFn;
}

// Mirrors PanelCatalogProvider behavior: extension panels only enter the catalog once the
// extension store publishes them in `installedPanels` (keyed by panel type), and the catalog
// object gets a new identity when that happens so PanelLayout re-resolves its panel components.
function TestPanelCatalogProvider({
  builtinPanels,
  extensionPanels = [],
  children,
}: React.PropsWithChildren<{
  builtinPanels: PanelInfo[];
  extensionPanels?: PanelInfo[];
}>): React.JSX.Element {
  const installedPanels = useExtensionCatalog((state) => state.installedPanels);
  const panelCatalog = useMemo<PanelCatalog>(() => {
    const installedTypes = new Set(Object.keys(installedPanels ?? {}));
    const panels = [
      ...builtinPanels,
      ...extensionPanels.filter((panel) => installedTypes.has(panel.type)),
    ];
    return {
      getPanels: () => panels,
      getPanelByType: (type: string) => panels.find((panel) => panel.type === type),
    };
  }, [builtinPanels, extensionPanels, installedPanels]);
  return <PanelCatalogContext.Provider value={panelCatalog}>{children}</PanelCatalogContext.Provider>;
}

function renderPanelLayout({
  layout,
  configById = {},
  store,
  builtinPanels,
  extensionPanels = [],
}: {
  layout: MosaicNode<string>;
  configById?: Record<string, PanelConfig>;
  store: StoreApi<ExtensionCatalog>;
  builtinPanels: PanelInfo[];
  extensionPanels?: PanelInfo[];
}) {
  return render(
    <DndProvider backend={HTML5Backend}>
      <WorkspaceContextProvider>
        <AppConfigurationContext.Provider value={makeMockAppConfiguration()}>
          <MockCurrentLayoutProvider initialState={{ layout, configById }}>
            <MessagePipelineProvider>
              <PanelStateContextProvider>
                <ExtensionCatalogContext.Provider value={store}>
                  <TestPanelCatalogProvider
                    builtinPanels={builtinPanels}
                    extensionPanels={extensionPanels}
                  >
                    <PanelLayout />
                  </TestPanelCatalogProvider>
                </ExtensionCatalogContext.Provider>
              </PanelStateContextProvider>
            </MessagePipelineProvider>
          </MockCurrentLayoutProvider>
        </AppConfigurationContext.Provider>
      </WorkspaceContextProvider>
    </DndProvider>,
  );
}

describe("PanelLayout", () => {
  beforeEach(() => {
    // jsdom can't parse our @container CSS so we have to silence console.error for this test.
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    (console.error as jest.Mock).mockRestore();
  });

  it("mounts built-in panels immediately while remote extensions are still loading", async () => {
    const builtin = makeMockPanel("a", "A");
    const ext = makeMockPanel("ext.MyPanel", "EXT");
    const store = createExtensionCatalogStore({ installedExtensions: undefined });

    renderPanelLayout({
      layout: { first: "a", second: "ext.MyPanel!abc", direction: "row", splitPercentage: 50 },
      store,
      builtinPanels: [builtin.panelInfo],
      extensionPanels: [ext.panelInfo],
    });

    // The built-in panel is mounted even though the extension catalog is still loading...
    await waitFor(() => {
      expect(builtin.renderFn).toHaveBeenCalled();
    });
    expect(store.getState().installedExtensions).toBeUndefined();
    // ...and the tile referencing the not-yet-loaded extension shows a loading placeholder
    // instead of UnknownPanel, without loading the extension module.
    expect(screen.getByText(/Loading extensions/)).toBeInTheDocument();
    expect(screen.queryByText(/Unknown panel type/)).not.toBeInTheDocument();
    expect(ext.moduleFn).not.toHaveBeenCalled();
  });

  it("recovers extension panel tiles once the extension catalog is ready", async () => {
    const builtin = makeMockPanel("a", "A");
    const ext = makeMockPanel("ext.MyPanel", "EXT");
    const extRegisteredPanel: RegisteredPanel = {
      extensionId: "ext",
      extensionName: "ext",
      registration: { name: "MyPanel", initPanel: () => {} },
    };
    const store = createExtensionCatalogStore({ installedExtensions: undefined });

    renderPanelLayout({
      layout: { first: "a", second: "ext.MyPanel!abc", direction: "row", splitPercentage: 50 },
      store,
      builtinPanels: [builtin.panelInfo],
      extensionPanels: [ext.panelInfo],
    });

    await waitFor(() => {
      expect(screen.getByText(/Loading extensions/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Unknown panel type/)).not.toBeInTheDocument();

    // Extensions finished loading, but the catalog has not published the extension panel yet
    // (installedPanels unchanged): the tile becomes UnknownPanel instead of recovering.
    act(() => {
      store.setState({ installedExtensions: [] });
    });
    await waitFor(() => {
      expect(screen.getByText("Unknown panel type: ext.MyPanel.")).toBeInTheDocument();
    });
    expect(ext.moduleFn).not.toHaveBeenCalled();

    // The catalog publishes the extension panel via installedPanels (as PanelCatalogProvider
    // consumes it), and the placeholder tile recovers to the real panel.
    act(() => {
      store.setState({ installedPanels: { "ext.MyPanel": extRegisteredPanel } });
    });

    await waitFor(() => {
      expect(ext.renderFn).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Loading extensions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unknown panel type/)).not.toBeInTheDocument();
    expect(ext.moduleFn).toHaveBeenCalledTimes(1);
  });

  it("mounts built-in panels and shows extension placeholders inside a Tab panel while extensions are loading", async () => {
    const builtin = makeMockPanel("a", "A");
    const ext = makeMockPanel("ext.MyPanel", "EXT");
    const tabModule = makeMockTabModule();
    const store = createExtensionCatalogStore({ installedExtensions: undefined });

    renderPanelLayout({
      layout: "Tab!tab1",
      configById: {
        "Tab!tab1": {
          activeTabIdx: 0,
          tabs: [
            {
              title: "Tab A",
              layout: {
                first: "a",
                second: "ext.MyPanel!abc",
                direction: "row",
                splitPercentage: 50,
              },
            },
          ],
        },
      },
      store,
      builtinPanels: [builtin.panelInfo, { title: "Tab", type: "Tab", module: tabModule }],
      extensionPanels: [ext.panelInfo],
    });

    // The built-in panel inside the Tab's nested layout is mounted even though the extension
    // catalog is still loading...
    await waitFor(() => {
      expect(builtin.renderFn).toHaveBeenCalled();
    });
    expect(store.getState().installedExtensions).toBeUndefined();
    // ...and the nested tile referencing the not-yet-loaded extension shows a loading placeholder
    // instead of UnknownPanel, without loading the extension module.
    expect(screen.getByText(/Loading extensions/)).toBeInTheDocument();
    expect(screen.queryByText(/Unknown panel type/)).not.toBeInTheDocument();
    expect(ext.moduleFn).not.toHaveBeenCalled();
  });

  it("recovers extension tiles inside a Tab panel once the catalog is ready", async () => {
    const builtin = makeMockPanel("a", "A");
    const ext = makeMockPanel("ext.MyPanel", "EXT");
    const tabModule = makeMockTabModule();
    const extRegisteredPanel: RegisteredPanel = {
      extensionId: "ext",
      extensionName: "ext",
      registration: { name: "MyPanel", initPanel: () => {} },
    };
    const store = createExtensionCatalogStore({ installedExtensions: undefined });

    renderPanelLayout({
      layout: "Tab!tab1",
      configById: {
        "Tab!tab1": {
          activeTabIdx: 0,
          tabs: [
            {
              title: "Tab A",
              layout: {
                first: "a",
                second: "ext.MyPanel!abc",
                direction: "row",
                splitPercentage: 50,
              },
            },
          ],
        },
      },
      store,
      builtinPanels: [builtin.panelInfo, { title: "Tab", type: "Tab", module: tabModule }],
      extensionPanels: [ext.panelInfo],
    });

    await waitFor(() => {
      expect(screen.getByText(/Loading extensions/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Unknown panel type/)).not.toBeInTheDocument();

    // Extensions finished loading, but the catalog has not published the extension panel yet
    // (installedPanels unchanged): the nested tile becomes UnknownPanel instead of recovering.
    act(() => {
      store.setState({ installedExtensions: [] });
    });
    await waitFor(() => {
      expect(screen.getByText("Unknown panel type: ext.MyPanel.")).toBeInTheDocument();
    });
    expect(ext.moduleFn).not.toHaveBeenCalled();

    // The catalog publishes the extension panel via installedPanels, and the nested tile recovers
    // to the real panel.
    act(() => {
      store.setState({ installedPanels: { "ext.MyPanel": extRegisteredPanel } });
    });

    await waitFor(() => {
      expect(ext.renderFn).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Loading extensions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unknown panel type/)).not.toBeInTheDocument();
    expect(ext.moduleFn).toHaveBeenCalledTimes(1);
  });


  it("shows UnknownPanel for unknown types once the catalog is ready", async () => {
    const builtin = makeMockPanel("a", "A");
    const store = createExtensionCatalogStore({ installedExtensions: [] });

    renderPanelLayout({
      layout: "unknown!xyz",
      store,
      builtinPanels: [builtin.panelInfo],
    });

    await waitFor(() => {
      expect(screen.getByText("Unknown panel type: unknown.")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Loading extensions/)).not.toBeInTheDocument();
  });

  it("renders the mosaic immediately when the extension catalog is ready", async () => {
    const builtin = makeMockPanel("a", "A");
    const store = createExtensionCatalogStore({ installedExtensions: [] });

    renderPanelLayout({ layout: "a", store, builtinPanels: [builtin.panelInfo] });

    await waitFor(() => {
      expect(builtin.renderFn).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Loading extensions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unknown panel type/)).not.toBeInTheDocument();
  });
});
