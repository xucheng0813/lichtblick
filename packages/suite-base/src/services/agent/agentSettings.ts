// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { useEffect, useState, useSyncExternalStore } from "react";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import type { IAppConfiguration } from "@lichtblick/suite-base/context/AppConfigurationContext";
import { readCurrentAgentBootstrap } from "@lichtblick/suite-base/services/agent/prompts/remotePromptCustomization";

export type AgentLlmProvider = "anthropic" | "openai-compatible";

export const DEFAULT_AGENT_LLM_PROVIDER: AgentLlmProvider = "anthropic";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

export type AgentConfiguration = {
  apiKey: string;
  baseUrl: string;
  desktop: boolean;
  model: string;
  provider: AgentLlmProvider;
  vtdAuthToken?: string;
  vtdEndpoint?: string;
};

export type AgentConfigurationField =
  | "apiKey"
  | "baseUrl"
  | "model"
  | "vtdAuthToken"
  | "vtdEndpoint";
export type AgentConfigurationError = "invalidToken" | "invalidUrl" | "required";
export type AgentConfigurationErrors = Partial<
  Record<AgentConfigurationField, AgentConfigurationError>
>;

type ProviderSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type AgentSettingsSnapshot = {
  anthropic: ProviderSettings;
  credentialResaveRequired: boolean;
  credentialStorage: "plaintext" | "secure";
  openAiCompatible: ProviderSettings;
  provider: AgentLlmProvider;
  revision: string;
  storageError: boolean;
  vtdAuthToken: string;
  vtdEndpoint: string;
};

export type AgentSettingsDraft = Omit<
  AgentSettingsSnapshot,
  "credentialResaveRequired" | "credentialStorage" | "storageError"
>;

export type AgentSettingsState = {
  credentialBackendUnavailable: boolean;
  migrationError?: Error;
  migrationReady: boolean;
  snapshot: AgentSettingsSnapshot;
};

export class AgentSettingsConflictError extends Error {
  public constructor() {
    super("Agent settings changed in another context");
    this.name = "AgentSettingsConflictError";
  }
}

export class AgentCredentialsBackendUnavailableError extends Error {
  public constructor() {
    super("OS-backed secure credential encryption is temporarily unavailable");
    this.name = "AgentCredentialsBackendUnavailableError";
  }
}

export class AgentPlaintextCredentialLockUnavailableError extends Error {
  public constructor() {
    super("Cross-window locking is unavailable for plaintext credentials");
    this.name = "AgentPlaintextCredentialLockUnavailableError";
  }
}

class InsecureCredentialBackendError extends Error {
  public constructor() {
    super("OS-backed secure credential encryption is unavailable");
    this.name = "InsecureCredentialBackendError";
  }
}

const WEB_CREDENTIAL_STORAGE_KEY = "lichtblick.agent.credentials.v1";
const PREVIOUS_API_KEY_STORAGE_KEYS: Record<AgentLlmProvider, string> = {
  anthropic: "lichtblick.agent.anthropic.apiKey",
  "openai-compatible": "lichtblick.agent.openai.apiKey",
};
const SECURE_LLM_CREDENTIAL = "agent.llmApiKey";
const SECURE_VTD_CREDENTIAL = "agent.vtdAuthToken";
const LEGACY_API_KEY_SETTING = "agent.llmApiKey";
const LEGACY_BASE_URL_SETTING = "agent.llmBaseUrl";
const LEGACY_MODEL_SETTING = "agent.llmModel";
const COMMIT_REVISION_SETTING = "agent.configurationRevision";
const CROSS_RENDERER_COMMIT_LOCK = "lichtblick.agent-settings.commit";

type CredentialBundle = {
  anthropicApiKey: string;
  openAiApiKey: string;
  vtdAuthToken: string;
};

type AgentSettingsMirror = {
  anthropicBaseUrl: string;
  anthropicModel: string;
  openAiBaseUrl: string;
  openAiModel: string;
  provider: AgentLlmProvider;
  vtdEndpoint: string;
};

type CredentialState = {
  configuration?: AgentSettingsMirror;
  credentials: CredentialBundle;
  desktopRecordsPresent: boolean;
  legacyApiKey?: string;
  legacyFormat: boolean;
  resaveRequired: boolean;
  revision: string;
  source: "desktop" | "web";
  storage: "plaintext" | "secure";
  storageError: boolean;
};

interface DesktopBridgeWithSecureCredentials {
  deleteSecureCredential(name: string): Promise<unknown>;
  getSecureCredential(name: string): Promise<unknown>;
  setManySecureCredentials(entries: unknown[]): Promise<unknown>;
}

type AgentSettingsStore = {
  appConfiguration: IAppConfiguration;
  credentialBackendUnavailable: boolean;
  credentialState: CredentialState;
  desktop: boolean;
  listeners: Set<() => void>;
  migrated: boolean;
  migration?: Promise<void>;
  snapshot: AgentSettingsSnapshot;
  suppressRefresh: number;
  unsubscribeSources?: () => void;
};

const EMPTY_CREDENTIALS: CredentialBundle = {
  anthropicApiKey: "",
  openAiApiKey: "",
  vtdAuthToken: "",
};

const stores = new WeakMap<
  IAppConfiguration,
  { desktop?: AgentSettingsStore; web?: AgentSettingsStore }
>();
let agentSettingsCommitChain: Promise<void> = Promise.resolve();

type CrossRendererLockManager = {
  request<Result>(name: string, callback: () => Promise<Result>): Promise<Result>;
};

const OBSERVED_SETTINGS = [
  AppSetting.AGENT_LLM_PROVIDER,
  AppSetting.AGENT_ANTHROPIC_BASE_URL,
  AppSetting.AGENT_ANTHROPIC_MODEL,
  AppSetting.AGENT_OPENAI_BASE_URL,
  AppSetting.AGENT_OPENAI_MODEL,
  AppSetting.AGENT_VTD_ENDPOINT,
  COMMIT_REVISION_SETTING,
] as const;

async function withAgentSettingsCommitLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = agentSettingsCommitChain.then(operation);
  agentSettingsCommitChain = result.then(
    () => undefined,
    () => undefined,
  );
  return await result;
}

