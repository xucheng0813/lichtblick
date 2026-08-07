// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { MessagePipelineContext } from "@lichtblick/suite-base/components/MessagePipeline/types";
import {
  validateLayoutProposal,
  type ValidatedLayoutProposal,
} from "@lichtblick/suite-base/services/agent/layoutSchema";
import {
  renderSkill,
  type Skill,
} from "@lichtblick/suite-base/services/agent/local/skills";
import type { CatalogSnapshot } from "@lichtblick/suite-base/services/agent/local/types";
import type { AgentMemoryStore } from "@lichtblick/suite-base/services/agent/memory/agentMemory";
import {
  runPlaybackControlTool,
  runReadMessagesTool,
  runSearchMessagesTool,
} from "@lichtblick/suite-base/services/agent/tools/dataQueryTools";
import type {
  LayoutProposal,
  ToolConfirmationDecision,
} from "@lichtblick/suite-base/services/agent/types";
import { VTD_ORDER_DIRECTIONS } from "@lichtblick/suite-base/services/vtd/types";
import type {
  IVtdClient,
  VtdSearchParams,
  VtdSliceParams,
} from "@lichtblick/suite-base/services/vtd/types";

export const TOOL_RUNTIME_MAX_RESULT_BYTES = 256 * 1024;

export type OpenDataSourceRequest = {
  urls: string[];
  sessionId?: string;
};

export type ToolRuntimeDeps = {
  vtdClient: IVtdClient;
  skills: readonly Skill[];
  memoryStore?: AgentMemoryStore;
  getCatalog: () => CatalogSnapshot;
  getInstalledPanelTypes: () => ReadonlySet<string>;
  emitOpenDataSource: (
    request: OpenDataSourceRequest,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  emitLayoutProposal: (
    proposal: ValidatedLayoutProposal,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  /**
   * Loaded-data reading and playback control for read_messages / search_messages /
   * playback_control. Absent when the workspace does not provide a message pipeline.
   */
  dataQuery?: AgentDataQueryDeps;
};

/**
 * The slice of the message pipeline the data-query tools consume. The context is re-read on
 * every tool call so playback capability gating (performed by the pipeline store) and the
 * active data time range are always current.
 */
export type AgentDataQueryContext = Pick<
  MessagePipelineContext,
  | "getBatchIterator"
  | "startPlayback"
  | "pausePlayback"
  | "seekPlayback"
  | "playerState"
>;

export type AgentDataQueryDeps = {
  getContext: () => AgentDataQueryContext;
};

export type ToolRuntimeContext = {
  signal?: AbortSignal;
  catalogReady?: CatalogSnapshot;
  confirmationDecision?: ToolConfirmationDecision;
};

export type RequestBatchConsentInput = {
  action: string;
  summary: string;
  itemCount: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value != undefined && !Array.isArray(value)
  );
}

export function requireRecord(
  value: unknown,
  toolName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${toolName} input must be an object`);
  }
  return value;
}

export function requireString(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string {
  const value = input[property];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}.${property} must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string | undefined {
  const value = input[property];
  if (!Object.hasOwn(input, property) || typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}.${property} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): boolean | undefined {
  const value = input[property];
  if (!Object.hasOwn(input, property) || typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${toolName}.${property} must be a boolean`);
  }
  return value;
}

