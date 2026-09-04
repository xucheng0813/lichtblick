// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import ts from "typescript/lib/typescript";

import type { MessagePath, MessagePathPart, MessagePathStructureItemMessage } from "@lichtblick/message-path";
import { parseMessagePath, quoteTopicNameIfNeeded } from "@lichtblick/message-path";
import type { Immutable } from "@lichtblick/suite";
import {
  messagePathStructures,
  traverseStructure,
  validTerminatingStructureItem,
} from "@lichtblick/suite-base/components/MessagePathSyntax/messagePathsForDatatype";
import { RAW_AUDIO_SCHEMA_NAME } from "@lichtblick/suite-base/panels/Audio/settings";
import { ALLOWED_DATATYPES as DIAGNOSTIC_ARRAY_DATATYPES } from "@lichtblick/suite-base/panels/DiagnosticSummary/constants";
import { TRANSITIONABLE_ROS_TYPES } from "@lichtblick/suite-base/panels/StateTransitions/constants";
import {
  CAMERA_CALIBRATION_DATATYPES,
  COMPRESSED_IMAGE_DATATYPES as FOXGLOVE_COMPRESSED_IMAGE_DATATYPES,
  RAW_IMAGE_DATATYPES,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/foxglove";
import {
  CAMERA_INFO_DATATYPES,
  COMPRESSED_IMAGE_DATATYPES as ROS_COMPRESSED_IMAGE_DATATYPES,
  IMAGE_DATATYPES as ROS_IMAGE_DATATYPES,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/ros";
import { PLOTABLE_ROS_TYPES } from "@lichtblick/suite-base/panels/shared/constants";
import type { Topic } from "@lichtblick/suite-base/players/types";
import type { AgentSafeLayoutData } from "@lichtblick/suite-base/services/agent/layoutSchema";
import type { RosDatatypes } from "@lichtblick/suite-base/types/RosDatatypes";
import { getPanelTypeFromId } from "@lichtblick/suite-base/util/layout";

import { suggestTopicNames } from "./tools/catalogTools";

export type LayoutCatalogCheckResult = { errors: string[]; warnings: string[] };

export type TopicReference = {
  location: string;
  kind: "topic" | "messagePath";
  value: unknown;
  required?: boolean;
  schemaAllowlist?: ReadonlySet<string>;
  terminalTypes?: readonly string[];
  terminalSeverity?: "error" | "warning";
};

/**
 * Schemas the Map panel can follow, copied from `panels/Map/config.ts` follow-topic options:
 * the NavSatFix / LocationFix families only — GeoJSON layers are excluded (they cannot be
 * followed).
 */
const MAP_FOLLOW_SCHEMAS = new Set<string>([
  "sensor_msgs/NavSatFix",
  "sensor_msgs/msg/NavSatFix",
  "ros.sensor_msgs.NavSatFix",
  "foxglove_msgs/LocationFix",
  "foxglove_msgs/msg/LocationFix",
  "foxglove.LocationFix",
  "foxglove::LocationFix",
]);

/**
 * Schemas the Map panel can render at all (NavSatFix / LocationFix / GeoJSON), copied from
 * `panels/Map/support.ts isSupportedSchema` (importing that module would drag in leaflet/geojson
 * at runtime). Used for `disabledTopics` and `topicColors` entries.
 */
const MAP_TOPIC_SCHEMAS = new Set<string>([
  "sensor_msgs/NavSatFix",
  "sensor_msgs/msg/NavSatFix",
  "ros.sensor_msgs.NavSatFix",
  "foxglove_msgs/LocationFix",
  "foxglove_msgs/msg/LocationFix",
  "foxglove.LocationFix",
  "foxglove::LocationFix",
  "foxglove_msgs/GeoJSON",
  "foxglove_msgs/msg/GeoJSON",
  "foxglove::GeoJSON",
  "foxglove.GeoJSON",
]);

/**
 * Schemas the RosOut panel renders, copied from `panels/Log/index.tsx SUPPORTED_DATATYPES`
 * (importing the panel module would drag in React/i18n).
 */
export const ROSOUT_LOG_SCHEMAS = new Set<string>([
  "foxglove_msgs/Log",
  "foxglove_msgs/msg/Log",
  "foxglove.Log",
  "foxglove::Log",
  "rcl_interfaces/msg/Log",
  "ros.rcl_interfaces.Log",
  "ros.rosgraph_msgs.Log",
  "rosgraph_msgs/Log",
]);

const DIAGNOSTIC_ARRAY_SCHEMAS = new Set<string>(DIAGNOSTIC_ARRAY_DATATYPES);

const IMAGE_TOPIC_SCHEMAS = new Set<string>([
  ...RAW_IMAGE_DATATYPES,
  ...FOXGLOVE_COMPRESSED_IMAGE_DATATYPES,
  ...ROS_IMAGE_DATATYPES,
  ...ROS_COMPRESSED_IMAGE_DATATYPES,
]);

const CALIBRATION_TOPIC_SCHEMAS = new Set<string>([
  ...CAMERA_CALIBRATION_DATATYPES,
  ...CAMERA_INFO_DATATYPES,
]);

const RAW_AUDIO_SCHEMAS = new Set<string>([RAW_AUDIO_SCHEMA_NAME]);

const STUDIO_SCRIPT_PREFIX = "/studio_script/";

/** Same regular expression as `players/UserScriptPlayer/transformerWorker/transform.ts` getOutputTopic. */
const SCRIPT_OUTPUT_REGEX = /^\s*export\s+const\s+output\s*=\s*("([^"]+)"|'([^']+)')/m;
const SCRIPT_INPUTS_REGEX = /^\s*export\s+const\s+inputs\s*=\s*\[([\s\S]*?)\]/m;
const STRING_LITERAL_REGEX = /"([^"]+)"|'([^']+)'/g;

