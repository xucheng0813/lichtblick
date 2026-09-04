// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { summarizeWorkspace } from "@lichtblick/suite-base/services/agent/local/systemPrompt";
import type { CatalogSnapshot } from "@lichtblick/suite-base/services/agent/local/types";

export const CATALOG_TOOL_DEFAULT_TOPIC_LIMIT = 200;
export const CATALOG_TOOL_MAX_TOPIC_LIMIT = 500;
export const CATALOG_TOOL_MAX_DESCRIBE_TOPICS = 10;
export const CATALOG_TOOL_MAX_FIELD_DEPTH = 6;
export const CATALOG_TOOL_MAX_FIELD_LINES = 150;
export const CATALOG_READY_MESSAGE_MAX_BYTES = 8 * 1024;

/**
 * UTF-8 byte budget for `buildCatalogListing` / `describeTopics` results. The bounded tool-result
 * envelope (toolRuntime.ts) truncates to a JSON prefix, which the model cannot read; keeping our
 * results under this budget with structured truncation (`truncated` + `omittedCount`) is what
 * makes catalog output usable at all.
 */
export const CATALOG_TOOL_MAX_RESULT_BYTES = 96 * 1024;

/** A single topic name or field line may not exceed this many UTF-8 bytes. */
const CATALOG_TOOL_MAX_ITEM_BYTES = 512;

export type CatalogTopicSummary = { name: string; schemaName?: string };

/**
 * Placeholder replacing an oversized topic summary. Names are never truncated or rewritten
 * (a truncated name would be copied by the model as a real topic name), so an entry whose
 * serialized form exceeds the per-item byte cap is replaced wholesale.
 */
export type OmittedTopicPlaceholder = { omitted: true; byteLength: number };

export type SchemaFieldListing = {
  schemaName: string;
  fields: string[];
  truncated?: true;
  missingDatatypes?: string[];
};

export type GetDataCatalogInput = { query?: string; schema?: string; limit?: number };

export type GetDataCatalogResult = {
  topicCount: number;
  matchedCount: number;
  /** Number of real topic entries in `topics` (omitted placeholders do not count). */
  returnedCount: number;
  topics: Array<CatalogTopicSummary | OmittedTopicPlaceholder>;
  truncated?: true;
  omittedCount?: number;
  schemaCounts?: Record<string, number>;
  /** Set when whole schemaCounts key-value pairs were dropped to fit the byte budget. */
  schemaCountsTruncated?: true;
  /** Number of schemaCounts key-value pairs omitted by the byte budget. */
  schemaCountsOmitted?: number;
};

export type DescribeTopicResult = {
  topics: Array<{
    name: string;
    schemaName?: string;
    fields: string[];
    fieldsTruncated?: true;
    missingDatatypes?: string[];
    note?: string;
  }>;
  unknownTopics?: Array<{ name: string; suggestions: string[] }>;
  truncated?: true;
  omittedCount?: number;
};

type RawField = {
  name?: unknown;
  type?: unknown;
  isArray?: unknown;
  isConstant?: unknown;
  isComplex?: unknown;
};

type RawMessageDefinition = {
  definitions: readonly RawField[];
};

const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function isMessageDefinition(value: unknown): value is RawMessageDefinition {
  return isRecord(value) && Array.isArray(value.definitions);
}

function utf8ByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function isOmittedPlaceholder(
  topic: CatalogTopicSummary | OmittedTopicPlaceholder,
): topic is OmittedTopicPlaceholder {
  // "omitted" is the discriminant: it only exists on placeholders.
  return "omitted" in topic;
}

/**
 * Reduces runtime topic objects to their wire-relevant fields. Everything else (schemaData
 * buffers, statistics, …) is dropped here so it can never reach a tool result.
 */
export function normalizeCatalogTopics(topics: readonly unknown[]): CatalogTopicSummary[] {
  const result: CatalogTopicSummary[] = [];
  for (const topic of topics) {
    if (!isRecord(topic) || typeof topic.name !== "string") {
      continue;
    }
    const summary: CatalogTopicSummary = { name: topic.name };
    if (typeof topic.schemaName === "string") {
      summary.schemaName = topic.schemaName;
    }
    result.push(summary);
  }
  return result;
}

