// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { LlmToolDef } from "./types";

const nonEmptyString = { type: "string", minLength: 1 } as const;
const decimalNanoseconds = {
  type: "string",
  pattern: "^[0-9]+$",
  description:
    "Decimal nanoseconds encoded as a string to avoid precision loss.",
} as const;

export const LOCAL_AGENT_TOOL_DEFINITIONS: LlmToolDef[] = [
  {
    name: "vtd_search",
    description:
      "Search VTD records by robot, trigger type, or time. Use this before inspecting a record.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        botSn: nonEmptyString,
        botName: nonEmptyString,
        triggerType: nonEmptyString,
        start: nonEmptyString,
        end: nonEmptyString,
        at: nonEmptyString,
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
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