function getCrossRendererLockManager(): CrossRendererLockManager | undefined {
  const navigatorValue = globalThis.navigator as (Navigator & { locks?: unknown }) | undefined;
  const lockManager = navigatorValue?.locks;
  if (
    !isRecord(lockManager) ||
    !("request" in lockManager) ||
    typeof lockManager.request !== "function"
  ) {
    return undefined;
  }
  return lockManager;
}

async function withAgentSettingsPersistenceLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return await withAgentSettingsCommitLock(async () => {
    const lockManager = getCrossRendererLockManager();
    if (lockManager == undefined) {
      return await operation();
    }
    return await lockManager.request(CROSS_RENDERER_COMMIT_LOCK, operation);
  });
}

/*
 * Credential trust boundary:
 * - Desktop uses the preload bridge backed by the OS credential store when available.
 * - Installed extensions execute in the application renderer and are trusted at the same level as
 *   the application. They can call the preload bridge or read the plaintext fallback.
 * - Web has no isolated secret channel and deliberately falls back to same-origin localStorage.
 *   Any same-origin script, including an installed extension, can read Web credentials.
 *
 * Raw key names and storage functions stay private and must never be attached to AppContext,
 * WorkspaceContext, contribution points, or the extension API.
 */
function getLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function getDesktopCredentialBridge(): DesktopBridgeWithSecureCredentials {
  const candidate = (globalThis as typeof globalThis & { desktopBridge?: unknown }).desktopBridge;
  if (
    typeof candidate !== "object" ||
    candidate == undefined ||
    !("getSecureCredential" in candidate) ||
    typeof candidate.getSecureCredential !== "function" ||
    !("setManySecureCredentials" in candidate) ||
    typeof candidate.setManySecureCredentials !== "function" ||
    !("deleteSecureCredential" in candidate) ||
    typeof candidate.deleteSecureCredential !== "function"
  ) {
    throw new Error("Desktop secure credential bridge is unavailable");
  }
  return candidate as DesktopBridgeWithSecureCredentials;
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function getProvider(value: unknown): AgentLlmProvider {
  return value === "openai-compatible" ? value : DEFAULT_AGENT_LLM_PROVIDER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function isInsecureBackendResult(value: unknown): boolean {
  return isRecord(value) && value.code === "insecure-backend";
}

function isBackendUnavailableResult(value: unknown): boolean {
  return isRecord(value) && value.code === "backend-unavailable";
}

function normalizeCredentialBridgeError(error: unknown): never {
  if (isBackendUnavailableResult(error)) {
    throw new AgentCredentialsBackendUnavailableError();
  }
  if (isInsecureBackendResult(error)) {
    throw new InsecureCredentialBackendError();
  }
  if (
    error instanceof Error &&
    error.message.includes("OS-backed secure credential encryption is unavailable")
  ) {
    throw new AgentCredentialsBackendUnavailableError();
  }
  throw error;
}

type DesktopCredentialRead = {
  insecureBackend: boolean;
  value?: string;
};

async function getDesktopCredential(
  bridge: DesktopBridgeWithSecureCredentials,
  name: string,
): Promise<DesktopCredentialRead> {
  let result: unknown;
  try {
    result = await bridge.getSecureCredential(name);
  } catch (error) {
    normalizeCredentialBridgeError(error);
  }
  if (isBackendUnavailableResult(result)) {
    throw new AgentCredentialsBackendUnavailableError();
  }
  if (isInsecureBackendResult(result)) {
    return {
      insecureBackend: true,
      value: isRecord(result) && typeof result.value === "string" ? result.value : undefined,
    };
  }
  if (typeof result === "string") {
    return { insecureBackend: false, value: result };
  }
  if (result == undefined) {
    return { insecureBackend: false };
  }
  if (isRecord(result) && (result.ok === true || result.status === "ok")) {
    if (typeof result.value === "string") {
      return { insecureBackend: false, value: result.value };
    }
    if (result.value == undefined) {
      return { insecureBackend: false };
    }
  }
  throw new Error("Desktop secure credential bridge returned an invalid get result");
}

async function setManyDesktopCredentials(
  bridge: DesktopBridgeWithSecureCredentials,
  entries: Array<{
    expectedRevision?: string;
    key: typeof SECURE_LLM_CREDENTIAL | typeof SECURE_VTD_CREDENTIAL;
    value: string;
  }>,
): Promise<void> {
  let result: unknown;
  try {
    result = await bridge.setManySecureCredentials(entries);
  } catch (error) {
    normalizeCredentialBridgeError(error);
  }
  if (isInsecureBackendResult(result)) {
    throw new InsecureCredentialBackendError();
  }
  if (isBackendUnavailableResult(result)) {
    throw new AgentCredentialsBackendUnavailableError();
  }
  if (isRecord(result) && result.code === "revision-conflict") {
    throw new AgentSettingsConflictError();
  }
  if (isRecord(result) && result.code === "invalid-request") {
    throw new Error("Desktop secure credential bridge rejected a credential bundle");
  }
  if (
    result == undefined ||
    result === true ||
    (isRecord(result) && (result.ok === true || result.status === "ok"))
  ) {
    return;
  }
  throw new Error("Desktop secure credential bridge returned an invalid setMany result");
}

async function deleteDesktopCredentialState(
  bridge: DesktopBridgeWithSecureCredentials,
): Promise<void> {
  await Promise.all([
    bridge.deleteSecureCredential(SECURE_LLM_CREDENTIAL),
    bridge.deleteSecureCredential(SECURE_VTD_CREDENTIAL),
  ]);
}

function readAppSetting(appConfiguration: IAppConfiguration, key: string): string | undefined {
  try {
    const value = appConfiguration.get(key);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function emptyCredentialState({
  resaveRequired = false,
  source = "web",
  storage = "plaintext",
  storageError = false,
}: {
  resaveRequired?: boolean;
  source?: "desktop" | "web";
  storage?: "plaintext" | "secure";
  storageError?: boolean;
} = {}): CredentialState {
  return {
    credentials: { ...EMPTY_CREDENTIALS },
    desktopRecordsPresent: false,
    legacyFormat: false,
    resaveRequired,
    revision: "",
    source,
    storage,
    storageError,
  };
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed != undefined
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseSettingsMirror(value: unknown): AgentSettingsMirror | undefined {
  if (
    !isRecord(value) ||
    typeof value.anthropicBaseUrl !== "string" ||
    typeof value.anthropicModel !== "string" ||
    typeof value.openAiBaseUrl !== "string" ||
    typeof value.openAiModel !== "string" ||
    typeof value.vtdEndpoint !== "string" ||
    (value.provider !== "anthropic" && value.provider !== "openai-compatible")
  ) {
    return undefined;
  }
  return {
    anthropicBaseUrl: value.anthropicBaseUrl,
    anthropicModel: value.anthropicModel,
    openAiBaseUrl: value.openAiBaseUrl,
    openAiModel: value.openAiModel,
    provider: value.provider,
    vtdEndpoint: value.vtdEndpoint,
  };
}

function readWebCredentialState(): CredentialState {
  const storage = getLocalStorage();
  if (storage == undefined) {
    return emptyCredentialState({ storageError: true });
  }

  try {
    const serialized = storage.getItem(WEB_CREDENTIAL_STORAGE_KEY);
    if (serialized != undefined) {
      const record = parseRecord(serialized);
      if (record == undefined) {
        return emptyCredentialState({ storageError: true });
      }
      return {
        configuration: parseSettingsMirror(record.configuration),
        credentials: {
          anthropicApiKey: getString(record.anthropicApiKey),
          openAiApiKey: getString(record.openAiApiKey),
          vtdAuthToken: getString(record.vtdAuthToken),
        },
        desktopRecordsPresent: false,
        legacyFormat: typeof record.revision !== "string",
        resaveRequired: false,
        revision: getString(record.revision),
        source: "web",
        storage: "plaintext",
        storageError: false,
      };
    }

    const anthropicApiKey = storage.getItem(PREVIOUS_API_KEY_STORAGE_KEYS.anthropic) ?? "";
    const openAiApiKey = storage.getItem(PREVIOUS_API_KEY_STORAGE_KEYS["openai-compatible"]) ?? "";
    return {
      credentials: {
        anthropicApiKey,
        openAiApiKey,
        vtdAuthToken: "",
      },
      desktopRecordsPresent: false,
      legacyFormat: anthropicApiKey !== "" || openAiApiKey !== "",
      resaveRequired: false,
      revision: "",
      source: "web",
      storage: "plaintext",
      storageError: false,
    };
  } catch {
    return emptyCredentialState({ storageError: true });
  }
}

async function readDesktopCredentialState(
  appConfiguration: IAppConfiguration,
): Promise<CredentialState> {
  const bridge = getDesktopCredentialBridge();
  const [llmRead, vtdRead] = await Promise.all([
    getDesktopCredential(bridge, SECURE_LLM_CREDENTIAL),
    getDesktopCredential(bridge, SECURE_VTD_CREDENTIAL),
  ]);
  const insecureBackend = llmRead.insecureBackend || vtdRead.insecureBackend;
  const llmValue = llmRead.value;
  const vtdValue = vtdRead.value;
  const desktopRecordsPresent = llmValue != undefined || vtdValue != undefined;
  if (insecureBackend) {
    const webState = readWebCredentialState();
    const configurationRevision = readAppSetting(appConfiguration, COMMIT_REVISION_SETTING) ?? "";
    if (
      desktopRecordsPresent &&
      webState.revision !== "" &&
      webState.revision === configurationRevision
    ) {
      await deleteDesktopCredentialState(bridge);
      return webState;
    }
  }
  const llmRecord = llmValue == undefined ? undefined : parseRecord(llmValue);
  const vtdRecord = vtdValue == undefined ? undefined : parseRecord(vtdValue);
  const legacyApiKey = llmValue != undefined && llmRecord == undefined ? llmValue : undefined;
  const legacyVtdToken = vtdValue != undefined && vtdRecord == undefined ? vtdValue : undefined;
  const llmRevision = getString(llmRecord?.revision);
  const vtdRevision = getString(vtdRecord?.revision);
  const revisionMismatch = llmRevision !== "" && vtdRevision !== "" && llmRevision !== vtdRevision;

  return {
    configuration: parseSettingsMirror(llmRecord?.configuration),
    credentials: {
      anthropicApiKey: getString(llmRecord?.anthropicApiKey),
      openAiApiKey: getString(llmRecord?.openAiApiKey),
      vtdAuthToken: getString(vtdRecord?.value, legacyVtdToken ?? ""),
    },
    desktopRecordsPresent,
    legacyApiKey,
    legacyFormat:
      legacyApiKey != undefined ||
      legacyVtdToken != undefined ||
      (llmValue != undefined && llmRevision === "") ||
      (vtdValue != undefined && vtdRevision === "") ||
      revisionMismatch,
    resaveRequired: insecureBackend && desktopRecordsPresent,
    revision: revisionMismatch ? "" : llmRevision || vtdRevision,
    source: "desktop",
    storage: insecureBackend ? "plaintext" : "secure",
    storageError: revisionMismatch,
  };
}

function serializeCredentialValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized == undefined) {
    throw new Error("Agent credentials could not be serialized");
  }
  return serialized;
}

function writeWebCredentialState(
  credentials: CredentialBundle,
  revision: string,
  configuration: AgentSettingsMirror,
): void {
  const storage = getLocalStorage();
  if (storage == undefined) {
    throw new Error("Local storage is unavailable");
  }
  storage.setItem(
    WEB_CREDENTIAL_STORAGE_KEY,
    serializeCredentialValue({ ...credentials, configuration, revision }),
  );
}

async function writeDesktopCredentialState(
  credentials: CredentialBundle,
  revision: string,
  configuration: AgentSettingsMirror,
  expectedRevision: string | undefined,
): Promise<void> {
  const bridge = getDesktopCredentialBridge();
  await setManyDesktopCredentials(bridge, [
    {
      ...(expectedRevision == undefined ? {} : { expectedRevision }),
      key: SECURE_LLM_CREDENTIAL,
      value: serializeCredentialValue({
        anthropicApiKey: credentials.anthropicApiKey,
        configuration,
        openAiApiKey: credentials.openAiApiKey,
        revision,
      }),
    },
    {
      ...(expectedRevision == undefined ? {} : { expectedRevision }),
      key: SECURE_VTD_CREDENTIAL,
      value: serializeCredentialValue({ revision, value: credentials.vtdAuthToken }),
    },
  ]);
}

async function readCredentialState(store: AgentSettingsStore): Promise<CredentialState> {
  if (!store.desktop || store.credentialState.source === "web") {
    return readWebCredentialState();
  }
  return await readDesktopCredentialState(store.appConfiguration);
}

function assertDesktopPlaintextLockAvailable(): void {
  if (getCrossRendererLockManager() == undefined) {
    throw new AgentPlaintextCredentialLockUnavailableError();
  }
}

async function writeCredentialState(
  store: AgentSettingsStore,
  credentials: CredentialBundle,
  revision: string,
  configuration: AgentSettingsMirror,
  { expectedRevision }: { expectedRevision?: string } = {},
): Promise<void> {
  let storage: CredentialState["storage"] = "plaintext";
  if (store.desktop) {
    if (store.credentialState.storage === "secure") {
      try {
        await writeDesktopCredentialState(credentials, revision, configuration, expectedRevision);
        storage = "secure";
      } catch (error) {
        if (!(error instanceof InsecureCredentialBackendError)) {
          throw error;
        }
        assertDesktopPlaintextLockAvailable();
        writeWebCredentialState(credentials, revision, configuration);
        if (store.credentialState.desktopRecordsPresent) {
          await deleteDesktopCredentialState(getDesktopCredentialBridge());
        }
      }
    } else {
      assertDesktopPlaintextLockAvailable();
      writeWebCredentialState(credentials, revision, configuration);
      if (store.credentialState.desktopRecordsPresent) {
        await deleteDesktopCredentialState(getDesktopCredentialBridge());
      }
    }
  } else {
    writeWebCredentialState(credentials, revision, configuration);
  }
  store.credentialState = {
    configuration,
    credentials: { ...credentials },
    desktopRecordsPresent: storage === "secure",
    legacyFormat: false,
    resaveRequired: false,
    revision,
    source: storage === "secure" ? "desktop" : "web",
    storage,
    storageError: false,
  };
}

function settingsMirrorFromDraft(draft: AgentSettingsDraft): AgentSettingsMirror {
  return {
    anthropicBaseUrl: draft.anthropic.baseUrl,
    anthropicModel: draft.anthropic.model,
    openAiBaseUrl: draft.openAiCompatible.baseUrl,
    openAiModel: draft.openAiCompatible.model,
    provider: draft.provider,
    vtdEndpoint: draft.vtdEndpoint,
  };
}

function makeSnapshot(store: AgentSettingsStore): AgentSettingsSnapshot {
  const { appConfiguration, credentialState, desktop } = store;
  const configurationRevision = readAppSetting(appConfiguration, COMMIT_REVISION_SETTING) ?? "";
  // A revisioned credential record is the transaction log for the complete Agent settings
  // snapshot. Its configuration mirror stays authoritative even when AppConfiguration has the
  // same revision, so an interrupted/partial configuration restore cannot pair old credentials
  // with a mixture of new non-sensitive values.
  const mirroredConfiguration = credentialState.configuration;
  return {
    anthropic: {
      apiKey: credentialState.credentials.anthropicApiKey,
      baseUrl:
        mirroredConfiguration?.anthropicBaseUrl ??
        readAppSetting(appConfiguration, AppSetting.AGENT_ANTHROPIC_BASE_URL) ??
        "",
      model:
        mirroredConfiguration?.anthropicModel ??
        readAppSetting(appConfiguration, AppSetting.AGENT_ANTHROPIC_MODEL) ??
        DEFAULT_ANTHROPIC_MODEL,
    },
    credentialResaveRequired: credentialState.resaveRequired,
    credentialStorage: credentialState.storage,
    openAiCompatible: {
      apiKey: credentialState.credentials.openAiApiKey,
      baseUrl:
        mirroredConfiguration?.openAiBaseUrl ??
        readAppSetting(appConfiguration, AppSetting.AGENT_OPENAI_BASE_URL) ??
        "",
      model:
        mirroredConfiguration?.openAiModel ??
        readAppSetting(appConfiguration, AppSetting.AGENT_OPENAI_MODEL) ??
        "",
    },
    provider:
      mirroredConfiguration?.provider ??
      getProvider(readAppSetting(appConfiguration, AppSetting.AGENT_LLM_PROVIDER)),
    revision:
      mirroredConfiguration == undefined
        ? configurationRevision
        : credentialState.revision,
    storageError:
      credentialState.storageError ||
      (credentialState.revision !== configurationRevision && mirroredConfiguration == undefined),
    vtdAuthToken: credentialState.credentials.vtdAuthToken,
    vtdEndpoint: desktop
      ? ""
      : (mirroredConfiguration?.vtdEndpoint ??
        readAppSetting(appConfiguration, AppSetting.AGENT_VTD_ENDPOINT) ??
        ""),
  };
}

function hasLegacyAppSettings(appConfiguration: IAppConfiguration): boolean {
  return (
    readAppSetting(appConfiguration, LEGACY_API_KEY_SETTING) != undefined ||
    readAppSetting(appConfiguration, LEGACY_MODEL_SETTING) != undefined ||
    readAppSetting(appConfiguration, LEGACY_BASE_URL_SETTING) != undefined ||
    readAppSetting(appConfiguration, AppSetting.AGENT_VTD_AUTH_TOKEN) != undefined
  );
}

function hasPreviousCredentialKeys(): boolean {
  const storage = getLocalStorage();
  if (storage == undefined) {
    return false;
  }
  try {
    return (
      storage.getItem(PREVIOUS_API_KEY_STORAGE_KEYS.anthropic) != undefined ||
      storage.getItem(PREVIOUS_API_KEY_STORAGE_KEYS["openai-compatible"]) != undefined
    );
  } catch {
    return false;
  }
}

function webMigrationPending(
  appConfiguration: IAppConfiguration,
  credentialState: CredentialState,
): boolean {
  const configurationRevision = readAppSetting(appConfiguration, COMMIT_REVISION_SETTING) ?? "";
  return (
    hasLegacyAppSettings(appConfiguration) ||
    hasPreviousCredentialKeys() ||
    credentialState.legacyFormat ||
    credentialState.revision !== configurationRevision
  );
}

function getStore(
  appConfiguration: IAppConfiguration,
  { desktop }: { desktop: boolean },
): AgentSettingsStore {
  let variants = stores.get(appConfiguration);
  if (variants == undefined) {
    variants = {};
    stores.set(appConfiguration, variants);
  }
  const variant = desktop ? "desktop" : "web";
  let store = variants[variant];
  if (store != undefined) {
    return store;
  }
  const credentialState = desktop
    ? emptyCredentialState({ source: "desktop", storage: "secure" })
    : readWebCredentialState();
  store = {
    appConfiguration,
    credentialBackendUnavailable: false,
    credentialState,
    desktop,
    listeners: new Set(),
    migrated: desktop ? false : !webMigrationPending(appConfiguration, credentialState),
    snapshot: undefined as unknown as AgentSettingsSnapshot,
    suppressRefresh: 0,
  };
  store.snapshot = makeSnapshot(store);
  variants[variant] = store;
  return store;
}

function publishStore(store: AgentSettingsStore): void {
  store.snapshot = makeSnapshot(store);
  for (const listener of store.listeners) {
    listener();
  }
}

function publishStoreWithoutRefreshingSnapshot(store: AgentSettingsStore): void {
  store.snapshot = {
    ...store.snapshot,
    anthropic: { ...store.snapshot.anthropic },
    openAiCompatible: { ...store.snapshot.openAiCompatible },
  };
  for (const listener of store.listeners) {
    listener();
  }
}

async function refreshStoreFromStorage(store: AgentSettingsStore): Promise<void> {
  store.credentialState = await readCredentialState(store);
  store.credentialBackendUnavailable = false;
  publishStore(store);
}

function subscribeStore(store: AgentSettingsStore, listener: () => void): () => void {
  store.listeners.add(listener);
  if (store.unsubscribeSources != undefined) {
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        store.unsubscribeSources?.();
        store.unsubscribeSources = undefined;
      }
    };
  }

  const handleAppConfigurationChange = () => {
    if (store.suppressRefresh !== 0) {
      return;
    }
    void refreshStoreFromStorage(store).catch((error: unknown) => {
      if (error instanceof AgentCredentialsBackendUnavailableError) {
        store.credentialBackendUnavailable = true;
        publishStoreWithoutRefreshingSnapshot(store);
        return;
      }
      store.credentialState = emptyCredentialState({
        resaveRequired: store.credentialState.resaveRequired,
        source: store.credentialState.source,
        storage: store.credentialState.storage,
        storageError: true,
      });
      publishStore(store);
    });
  };
  const observedSettings = store.desktop
    ? OBSERVED_SETTINGS.filter((key) => key !== AppSetting.AGENT_VTD_ENDPOINT)
    : OBSERVED_SETTINGS;
  for (const key of observedSettings) {
    store.appConfiguration.addChangeListener(key, handleAppConfigurationChange);
  }

  const handleStorage = (event: StorageEvent) => {
    // Revision is written after the complete credential/config snapshot. key === null is clear().
    if (event.key == undefined || event.key.endsWith(COMMIT_REVISION_SETTING)) {
      handleAppConfigurationChange();
    }
  };
  globalThis.addEventListener("storage", handleStorage);

  store.unsubscribeSources = () => {
    for (const key of observedSettings) {
      store.appConfiguration.removeChangeListener(key, handleAppConfigurationChange);
    }
    globalThis.removeEventListener("storage", handleStorage);
  };
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.unsubscribeSources?.();
      store.unsubscribeSources = undefined;
    }
  };
}