/** Arithmetic hint only when the value contains an operator with whitespace on both sides. */
const ARITHMETIC_REGEX = /\s[-+*/]\s/;
/** A Plot reference line is only skipped when the whole value is one finite number. */
const REFERENCE_LINE_REGEX = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Removes `//` line comments and `/* … * /` block comments using the TypeScript scanner, which
 * tokenizes template strings (including `${…}` interpolation, escapes, and nesting) and regular
 * expression literals correctly, so `//` or `/*` inside them survive. Comment content is replaced
 * with spaces and newlines are preserved, so `export` declarations keep their line positions and
 * tokens on either side of a comment are not accidentally joined.
 */
function stripComments(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  let result = "";
  let cursor = 0;
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      result += source.slice(cursor, scanner.getTokenStart());
      result += blankOutComment(source.slice(scanner.getTokenStart(), scanner.getTokenEnd()));
      cursor = scanner.getTokenEnd();
    }
  }
  result += source.slice(cursor);
  return result;
}

function blankOutComment(comment: string): string {
  let blanked = "";
  for (const char of comment) {
    blanked += char === "\n" || char === "\r" ? char : " ";
  }
  return blanked;
}

/**
 * Extracts the topic references a panel config makes. Two kinds are strictly separated:
 *
 * - `kind: "topic"` values are opaque topic names checked verbatim against the catalog; they are
 *   never run through parseMessagePath (a topic name itself may contain "." or ":").
 * - `kind: "messagePath"` values are parsed with parseMessagePath; the topic is the parsed prefix.
 *
 * Panel types not listed here (including extension panels) produce no references.
 */
