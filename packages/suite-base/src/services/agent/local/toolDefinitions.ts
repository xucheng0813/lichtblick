// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { SKILL_IDS } from "./skills";
import type { LlmToolDef } from "./types";

const nonEmptyString = { type: "string", minLength: 1 } as const;
const decimalNanoseconds = {
  type: "string",
  pattern: "^[0-9]+$",
  description:
    "Decimal nanoseconds encoded as a string to avoid precision loss.",
} as const;

/**
 * Tool definitions for a turn.
 *
 * The load_skill enum has to reflect the skills actually available, which depends on the user's
 * custom skills, so this is a function rather than a constant.
 */
export function buildToolDefinitions(skillIds: readonly string[] = SKILL_IDS): LlmToolDef[] {
  return LOCAL_AGENT_TOOL_DEFINITIONS.map((tool) =>
    tool.name === "load_skill"
      ? {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: { skillId: { type: "string", enum: [...skillIds] } },
          },
        }
      : tool,
  );
}

export const LOCAL_AGENT_TOOL_DEFINITIONS: LlmToolDef[] = [
  {
    name: "load_skill",
    description:
      "Load the full text of a reference document listed in the skill index. Read-only and cheap; " +
      "prefer loading the relevant skill over guessing parameters or panel capabilities.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["skillId"],
      properties: { skillId: { type: "string", enum: [...SKILL_IDS] } },
    },
  },
  {
    name: "memory_write",
    description:
      "Remember one durable fact about this user across sessions, such as a robot they usually " +
      "review, a preferred panel combination, or a term they use. Do not store one-off context " +
      "from the current task, anything the user asked you not to keep, or credentials.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  },
  {
    name: "memory_forget",
    description:
      "Delete one stored memory by id. Use this when a memory is wrong or outdated, when the user " +
      "asks you to forget something, or to free space when memory is full.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: nonEmptyString },
    },
  },
  {
    name: "memory_list",
    description:
      "List stored memories with their ids. Memories are already included in your context, so " +
      "this is only needed to confirm an id before forgetting one.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "vtd_search",
    description:
      "Search VTD records by robot, trigger type, or time. Use this before inspecting a record. " +
      "Load the vtd-query skill for the filter semantics and accepted time formats.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { ...nonEmptyString, description: "Exact record id." },
        botSn: {
          ...nonEmptyString,
          description: "Bot SN alias/suffix match. Use botSnExact for an exact SN.",
        },
        botSnExact: { ...nonEmptyString, description: "Exact Bot SN." },
        botName: { ...nonEmptyString, description: "Fuzzy bot name match." },
        triggerType: { ...nonEmptyString, description: 'Trigger type, e.g. "bms" or "nav".' },
        dataType: {
          type: "string",
          enum: ["1", "2", "3", "4"],
          description: "1=full, 2=trigger, 3=simulation, 4=collected.",
        },
        inspection: {
          type: "string",
          enum: ["0", "1", "2"],
          description: "0=not inspected, 1=passed, 2=failed.",
        },
        fixData: {
          type: "string",
          enum: ["0", "1", "2"],
          description: "0=not repaired, 1=repaired, 2=repair failed.",
        },
        start: { ...nonEmptyString, description: "Trigger-time lower bound." },
        end: { ...nonEmptyString, description: "Trigger-time upper bound." },
        at: { ...nonEmptyString, description: "Trigger time +/-5s. Overrides start and end." },
        triggerTime: { ...nonEmptyString, description: "Exact trigger time." },
        queryStart: { ...nonEmptyString, description: "Data-coverage start bound." },
        queryEnd: { ...nonEmptyString, description: "Data-coverage end bound." },
        queryTime: {
          ...nonEmptyString,
          description: "Find records whose data covers this instant.",
        },
        dataDay: {
          type: "string",
          pattern: "^[0-9]{8}$",
          description: "Data day as YYYYMMDD.",
        },
        dataTos: { ...nonEmptyString, description: "Exact TOS path." },
        orderBy: nonEmptyString,
        orderDir: { type: "string", enum: ["ASC", "DESC"] },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "vtd_trigger",
    description:
      "Look up the data records and app logs attached to one triggerId. Read-only. By default " +
      "only full and trigger data are returned; set all to include everything.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["triggerId"],
      properties: {
        triggerId: nonEmptyString,
        all: { type: "boolean" },
      },
    },
  },
  {
    name: "vtd_detail",
    description: "Get the complete metadata for one VTD record.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: nonEmptyString },
    },
  },
  {
    name: "vtd_topics",
    description: "List topic names and message counts for one VTD record.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: nonEmptyString },
    },
  },
  {
    name: "vtd_slice_store",
    description:
      "Create and store a filtered MCAP slice. This has a side effect and requires explicit user confirmation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: nonEmptyString,
        topics: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: nonEmptyString,
        },
        startNs: decimalNanoseconds,
        endNs: decimalNanoseconds,
      },
    },
  },
  {
    name: "vtd_presign",
    description:
      "Get a temporary download URL for either a complete VTD record or a stored MCAP slice.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: nonEmptyString,
        sliceId: nonEmptyString,
      },
      oneOf: [{ required: ["id"] }, { required: ["sliceId"] }],
    },
  },
  {
    name: "open_data_source",
    description:
      "Ask Lichtblick to open one or more MCAP URLs. Catalog loading completes asynchronously.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["urls"],
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1, format: "uri" },
        },
        sessionId: nonEmptyString,
      },
    },
  },
  {
    name: "get_data_catalog",
    description:
      "Read the topics and datatypes currently loaded in the Lichtblick workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "propose_layout",
    description:
      "Propose an Agent-safe Lichtblick layout for the loaded catalog. The user chooses whether to apply it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "data"],
      properties: {
        name: nonEmptyString,
        summary: { type: "string" },
        data: {
          type: "object",
          description:
            "AgentSafeLayoutData. Mosaic leaves are <panel-type>!<suffix> and exactly match configById.",
        },
      },
    },
  },
];