function draftFromSnapshot(snapshot: AgentSettingsSnapshot): AgentSettingsDraft {
  return {
    anthropic: { ...snapshot.anthropic },
    openAiCompatible: { ...snapshot.openAiCompatible },
    provider: snapshot.provider,
    revision: snapshot.revision,
    vtdAuthToken: snapshot.vtdAuthToken,
    vtdEndpoint: snapshot.vtdEndpoint,
  };
}

function nextRevision(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function restoreSetting(
  appConfiguration: IAppConfiguration,
  key: string,
  value: string | undefined,
): Promise<void> {
  await appConfiguration.set(key, value);
}

function settingFromMirror(
  key: (typeof OBSERVED_SETTINGS)[number],
  mirror: AgentSettingsMirror,
  revision: string,
): string {
  switch (key) {
    case AppSetting.AGENT_LLM_PROVIDER:
      return mirror.provider;
    case AppSetting.AGENT_ANTHROPIC_BASE_URL:
      return mirror.anthropicBaseUrl;
    case AppSetting.AGENT_ANTHROPIC_MODEL:
      return mirror.anthropicModel;
    case AppSetting.AGENT_OPENAI_BASE_URL:
      return mirror.openAiBaseUrl;
    case AppSetting.AGENT_OPENAI_MODEL:
      return mirror.openAiModel;
    case AppSetting.AGENT_VTD_ENDPOINT:
      return mirror.vtdEndpoint;
    case COMMIT_REVISION_SETTING:
      return revision;
  }
}

async function assertAppConfigurationSnapshot(
  store: AgentSettingsStore,
  expectedValues: ReadonlyMap<
    (typeof OBSERVED_SETTINGS)[number],
    string | undefined
  >,
): Promise<void> {
  const mismatches = [...expectedValues].filter(
    ([key, expectedValue]) =>
      readAppSetting(store.appConfiguration, key) !== expectedValue,
  );
  if (mismatches.length === 0) {
    return;
  }

  // NativeStorageAppConfiguration has no multi-key CAS. Restore the coherent values mirrored in
  // the current credential revision before reporting a conflict. Another non-cooperating writer
  // can still change a non-sensitive key after this comparison; that accepted residual window only
  // affects configuration values, while the credential CAS and mirror keep secrets/config paired.
  store.suppressRefresh++;
  const restoreResults = await Promise.allSettled(
    mismatches.map(async ([key, expectedValue]) => {
      await restoreSetting(store.appConfiguration, key, expectedValue);
    }),
  ).finally(() => {
    store.suppressRefresh--;
  });
  publishStore(store);
  if (restoreResults.some((result) => result.status === "rejected")) {
    throw new Error(
      "Failed to restore Agent settings after a configuration conflict",
    );
  }
  throw new AgentSettingsConflictError();
}

async function assertCurrentRevision(
  store: AgentSettingsStore,
  expectedRevision: string,
): Promise<void> {
  const currentCredentials = await readCredentialState(store);
  const currentConfigurationRevision =
    readAppSetting(store.appConfiguration, COMMIT_REVISION_SETTING) ?? "";
  const mirroredWinner =
    currentCredentials.configuration != undefined &&
    currentCredentials.revision !== "" &&
    currentCredentials.revision !== currentConfigurationRevision;
  const currentRevision = mirroredWinner
    ? currentCredentials.revision
    : currentConfigurationRevision;
  const credentialsMatch =
    (currentCredentials.revision === currentConfigurationRevision || mirroredWinner) &&
    !currentCredentials.legacyFormat &&
    !currentCredentials.storageError;
  if (expectedRevision !== currentRevision || !credentialsMatch) {
    const winnerConfiguration = currentCredentials.configuration;
    if (
      mirroredWinner &&
      winnerConfiguration != undefined
    ) {
      const settings = store.desktop
        ? OBSERVED_SETTINGS.filter(
            (key) => key !== AppSetting.AGENT_VTD_ENDPOINT,
          )
        : OBSERVED_SETTINGS;
      store.suppressRefresh++;
      const restoreResults = await Promise.allSettled(
        settings.map(async (key) => {
          await restoreSetting(
            store.appConfiguration,
            key,
            settingFromMirror(
              key,
              winnerConfiguration,
              currentCredentials.revision,
            ),
          );
        }),
      ).finally(() => {
        store.suppressRefresh--;
      });
      if (restoreResults.some((result) => result.status === "rejected")) {
        throw new Error(
          "Failed to load winning Agent settings after a revision conflict",
        );
      }
    }
    store.credentialState = currentCredentials;
    publishStore(store);
    throw new AgentSettingsConflictError();
  }
  store.credentialState = currentCredentials;
}

async function commitDraft(
  store: AgentSettingsStore,
  draft: AgentSettingsDraft,
  { allowLegacyState = false }: { allowLegacyState?: boolean } = {},
): Promise<void> {
  const appConfiguration = store.appConfiguration;
  if (!allowLegacyState) {
    await assertCurrentRevision(store, draft.revision);
  }
  const previousCredentials = await readCredentialState(store);
  const previousConfiguration =
    previousCredentials.configuration ??
    settingsMirrorFromDraft(draftFromSnapshot(makeSnapshot(store)));
  const persistedSettings = store.desktop
    ? OBSERVED_SETTINGS.filter((key) => key !== AppSetting.AGENT_VTD_ENDPOINT)
    : OBSERVED_SETTINGS;
  const previousValues = new Map<(typeof OBSERVED_SETTINGS)[number], string | undefined>(
    persistedSettings.map((key) => [
      key,
      previousCredentials.configuration == undefined
        ? readAppSetting(appConfiguration, key)
        : settingFromMirror(
            key,
            previousCredentials.configuration,
            previousCredentials.revision,
          ),
    ]),
  );
  const nextCredentials: CredentialBundle = {
    anthropicApiKey: draft.anthropic.apiKey,
    openAiApiKey: draft.openAiCompatible.apiKey,
    vtdAuthToken: draft.vtdAuthToken,
  };
  const nextConfiguration = settingsMirrorFromDraft(draft);
  const revision = nextRevision();

  // The cross-renderer lock makes this comparison atomic with the writes for Web clients. Desktop
  // additionally enforces this revision in the main-process credential transaction below.
  if (!allowLegacyState) {
    await assertCurrentRevision(store, draft.revision);
  }
  await assertAppConfigurationSnapshot(store, previousValues);

  store.suppressRefresh++;
  let credentialWriteCompleted = false;
  try {
    await writeCredentialState(
      store,
      nextCredentials,
      revision,
      nextConfiguration,
      { expectedRevision: previousCredentials.revision },
    );
    credentialWriteCompleted = true;
    const writes = [
      appConfiguration.set(AppSetting.AGENT_LLM_PROVIDER, draft.provider),
      appConfiguration.set(AppSetting.AGENT_ANTHROPIC_BASE_URL, draft.anthropic.baseUrl),
      appConfiguration.set(AppSetting.AGENT_ANTHROPIC_MODEL, draft.anthropic.model),
      appConfiguration.set(AppSetting.AGENT_OPENAI_BASE_URL, draft.openAiCompatible.baseUrl),
      appConfiguration.set(AppSetting.AGENT_OPENAI_MODEL, draft.openAiCompatible.model),
    ];
    if (!store.desktop) {
      writes.push(appConfiguration.set(AppSetting.AGENT_VTD_ENDPOINT, draft.vtdEndpoint));
    }
    const writeResults = await Promise.allSettled(writes);
    const rejectedWrite = writeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedWrite != undefined) {
      throw rejectedWrite.reason;
    }
    await appConfiguration.set(COMMIT_REVISION_SETTING, revision);
  } catch (error) {
    if (error instanceof AgentSettingsConflictError) {
      const winnerCredentials = await readCredentialState(store);
      const winnerConfiguration = winnerCredentials.configuration;
      const winnerRevision = winnerCredentials.revision;
      const restoreResults = await Promise.allSettled(
        [...previousValues].map(async ([key, previousValue]) => {
          await restoreSetting(
            appConfiguration,
            key,
            winnerConfiguration == undefined
              ? previousValue
              : settingFromMirror(key, winnerConfiguration, winnerRevision),
          );
        }),
      );
      store.credentialBackendUnavailable = false;
      store.credentialState = winnerCredentials;
      publishStore(store);
      if (restoreResults.some((result) => result.status === "rejected")) {
        throw new Error("Failed to restore the winning Agent settings after a conflict", {
          cause: error,
        });
      }
      throw error;
    }
    if (!credentialWriteCompleted) {
      store.credentialState = previousCredentials;
      throw error;
    }
    try {
      // Restore the authoritative credential bundle first. From this point onward, every
      // observable/restart snapshot is coherent because makeSnapshot always uses its mirror.
      // AppConfiguration is then repaired one key at a time; interruption or failure can leave
      // stale non-sensitive storage values, but never a mixed effective Agent settings snapshot.
      await writeCredentialState(
        store,
        previousCredentials.credentials,
        previousCredentials.revision,
        previousConfiguration,
        { expectedRevision: revision },
      );
      for (const [key, value] of previousValues) {
        await restoreSetting(appConfiguration, key, value);
      }
    } catch (rollbackError) {
      try {
        store.credentialState = await readCredentialState(store);
      } catch {
        // Keep the last successfully written credential mirror if the backend also became
        // unreadable. Either the forward or rollback mirror is still internally complete.
      }
      publishStore(store);
      throw new Error(
        "Failed to save Agent settings and restore the previous snapshot",
        { cause: rollbackError },
      );
    }
    store.credentialState = previousCredentials;
    throw error;
  } finally {
    store.suppressRefresh--;
  }
  publishStore(store);
}