export function extractTopicReferences(
  panelType: string,
  panelId: string,
  config: Record<string, unknown>,
): { refs: TopicReference[]; warnings: string[] } {
  const refs: TopicReference[] = [];
  const warnings: string[] = [];
  const base = `configById["${panelId}"]`;

  switch (panelType) {
    case "Plot": {
      const paths = config.paths;
      if (Array.isArray(paths)) {
        for (const [index, path] of paths.entries()) {
          if (!isRecord(path) || typeof path.value !== "string") {
            continue;
          }
          // Reference lines ("5", "-3.14") are skipped. The arithmetic check comes before the
          // reference-line check on purpose: isReferenceLinePlotPathType uses parseFloat and
          // would misclassify "100 - 5" as a reference line, but the strict whole-string match
          // below does not, so "100 - 5" stays a reference and errors later.
          if (REFERENCE_LINE_REGEX.test(path.value)) {
            continue;
          }
          refs.push({
            location: `${base}.paths[${index}].value`,
            kind: "messagePath",
            value: path.value,
            terminalTypes: PLOTABLE_ROS_TYPES,
            terminalSeverity: "error",
          });
        }
      }
      break;
    }
    case "StateTransitions": {
      const paths = config.paths;
      if (Array.isArray(paths)) {
        for (const [index, path] of paths.entries()) {
          if (!isRecord(path) || typeof path.value !== "string") {
            continue;
          }
          refs.push({
            location: `${base}.paths[${index}].value`,
            kind: "messagePath",
            value: path.value,
            terminalTypes: TRANSITIONABLE_ROS_TYPES,
            terminalSeverity: "warning",
          });
        }
      }
      break;
    }
    case "Gauge":
    case "Indicator":
    case "PieChart": {
      refs.push({
        location: `${base}.path`,
        kind: "messagePath",
        value: config.path,
        required: true,
      });
      break;
    }
    case "RawMessages":
    case "RawMessagesVirtual":
    case "Table": {
      refs.push({
        location: `${base}.topicPath`,
        kind: "messagePath",
        value: config.topicPath,
        required: true,
      });
      if (panelType === "RawMessages" || panelType === "RawMessagesVirtual") {
        // diffTopicPath is only active — and only required — while custom diffing is enabled.
        // A stale saved path from another mode is legal config and must never reject the
        // layout, so it is not extracted (and thus not validated) in any other mode.
        if (config.diffEnabled === true && config.diffMethod === "custom") {
          refs.push({
            location: `${base}.diffTopicPath`,
            kind: "messagePath",
            value: config.diffTopicPath,
            required: true,
          });
        }
      }
      break;
    }
    case "Image":
    case "3D": {
      const imageMode = config.imageMode;
      if (isRecord(imageMode)) {
        if (isNonEmptyString(imageMode.imageTopic)) {
          refs.push({
            location: `${base}.imageMode.imageTopic`,
            kind: "topic",
            value: imageMode.imageTopic,
            schemaAllowlist: IMAGE_TOPIC_SCHEMAS,
          });
        }
        if (isNonEmptyString(imageMode.calibrationTopic)) {
          refs.push({
            location: `${base}.imageMode.calibrationTopic`,
            kind: "topic",
            value: imageMode.calibrationTopic,
            schemaAllowlist: CALIBRATION_TOPIC_SCHEMAS,
          });
        }
      }
      if (panelType === "3D") {
        const topics = config.topics;
        if (Array.isArray(topics) || isRecord(topics)) {
          if (isRecord(topics)) {
            const entries = Object.values(topics);
            if (entries.length === 0 || !entries.some((entry) => isRecord(entry) && entry.visible !== false)) {
              warnings.push(
                `${base}.topics: no visible topics (every entry has visible: false); the panel will render nothing`,
              );
            }
          }
          // The check function reports `topics must be an object keyed by topic name` for arrays
          // and verifies each object key verbatim as a topic name.
          refs.push({ location: `${base}.topics`, kind: "topic", value: topics });
        }
      }
      break;
    }
    case "map": {
      if (isNonEmptyString(config.followTopic)) {
        refs.push({
          location: `${base}.followTopic`,
          kind: "topic",
          value: config.followTopic,
          schemaAllowlist: MAP_FOLLOW_SCHEMAS,
        });
      }
      // disabledTopics entries and topicColors keys are verbatim topic names: unknown names are
      // errors, schemas outside the map-renderable set are warnings.
      const disabledTopics = config.disabledTopics;
      if (Array.isArray(disabledTopics)) {
        for (const [index, name] of disabledTopics.entries()) {
          if (isNonEmptyString(name)) {
            refs.push({
              location: `${base}.disabledTopics[${index}]`,
              kind: "topic",
              value: name,
              schemaAllowlist: MAP_TOPIC_SCHEMAS,
            });
          }
        }
      }
      const topicColors = config.topicColors;
      if (isRecord(topicColors)) {
        for (const name of Object.keys(topicColors)) {
          if (isNonEmptyString(name)) {
            refs.push({
              location: `${base}.topicColors["${name}"]`,
              kind: "topic",
              value: name,
              schemaAllowlist: MAP_TOPIC_SCHEMAS,
            });
          }
        }
      }
      break;
    }
    case "RosOut": {
      if (!isNonEmptyString(config.topicToRender)) {
        warnings.push(
          `${base}.topicToRender is empty; the panel will render the first Log topic it finds`,
        );
      } else {
        refs.push({
          location: `${base}.topicToRender`,
          kind: "topic",
          value: config.topicToRender,
          schemaAllowlist: ROSOUT_LOG_SCHEMAS,
        });
      }
      break;
    }
    case "DiagnosticSummary":
    case "DiagnosticStatusPanel": {
      refs.push({
        location: `${base}.topicToRender`,
        kind: "topic",
        value: config.topicToRender,
        required: true,
        schemaAllowlist: DIAGNOSTIC_ARRAY_SCHEMAS,
      });
      break;
    }
    case "Audio": {
      refs.push({
        location: `${base}.topicPath`,
        kind: "topic",
        value: config.topicPath,
        required: true,
        schemaAllowlist: RAW_AUDIO_SCHEMAS,
      });
      break;
    }
    default:
      // Extension panels and panel types without topic references are intentionally skipped.
      break;
  }

  return { refs, warnings };
}

