/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";

import { ChatMessage } from "@lichtblick/suite-base/services/agent/types";

import { MessageList } from "./MessageList";

const mockMarkdownRender = jest.fn(
  (props: { children?: React.ReactNode }) => <>{props.children}</>,
);

jest.mock("react-i18next", () => ({
  useTranslation: jest.fn(),
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: (props: { children?: React.ReactNode }) => mockMarkdownRender(props),
}));

describe("MessageList", () => {
  beforeEach(() => {
    mockMarkdownRender.mockClear();
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
      <MessageList messages={[firstMessage, streamingMessage]} />,
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
      />,
    );

    expect(mockMarkdownRender).toHaveBeenCalledTimes(3);
    expect(mockMarkdownRender.mock.calls[2]?.[0].children).toBe("Partial response");
  });

  it("anchors expanded history across appends and resets when the anchor disappears", () => {
    const messages: ChatMessage[] = Array.from({ length: 105 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant",
      content: `Message ${index}`,
      createdAt: "2026-07-27T00:00:00.000Z",
    }));

    const { rerender } = render(<MessageList messages={messages} />);

    expect(screen.getAllByRole("article")).toHaveLength(100);
    expect(screen.queryByText("Message 0")).not.toBeInTheDocument();
    expect(mockMarkdownRender).toHaveBeenCalledTimes(100);

    fireEvent.click(screen.getByRole("button", { name: "showEarlierMessages" }));

    expect(screen.getAllByRole("article")).toHaveLength(105);
    expect(screen.getByText("Message 0")).toBeInTheDocument();
    expect(mockMarkdownRender).toHaveBeenCalledTimes(105);

    const appendedMessage: ChatMessage = {
      id: "message-105",
      role: "assistant",
      content: "Message 105",
      createdAt: "2026-07-27T00:00:01.000Z",
    };
    rerender(<MessageList messages={[...messages, appendedMessage]} />);

    expect(screen.getAllByRole("article")).toHaveLength(106);
    expect(screen.getByText("Message 0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "showEarlierMessages" })).not.toBeInTheDocument();

    const resetMessages: ChatMessage[] = Array.from({ length: 150 }, (_, index) => ({
      id: `reset-message-${index}`,
      role: "assistant",
      content: `Reset message ${index}`,
      createdAt: "2026-07-27T00:01:00.000Z",
    }));
    rerender(<MessageList messages={resetMessages} />);

    expect(screen.getAllByRole("article")).toHaveLength(100);
    expect(screen.queryByText("Reset message 0")).not.toBeInTheDocument();
    expect(screen.getByText("Reset message 50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "showEarlierMessages" })).toBeInTheDocument();
  });
});