export async function commitAgentSettings(
  appConfiguration: IAppConfiguration,
  draft: AgentSettingsDraft,
  { desktop = false }: { desktop?: boolean } = {},
): Promise<void> {
  const store = getStore(appConfiguration, { desktop });
  await ensureMigration(store);
  try {
    await withAgentSettingsPersistenceLock(async () => {
      await commitDraft(store, draft);
    });
    if (store.credentialBackendUnavailable) {
      store.credentialBackendUnavailable = false;
      publishStore(store);
    }
  } catch (error) {
    if (error instanceof AgentCredentialsBackendUnavailableError) {
      store.credentialBackendUnavailable = true;
      publishStore(store);
    }
    throw error;
  }
}

function removeLegacyWebCredentials({ removeBundle }: { removeBundle: boolean }): void {
  const storage = getLocalStorage();
  if (storage == undefined) {
    throw new Error("Local storage is unavailable");
  }
  if (removeBundle) {
    storage.removeItem(WEB_CREDENTIAL_STORAGE_KEY);
  }
  storage.removeItem(PREVIOUS_API_KEY_STORAGE_KEYS.anthropic);
  storage.removeItem(PREVIOUS_API_KEY_STORAGE_KEYS["openai-compatible"]);
}

async function ensureMigration(store: AgentSettingsStore): Promise<void> {
  if (store.migrated) {
    return;
  }
  if (store.migration != undefined) {
    await store.migration;
    return;
  }

  const migrate = async () => {
    const appConfiguration = store.appConfiguration;
    const primaryCredentials = await readCredentialState(store);
    const legacyWebCredentials = readWebCredentialState();
    store.credentialState = primaryCredentials;
    const provider = getProvider(readAppSetting(appConfiguration, AppSetting.AGENT_LLM_PROVIDER));
    const legacyApiKey =
      readAppSetting(appConfiguration, LEGACY_API_KEY_SETTING) ?? primaryCredentials.legacyApiKey;
    const legacyModel = readAppSetting(appConfiguration, LEGACY_MODEL_SETTING);
    const legacyBaseUrl = readAppSetting(appConfiguration, LEGACY_BASE_URL_SETTING);
    const misplacedVtdAuthToken = readAppSetting(appConfiguration, AppSetting.AGENT_VTD_AUTH_TOKEN);
    const configurationRevision = readAppSetting(appConfiguration, COMMIT_REVISION_SETTING) ?? "";
    const needsMigration =
      hasLegacyAppSettings(appConfiguration) ||
      hasPreviousCredentialKeys() ||
      primaryCredentials.legacyFormat ||
      primaryCredentials.revision !== configurationRevision ||
      (store.desktop &&
        primaryCredentials.storage === "secure" &&
        (legacyWebCredentials.legacyFormat ||
          legacyWebCredentials.credentials.anthropicApiKey !== "" ||
          legacyWebCredentials.credentials.openAiApiKey !== "" ||
          legacyWebCredentials.credentials.vtdAuthToken !== ""));

    if (needsMigration) {
      const draft = draftFromSnapshot(makeSnapshot(store));
      if (draft.anthropic.apiKey === "") {
        draft.anthropic.apiKey = legacyWebCredentials.credentials.anthropicApiKey;
      }
      if (draft.openAiCompatible.apiKey === "") {
        draft.openAiCompatible.apiKey = legacyWebCredentials.credentials.openAiApiKey;
      }
      if (draft.vtdAuthToken === "") {
        draft.vtdAuthToken =
          legacyWebCredentials.credentials.vtdAuthToken !== ""
            ? legacyWebCredentials.credentials.vtdAuthToken
            : (misplacedVtdAuthToken ?? "");
      }
      const providerDraft = provider === "anthropic" ? draft.anthropic : draft.openAiCompatible;
      const providerModelSetting =
        provider === "anthropic" ? AppSetting.AGENT_ANTHROPIC_MODEL : AppSetting.AGENT_OPENAI_MODEL;
      const providerBaseUrlSetting =
        provider === "anthropic"
          ? AppSetting.AGENT_ANTHROPIC_BASE_URL
          : AppSetting.AGENT_OPENAI_BASE_URL;
      if (providerDraft.apiKey === "" && legacyApiKey != undefined) {
        providerDraft.apiKey = legacyApiKey;
      }
      if (
        readAppSetting(appConfiguration, providerModelSetting) == undefined &&
        legacyModel != undefined
      ) {
        providerDraft.model = legacyModel;
      }
      if (
        readAppSetting(appConfiguration, providerBaseUrlSetting) == undefined &&
        legacyBaseUrl != undefined
      ) {
        providerDraft.baseUrl = legacyBaseUrl;
      }

      try {
        await commitDraft(store, draft, { allowLegacyState: true });
      } catch (error) {
        const winner = store.credentialState;
        if (
          !(error instanceof AgentSettingsConflictError) ||
          winner.revision === "" ||
          winner.legacyFormat ||
          winner.storageError
        ) {
          throw error;
        }
        // Another Desktop window completed the same migration first. Its credential mirror is the
        // authoritative migrated snapshot; continue with idempotent legacy-key cleanup.
      }
      await Promise.all([
        appConfiguration.set(LEGACY_API_KEY_SETTING, undefined),
        appConfiguration.set(LEGACY_MODEL_SETTING, undefined),
        appConfiguration.set(LEGACY_BASE_URL_SETTING, undefined),
        appConfiguration.set(AppSetting.AGENT_VTD_AUTH_TOKEN, undefined),
      ]);
      removeLegacyWebCredentials({
        removeBundle: store.desktop && store.credentialState.storage === "secure",
      });
    } else {
      store.credentialState = primaryCredentials;
    }

    store.migrated = true;
    publishStore(store);
  };

  store.migration = withAgentSettingsPersistenceLock(migrate).catch((error: unknown) => {
    store.migration = undefined;
    throw error;
  });
  await store.migration;
}