type CheckContext = {
  topicNames: Set<string>;
  /** Real catalog topic names only (no virtual script outputs) — used for suggestions. */
  catalogTopicNames: string[];
  schemaByTopic: Map<string, string>;
  structures: Record<string, MessagePathStructureItemMessage> | undefined;
};

function switchedSlashMatch(name: string, candidate: string): boolean {
  return candidate === `/${name}` || name === `/${candidate}`;
}

function formatSuggestions(name: string, ctx: CheckContext): string {
  const suggestions = suggestTopicNames(name, ctx.catalogTopicNames, 3);
  if (suggestions.length === 0) {
    return "";
  }
  const parts = suggestions.map((candidate) =>
    switchedSlashMatch(name, candidate)
      ? candidate.startsWith("/")
        ? `did you mean "${candidate}" (with leading slash)?`
        : `did you mean "${candidate}" (no leading slash)?`
      : `did you mean "${candidate}"?`,
  );
  return `; ${parts.join(" ")}`;
}

function topicSegmentNeedsQuoting(value: string): boolean {
  const firstDot = value.indexOf(".");
  const segment = firstDot === -1 ? value : value.slice(0, firstDot);
  return /[^a-zA-Z0-9_/-]/.test(segment);
}

function formatParseError(location: string, value: string): string {
  const message = `${location} "${value}" is not a valid message path`;
  if (ARITHMETIC_REGEX.test(value)) {
    return `${message}; arithmetic and operators are not supported in paths — compute derived values in a user script`;
  }
  if (topicSegmentNeedsQuoting(value)) {
    return `${message}; topic names containing special characters must be quoted, e.g. "my.topic".field`;
  }
  return message;
}

/**
 * Longest catalog topic name that is a prefix of `value` and is followed by `.`, `[`, `{`, or
 * the end of the string — used to disambiguate topics whose names contain dots (a bare
 * `foo.bar.x` parses as topic `foo` + fields `bar.x`).
 */
function longestPrefixTopic(value: string, names: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  for (const name of names) {
    if (name.length === 0 || name.length > value.length || !value.startsWith(name)) {
      continue;
    }
    const next = value[name.length];
    if (next != undefined && next !== "." && next !== "[" && next !== "{") {
      continue;
    }
    if (best == undefined || name.length > best.length) {
      best = name;
    }
  }
  return best;
}

type ResolvedPath = {
  topicName: string;
  messagePath: MessagePathPart[];
  /** Remainder of the original value after the resolved topic (for error messages). */
  rest: string;
};

function fieldStatus(
  resolved: ResolvedPath,
  ctx: CheckContext,
): "ok" | "unverifiable" | "invalid" {
  const schemaName = ctx.schemaByTopic.get(resolved.topicName);
  if (schemaName == undefined) {
    return "unverifiable";
  }
  const structure = ctx.structures?.[schemaName];
  if (structure == undefined) {
    return "unverifiable";
  }
  return traverseStructure(structure, resolved.messagePath).valid ? "ok" : "invalid";
}

/**
 * Resolves the topic of a parsed message path.
 *
 * The parse result wins when its topic is known — this mirrors how the panels themselves parse
 * paths. When the parsed topic is unknown (or its field chain does not validate), the longest
 * catalog topic that is a prefix of the raw value is adopted and the remainder is re-parsed as
 * the field chain (with the topic written in quoted form, since topic names may contain dots).
 */
