// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  AGENT_PROMPT_MAX_CUSTOM_SKILLS,
  AGENT_PROMPT_MAX_INSTRUCTIONS_LENGTH,
  type AgentPromptCustomization,
  validateAgentPromptCustomization,
} from "@lichtblick/suite-base/services/agent/prompts/agentPrompts";
import HttpService from "@lichtblick/suite-base/services/http/HttpService";
import {
  resolveVizServerConfigured,
  resolveWorkspaceBestEffort,
} from "@lichtblick/suite-base/util/vizServerParams";

export type AgentBootstrapConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: "anthropic" | "openai-compatible";
  vtdAuthToken?: string;
  vtdEndpoint?: string;
};

export type AgentBootstrap = {
  apiKeyOmitted?: true;
  config?: AgentBootstrapConfig;
  prompt?: AgentPromptCustomization;
  syncedAt?: string;
  version: string;
};

export type AgentBootstrapResponse = AgentBootstrap & {
  unchanged?: true;
};

const BOOTSTRAP_CACHE_KEY = "lichtblick.vizserver.agent-bootstrap.v1";
const inMemoryBootstraps = new Map<string, AgentBootstrap>();
/**
 * Monotonic per-workspace fetch sequence. A response may only write the cache if no *later*
 * fetch has already applied its result, so an out-of-order stale response cannot roll the cache
 * back after a fresher full fetch (for example a post-invalidation re-fetch) landed.
 */
const bootstrapFetchSequences = new Map<string, number>();
const appliedBootstrapSequences = new Map<string, number>();

/**
 * Listener invoked with the workspace id whenever `invalidateAgentBootstrapCache` clears a
 * workspace's bootstrap cache. Consumers use this to trigger an immediate re-fetch.
 */
export type AgentBootstrapInvalidationListener = (workspace: string) => void;
const invalidationListeners = new Set<AgentBootstrapInvalidationListener>();

/**
 * Subscribes to bootstrap cache invalidations. Returns an unsubscribe function.
 *
 * Consumers that render the server-provided prompt/skills (e.g. the Workspace bootstrap polling
 * effect) should subscribe and re-fetch on the matching workspace: after an invalidation the
 * cached version is gone, so the next fetch is forced to omit `known_version` and returns the
 * full payload.
 */
export function subscribeAgentBootstrapInvalidation(
  listener: AgentBootstrapInvalidationListener,
): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

/**
 * Drops the cached bootstrap (memory and persisted copy) for the given workspace, so the next
 * `fetchAgentBootstrap` call sends no `known_version` and the server returns the full payload
 * instead of `unchanged`. Notifies subscribers immediately so they can re-fetch right away.
 *
 * This is the single entry point for invalidating the bootstrap cache after a server-side change
 * (for example a deleted remote skill); consumers must not manipulate the cache directly.
 */