export function useAgentSettings(
  appConfiguration: IAppConfiguration,
  { desktop = false }: { desktop?: boolean } = {},
): AgentSettingsState {
  const store = getStore(appConfiguration, { desktop });
  const snapshot = useSyncExternalStore(
    (listener) => subscribeStore(store, listener),
    () => store.snapshot,
    () => store.snapshot,
  );
  const [migrationState, setMigrationState] = useState<{
    error?: Error;
    ready: boolean;
  }>(() => ({ ready: store.migrated }));

  useEffect(() => {
    if (store.migrated) {
      return undefined;
    }
    let mounted = true;
    void ensureMigration(store).then(
      () => {
        if (mounted) {
          setMigrationState({ ready: true });
        }
      },
      (error: unknown) => {
        if (mounted) {
          setMigrationState({
            error: error instanceof Error ? error : new Error(String(error)),
            ready: false,
          });
        }
      },
    );
    return () => {
      mounted = false;
    };
  }, [store]);

  return {
    credentialBackendUnavailable: store.credentialBackendUnavailable,
    migrationError: migrationState.error,
    migrationReady: migrationState.ready,
    snapshot,
  };
}

export function createAgentSettingsDraft(snapshot: AgentSettingsSnapshot): AgentSettingsDraft {
  return draftFromSnapshot(snapshot);
}