function resolveTopic(
  value: string,
  parsed: MessagePath,
  ctx: CheckContext,
): ResolvedPath | undefined {
  const primary: ResolvedPath = {
    topicName: parsed.topicName,
    messagePath: parsed.messagePath,
    rest: value.slice(parsed.topicNameRepr.length),
  };

  if (ctx.topicNames.has(primary.topicName)) {
    if (fieldStatus(primary, ctx) !== "invalid") {
      return primary;
    }
    const disambiguated = longestPrefixTopic(value, ctx.topicNames);
    if (disambiguated != undefined && disambiguated !== primary.topicName) {
      const alternative = reparseWithTopic(disambiguated, value);
      if (alternative != undefined && fieldStatus(alternative, ctx) === "ok") {
        return alternative;
      }
    }
    return primary;
  }

  const disambiguated = longestPrefixTopic(value, ctx.topicNames);
  if (disambiguated != undefined) {
    const alternative = reparseWithTopic(disambiguated, value);
    if (alternative != undefined) {
      return alternative;
    }
  }
  return undefined;
}

function reparseWithTopic(topicName: string, value: string): ResolvedPath | undefined {
  const remainder = value.slice(topicName.length);
  const reparsed = parseMessagePath(quoteTopicNameIfNeeded(topicName) + remainder);
  if (reparsed == undefined) {
    return undefined;
  }
  return {
    topicName,
    messagePath: reparsed.messagePath,
    rest: remainder,
  };
}

function fieldDisplay(rest: string): string {
  return rest.startsWith(".") ? rest.slice(1) : rest;
}

function checkResolvedPath(
  ref: TopicReference,
  resolved: ResolvedPath,
  rawValue: string,
  ctx: CheckContext,
  errors: string[],
  warnings: string[],
): void {
  const schemaName = ctx.schemaByTopic.get(resolved.topicName);

  if (ref.schemaAllowlist != undefined) {
    if (schemaName == undefined || !ref.schemaAllowlist.has(schemaName)) {
      warnings.push(
        `${ref.location}: topic "${resolved.topicName}" uses unsupported schema "${schemaName ?? "unknown"}" (expected one of: ${[...ref.schemaAllowlist].join(", ")})`,
      );
    }
  }

  const structure = schemaName == undefined ? undefined : ctx.structures?.[schemaName];
  if (structure == undefined) {
    // User-script outputs, schema-less topics, and failed structure construction all degrade to
    // warnings: we cannot verify the field chain without a structure.
    if (resolved.messagePath.length > 0) {
      warnings.push(
        `${ref.location}: cannot verify field path "${fieldDisplay(resolved.rest)}" on "${resolved.topicName}"`,
      );
    }
    return;
  }

  const traversal = traverseStructure(structure, resolved.messagePath);
  if (!traversal.valid) {
    const failingName =
      traversal.msgPathPart?.type === "name" ? traversal.msgPathPart.name : undefined;
    if (failingName != undefined) {
      errors.push(
        `${ref.location}: field "${failingName}" does not exist on ${schemaName}; run describe_topic on "${resolved.topicName}"`,
      );
    } else {
      errors.push(
        `${ref.location}: path "${rawValue}" is not valid on ${schemaName}; run describe_topic on "${resolved.topicName}"`,
      );
    }
    return;
  }

  // traverseStructure reports valid with an undefined structure item when the path ends at a
  // missing field (this is the autocomplete case in the UI); treat it as a missing field.
  if (traversal.structureItem == undefined) {
    const last = resolved.messagePath[resolved.messagePath.length - 1];
    const missingName = last?.type === "name" ? last.name : fieldDisplay(resolved.rest);
    errors.push(
      `${ref.location}: field "${missingName}" does not exist on ${schemaName}; run describe_topic on "${resolved.topicName}"`,
    );
    return;
  }

  if (
    ref.terminalTypes != undefined &&
    !validTerminatingStructureItem(traversal.structureItem, ref.terminalTypes)
  ) {
    const display = fieldDisplay(resolved.rest);
    const message =
      display === ""
        ? `${ref.location}: path "${rawValue}" does not end in a supported type on ${schemaName}`
        : `${ref.location}: field "${display}" does not end in a supported type on ${schemaName}`;
    if (ref.terminalSeverity === "warning") {
      warnings.push(message);
    } else {
      errors.push(message);
    }
  }
}