export function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(input, property, toolName);
  if (value == undefined) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw new Error(
      `${toolName}.${property} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

export function optionalPositiveInteger(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = input[property];
  if (!Object.hasOwn(input, property) || typeof value === "undefined") {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new Error(`${toolName}.${property} must be a positive safe integer`);
  }
  return value as number;
}

function requirePositiveInteger(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): number {
  const value = optionalPositiveInteger(input, property, toolName);
  if (value == undefined) {
    throw new Error(`${toolName}.${property} is required`);
  }
  return value;
}

function optionalStringArray(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string[] | undefined {
  const value = input[property];
  if (!Object.hasOwn(input, property) || typeof value === "undefined") {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new Error(`${toolName}.${property} must be a non-empty string array`);
  }
  return value as string[];
}

export function optionalDecimalString(
  input: Record<string, unknown>,
  property: string,
  toolName: string,
): string | undefined {
  const value = optionalString(input, property, toolName);
  if (value != undefined && !/^[0-9]+$/.test(value)) {
    throw new Error(
      `${toolName}.${property} must be an unsigned decimal string`,
    );
  }
  return value;
}

function requireUrls(
  input: Record<string, unknown>,
  toolName: string,
): string[] {
  const urls = optionalStringArray(input, "urls", toolName);
  if (urls == undefined) {
    throw new Error(`${toolName}.urls is required`);
  }
  for (const url of urls) {
    try {
      if (url.includes(",")) {
        throw new Error("literal comma");
      }
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        !parsed.pathname.toLowerCase().endsWith(".mcap")
      ) {
        throw new Error("unsupported URL");
      }
    } catch {
      throw new Error(
        `${toolName}.urls must contain only HTTPS .mcap URLs without literal commas; encode commas as %2C`,
      );
    }
  }
  return urls;
}

function normalizeCatalog(catalog: CatalogSnapshot): {
  topics: readonly unknown[];
  datatypes: Record<string, unknown>;
} {
  return {
    topics: catalog.topics,
    datatypes: Object.fromEntries(catalog.datatypes),
  };
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export async function runDependency<T>(
  factory: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const operation = Promise.resolve().then(factory);
  if (signal == undefined) {
    return await operation;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function requireMemoryStore(
  deps: ToolRuntimeDeps,
  toolName: string,
): AgentMemoryStore {
  if (deps.memoryStore == undefined) {
    throw new Error(`${toolName} is unavailable: memory is not configured`);
  }
  return deps.memoryStore;
}

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (entry instanceof Map) {
        return Object.fromEntries(entry);
      }
      if (typeof entry === "object" && entry != undefined) {
        if (seen.has(entry)) {
          return "[Circular]";
        }
        seen.add(entry);
      }
      return entry;
    }) ?? String(value)
  );
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(safeSerialize(value)).byteLength;
}

export function boundedToolResult(value: unknown): unknown {
  const serialized = safeSerialize(value);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength <= TOOL_RUNTIME_MAX_RESULT_BYTES) {
    try {
      return JSON.parse(serialized) as unknown;
    } catch {
      return serialized;
    }
  }

  const createTruncatedResult = (preview: string) => ({
    truncated: true,
    byteLength,
    preview,
  });
  let best = createTruncatedResult("");
  let low = 0;
  let high = serialized.length;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    let end = midpoint;
    if (
      end > 0 &&
      end < serialized.length &&
      serialized.charCodeAt(end - 1) >= 0xd800 &&
      serialized.charCodeAt(end - 1) <= 0xdbff &&
      serialized.charCodeAt(end) >= 0xdc00 &&
      serialized.charCodeAt(end) <= 0xdfff
    ) {
      end--;
    }
    const candidate = createTruncatedResult(serialized.slice(0, end));
    if (serializedByteLength(candidate) <= TOOL_RUNTIME_MAX_RESULT_BYTES) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function compactVtdSearchResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return value;
  }
  return {
    ...value,
    records: value.records.map((record) => {
      if (!isRecord(record)) {
        return record;
      }
      const compactRecord = { ...record };
      delete compactRecord.raw;
      return compactRecord;
    }),
  };
}

function boundedRuntimeResult(name: string, result: unknown): unknown {
  const bounded = boundedToolResult(result);
  if (
    name !== "vtd_search" ||
    !isRecord(bounded) ||
    bounded.truncated !== true
  ) {
    return bounded;
  }
  // VTD raw records contain large topic inventories and storage metadata which the card and model
  // do not consume. Preserve every normalized row before falling back to the generic byte preview.
  return boundedToolResult(compactVtdSearchResult(result));
}

export async function runLoadSkillTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<string> {
  context.signal?.throwIfAborted();
  const toolName = "load_skill";
  const input = requireRecord(value, toolName);
  const skillId = requireString(input, "skillId", toolName);
  const skill = deps.skills.find((candidate) => candidate.id === skillId);
  if (skill == undefined) {
    throw new Error(
      `${toolName}.skillId must be one of: ${deps.skills.map((candidate) => candidate.id).join(", ")}`,
    );
  }
  return renderSkill(skill);
}

export async function runMemoryWriteTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<{ remembered: string }> {
  const toolName = "memory_write";
  const input = requireRecord(value, toolName);
  const store = requireMemoryStore(deps, toolName);
  const entry = await runDependency(
    async () => await store.add(requireString(input, "text", toolName)),
    context.signal,
  );
  return { remembered: entry.id };
}

export async function runMemoryForgetTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<{ forgotten: string }> {
  const toolName = "memory_forget";
  const input = requireRecord(value, toolName);
  const store = requireMemoryStore(deps, toolName);
  const id = requireString(input, "id", toolName);
  if (
    !(await runDependency(async () => await store.remove(id), context.signal))
  ) {
    throw new Error(`${toolName}.id "${id}" is not a stored memory`);
  }
  return { forgotten: id };
}

export async function runMemoryListTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<{ memories: ReturnType<AgentMemoryStore["list"]> }> {
  const toolName = "memory_list";
  requireRecord(value, toolName);
  const memories = await runDependency(
    () => requireMemoryStore(deps, toolName).list(),
    context.signal,
  );
  return { memories };
}

export async function runVtdSearchTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<Awaited<ReturnType<IVtdClient["search"]>>> {
  const toolName = "vtd_search";
  const input = requireRecord(value, toolName);
  const params: VtdSearchParams = {
    id: optionalString(input, "id", toolName),
    botSn: optionalString(input, "botSn", toolName),
    botSnExact: optionalString(input, "botSnExact", toolName),
    botName: optionalString(input, "botName", toolName),
    triggerType: optionalString(input, "triggerType", toolName),
    dataType: optionalString(input, "dataType", toolName),
    inspection: optionalString(input, "inspection", toolName),
    fixData: optionalString(input, "fixData", toolName),
    start: optionalString(input, "start", toolName),
    end: optionalString(input, "end", toolName),
    at: optionalString(input, "at", toolName),
    triggerTime: optionalString(input, "triggerTime", toolName),
    queryStart: optionalString(input, "queryStart", toolName),
    queryEnd: optionalString(input, "queryEnd", toolName),
    queryTime: optionalString(input, "queryTime", toolName),
    dataDay: optionalString(input, "dataDay", toolName),
    dataTos: optionalString(input, "dataTos", toolName),
    orderBy: optionalString(input, "orderBy", toolName),
    orderDir: optionalEnum(input, "orderDir", toolName, VTD_ORDER_DIRECTIONS),
    page: optionalPositiveInteger(input, "page", toolName),
    pageSize: optionalPositiveInteger(input, "pageSize", toolName, 100),
  };
  return await runDependency(
    async () => await deps.vtdClient.search(params, context.signal),
    context.signal,
  );
}

export async function runVtdTriggerTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<unknown> {
  const toolName = "vtd_trigger";
  const input = requireRecord(value, toolName);
  return await runDependency(
    async () =>
      await deps.vtdClient.trigger(
        {
          triggerId: requireString(input, "triggerId", toolName),
          all: optionalBoolean(input, "all", toolName),
        },
        context.signal,
      ),
    context.signal,
  );
}

export async function runVtdDetailTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<unknown> {
  const toolName = "vtd_detail";
  const input = requireRecord(value, toolName);
  return await runDependency(
    async () =>
      await deps.vtdClient.detail(
        requireString(input, "id", toolName),
        context.signal,
      ),
    context.signal,
  );
}

export async function runVtdTopicsTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<Record<string, number>> {
  const toolName = "vtd_topics";
  const input = requireRecord(value, toolName);
  return await runDependency(
    async () =>
      await deps.vtdClient.topics(
        requireString(input, "id", toolName),
        context.signal,
      ),
    context.signal,
  );
}

export function parseRequestBatchConsentInput(value: unknown): RequestBatchConsentInput {
  const toolName = "request_batch_consent";
  const input = requireRecord(value, toolName);
  return {
    action: requireString(input, "action", toolName),
    summary: requireString(input, "summary", toolName),
    itemCount: requirePositiveInteger(input, "itemCount", toolName),
  };
}

export async function runRequestBatchConsentTool(
  value: unknown,
  _deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<ToolConfirmationDecision> {
  parseRequestBatchConsentInput(value);
  context.signal?.throwIfAborted();
  if (context.confirmationDecision == undefined) {
    throw new Error("request_batch_consent requires a confirmation decision");
  }
  return context.confirmationDecision;
}

export async function runVtdSliceStoreTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<Awaited<ReturnType<IVtdClient["sliceStore"]>>> {
  const toolName = "vtd_slice_store";
  const input = requireRecord(value, toolName);
  const topics = optionalStringArray(input, "topics", toolName);
  const startNs = optionalDecimalString(input, "startNs", toolName);
  const endNs = optionalDecimalString(input, "endNs", toolName);
  const params: VtdSliceParams = {
    id: requireString(input, "id", toolName),
    ...(topics == undefined ? {} : { topics }),
    ...(startNs == undefined ? {} : { startNs }),
    ...(endNs == undefined ? {} : { endNs }),
  };
  return await runDependency(
    async () => await deps.vtdClient.sliceStore(params, context.signal),
    context.signal,
  );
}

export async function runVtdPresignTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<
  | Awaited<ReturnType<IVtdClient["sliceGet"]>>
  | Awaited<ReturnType<IVtdClient["url"]>>
> {
  const toolName = "vtd_presign";
  const input = requireRecord(value, toolName);
  const sliceId = optionalString(input, "sliceId", toolName);
  const id = optionalString(input, "id", toolName);
  if ((sliceId == undefined) === (id == undefined)) {
    throw new Error("vtd_presign requires exactly one of sliceId or id");
  }
  return await runDependency(
    async () =>
      sliceId != undefined
        ? await deps.vtdClient.sliceGet(sliceId, context.signal)
        : await deps.vtdClient.url(id!, context.signal),
    context.signal,
  );
}

export async function runOpenDataSourceTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<{ status: "opening"; message: string }> {
  const toolName = "open_data_source";
  const input = requireRecord(value, toolName);
  const request: OpenDataSourceRequest = {
    urls: requireUrls(input, toolName),
    sessionId: optionalString(input, "sessionId", toolName),
  };
  await runDependency(async () => {
    await deps.emitOpenDataSource(request, context.signal);
  }, context.signal);
  return { status: "opening", message: "打开中，等待目录就绪通知" };
}

export async function runGetDataCatalogTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<{ topics: readonly unknown[]; datatypes: Record<string, unknown> }> {
  const toolName = "get_data_catalog";
  requireRecord(value, toolName);
  const catalog =
    context.catalogReady ??
    (await runDependency(() => deps.getCatalog(), context.signal));
  context.signal?.throwIfAborted();
  return normalizeCatalog(catalog);
}

export async function runProposeLayoutTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<{ accepted: true; name: string }> {
  const toolName = "propose_layout";
  const input = requireRecord(value, toolName);
  const proposal: LayoutProposal = {
    name: requireString(input, "name", toolName),
    data: input.data,
    summary: optionalString(input, "summary", toolName),
  };
  const validated = validateLayoutProposal(proposal, {
    installedPanelTypes: deps.getInstalledPanelTypes(),
  });
  await runDependency(async () => {
    await deps.emitLayoutProposal(validated, context.signal);
  }, context.signal);
  return { accepted: true, name: validated.name };
}

type ToolRuntimeFunction = (
  value: unknown,
  deps: ToolRuntimeDeps,
  context?: ToolRuntimeContext,
) => Promise<unknown>;

export const TOOL_RUNTIME_FUNCTIONS: Readonly<
  Record<string, ToolRuntimeFunction>
> = {
  load_skill: runLoadSkillTool,
  memory_write: runMemoryWriteTool,
  memory_forget: runMemoryForgetTool,
  memory_list: runMemoryListTool,
  vtd_search: runVtdSearchTool,
  vtd_trigger: runVtdTriggerTool,
  vtd_detail: runVtdDetailTool,
  vtd_topics: runVtdTopicsTool,
  request_batch_consent: runRequestBatchConsentTool,
  vtd_slice_store: runVtdSliceStoreTool,
  vtd_presign: runVtdPresignTool,
  open_data_source: runOpenDataSourceTool,
  get_data_catalog: runGetDataCatalogTool,
  propose_layout: runProposeLayoutTool,
  read_messages: runReadMessagesTool,
  search_messages: runSearchMessagesTool,
  playback_control: runPlaybackControlTool,
};

export async function executeToolRuntime(
  name: string,
  value: unknown,
  deps: ToolRuntimeDeps,
  context: ToolRuntimeContext = {},
): Promise<unknown> {
  const runtime = TOOL_RUNTIME_FUNCTIONS[name];
  if (runtime == undefined) {
    throw new Error(`Unsupported local agent tool "${name}"`);
  }
  context.signal?.throwIfAborted();
  const result = await runtime(value, deps, context);
  context.signal?.throwIfAborted();
  return boundedRuntimeResult(name, result);
}