export function selectAgentConfiguration(
  snapshot: AgentSettingsSnapshot,
  { desktop }: { desktop: boolean },
): AgentConfiguration {
  const serverConfig = readCurrentAgentBootstrap()?.config;
  const provider =
    snapshot.revision === "" && serverConfig?.provider != undefined
      ? serverConfig.provider
      : snapshot.provider;
  const providerSettings =
    provider === "anthropic" ? snapshot.anthropic : snapshot.openAiCompatible;
  const matchingServerConfig =
    serverConfig?.provider == undefined || serverConfig.provider === provider
      ? serverConfig
      : undefined;
  return {
    apiKey:
      providerSettings.apiKey === ""
        ? (matchingServerConfig?.apiKey ?? "")
        : providerSettings.apiKey,
    baseUrl:
      snapshot.revision === "" || providerSettings.baseUrl === ""
        ? (matchingServerConfig?.baseUrl ?? providerSettings.baseUrl)
        : providerSettings.baseUrl,
    desktop,
    model:
      snapshot.revision === "" || providerSettings.model === ""
        ? (matchingServerConfig?.model ?? providerSettings.model)
        : providerSettings.model,
    provider,
    vtdAuthToken: desktop
      ? undefined
      : snapshot.vtdAuthToken === ""
        ? serverConfig?.vtdAuthToken
        : snapshot.vtdAuthToken,
    vtdEndpoint: desktop
      ? undefined
      : snapshot.vtdEndpoint === ""
        ? serverConfig?.vtdEndpoint
        : snapshot.vtdEndpoint,
  };
}