function checkTopicRef(
  ref: TopicReference,
  ctx: CheckContext,
  errors: string[],
  warnings: string[],
): void {
  const value = ref.value;
  if (typeof value === "object" && value != undefined) {
    if (Array.isArray(value)) {
      errors.push(`${ref.location}: topics must be an object keyed by topic name`);
      return;
    }
    for (const key of Object.keys(value)) {
      checkSingleTopicRef({ ...ref, location: `${ref.location}["${key}"]`, value: key }, ctx, errors, warnings);
    }
    return;
  }
  checkSingleTopicRef(ref, ctx, errors, warnings);
}

function checkSingleTopicRef(
  ref: TopicReference,
  ctx: CheckContext,
  errors: string[],
  warnings: string[],
): void {
  if (!isNonEmptyString(ref.value)) {
    if (ref.required === true) {
      errors.push(`${ref.location} is required`);
    }
    return;
  }
  const name = ref.value;
  if (!ctx.topicNames.has(name)) {
    errors.push(`${ref.location} references unknown topic "${name}"${formatSuggestions(name, ctx)}`);
    return;
  }
  if (ref.schemaAllowlist != undefined) {
    const schemaName = ctx.schemaByTopic.get(name);
    if (schemaName == undefined || !ref.schemaAllowlist.has(schemaName)) {
      warnings.push(
        `${ref.location}: topic "${name}" uses unsupported schema "${schemaName ?? "unknown"}" (expected one of: ${[...ref.schemaAllowlist].join(", ")})`,
      );
    }
  }
}

function checkMessagePathRef(
  ref: TopicReference,
  ctx: CheckContext,
  errors: string[],
  warnings: string[],
): void {
  if (!isNonEmptyString(ref.value)) {
    if (ref.required === true) {
      errors.push(`${ref.location} is required`);
    }
    return;
  }
  const value = ref.value;
  const parsed = parseMessagePath(value);
  if (parsed == undefined) {
    errors.push(formatParseError(ref.location, value));
    return;
  }
  const resolved = resolveTopic(value, parsed, ctx);
  if (resolved == undefined) {
    errors.push(
      `${ref.location} references unknown topic "${parsed.topicName}"${formatSuggestions(parsed.topicName, ctx)}`,
    );
    return;
  }
  checkResolvedPath(ref, resolved, value, ctx, errors, warnings);
}

/**
 * Collects the user-script virtual catalog and validates script outputs/inputs against it.
 *
 * Parsing mirrors the UserScriptPlayer transformer contract:
 * - comments are stripped first (strings survive), then the same regexes as
 *   `transform.ts` getOutputTopic / InputTopicsChecker extract the FIRST `export const output`
 *   and the first `export const inputs` array (repeated exports: first one wins);
 * - a missing/empty output or a missing/empty inputs array is an error — never silently passed;
 * - output must be unique across scripts and must not collide with a real data source topic;
 * - outputs not starting with `/studio_script/` get a warning;
 * - every input string literal must exist in the catalog or be an output of another script;
 * - valid outputs join a virtual catalog without schema: references to them resolve as known
 *   topics whose field checks degrade to warnings. Nothing is allowlisted by prefix — a
 *   misspelled script output is still an unknown topic.
 */
