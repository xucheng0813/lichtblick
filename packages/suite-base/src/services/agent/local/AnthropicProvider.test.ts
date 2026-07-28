// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError, APIError } from "@anthropic-ai/sdk";

import { AnthropicProvider } from "./AnthropicProvider";
import type { LlmStreamEvent } from "./types";

describe("AnthropicProvider", () => {
  it("uses adaptive thinking and translates text, tool calls, and tool results", async () => {
    const onText = jest.fn();
    const finalMessage = jest.fn().mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "tool-2",
          name: "vtd_detail",
          input: { id: "vtd-1" },
        },
      ],
      stop_reason: "tool_use",
    });
    const streamResult = {
      on: jest.fn((event: string, callback: (delta: string) => void): void => {
        if (event === "text") {
          onText(callback);
          callback("Found it.");
        }
      }),
      finalMessage,
    };
    const stream = jest.fn().mockReturnValue(streamResult);
    const client = { messages: { stream } };
    const provider = new AnthropicProvider({
      apiKey: "key",
      client: client as unknown as Anthropic,
    });
    const events: LlmStreamEvent[] = [];

    await provider.stream(
      {
        system: "system",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "tool-1",
                name: "vtd_search",
                input: { botSn: "SN1" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "tool-1",
                content: { records: [] },
              },
            ],
          },
        ],
        tools: [
          {
            name: "vtd_detail",
            description: "detail",
            inputSchema: { type: "object" },
          },
        ],
      },
      (event) => events.push(event),
    );

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-4-8",
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "vtd_search",
                input: { botSn: "SN1" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: '{"records":[]}',
                is_error: undefined,
              },
            ],
          },
        ],
      }),
      { signal: undefined, maxRetries: 0 },
    );
    expect(onText).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "text", delta: "Found it." },
      {
        type: "tool-call",
        id: "tool-2",
        name: "vtd_detail",
        input: { id: "vtd-1" },
      },
      {
        type: "done",
        stopReason: "tool-use",
        finalContentFormat: "anthropic-native",
        finalContent: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "vtd_detail",
            input: { id: "vtd-1" },
          },
        ],
      },
    ]);
  });

  it("round-trips signed thinking blocks and multi-result error state without reconstruction", async () => {
    const nativeContent = [
      {
        type: "thinking",
        thinking: "private reasoning",
        signature: "signed-value",
      },
      { type: "redacted_thinking", data: "opaque-redacted-value" },
      {
        type: "tool_use",
        id: "tool-a",
        name: "vtd_detail",
        input: { id: "a" },
      },
      {
        type: "tool_use",
        id: "tool-b",
        name: "vtd_topics",
        input: { id: "b" },
      },
    ];
    const stream = jest
      .fn()
      .mockReturnValueOnce({
        on: jest.fn(),
        finalMessage: jest.fn().mockResolvedValue({
          content: nativeContent,
          stop_reason: "tool_use",
        }),
      })
      .mockReturnValueOnce({
        on: jest.fn(),
        finalMessage: jest.fn().mockResolvedValue({
          content: [{ type: "text", text: "done", citations: null }],
          stop_reason: "end_turn",
        }),
      });
    const provider = new AnthropicProvider({
      apiKey: "key",
      client: { messages: { stream } } as unknown as Anthropic,
    });
    const firstEvents: LlmStreamEvent[] = [];
    await provider.stream(
      {
        system: "",
        messages: [{ role: "user", content: "inspect" }],
        tools: [],
      },
      (event) => firstEvents.push(event),
    );
    const finalContent = firstEvents.find(
      (event) => event.type === "done",
    )!.finalContent;

    await provider.stream(
      {
        system: "",
        messages: [
          {
            role: "assistant",
            content: finalContent,
            contentFormat: "anthropic-native",
          },
          {
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "tool-a",
                content: { ok: true },
              },
              {
                type: "tool-result",
                toolCallId: "tool-b",
                content: { error: "missing" },
                isError: true,
              },
            ],
          },
        ],
        tools: [],
      },
      jest.fn(),
    );

    expect(stream.mock.calls[1]?.[0].messages).toEqual([
      { role: "assistant", content: nativeContent },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-a",
            content: '{"ok":true}',
            is_error: undefined,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-b",
            content: '{"error":"missing"}',
            is_error: true,
          },
        ],
      },
    ]);
  });

  it("round-trips text-only citations and unknown native blocks exactly", async () => {
    const nativeContent = [
      {
        type: "text",
        text: "cited",
        citations: [{ type: "char_location", start_char_index: 0 }],
      },
      { type: "future_opaque_block", opaque: { signed: "value" } },
    ];
    const stream = jest.fn().mockReturnValue({
      on: jest.fn(),
      finalMessage: jest
        .fn()
        .mockResolvedValue({ content: nativeContent, stop_reason: "end_turn" }),
    });
    const provider = new AnthropicProvider({
      apiKey: "key",
      client: { messages: { stream } } as unknown as Anthropic,
    });
    const events: LlmStreamEvent[] = [];
    await provider.stream({ system: "", messages: [], tools: [] }, (event) =>
      events.push(event),
    );
    const done = events.find((event) => event.type === "done")!;

    await provider.stream(
      {
        system: "",
        messages: [
          {
            role: "assistant",
            content: done.finalContent,
            contentFormat: done.finalContentFormat,
          },
        ],
        tools: [],
      },
      jest.fn(),
    );

    expect(stream.mock.calls[1]?.[0].messages).toEqual([
      { role: "assistant", content: nativeContent },
    ]);
  });

  it.each([
    ["end_turn", "end"],
    ["stop_sequence", "end"],
    ["tool_use", "tool-use"],
    ["max_tokens", "max-tokens"],
    ["model_context_window_exceeded", "context-exceeded"],
    ["pause_turn", "pause"],
    ["refusal", "refusal"],
    ["future_safety_stop", "filtered"],
    [null, "truncated"],
  ] as const)(
    "maps Anthropic stop reason %s to %s",
    async (sdkReason, expected) => {
      const provider = new AnthropicProvider({
        apiKey: "key",
        client: {
          messages: {
            stream: jest.fn().mockReturnValue({
              on: jest.fn(),
              finalMessage: jest
                .fn()
                .mockResolvedValue({ content: [], stop_reason: sdkReason }),
            }),
          },
        } as unknown as Anthropic,
      });
      const events: LlmStreamEvent[] = [];

      await provider.stream({ system: "", messages: [], tools: [] }, (event) =>
        events.push(event),
      );

      expect(events.at(-1)).toEqual({
        type: "done",
        stopReason: expected,
        finalContent: [],
        finalContentFormat: "anthropic-native",
      });
    },
  );

  it("classifies SDK connection errors as retryable", async () => {
    const stream = jest.fn(() => {
      throw new APIConnectionError({ message: "offline" });
    });
    const provider = new AnthropicProvider({
      apiKey: "key",
      maxRetries: 0,
      client: { messages: { stream } } as unknown as Anthropic,
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toMatchObject({
      name: "LlmProviderError",
      provider: "anthropic",
      retryable: true,
    });
  });

  it.each([408, 409, 429, 500, 503])(
    "retries typed SDK status %i errors",
    async (status) => {
      jest.useFakeTimers();
      const stream = jest
        .fn()
        .mockImplementationOnce(() => {
          throw APIError.generate(
            status,
            { error: { message: "retry", type: "api_error" } },
            "retry",
            new Headers(),
          );
        })
        .mockReturnValueOnce({
          on: jest.fn(),
          finalMessage: jest
            .fn()
            .mockResolvedValue({ content: [], stop_reason: "end_turn" }),
        });
      const provider = new AnthropicProvider({
        apiKey: "key",
        maxRetries: 1,
        client: { messages: { stream } } as unknown as Anthropic,
      });

      const result = provider.stream(
        { system: "", messages: [], tools: [] },
        jest.fn(),
      );
      await jest.runAllTimersAsync();
      await expect(result).resolves.toBeUndefined();
      expect(stream).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    },
  );

  it("does not retry after emitting partial content", async () => {
    const error = APIError.generate(
      409,
      { error: { message: "conflict", type: "api_error" } },
      "conflict",
      new Headers(),
    );
    const stream = jest.fn().mockReturnValue({
      on: jest.fn((_event: string, callback: (delta: string) => void) => {
        callback("partial");
      }),
      finalMessage: jest.fn().mockRejectedValue(error),
    });
    const provider = new AnthropicProvider({
      apiKey: "key",
      maxRetries: 2,
      client: { messages: { stream } } as unknown as Anthropic,
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toMatchObject({ retryable: true, status: 409 });
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
