// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { AgentEvent as PiAgentEvent } from "@earendil-works/pi-agent-core";

import { mapPiToolExecutionEvent, summarizeToolValue } from "./eventMapping";

type PiToolExecutionEvent = Extract<
  PiAgentEvent,
  {
    type:
      "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  }
>;

describe("mapPiToolExecutionEvent", () => {
  it("maps start and progress updates to queued and running ToolRuns", () => {
    const start: PiToolExecutionEvent = {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "vtd_detail",
      args: { id: "record-1" },
    };
    const update: PiToolExecutionEvent = {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "vtd_detail",
      args: { id: "record-1" },
      partialResult: {
        content: [{ type: "text", text: "Running vtd_detail" }],
        details: { status: "running", progress: 0.5 },
      },
    };

    expect(mapPiToolExecutionEvent(start)).toEqual({
      id: "tool-1",
      name: "vtd_detail",
      status: "queued",
    });
    expect(mapPiToolExecutionEvent(update)).toEqual({
      id: "tool-1",
      name: "vtd_detail",
      status: "running",
      progress: 0.5,
      summary: undefined,
      result: undefined,
      error: undefined,
    });
  });

  it("maps successful, failed, and cancelled end events", () => {
    const base = { toolCallId: "tool-1", toolName: "vtd_detail" };

    expect(
      mapPiToolExecutionEvent({
        ...base,
        type: "tool_execution_end",
        result: {
          content: [{ type: "text", text: '{"id":"record-1"}' }],
          details: {
            status: "succeeded",
            result: { id: "record-1" },
          },
        },
        isError: false,
      }),
    ).toEqual({
      id: "tool-1",
      name: "vtd_detail",
      status: "succeeded",
      progress: 1,
      summary: '{"id":"record-1"}',
      result: { id: "record-1" },
    });

    expect(
      mapPiToolExecutionEvent({
        ...base,
        type: "tool_execution_end",
        result: {
          content: [{ type: "text", text: "detail failed" }],
          details: {},
        },
        isError: true,
      }),
    ).toEqual({
      id: "tool-1",
      name: "vtd_detail",
      status: "failed",
      error: "detail failed",
    });

    const cancelled = {
      cancelled: true,
      reason: "User declined the operation",
    };
    expect(
      mapPiToolExecutionEvent({
        ...base,
        type: "tool_execution_end",
        result: {
          content: [{ type: "text", text: JSON.stringify(cancelled) }],
          details: { status: "cancelled", result: cancelled },
        },
        isError: false,
      }),
    ).toEqual({
      id: "tool-1",
      name: "vtd_detail",
      status: "cancelled",
      summary: "Cancelled by user",
      result: cancelled,
    });
  });

  it("uses the legacy 240-character summary bound", () => {
    const summary = summarizeToolValue("x".repeat(241));

    expect(summary).toHaveLength(240);
    expect(summary).toBe(`${"x".repeat(237)}...`);
  });
});