function collectUserScriptTopics(
  data: AgentSafeLayoutData,
  ctx: CheckContext,
  errors: string[],
  warnings: string[],
): void {
  const userNodes = data.userNodes;
  if (userNodes == undefined || !isRecord(userNodes)) {
    return;
  }
  const scriptOutputs = new Map<string, string>();
  type ScriptEntry = { location: string; output: string | undefined; inputs: string[] };
  const entries: ScriptEntry[] = [];

  // Pass 1: parse outputs and inputs, register valid outputs (two passes so a script may consume
  // an output produced by a script that appears later in userNodes).
  for (const [nodeId, node] of Object.entries(userNodes)) {
    if (!isRecord(node) || typeof node.sourceCode !== "string") {
      continue;
    }
    const location = `userNodes["${nodeId}"]`;
    const sourceCode = stripComments(node.sourceCode);

    const outputMatch = SCRIPT_OUTPUT_REGEX.exec(sourceCode);
    const output = outputMatch?.[2] ?? outputMatch?.[3];
    if (output == undefined) {
      errors.push(`${location} has no parseable export const output`);
    } else if (output === "") {
      errors.push(`${location}: output topic must be a non-empty string`);
    }

    const inputs: string[] = [];
    const inputsMatch = SCRIPT_INPUTS_REGEX.exec(sourceCode);
    const inputsBody = inputsMatch?.[1];
    if (inputsBody != undefined) {
      for (const literal of inputsBody.matchAll(STRING_LITERAL_REGEX)) {
        const input = literal[1] ?? literal[2];
        if (input != undefined && input !== "") {
          inputs.push(input);
        }
      }
    }
    if (inputs.length === 0) {
      errors.push(`${location} has no parseable export const inputs`);
    }
    entries.push({ location, output, inputs });

    if (output == undefined || output === "") {
      continue;
    }
    const existingProducer = scriptOutputs.get(output);
    if (existingProducer != undefined) {
      errors.push(
        `${location}: output topic "${output}" is also produced by userNodes["${existingProducer}"]`,
      );
      continue;
    }
    if (ctx.catalogTopicNames.includes(output)) {
      errors.push(`${location}: output topic "${output}" conflicts with a data source topic`);
      continue;
    }
    if (!output.startsWith(STUDIO_SCRIPT_PREFIX)) {
      warnings.push(
        `${location}: output topic "${output}" does not start with ${STUDIO_SCRIPT_PREFIX}`,
      );
    }
    scriptOutputs.set(output, nodeId);
    // Virtual catalog entry: known topic name, no schema (field checks degrade to warnings).
    ctx.topicNames.add(output);
  }

  // Pass 2: validate inputs against the real catalog and the registered virtual outputs.
  for (const entry of entries) {
    for (const input of entry.inputs) {
      if (!ctx.topicNames.has(input)) {
        errors.push(
          `${entry.location}: input "${input}" is not in the catalog${formatSuggestions(input, ctx)}`,
        );
      }
    }
  }
}

/**
 * Validates every topic reference of an Agent layout proposal against the loaded data source.
 *
 * - `topics.length === 0` skips validation entirely (no data source loaded).
 * - Script outputs from `userNodes` form a virtual catalog (see collectUserScriptTopics).
 * - `kind: "topic"` references are matched verbatim (never parsed); `kind: "messagePath"`
 *   references are parsed, with longest-prefix disambiguation for topic names containing dots.
 * - Field chains are verified with messagePathStructures + traverseStructure; when structure
 *   construction throws (missing sub-datatypes), all field checks degrade to warnings.
 */
export function checkLayoutAgainstCatalog(
  data: AgentSafeLayoutData,
  topics: readonly Topic[],
  datatypes: Immutable<RosDatatypes>,
): LayoutCatalogCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (topics.length === 0) {
    return { errors, warnings };
  }

  const ctx: CheckContext = {
    topicNames: new Set(),
    catalogTopicNames: [],
    schemaByTopic: new Map(),
    structures: undefined,
  };
  for (const topic of topics) {
    ctx.topicNames.add(topic.name);
    ctx.catalogTopicNames.push(topic.name);
    if (topic.schemaName != undefined) {
      ctx.schemaByTopic.set(topic.name, topic.schemaName);
    }
  }

  try {
    ctx.structures = messagePathStructures(datatypes);
  } catch {
    ctx.structures = undefined;
  }

  collectUserScriptTopics(data, ctx, errors, warnings);

  for (const [panelId, config] of Object.entries(data.configById)) {
    if (!isRecord(config)) {
      continue;
    }
    const panelType = getPanelTypeFromId(panelId);
    if (panelType === "") {
      continue;
    }
    const { refs, warnings: extractionWarnings } = extractTopicReferences(
      panelType,
      panelId,
      config,
    );
    warnings.push(...extractionWarnings);
    for (const ref of refs) {
      if (ref.kind === "topic") {
        checkTopicRef(ref, ctx, errors, warnings);
      } else {
        checkMessagePathRef(ref, ctx, errors, warnings);
      }
    }
  }

  return { errors, warnings };
}

export function formatLayoutCatalogErrors(result: LayoutCatalogCheckResult): string {
  const lines: string[] = [
    `propose_layout rejected: ${result.errors.length} problem(s) must be fixed:`,
    ...result.errors.map((error) => `- ${error}`),
  ];
  if (result.warnings.length > 0) {
    lines.push("Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