export function invalidateAgentBootstrapCache(workspace: string): void {
  inMemoryBootstraps.delete(workspace);
  const storage = getStorage();
  if (storage != undefined) {
    try {
      const record = readCacheRecord();
      if (hasOwn(record, workspace)) {
        delete record[workspace];
        const serialized = JSON.stringify(record);
        if (serialized != undefined) {
          storage.setItem(BOOTSTRAP_CACHE_KEY, serialized);
        }
      }
    } catch {
      // Storage failures must not break invalidation; the in-memory copy is already gone.
    }
  }
  for (const listener of [...invalidationListeners]) {
    try {
      listener(workspace);
    } catch {
      // A failing subscriber must not prevent other subscribers from being notified.
    }
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function getStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function parsePrompt(value: unknown): AgentPromptCustomization {
  if (!isRecord(value) || typeof value.instructions !== "string") {
    throw new Error("Invalid agent prompt customization");
  }
  if (!isRecord(value.skillOverrides) || !Array.isArray(value.customSkills)) {
    throw new Error("Invalid agent prompt customization");
  }
  if (Object.values(value.skillOverrides).some((body) => typeof body !== "string")) {
    throw new Error("Invalid agent prompt customization");
  }

  const customSkills = value.customSkills.map((skill) => {
    if (
      !isRecord(skill) ||
      typeof skill.id !== "string" ||
      typeof skill.name !== "string" ||
      typeof skill.whenToUse !== "string" ||
      typeof skill.body !== "string"
    ) {
      throw new Error("Invalid agent prompt customization");
    }
    return {
      body: skill.body,
      id: skill.id,
      name: skill.name,
      whenToUse: skill.whenToUse,
    };
  });
  const prompt = {
    customSkills,
    instructions: value.instructions,
    skillOverrides: Object.fromEntries(Object.entries(value.skillOverrides) as [string, string][]),
  };
  validateAgentPromptCustomization(prompt);
  return prompt;
}

function parseOptionalString(
  record: Record<string, unknown>,
  field: keyof Omit<AgentBootstrapConfig, "provider">,
): string | undefined {
  const value = record[field];
  if (value == undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid agent bootstrap config field: ${field}`);
  }
  return value;
}

function parseConfig(value: unknown): AgentBootstrapConfig {
  if (!isRecord(value)) {
    throw new Error("Invalid agent bootstrap config");
  }
  const provider = value.provider;
  if (provider != undefined && provider !== "anthropic" && provider !== "openai-compatible") {
    throw new Error("Invalid agent bootstrap config field: provider");
  }
  return {
    ...(provider == undefined ? {} : { provider }),
    ...(parseOptionalString(value, "model") == undefined
      ? {}
      : { model: parseOptionalString(value, "model") }),
    ...(parseOptionalString(value, "baseUrl") == undefined
      ? {}
      : { baseUrl: parseOptionalString(value, "baseUrl") }),
    ...(parseOptionalString(value, "apiKey") == undefined
      ? {}
      : { apiKey: parseOptionalString(value, "apiKey") }),
    ...(parseOptionalString(value, "vtdEndpoint") == undefined
      ? {}
      : { vtdEndpoint: parseOptionalString(value, "vtdEndpoint") }),
    ...(parseOptionalString(value, "vtdAuthToken") == undefined
      ? {}
      : { vtdAuthToken: parseOptionalString(value, "vtdAuthToken") }),
  };
}

function parseBootstrap(value: unknown): AgentBootstrapResponse {
  if (!isRecord(value) || typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("Invalid agent bootstrap response");
  }
  if (value.unchanged != undefined && value.unchanged !== true) {
    throw new Error("Invalid agent bootstrap response");
  }
  if (value.unchanged === true) {
    return { unchanged: true, version: value.version };
  }
  return {
    ...(value.config == undefined ? {} : { config: parseConfig(value.config) }),
    ...(value.prompt == undefined ? {} : { prompt: parsePrompt(value.prompt) }),
    version: value.version,
  };
}

function parseCachedBootstrap(value: unknown): AgentBootstrap | undefined {
  if (!isRecord(value) || typeof value.version !== "string" || value.version.length === 0) {
    return undefined;
  }
  try {
    return {
      ...(value.apiKeyOmitted === true ? { apiKeyOmitted: true as const } : {}),
      ...(value.config == undefined ? {} : { config: parseConfig(value.config) }),
      ...(value.prompt == undefined ? {} : { prompt: parsePrompt(value.prompt) }),
      ...(typeof value.syncedAt === "string" ? { syncedAt: value.syncedAt } : {}),
      version: value.version,
    };
  } catch {
    return undefined;
  }
}

function readCacheRecord(): Record<string, unknown> {
  const storage = getStorage();
  if (storage == undefined) {
    return {};
  }
  try {
    const serialized = storage.getItem(BOOTSTRAP_CACHE_KEY);
    if (serialized == undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function persistBootstrap(workspace: string, bootstrap: AgentBootstrap): void {
  const storage = getStorage();
  if (storage == undefined) {
    return;
  }
  const { apiKey: _apiKey, ...cacheableConfig } = bootstrap.config ?? {};
  const cacheableBootstrap: AgentBootstrap = {
    ...bootstrap,
    ...(bootstrap.apiKeyOmitted === true || bootstrap.config?.apiKey != undefined
      ? { apiKeyOmitted: true }
      : {}),
    ...(bootstrap.config == undefined ? {} : { config: cacheableConfig }),
  };
  try {
    const serialized = JSON.stringify({
      ...readCacheRecord(),
      [workspace]: cacheableBootstrap,
    });
    if (serialized == undefined) {
      return;
    }
    storage.setItem(BOOTSTRAP_CACHE_KEY, serialized);
  } catch {
    // The in-memory bootstrap remains usable when storage is unavailable or full.
  }
}

function applyBootstrap(workspace: string, bootstrap: AgentBootstrap): AgentBootstrap {
  inMemoryBootstraps.set(workspace, bootstrap);
  persistBootstrap(workspace, bootstrap);
  return bootstrap;
}

export function readCachedAgentBootstrap(workspace: string): AgentBootstrap | undefined {
  const current = inMemoryBootstraps.get(workspace);
  if (current != undefined) {
    return current;
  }
  const cached = parseCachedBootstrap(readCacheRecord()[workspace]);
  if (cached != undefined) {
    inMemoryBootstraps.set(workspace, cached);
  }
  return cached;
}

export function readCurrentAgentBootstrap(): AgentBootstrap | undefined {
  const workspace = resolveWorkspaceBestEffort();
  return resolveVizServerConfigured(workspace)
    ? readCachedAgentBootstrap(workspace)
    : undefined;
}

export async function fetchAgentBootstrap(
  workspace: string,
  knownVersion?: string,
): Promise<AgentBootstrapResponse> {
  const sequence = (bootstrapFetchSequences.get(workspace) ?? 0) + 1;
  bootstrapFetchSequences.set(workspace, sequence);
  const { data } = await HttpService.get<unknown>(
    `workspaces/${encodeURIComponent(workspace)}/agent/bootstrap`,
    knownVersion == undefined ? {} : { known_version: knownVersion },
  );
  const response = parseBootstrap(data);
  if (response.unchanged === true) {
    return response;
  }
  const bootstrap = {
    ...response,
    syncedAt: new Date().toISOString(),
  };
  // A later fetch (higher sequence) already applied its result; this response is stale and must
  // not overwrite the fresher cache entry, even though the caller may still use it.
  if ((appliedBootstrapSequences.get(workspace) ?? 0) > sequence) {
    return bootstrap;
  }
  appliedBootstrapSequences.set(workspace, sequence);
  return applyBootstrap(workspace, bootstrap);
}

export function mergeCustomizations(
  server: AgentPromptCustomization | undefined,
  local: AgentPromptCustomization,
): AgentPromptCustomization {
  if (server == undefined) {
    return local;
  }
  const instructions = [server.instructions, local.instructions]
    .filter((value) => value.length > 0)
    .join("\n\n")
    .slice(-AGENT_PROMPT_MAX_INSTRUCTIONS_LENGTH);
  const localSkills = [
    ...new Map(local.customSkills.map((skill) => [skill.id, skill])).values(),
  ].slice(0, AGENT_PROMPT_MAX_CUSTOM_SKILLS);
  const localSkillIds = new Set(localSkills.map((skill) => skill.id));
  const serverSkills = [
    ...new Map(server.customSkills.map((skill) => [skill.id, skill])).values(),
  ].filter((skill) => !localSkillIds.has(skill.id));
  const serverSkillLimit = Math.max(0, AGENT_PROMPT_MAX_CUSTOM_SKILLS - localSkills.length);

  return {
    customSkills: [...serverSkills.slice(0, serverSkillLimit), ...localSkills],
    instructions,
    skillOverrides: { ...server.skillOverrides, ...local.skillOverrides },
  };
}

export async function publishCustomization(
  workspace: string,
  local: AgentPromptCustomization,
): Promise<AgentBootstrap> {
  validateAgentPromptCustomization(local);
  const { data } = await HttpService.put<unknown>(
    `workspaces/${encodeURIComponent(workspace)}/agent/prompt`,
    local,
  );
  if (!isRecord(data) || typeof data.version !== "string" || data.version.length === 0) {
    throw new Error("Invalid agent prompt publish response");
  }
  const current = readCachedAgentBootstrap(workspace);
  return applyBootstrap(workspace, {
    ...(current?.apiKeyOmitted === true ? { apiKeyOmitted: true } : {}),
    ...(current?.config == undefined ? {} : { config: current.config }),
    prompt: local,
    syncedAt: new Date().toISOString(),
    version: data.version,
  });
}