export function getAgentConfigurationSource(
  snapshot: AgentSettingsSnapshot,
  { desktop }: { desktop: boolean },
): "local" | "server" {
  const serverConfig = readCurrentAgentBootstrap()?.config;
  if (serverConfig == undefined) {
    return "local";
  }
  const providerUsesServerDefault =
    snapshot.revision === "" && serverConfig.provider != undefined;
  const provider =
    snapshot.revision === "" && serverConfig.provider != undefined
      ? serverConfig.provider
      : snapshot.provider;
  const providerSettings =
    provider === "anthropic" ? snapshot.anthropic : snapshot.openAiCompatible;
  const providerMatchesServer =
    serverConfig.provider == undefined || serverConfig.provider === provider;
  const llmUsesServerDefault =
    providerMatchesServer &&
    ((providerSettings.apiKey === "" && serverConfig.apiKey != undefined) ||
      ((snapshot.revision === "" || providerSettings.baseUrl === "") &&
        serverConfig.baseUrl != undefined) ||
      ((snapshot.revision === "" || providerSettings.model === "") &&
        serverConfig.model != undefined));
  const vtdUsesServerDefault =
    !desktop &&
    ((snapshot.vtdAuthToken === "" && serverConfig.vtdAuthToken != undefined) ||
      (snapshot.vtdEndpoint === "" && serverConfig.vtdEndpoint != undefined));
  return providerUsesServerDefault || llmUsesServerDefault || vtdUsesServerDefault
    ? "server"
    : "local";
}

