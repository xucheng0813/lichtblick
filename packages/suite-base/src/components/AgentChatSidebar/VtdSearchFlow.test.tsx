/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";

import { mapPiToolExecutionEvent } from "@lichtblick/suite-base/services/agent/tools/eventMapping";
import { buildPiTools } from "@lichtblick/suite-base/services/agent/tools/piTools";
import type { ToolRuntimeDeps } from "@lichtblick/suite-base/services/agent/tools/toolRuntime";
import type { ChatMessage } from "@lichtblick/suite-base/services/agent/types";
import HttpVtdClient from "@lichtblick/suite-base/services/vtd/HttpVtdClient";

import { MessageList } from "./MessageList";
import realVtdListFixture from "./__fixtures__/vtd-list-20260803.json";

const oversizedVtdListFixture = {
  ...realVtdListFixture,
  data: Array.from({ length: 22 }, (_, index) => {
    const source =
      realVtdListFixture.data[index % realVtdListFixture.data.length]!;
    return {
      ...source,
      data_topic_info: `${source.data_topic_info}${"x".repeat(14_000)}`,
      id: 900_000 + index,
    };
  }),
  page_size: 100,
};

jest.mock("react-i18next", () => ({
  useTranslation: jest.fn(),
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

jest.mock("./ToolRunGroup", () => ({
  ToolRunGroup: () => <div data-testid="tool-run-group" />,
}));

function jsonResponse(value: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let consumed = false;
  return {
    body: {
      getReader: () => ({
        read: jest.fn(async () => {
          if (consumed) {
            return { done: true, value: undefined };
          }
          consumed = true;
          return { done: false, value: bytes };
        }),
        releaseLock: jest.fn(),
      }),
    },
    headers: { get: jest.fn().mockReturnValue(undefined) },
    ok: true,
    status: 200,
    statusText: "OK",
  } as unknown as Response;
}

function makeDeps(vtdClient: HttpVtdClient): ToolRuntimeDeps {
  return {
    emitLayoutProposal: jest.fn(),
    emitOpenDataSource: jest.fn(),
    getCatalog: jest.fn().mockReturnValue({ datatypes: new Map(), topics: [] }),
    getInstalledPanelTypes: jest.fn().mockReturnValue(new Set()),
    skills: [],
    vtdClient,
  };
}

describe("VTD search result flow", () => {
  beforeEach(() => {
    (useTranslation as jest.Mock).mockReturnValue({ t: (key: string) => key });
  });

  it.each([
    {
      expectedRecords: 3,
      expectedVisibleId: "867723",
      fixture: realVtdListFixture,
      label: "complete AgentToolResult",
      params: {
        botSnExact: "8010006BHQ26E8A0078",
        dataDay: "20260803",
      },
    },
    {
      expectedRecords: 22,
      expectedVisibleId: "900000",
      fixture: oversizedVtdListFixture,
      label: "oversized all-records page",
      params: {
        botSnExact: "8010006BHQ26E8A0078",
        dataDay: "20260803",
        pageSize: 100,
      },
    },
  ])(
    "renders a real-shape sidecar response through HttpVtdClient, piTools, eventMapping, and MessageList ($label)",
    async ({ expectedRecords, expectedVisibleId, fixture, params }) => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(fixture));
      const vtdClient = new HttpVtdClient(
        "http://localhost:8770",
        fetchImpl as typeof fetch,
      );
      const tool = buildPiTools(makeDeps(vtdClient), [], {
        requestConfirmation: jest.fn(),
      }).find((candidate) => candidate.name === "vtd_search");
      if (tool == undefined) {
        throw new Error("Expected vtd_search pi tool");
      }

      const executed = await tool.execute("vtd-search-1", params);
      const toolRun = mapPiToolExecutionEvent({
        type: "tool_execution_end",
        isError: false,
        result: executed,
        toolCallId: "vtd-search-1",
        toolName: "vtd_search",
      });
      const message: ChatMessage = {
        content: "结果已在列表卡片中展示",
        createdAt: "2026-08-05T00:00:00.000Z",
        id: "assistant-vtd-search",
        role: "assistant",
        toolRuns: [toolRun],
      };

      render(
        <MessageList
          messages={[message]}
          onLoadVtdRecord={jest.fn().mockResolvedValue(undefined)}
        />,
      );

      expect(fetchImpl).toHaveBeenCalledWith(
        new URL("http://localhost:8770/vtd/list"),
        expect.objectContaining({
          body: JSON.stringify(params),
          method: "POST",
        }),
      );
      expect(toolRun.result).toMatchObject({
        records: expect.any(Array),
        total: 22,
      });
      expect((toolRun.result as { records: unknown[] }).records).toHaveLength(
        expectedRecords,
      );
      expect(toolRun.result).toEqual(
        expect.objectContaining({
          records: expect.arrayContaining([
            expect.objectContaining({ dataType: expect.any(String) }),
          ]),
        }),
      );
      expect(screen.getByTestId("vtd-record-list-card")).toBeInTheDocument();
      expect(screen.getAllByTestId("vtd-record-row")).toHaveLength(
        Math.min(expectedRecords, 10),
      );
      expect(screen.getByText(expectedVisibleId)).toBeInTheDocument();
    },
  );
});
