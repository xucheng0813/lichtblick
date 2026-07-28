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
import { AnthropicProvider } from "@lichtblick/suite-base/services/agent/local/AnthropicProvider";
import { LocalAgentOrchestrator } from "@lichtblick/suite-base/services/agent/local/LocalAgentOrchestrator";
import { OpenAICompatProvider } from "@lichtblick/suite-base/services/agent/local/OpenAICompatProvider";
import type { CatalogSnapshot } from "@lichtblick/suite-base/services/agent/local/types";
import DesktopVtdClient from "@lichtblick/suite-base/services/vtd/DesktopVtdClient";
import HttpVtdClient from "@lichtblick/suite-base/services/vtd/HttpVtdClient";

const log = Logger.getLogger(__filename);

export type AgentClientConfiguration = AgentConfiguration & {
  getCatalog: () => CatalogSnapshot;
};

export function createLocalAgentClient({
  apiKey,
  baseUrl,
  desktop,
  getCatalog,
  model,
  provider,
  vtdAuthToken,
  vtdEndpoint,
}: AgentClientConfiguration): LocalAgentOrchestrator {
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
  const llmProvider =
    provider === "openai-compatible"
      ? new OpenAICompatProvider({
          apiKey,
          baseUrl: normalizedBaseUrl,
          model: normalizedModel,
        })
      : new AnthropicProvider({
          apiKey,
          baseUrl: normalizedBaseUrl === "" ? undefined : normalizedBaseUrl,
          model: normalizedModel,
        });
  const vtdClient = desktop
    ? new DesktopVtdClient()
    : new HttpVtdClient(
        vtdEndpoint!.trim(),
        globalThis.fetch,
        undefined,
        vtdAuthToken?.trim() === "" ? undefined : vtdAuthToken?.trim(),
      );

  return new LocalAgentOrchestrator({
    provider: llmProvider,
    vtdClient,
    getCatalog,
  });
}

export function useLocalAgentClient(
  configuration: AgentConfiguration,
  {
    enabled,
    getCatalog,
  }: {
    enabled: boolean;
    getCatalog: AgentClientConfiguration["getCatalog"];
  },
): LocalAgentOrchestrator | undefined {
  const { apiKey, baseUrl, desktop, model, provider, vtdAuthToken, vtdEndpoint } =
    configuration;
  const stableGetCatalog = useLatestAgentCatalog(getCatalog);
  // The identity is a pure render value. Resource creation is deferred until a committed layout
  // effect, so an abandoned concurrent render cannot leak an orchestrator.
  const configurationIdentity = useMemo(
    () => ({
      apiKey,
      baseUrl,
      desktop,
      enabled,
      model,
      provider,
      vtdAuthToken,
      vtdEndpoint,
    }),
    [apiKey, baseUrl, desktop, enabled, model, provider, vtdAuthToken, vtdEndpoint],
  );
  const valid =
    configurationIdentity.enabled &&
    isAgentConfigurationValid(configurationIdentity);
  const [resource, setResource] = useState<{
    client: LocalAgentOrchestrator;
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
      model: current.model,
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
  }, [configurationIdentity, stableGetCatalog, valid]);

  return valid && resource?.identity === configurationIdentity
    ? resource.client
    : undefined;
}

export function useLatestAgentCatalog(
  getCatalog: AgentClientConfiguration["getCatalog"],
): AgentClientConfiguration["getCatalog"] {
  const latestGetCatalogRef = useRef(getCatalog);
  useLayoutEffect(() => {
    latestGetCatalogRef.current = getCatalog;
  }, [getCatalog]);
  return useCallback(() => latestGetCatalogRef.current(), []);
}