/**
 * Counts how many field lines a datatype would produce under the same traversal rules as
 * `flattenSchemaFields` (constants skipped, time/duration built-in, cycles cut, depth limited).
 * Used only to fill in the trailing `… (N more fields …)` note.
 */
function countFieldLines(
  typeName: string,
  datatypes: ReadonlyMap<string, unknown>,
  maxDepth: number,
): number {
  let count = 0;
  const visit = (type: string, depth: number, ancestors: readonly string[]): void => {
    const definition = datatypes.get(type);
    if (!isMessageDefinition(definition)) {
      return;
    }
    for (const field of definition.definitions) {
      if (
        field.isConstant === true ||
        typeof field.name !== "string" ||
        typeof field.type !== "string"
      ) {
        continue;
      }
      count++;
      const complex = (field.isComplex as boolean | undefined) ?? datatypes.has(field.type);
      if (
        complex &&
        field.type !== "time" &&
        field.type !== "duration" &&
        depth < maxDepth &&
        !ancestors.includes(field.type) &&
        datatypes.has(field.type)
      ) {
        visit(field.type, depth + 1, [...ancestors, type]);
      }
    }
  };
  visit(typeName, 1, [typeName]);
  return count;
}

/**
 * Flattens one datatype into human-readable field lines, depth-first in definition order.
 *
 * - `isConstant` fields are skipped.
 * - `time` / `duration` are treated as built-in primitive types (never recursed into).
 * - Complex fields emit their own line first, then their children with a `name.` or `name[].`
 *   prefix, while depth < maxDepth and the type is not already on the ancestor stack (cycles).
 * - Complex fields whose datatype is missing are recorded in `missingDatatypes` and not recursed.
 * - When more lines would be emitted than maxLines, the listing stops, is marked `truncated`, and
 *   gets a trailing note describing how many fields were omitted.
 */
export function flattenSchemaFields(
  schemaName: string,
  datatypes: ReadonlyMap<string, unknown>,
  options?: { maxDepth?: number; maxLines?: number },
): SchemaFieldListing {
  const maxDepth = options?.maxDepth ?? CATALOG_TOOL_MAX_FIELD_DEPTH;
  const maxLines = options?.maxLines ?? CATALOG_TOOL_MAX_FIELD_LINES;

  const fields: string[] = [];
  const missingDatatypes: string[] = [];
  const ancestors: string[] = [schemaName];
  // Mutable state object: the truncation flag is set inside the recursive visitor.
  const state = { truncated: false };

  const root = datatypes.get(schemaName);
  if (!isMessageDefinition(root)) {
    return { schemaName, fields, missingDatatypes: [schemaName] };
  }

  const visit = (typeName: string, prefix: string, depth: number): void => {
    const definition = datatypes.get(typeName);
    if (!isMessageDefinition(definition)) {
      if (!missingDatatypes.includes(typeName)) {
        missingDatatypes.push(typeName);
      }
      return;
    }
    for (const field of definition.definitions) {
      if (state.truncated) {
        return;
      }
      if (
        field.isConstant === true ||
        typeof field.name !== "string" ||
        typeof field.type !== "string"
      ) {
        continue;
      }
      // Only the attempt to write the (maxLines + 1)-th line triggers truncation: a schema with
      // exactly maxLines fields must not be marked truncated.
      if (fields.length >= maxLines) {
        state.truncated = true;
        return;
      }
      fields.push(
        `${prefix}${field.name}${field.isArray === true ? "[]" : ""}: ${field.type}`,
      );
      const complex = (field.isComplex as boolean | undefined) ?? datatypes.has(field.type);
      if (
        complex &&
        field.type !== "time" &&
        field.type !== "duration" &&
        depth < maxDepth &&
        !ancestors.includes(field.type)
      ) {
        if (!datatypes.has(field.type)) {
          if (!missingDatatypes.includes(field.type)) {
            missingDatatypes.push(field.type);
          }
        } else {
          const nextPrefix = `${prefix}${field.name}${field.isArray === true ? "[]." : "."}`;
          ancestors.push(typeName);
          visit(field.type, nextPrefix, depth + 1);
          ancestors.pop();
        }
      }
    }
  };

  visit(schemaName, "", 1);

  if (state.truncated) {
    const remaining = Math.max(0, countFieldLines(schemaName, datatypes, maxDepth) - fields.length);
    fields.push(`… (${remaining} more fields; narrow with maxDepth or read one message)`);
  }

  const result: SchemaFieldListing = { schemaName, fields };
  if (state.truncated) {
    result.truncated = true;
  }
  if (missingDatatypes.length > 0) {
    result.missingDatatypes = missingDatatypes;
  }
  return result;
}

function levenshteinDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + cost);
      previous = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

/**
 * Suggests catalog topic names close to `name`, in priority order:
 * 1. exact match after toggling the leading `/`;
 * 2. case-insensitive equality;
 * 3. one name is the other with a `/`-prefixed suffix (`candidate.endsWith("/" + name)` or vice
 *    versa);
 * 4. Levenshtein distance ≤ max(2, floor(len/4)), sorted by distance.
 * Results are deduplicated and capped at `max`.
 */
export function suggestTopicNames(
  name: string,
  topicNames: readonly string[],
  max = 3,
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    if (candidate === name || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    results.push(candidate);
  };

  const switched = name.startsWith("/") ? name.replace(/^\/+/, "") : `/${name}`;
  for (const candidate of topicNames) {
    if (candidate === switched) {
      push(candidate);
    }
  }
  if (results.length >= max) {
    return results.slice(0, max);
  }

  const lower = name.toLowerCase();
  for (const candidate of topicNames) {
    if (candidate.toLowerCase() === lower) {
      push(candidate);
    }
  }
  if (results.length >= max) {
    return results.slice(0, max);
  }

  for (const candidate of topicNames) {
    if (candidate.endsWith(`/${name}`) || name.endsWith(`/${candidate}`)) {
      push(candidate);
    }
  }
  if (results.length >= max) {
    return results.slice(0, max);
  }

  const threshold = Math.max(2, Math.floor(name.length / 4));
  const scored: Array<{ candidate: string; distance: number }> = [];
  for (const candidate of topicNames) {
    if (candidate === name || seen.has(candidate)) {
      continue;
    }
    const distance = levenshteinDistance(name, candidate);
    if (distance <= threshold) {
      scored.push({ candidate, distance });
    }
  }
  scored.sort((a, b) => {
    const byDistance = a.distance - b.distance;
    return byDistance !== 0 ? byDistance : a.candidate.localeCompare(b.candidate);
  });
  for (const { candidate } of scored) {
    if (results.length >= max) {
      break;
    }
    push(candidate);
  }
  return results.slice(0, max);
}

function clampLimit(limit: number | undefined): number {
  if (limit == undefined || !Number.isFinite(limit)) {
    return CATALOG_TOOL_DEFAULT_TOPIC_LIMIT;
  }
  return Math.min(CATALOG_TOOL_MAX_TOPIC_LIMIT, Math.max(1, Math.trunc(limit)));
}