function isHttpUrlWithoutRequestSuffix(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function validateAgentConfiguration(
  configuration: AgentConfiguration,
): AgentConfigurationErrors {
  const errors: AgentConfigurationErrors = {};

  if (configuration.apiKey.trim() === "") {
    errors.apiKey = "required";
  }
  if (configuration.model.trim() === "") {
    errors.model = "required";
  }
  if (configuration.provider === "openai-compatible" && configuration.baseUrl.trim() === "") {
    errors.baseUrl = "required";
  } else if (
    configuration.baseUrl.trim() !== "" &&
    !isHttpUrlWithoutRequestSuffix(configuration.baseUrl.trim())
  ) {
    errors.baseUrl = "invalidUrl";
  }

  if (!configuration.desktop) {
    if (
      configuration.vtdAuthToken?.includes("\r") === true ||
      configuration.vtdAuthToken?.includes("\n") === true
    ) {
      errors.vtdAuthToken = "invalidToken";
    }
    if (configuration.vtdEndpoint?.trim() === "") {
      errors.vtdEndpoint = "required";
    } else if (
      configuration.vtdEndpoint == undefined ||
      !isHttpUrlWithoutRequestSuffix(configuration.vtdEndpoint.trim())
    ) {
      errors.vtdEndpoint = "invalidUrl";
    }
  }

  return errors;
}

export function isAgentConfigurationValid(configuration: AgentConfiguration): boolean {
  return Object.keys(validateAgentConfiguration(configuration)).length === 0;
}
