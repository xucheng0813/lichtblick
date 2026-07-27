// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useMemo } from "react";

import { useDataSourceInfo } from "@lichtblick/suite-base/PanelAPI";
import { useCurrentLayoutActions } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import { usePlayerSelection } from "@lichtblick/suite-base/context/PlayerSelectionContext";
import { validateLayoutProposalData } from "@lichtblick/suite-base/services/agent/layoutSchema";

export type AgentWorkspaceTools = {
  openDataSource(urls: string[]): void;
  getCatalog(): {
    topics: readonly unknown[];
    datatypes: ReadonlyMap<string, unknown>;
  };
  applyLayout(name: string, data: unknown): Promise<void>;
  getCurrentLayout(): unknown;
};

export function useAgentWorkspaceTools(): AgentWorkspaceTools {
  const { selectSource } = usePlayerSelection();
  const layoutManager = useLayoutManager();
  const { getCurrentLayoutState, setSelectedLayoutId } =
    useCurrentLayoutActions();
  const { datatypes, topics } = useDataSourceInfo();

  const openDataSource = useCallback(
    (urls: string[]) => {
      if (urls.length === 0) {
        throw new Error("Agent data source must include at least one URL");
      }
      if (urls.some((url) => url.includes(","))) {
        throw new Error(
          "Agent data source URLs must not contain literal commas; encode commas as %2C",
        );
      }

      // PlayerSelection's public API returns void. It validates these synchronous arguments, but
      // remote player initialization failures are reported later by PlayerManager. Agent Chat must
      // therefore rely on AgentCatalogWatcher and the actionable
      // `agentChat:catalogLoadTimeout` 120-second timeout surfaced by the state/UI integration.
      selectSource("remote-file", {
        type: "connection",
        params: { url: urls.join(",") },
      });
    },
    [selectSource],
  );

  const getCatalog = useCallback(() => {
    // Reserved for protocol-v1 catalog reporting after the backend accepts the catalog payload.
    return { topics, datatypes };
  }, [datatypes, topics]);

  const applyLayout = useCallback(
    async (name: string, data: unknown) => {
      const validatedData = validateLayoutProposalData(data);
      const layout = await layoutManager.saveNewLayout({
        name,
        data: validatedData,
        permission: "CREATOR_WRITE",
      });

      // The public CurrentLayoutContext contract returns void: selection/loading continues
      // asynchronously and reports its own errors. Only saveNewLayout is awaited and can be
      // truthfully reported to Agent Chat as completed here.
      setSelectedLayoutId(layout.id);
    },
    [layoutManager, setSelectedLayoutId],
  );

  const getCurrentLayout = useCallback(() => {
    // Reserved for protocol-v1 context/catalog reporting before requesting a replacement layout.
    return getCurrentLayoutState().selectedLayout?.data;
  }, [getCurrentLayoutState]);

  return useMemo(
    () => ({
      openDataSource,
      getCatalog,
      applyLayout,
      getCurrentLayout,
    }),
    [applyLayout, getCatalog, getCurrentLayout, openDataSource],
  );
}
