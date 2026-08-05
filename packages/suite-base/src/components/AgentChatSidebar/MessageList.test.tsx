/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useTranslation } from "react-i18next";

import { useAgentChat } from "@lichtblick/suite-base/context/AgentChatContext";
import { ChatMessage } from "@lichtblick/suite-base/services/agent/types";

import { MessageList } from "./MessageList";

const mockMarkdownRender = jest.fn((props: { children?: React.ReactNode }) => (
  <>{props.children}</>
));
const onLoadVtdRecord = jest.fn().mockResolvedValue(undefined);
const sendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock("react-i18next", () => ({
  useTranslation: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/context/AgentChatContext", () => ({
  useAgentChat: jest.fn(),
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: (props: { children?: React.ReactNode }) => mockMarkdownRender(props),
}));

jest.mock("./ToolRunGroup", () => ({
  ToolRunGroup: ({
    toolRuns,
  }: {
    toolRuns: { id: string; name: string }[];
  }) => (
    <div data-testid="tool-run-group">
      {toolRuns.map((toolRun) => (
        <div key={toolRun.id} data-testid="tool-run-card">
          {toolRun.name}
        </div>
      ))}
    </div>
  ),
}));

describe("MessageList", () => {
  beforeEach(() => {
    mockMarkdownRender.mockClear();
    onLoadVtdRecord.mockClear();
    sendMessage.mockClear();
    (useAgentChat as jest.Mock).mockImplementation(
      (
        selector: (state: {
          actions: { sendMessage: typeof sendMessage };
        }) => unknown,
      ) => selector({ actions: { sendMessage } }),
    );
    (useTranslation as jest.Mock).mockReturnValue({
      t: (key: string) => key,
    });
  });

  it("rerenders only the changed streaming message", () => {
    const firstMessage: ChatMessage = {
      id: "message-1",
      role: "assistant",
      content: "Completed history",
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    const streamingMessage: ChatMessage = {
      id: "message-2",
      role: "assistant",
      content: "Partial",
      createdAt: "2026-07-27T00:00:01.000Z",
    };

    const { rerender } = render(
      <MessageList
        messages={[firstMessage, streamingMessage]}
        onLoadVtdRecord={onLoadVtdRecord}
      />,
    );
    expect(mockMarkdownRender).toHaveBeenCalledTimes(2);

    rerender(
      <MessageList
        messages={[
          firstMessage,
          {
            ...streamingMessage,
            content: "Partial response",
          },
        ]}
        onLoadVtdRecord={onLoadVtdRecord}
      />,
    );

    expect(mockMarkdownRender).toHaveBeenCalledTimes(3);
    expect(mockMarkdownRender.mock.calls[2]?.[0].children).toBe(
      "Partial response",
    );
  });

  it("anchors expanded history across appends and resets when the anchor disappears", () => {
    const messages: ChatMessage[] = Array.from({ length: 105 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant",
      content: `Message ${index}`,
      createdAt: "2026-07-27T00:00:00.000Z",
    }));

    const { rerender } = render(
      <MessageList messages={messages} onLoadVtdRecord={onLoadVtdRecord} />,
    );

    expect(screen.getAllByRole("article")).toHaveLength(100);
    expect(screen.queryByText("Message 0")).not.toBeInTheDocument();
    expect(mockMarkdownRender).toHaveBeenCalledTimes(100);

    fireEvent.click(
      screen.getByRole("button", { name: "showEarlierMessages" }),
    );

    expect(screen.getAllByRole("article")).toHaveLength(105);
    expect(screen.getByText("Message 0")).toBeInTheDocument();
    expect(mockMarkdownRender).toHaveBeenCalledTimes(105);

    const appendedMessage: ChatMessage = {
      id: "message-105",
      role: "assistant",
      content: "Message 105",
      createdAt: "2026-07-27T00:00:01.000Z",
    };
    rerender(
      <MessageList
        messages={[...messages, appendedMessage]}
        onLoadVtdRecord={onLoadVtdRecord}
      />,
    );

    expect(screen.getAllByRole("article")).toHaveLength(106);
    expect(screen.getByText("Message 0")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "showEarlierMessages" }),
    ).not.toBeInTheDocument();

    const resetMessages: ChatMessage[] = Array.from(
      { length: 150 },
      (_, index) => ({
        id: `reset-message-${index}`,
        role: "assistant",
        content: `Reset message ${index}`,
        createdAt: "2026-07-27T00:01:00.000Z",
      }),
    );
    rerender(
      <MessageList
        messages={resetMessages}
        onLoadVtdRecord={onLoadVtdRecord}
      />,
    );

    expect(screen.getAllByRole("article")).toHaveLength(100);
    expect(screen.queryByText("Reset message 0")).not.toBeInTheDocument();
    expect(screen.getByText("Reset message 50")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "showEarlierMessages" }),
    ).toBeInTheDocument();
  });

  it("renders all tool runs for one message inside a single execution group", () => {
    const message: ChatMessage = {
      id: "message-tools",
      role: "assistant",
      content: "Used two tools",
      createdAt: "2026-08-04T00:00:00.000Z",
      toolRuns: [
        { id: "tool-skill", name: "load_skill", status: "succeeded" },
        { id: "tool-search", name: "vtd_search", status: "running" },
      ],
    };

    render(
      <MessageList messages={[message]} onLoadVtdRecord={onLoadVtdRecord} />,
    );

    const group = screen.getByTestId("tool-run-group");
    expect(screen.getAllByTestId("tool-run-group")).toHaveLength(1);
    expect(within(group).getAllByTestId("tool-run-card")).toHaveLength(2);
    expect(within(group).getByText("load_skill")).toBeInTheDocument();
    expect(within(group).getByText("vtd_search")).toBeInTheDocument();
  });

  it("hides in-progress assistant content after a tool run starts", () => {
    const message: ChatMessage = {
      id: "message-processing",
      role: "assistant",
      content: "Fragmented intermediate response",
      createdAt: "2026-08-04T00:00:00.000Z",
      toolRuns: [{ id: "tool-running", name: "vtd_search", status: "running" }],
    };

    render(
      <MessageList
        messages={[message]}
        onLoadVtdRecord={onLoadVtdRecord}
        status="streaming"
      />,
    );

    const article = screen.getByRole("article");
    const toolGroup = within(article).getByTestId("tool-run-group");
    const processing = within(article).getByTestId("agent-chat-processing");
    expect(processing).toHaveTextContent("processing");
    expect(
      within(article).queryByText("Fragmented intermediate response"),
    ).not.toBeInTheDocument();
    expect(toolGroup.nextElementSibling).toBe(processing);
  });

  it("keeps streaming an in-progress assistant message before any tool run starts", () => {
    const message: ChatMessage = {
      id: "message-text-stream",
      role: "assistant",
      content: "Streaming text response",
      createdAt: "2026-08-04T00:00:00.000Z",
    };

    render(
      <MessageList
        messages={[message]}
        onLoadVtdRecord={onLoadVtdRecord}
        status="streaming"
      />,
    );

    expect(screen.getByText("Streaming text response")).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-chat-processing"),
    ).not.toBeInTheDocument();
  });

  it("reveals the full assistant response when the tool-assisted turn completes", () => {
    const message: ChatMessage = {
      id: "message-complete",
      role: "assistant",
      content: "Final complete response",
      createdAt: "2026-08-04T00:00:00.000Z",
      toolRuns: [
        { id: "tool-complete", name: "vtd_search", status: "succeeded" },
      ],
    };

    render(
      <MessageList
        messages={[message]}
        onLoadVtdRecord={onLoadVtdRecord}
        status="idle"
      />,
    );

    expect(screen.getByText("Final complete response")).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-chat-processing"),
    ).not.toBeInTheDocument();
  });

  it("leaves historical tool-assisted messages visible during a later tool run", () => {
    const historicalMessage: ChatMessage = {
      id: "message-history",
      role: "assistant",
      content: "Historical final response",
      createdAt: "2026-08-04T00:00:00.000Z",
      toolRuns: [
        { id: "tool-history", name: "vtd_search", status: "succeeded" },
      ],
    };
    const activeMessage: ChatMessage = {
      id: "message-active",
      role: "assistant",
      content: "Active fragmented response",
      createdAt: "2026-08-04T00:00:01.000Z",
      toolRuns: [{ id: "tool-active", name: "vtd_search", status: "running" }],
    };

    render(
      <MessageList
        messages={[historicalMessage, activeMessage]}
        onLoadVtdRecord={onLoadVtdRecord}
        status="streaming"
      />,
    );

    expect(screen.getByText("Historical final response")).toBeInTheDocument();
    expect(
      screen.queryByText("Active fragmented response"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId("agent-chat-processing")).toHaveLength(1);
  });

  it("merges VTD results under the last result message with later duplicates winning", () => {
    const messages: ChatMessage[] = [
      {
        id: "message-first-vtd",
        role: "assistant",
        content: "First page",
        createdAt: "2026-08-04T00:00:00.000Z",
        toolRuns: [
          {
            id: "tool-first-vtd",
            name: "vtd_search",
            status: "succeeded",
            result: {
              records: [
                { id: "duplicate", botName: "Old robot" },
                { id: "first-only" },
              ],
            },
          },
        ],
      },
      {
        id: "message-other",
        role: "assistant",
        content: "Intermediate tool",
        createdAt: "2026-08-04T00:00:01.000Z",
        toolRuns: [
          {
            id: "tool-other",
            name: "other_tool",
            status: "succeeded",
          },
        ],
      },
      {
        id: "message-last-vtd",
        role: "assistant",
        content: "Second page",
        createdAt: "2026-08-04T00:00:02.000Z",
        toolRuns: [
          {
            id: "tool-last-vtd",
            name: "vtd_search",
            status: "succeeded",
            result: {
              records: [
                { id: "duplicate", botName: "New robot" },
                { id: "last-only" },
              ],
            },
          },
        ],
      },
    ];

    render(
      <MessageList messages={messages} onLoadVtdRecord={onLoadVtdRecord} />,
    );

    expect(screen.getAllByTestId("tool-run-card")).toHaveLength(3);
    expect(screen.getAllByTestId("tool-run-group")).toHaveLength(3);
    expect(screen.getAllByTestId("vtd-record-list-card")).toHaveLength(1);
    expect(
      within(
        screen.getByTestId("agent-chat-message-message-first-vtd"),
      ).queryByTestId("vtd-record-list-card"),
    ).not.toBeInTheDocument();
    const lastMessage = screen.getByTestId(
      "agent-chat-message-message-last-vtd",
    );
    const lastToolRunGroup = within(lastMessage).getByTestId("tool-run-group");
    expect(
      within(lastMessage).getByTestId("vtd-record-list-card"),
    ).toBeInTheDocument();
    expect(
      within(lastToolRunGroup).queryByTestId("vtd-record-list-card"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId("vtd-record-row")).toHaveLength(3);
    expect(screen.queryByText("Old robot")).not.toBeInTheDocument();
    expect(screen.getByText("New robot")).toBeInTheDocument();
  });

  it("ignores non-VTD and malformed structured tool results", () => {
    const message: ChatMessage = {
      id: "message-invalid",
      role: "assistant",
      content: "No structured result",
      createdAt: "2026-08-04T00:00:00.000Z",
      toolRuns: [
        {
          id: "tool-other",
          name: "other_tool",
          status: "succeeded",
          result: { records: [{ id: "other-record" }] },
        },
        {
          id: "tool-invalid-vtd",
          name: "vtd_search",
          status: "succeeded",
          result: { records: "not-an-array" },
        },
      ],
    };

    render(
      <MessageList messages={[message]} onLoadVtdRecord={onLoadVtdRecord} />,
    );

    expect(screen.getAllByTestId("tool-run-card")).toHaveLength(2);
    expect(screen.queryByText("other-record")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "loadData" }),
    ).not.toBeInTheDocument();
  });
});
