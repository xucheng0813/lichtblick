// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { PANEL_SKILL_BY_TYPE } from "@lichtblick/suite-base/services/agent/local/skills";
import type { PanelInventoryEntry } from "@lichtblick/suite-base/services/agent/panelInventory";
import { getPanelTypeFromId, PANEL_TITLE_CONFIG_KEY } from "@lichtblick/suite-base/util/layout";

import type { ToolRuntimeDeps, ToolRuntimeContext } from "./toolRuntime";

/**
 * The upper byte bound for echoing the open layout back to the model. The result must stay
 * comfortably under TOOL_RUNTIME_MAX_RESULT_BYTES (256 KB) so the tool-result envelope never
 * truncates it into an unreadable JSON prefix; past this bound we degrade to the panel-index
 * summary below instead of partial LayoutData (a partial layout would be copied by the model
 * as if it were the whole one).
 */
export const GET_CURRENT_LAYOUT_MAX_BYTES = 128 * 1024;

/**
 * Byte budget for the degraded tooLarge panel index. It must stay comfortably below
 * TOOL_RUNTIME_MAX_RESULT_BYTES (256 KB) so the tool-result envelope never replaces the
 * structured tooLarge contract with an unreadable JSON preview; whole panel summaries are
 * dropped from the end until the result fits.
 */
export const GET_CURRENT_LAYOUT_TOO_LARGE_MAX_BYTES = 96 * 1024;

const GET_CURRENT_LAYOUT_TOO_LARGE_NOTE =
  "Layout too large to echo; in-place extension is impossible — propose a new layout or ask the user.";

export type ListPanelsResult = {
  count: number;
  panels: Array<PanelInventoryEntry & { skillId?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function requireRecord(value: unknown, toolName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${toolName} input must be an object`);
  }
  return value;
}

function requireNoUnknownProperties(
  input: Record<string, unknown>,
  allowed: readonly string[],
  toolName: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(`${toolName} does not support property "${key}"`);
    }
  }
}

function optionalString(
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

function optionalEnum<T extends string>(
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
    throw new Error(`${toolName}.${property} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === "bigint") {
        return entry.toString();
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

function matchesQuery(entry: PanelInventoryEntry, query: string): boolean {
  return (
    entry.type.toLowerCase().includes(query) ||
    entry.title.toLowerCase().includes(query) ||
    entry.description.toLowerCase().includes(query)
  );
}

/**
 * list_panels: reports every panel type this instance can render (built-ins and installed
 * extensions) with the panel-* skill that documents it. The returned type string is the exact
 * panel id prefix the proposal must use.
 */
export async function runListPanelsTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  _context: ToolRuntimeContext = {},
): Promise<ListPanelsResult> {
  const toolName = "list_panels";
  const input = requireRecord(value, toolName);
  requireNoUnknownProperties(input, ["source", "query"], toolName);
  const source = optionalEnum(input, "source", toolName, ["builtin", "extension"]);
  const query = optionalString(input, "query", toolName);
  if (deps.getPanelInventory == undefined) {
    throw new Error("list_panels is unavailable: panel inventory not configured");
  }
  const queryLower = query?.toLowerCase();
  const panels = deps
    .getPanelInventory()
    .filter((entry) => source == undefined || entry.source === source)
    .filter((entry) => queryLower == undefined || matchesQuery(entry, queryLower))
    .map((entry) => {
      const skillId = PANEL_SKILL_BY_TYPE.get(entry.type);
      return skillId == undefined ? { ...entry } : { ...entry, skillId };
    });
  return { count: panels.length, panels };
}

/**
 * Bounds the open-layout echo: full verbatim LayoutData (configById, layout, globalVariables,
 * userNodes with complete sourceCode, playbackConfig, savedProps, version) plus id/panelCount
 * when it fits the byte budget; otherwise a panel-index summary that still lets the model name
 * existing panels. A non-object layout means no layout is selected.
 */
export function boundCurrentLayout(id: string | undefined, data: unknown): unknown {
  if (!isRecord(data)) {
    return { panelCount: 0, note: "No layout is selected." };
  }
  const configById = isRecord(data.configById) ? data.configById : {};
  const result: Record<string, unknown> = { ...data, id, panelCount: 0 };
  result.panelCount = Object.keys(configById).length;
  const byteLength = serializedByteLength(result);
  if (byteLength <= GET_CURRENT_LAYOUT_MAX_BYTES) {
    return result;
  }

  const panels = Object.entries(configById).map(([panelId, config]) => {
    const title = readStringField(config, PANEL_TITLE_CONFIG_KEY);
    return {
      id: panelId,
      type: getPanelTypeFromId(panelId),
      ...(title == undefined ? {} : { title }),
      byteLength: serializedByteLength(config),
    };
  });
  let omittedCount = 0;
  const buildResult = () => ({
    id,
    tooLarge: true,
    byteLength,
    panelCount: result.panelCount,
    panels,
    ...(omittedCount > 0 ? { truncatedPanels: true, omittedCount } : {}),
    note: GET_CURRENT_LAYOUT_TOO_LARGE_NOTE,
  });
  // The degraded index has its own budget: whole panel summaries are dropped from the end
  // until the result fits, so the envelope never falls back to a raw JSON preview.
  while (
    panels.length > 0 &&
    serializedByteLength(buildResult()) > GET_CURRENT_LAYOUT_TOO_LARGE_MAX_BYTES
  ) {
    panels.pop();
    omittedCount++;
  }
  return buildResult();
}

/**
 * get_current_layout: reads the layout the user has open and returns it in full, so an
 * incremental proposal can reproduce existing panels and scripts verbatim.
 */
export async function runGetCurrentLayoutTool(
  value: unknown,
  deps: ToolRuntimeDeps,
  _context: ToolRuntimeContext = {},
): Promise<unknown> {
  const toolName = "get_current_layout";
  const input = requireRecord(value, toolName);
  requireNoUnknownProperties(input, [], toolName);
  if (deps.getCurrentLayout == undefined) {
    throw new Error("get_current_layout is unavailable: layout access is not configured");
  }
  return boundCurrentLayout(deps.getCurrentLayoutId?.(), deps.getCurrentLayout());
}
