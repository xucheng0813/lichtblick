// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import Logger from "@lichtblick/log";
import {
  AgentConfiguration,
  isAgentConfigurationValid,
} from "@lichtblick/suite-base/services/agent/agentSettings";
import { summarizeWorkspace } from "@lichtblick/suite-base/services/agent/local/systemPrompt";
import type { CatalogSnapshot } from "@lichtblick/suite-base/services/agent/local/types";
import type { AgentMemoryStore } from "@lichtblick/suite-base/services/agent/memory/agentMemory";
import type { PanelInventoryEntry } from "@lichtblick/suite-base/services/agent/panelInventory";
import {
  PiAgentOrchestrator,
  type PiAgentOrchestratorOptions,
} from "@lichtblick/suite-base/services/agent/pi/PiAgentOrchestrator";
import DesktopVtdClient from "@lichtblick/suite-base/services/vtd/DesktopVtdClient";
import HttpVtdClient from "@lichtblick/suite-base/services/vtd/HttpVtdClient";

const log = Logger.getLogger(__filename);

const noLayout = (): undefined => undefined;
const noPanels = (): readonly PanelInventoryEntry[] => [];

export type AgentClientConfiguration = AgentConfiguration & {
  getCatalog: () => CatalogSnapshot;
  getCurrentLayout?: () => unknown;
  getPanelInventory?: () => readonly PanelInventoryEntry[];
  memoryStore?: AgentMemoryStore;
  onHistoryChanged?: PiAgentOrchestratorOptions["onHistoryChanged"];
  restoreHistory?: PiAgentOrchestratorOptions["restoreHistory"];
  getPromptCustomization?: PiAgentOrchestratorOptions["getPromptCustomization"];
};

export function createLocalAgentClient({
  apiKey,
  baseUrl,
  desktop,
  getCatalog,
  getCurrentLayout,
  getPanelInventory,
  getPromptCustomization,
  memoryStore,
  model,
  onHistoryChanged,
  restoreHistory,
  provider,
  vtdAuthToken,
  vtdEndpoint,
}: AgentClientConfiguration): PiAgentOrchestrator {
  if (
    !isAgentConfigurationValid({
      apiKey,
      baseUrl,
      desktop,
      model,
      provider,
      vtdAuthToken,
      vtdEndpoint,
    })
  ) {
    throw new Error("Cannot create a local Agent client from an invalid configuration");
  }

  const normalizedBaseUrl = baseUrl.trim();
  const normalizedModel = model.trim();
  const vtdClient = desktop
    ? new DesktopVtdClient()
    : new HttpVtdClient(
        vtdEndpoint!.trim(),
        globalThis.fetch,
        undefined,
        vtdAuthToken?.trim() === "" ? undefined : vtdAuthToken?.trim(),
      );

  return new PiAgentOrchestrator({
    configuration: {
      apiKey,
      baseUrl: normalizedBaseUrl,
      desktop,
      model: normalizedModel,
      provider,
      vtdAuthToken,
      vtdEndpoint,
    },
    getPromptCustomization,
    getPanelInventory,
    getWorkspaceContext: () => summarizeWorkspace(getCatalog(), getCurrentLayout?.()),
    memoryStore,
    onHistoryChanged,
    restoreHistory,
    toolRuntime: {
      deps: {
        getCatalog,
        memoryStore,
        vtdClient,
      },
    },
  });
}

export function useLocalAgentClient(
  configuration: AgentConfiguration,
  {
    enabled,
    getCatalog,
    getCurrentLayout,
    getPanelInventory,
    getPromptCustomization,
    memoryStore,
    onHistoryChanged,
    profileId,
    restoreHistory,
  }: {
    enabled: boolean;
    getCatalog: AgentClientConfiguration["getCatalog"];
    getCurrentLayout?: () => unknown;
    getPanelInventory?: () => readonly PanelInventoryEntry[];
    memoryStore?: AgentMemoryStore;
    onHistoryChanged?: PiAgentOrchestratorOptions["onHistoryChanged"];
    profileId?: string;
    restoreHistory?: PiAgentOrchestratorOptions["restoreHistory"];
    getPromptCustomization?: PiAgentOrchestratorOptions["getPromptCustomization"];
  },
): PiAgentOrchestrator | undefined {
  const { apiKey, baseUrl, desktop, model, provider, vtdAuthToken, vtdEndpoint } =
    configuration;
  const stableGetCatalog = useLatestAgentCatalog(getCatalog);
  const stableGetCurrentLayout = useLatestGetter(getCurrentLayout ?? noLayout);
  const stableGetPanelInventory = useLatestGetter(getPanelInventory ?? noPanels);
  // The identity is a pure render value. Resource creation is deferred until a committed layout
  // effect, so an abandoned concurrent render cannot leak an orchestrator.
  const configurationIdentity = useMemo(
    () => ({
      apiKey,
      baseUrl,
      desktop,
      enabled,
      model,
      profileId,
      provider,
      vtdAuthToken,
      vtdEndpoint,
    }),
    [apiKey, baseUrl, desktop, enabled, model, profileId, provider, vtdAuthToken, vtdEndpoint],
  );
  const valid =
    configurationIdentity.enabled &&
    isAgentConfigurationValid(configurationIdentity);
  const [resource, setResource] = useState<{
    client: PiAgentOrchestrator;
    identity: object;
  }>();
  useLayoutEffect(() => {
    if (!valid) {
      return undefined;
    }
    const current = configurationIdentity;
    const client = createLocalAgentClient({
      apiKey: current.apiKey,
      baseUrl: current.baseUrl,
      desktop: current.desktop,
      getCatalog: stableGetCatalog,
      getCurrentLayout: stableGetCurrentLayout,
      getPanelInventory: stableGetPanelInventory,
      getPromptCustomization,
      memoryStore,
      model: current.model,
      onHistoryChanged,
      restoreHistory,
      provider: current.provider,
      vtdAuthToken: current.vtdAuthToken,
      vtdEndpoint: current.vtdEndpoint,
    });
    setResource({ client, identity: configurationIdentity });
    return () => {
      try {
        client.dispose();
      } catch (error) {
        log.error(error, "Failed to dispose local Agent orchestrator");
      }
    };
  }, [
    configurationIdentity,
    getPromptCustomization,
    memoryStore,
    onHistoryChanged,
    restoreHistory,
    stableGetCatalog,
    stableGetCurrentLayout,
    stableGetPanelInventory,
    valid,
  ]);

  return valid && resource?.identity === configurationIdentity
    ? resource.client
    : undefined;
}

/**
 * Wraps a getter in a stable identity so it can be handed to the orchestrator without a changing
 * reference forcing the client to be rebuilt on every render.
 */
export function useLatestGetter<T>(getter: () => T): () => T {
  const latestRef = useRef(getter);
  useLayoutEffect(() => {
    latestRef.current = getter;
  }, [getter]);
  return useCallback(() => latestRef.current(), []);
}

export function useLatestAgentCatalog(
  getCatalog: AgentClientConfiguration["getCatalog"],
): AgentClientConfiguration["getCatalog"] {
  return useLatestGetter(getCatalog);
}