function countSchemas(topics: readonly CatalogTopicSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const topic of topics) {
    const key = topic.schemaName ?? "(no schema)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Builds a `get_data_catalog` listing. Topics are normalized to `{name, schemaName}`, filtered by
 * exact `schema` and case-insensitive substring `query` (against both name and schemaName; `|` OR
 * is not supported), then limited (default 200, clamped to [1, 500]). When topics are dropped —
 * by the limit or by the byte budget — the result is marked `truncated` with `omittedCount` and
 * `schemaCounts` over the matched set so the model can narrow with query/schema.
 */
export function buildCatalogListing(
  catalog: CatalogSnapshot,
  input: GetDataCatalogInput,
): GetDataCatalogResult {
  const summaries = normalizeCatalogTopics(catalog.topics);
  let matched = summaries;
  if (input.schema != undefined) {
    matched = matched.filter((topic) => topic.schemaName === input.schema);
  }
  if (input.query != undefined && input.query !== "") {
    const query = input.query.toLowerCase();
    matched = matched.filter(
      (topic) =>
        topic.name.toLowerCase().includes(query) ||
        (topic.schemaName ?? "").toLowerCase().includes(query),
    );
  }

  let topics: GetDataCatalogResult["topics"] = matched
    .slice(0, clampLimit(input.limit))
    .map((topic) => {
      const item: CatalogTopicSummary =
        topic.schemaName == undefined
          ? { name: topic.name }
          : { name: topic.name, schemaName: topic.schemaName };
      // Names are never truncated: an oversized summary is replaced by a placeholder so the
      // model can never copy a modified name as if it were a real topic.
      return utf8ByteLength(item) > CATALOG_TOOL_MAX_ITEM_BYTES
        ? { omitted: true, byteLength: utf8ByteLength(item) }
        : item;
    });

  const schemaCounts = countSchemas(matched);
  const countsEntries = Object.entries(schemaCounts);
  let droppedCountEntries = 0;
  const currentCounts = (): Record<string, number> =>
    Object.fromEntries(countsEntries.slice(0, countsEntries.length - droppedCountEntries));

  const buildResult = (
    topicsList: GetDataCatalogResult["topics"],
  ): GetDataCatalogResult => {
    const realCount = topicsList.length - topicsList.filter(isOmittedPlaceholder).length;
    const result: GetDataCatalogResult = {
      topicCount: summaries.length,
      matchedCount: matched.length,
      returnedCount: realCount,
      topics: topicsList,
    };
    if (realCount < matched.length) {
      result.truncated = true;
      result.omittedCount = matched.length - realCount;
      const counts = currentCounts();
      if (Object.keys(counts).length > 0) {
        result.schemaCounts = counts;
      }
      if (droppedCountEntries > 0) {
        result.schemaCountsTruncated = true;
        result.schemaCountsOmitted = droppedCountEntries;
      }
    }
    return result;
  };

  // Byte budget: the serialized result — including schemaCounts and the truncation metadata —
  // must never exceed the budget. Whole schemaCounts key-value pairs are dropped first (they are
  // auxiliary), then whole topics from the end; if every counts entry is dropped, schemaCounts
  // is omitted entirely.
  while (utf8ByteLength(buildResult(topics)) > CATALOG_TOOL_MAX_RESULT_BYTES) {
    const realCount = topics.length - topics.filter(isOmittedPlaceholder).length;
    if (realCount < matched.length && droppedCountEntries < countsEntries.length) {
      droppedCountEntries++;
    } else if (topics.length > 0) {
      topics = topics.slice(0, -1);
    } else {
      break;
    }
  }

  return buildResult(topics);
}

/**
 * Describes up to `CATALOG_TOOL_MAX_DESCRIBE_TOPICS` topics: exact-match names get their schema
 * flattened (optionally with a maxDepth), unknown names get spelling suggestions. Results are
 * subject to the same byte budget as listings; whole field lines (and then whole topics) are
 * dropped from the end, marked with `truncated` + `omittedCount`.
 */
export function describeTopics(
  catalog: CatalogSnapshot,
  names: readonly string[],
  maxDepth?: number,
): DescribeTopicResult {
  if (names.length > CATALOG_TOOL_MAX_DESCRIBE_TOPICS) {
    throw new Error(
      `describe_topic supports at most ${CATALOG_TOOL_MAX_DESCRIBE_TOPICS} topics per call, got ${names.length}`,
    );
  }

  const summaries = normalizeCatalogTopics(catalog.topics);
  const summaryByName = new Map(summaries.map((summary) => [summary.name, summary]));
  const topicNames = summaries.map((summary) => summary.name);
  const depth = maxDepth ?? CATALOG_TOOL_MAX_FIELD_DEPTH;

  const topics: DescribeTopicResult["topics"] = [];
  const unknownTopics: Array<{ name: string; suggestions: string[] }> = [];
  let omittedCount = 0;

  for (const name of names) {
    const summary = summaryByName.get(name);
    if (summary == undefined) {
      unknownTopics.push({ name, suggestions: suggestTopicNames(name, topicNames) });
      continue;
    }
    if (summary.schemaName == undefined) {
      topics.push({ name, fields: [], note: "schema unknown; use read_messages" });
      continue;
    }
    const flattened = flattenSchemaFields(summary.schemaName, catalog.datatypes, {
      maxDepth: depth,
    });
    const entry: DescribeTopicResult["topics"][number] = {
      name,
      schemaName: summary.schemaName,
      // Field lines are only ever truncated on whole-line boundaries: a single line over the
      // per-item byte cap is dropped entirely (counted in omittedCount), never rewritten — a
      // modified line would be copied by the model as a real field path.
      fields: [],
    };
    for (const field of flattened.fields) {
      if (utf8ByteLength(field) > CATALOG_TOOL_MAX_ITEM_BYTES) {
        omittedCount++;
        continue;
      }
      entry.fields.push(field);
    }
    if (flattened.truncated) {
      entry.fieldsTruncated = true;
    }
    if (flattened.missingDatatypes != undefined && flattened.missingDatatypes.length > 0) {
      entry.missingDatatypes = flattened.missingDatatypes;
    }
    topics.push(entry);
  }

  const buildResult = (): DescribeTopicResult => {
    const built: DescribeTopicResult = { topics };
    if (unknownTopics.length > 0) {
      built.unknownTopics = unknownTopics;
    }
    if (omittedCount > 0) {
      built.truncated = true;
      built.omittedCount = omittedCount;
    }
    return built;
  };

  // Byte budget: drop the last field line of the last topic that has fields, then whole topics,
  // then whole unknownTopic entries, until the serialized result fits.
  while (utf8ByteLength(buildResult()) > CATALOG_TOOL_MAX_RESULT_BYTES) {
    let dropped = false;
    for (let index = topics.length - 1; index >= 0; index--) {
      const topic = topics[index]!;
      if (topic.fields.length > 0) {
        topic.fields = topic.fields.slice(0, -1);
        omittedCount++;
        dropped = true;
        break;
      }
    }
    if (!dropped && topics.length > 0) {
      topics.splice(topics.length - 1, 1);
      omittedCount++;
      dropped = true;
    }
    if (!dropped && unknownTopics.length > 0) {
      unknownTopics.splice(unknownTopics.length - 1, 1);
      omittedCount++;
      dropped = true;
    }
    if (!dropped) {
      break;
    }
  }

  return buildResult();
}

/**
 * Renders the catalog-ready follow-up message the orchestrator sends after open_data_source.
 * The prefix is pinned by the orchestrator contract (tests assert it verbatim); the body is the
 * byte-bounded workspace summary so the model gets names/schemas without the schemaData payload.
 *
 * The WHOLE injected message — prefix plus summary — must fit in CATALOG_READY_MESSAGE_MAX_BYTES,
 * so the summary budget is what remains after the prefix's UTF-8 bytes. A requestId whose prefix
 * alone exceeds the budget is rejected explicitly instead of truncating the pinned prefix.
 */
export function renderCatalogReadyMessage(catalog: CatalogSnapshot, requestId: string): string {
  const prefix = `The Lichtblick data catalog is ready for request ${requestId}: `;
  const prefixBytes = new TextEncoder().encode(prefix).byteLength;
  if (prefixBytes > CATALOG_READY_MESSAGE_MAX_BYTES) {
    throw new Error(
      `catalog-ready requestId is too long: the fixed prefix alone takes ${prefixBytes} bytes, exceeding the ${CATALOG_READY_MESSAGE_MAX_BYTES}-byte budget`,
    );
  }
  return (
    prefix +
    summarizeWorkspace(catalog, undefined, {
      maxBytes: CATALOG_READY_MESSAGE_MAX_BYTES - prefixBytes,
    })
  );
}
