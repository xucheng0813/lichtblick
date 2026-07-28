// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  OPENAI_MAX_RESPONSE_BYTES,
  OPENAI_MAX_TOOL_CALLS,
  OpenAICompatProvider,
} from "./OpenAICompatProvider";
import type { LlmStreamEvent } from "./types";

function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("OpenAICompatProvider", () => {
  it("parses chunked text and incremental function calls", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Found "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"one","tool_calls":[{"index":0,"id":"call-1","function":{"name":"vtd_","arguments":"{\\"id\\":"}}]}}]}\n',
          '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"detail","arguments":"\\"vtd-1\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      baseUrl: "https://llm.example/v1/",
      model: "model-a",
      fetch,
    });
    const events: LlmStreamEvent[] = [];

    await provider.stream(
      {
        system: "system",
        messages: [{ role: "user", content: "find it" }],
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

    expect(fetch).toHaveBeenCalledWith(
      "https://llm.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "Found " },
      { type: "text", delta: "one" },
      {
        type: "tool-call",
        id: "call-1",
        name: "vtd_detail",
        input: { id: "vtd-1" },
      },
      {
        type: "done",
        stopReason: "tool-use",
        finalContentFormat: "provider-neutral",
        finalContent: [
          { type: "text", text: "Found one" },
          {
            type: "tool-call",
            id: "call-1",
            name: "vtd_detail",
            input: { id: "vtd-1" },
          },
        ],
      },
    ]);
  });

  it("recognizes streamed error envelopes", async () => {
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([
            'data: {"error":{"message":"rate limited","status":429,"type":"rate_limit_error"}}\n\n',
          ]),
        ),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toMatchObject({
      name: "LlmProviderError",
      message: "rate limited",
      status: 429,
      retryable: true,
    });
  });

  it("assembles parallel calls by index, preserves split ids, and accepts CR separators", async () => {
    const events: LlmStreamEvent[] = [];
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call-","function":{"name":"vtd_","arguments":"{\\"id\\":\\"b\\"}"}},{"index":0,"id":"first","function":{"name":"vtd_detail","arguments":"{\\"id\\":\\"a\\"}"}}]}}]}\r\r',
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"2","function":{"name":"topics"}}]},"finish_reason":"tool_calls"}]}\r\r',
            "data: [DONE]\r\r",
          ]),
        ),
    });

    await provider.stream({ system: "", messages: [], tools: [] }, (event) =>
      events.push(event),
    );

    expect(events.filter((event) => event.type === "tool-call")).toEqual([
      {
        type: "tool-call",
        id: "first",
        name: "vtd_detail",
        input: { id: "a" },
      },
      {
        type: "tool-call",
        id: "call-2",
        name: "vtd_topics",
        input: { id: "b" },
      },
    ]);
  });

  it("rejects multiple streamed choices instead of merging them", async () => {
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"a"}},{"index":1,"delta":{"content":"b"}}]}\n\n',
          ]),
        ),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toThrow("exactly one choice");
  });

  it("cancels and releases the reader after DONE", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const releaseLock = jest.fn();
    const read = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      })
      .mockResolvedValue({ done: true, value: undefined });
    const response = {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      fetch: jest.fn().mockResolvedValue(response),
    });

    await provider.stream({ system: "", messages: [], tools: [] }, jest.fn());

    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("budgets individual frames rather than the transport chunk", async () => {
    const content = "x".repeat(400_000);
    const chunk = [content, content, content]
      .map(
        (part) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`,
      )
      .join("");
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([
            chunk,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        ),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).resolves.toBeUndefined();
  });

  it("rejects a single SSE frame larger than 1 MiB", async () => {
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([`data: ${"x".repeat(1024 * 1024)}\n\n`]),
        ),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toThrow("exceeds 1 MiB");
  });

  it("classifies a non-retryable HTTP response", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(new Response("invalid key", { status: 401 }));
    const provider = new OpenAICompatProvider({
      apiKey: "bad",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch,
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toMatchObject({
      name: "LlmProviderError",
      provider: "openai-compatible",
      retryable: false,
      status: 401,
    });
  });

  it("rejects a stream that closes without a finish reason", async () => {
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          ]),
        ),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toMatchObject({
      name: "LlmProviderError",
      retryable: true,
      message: expect.stringContaining("finish_reason"),
    });
  });

  it("rejects [DONE] when no finish_reason was received", async () => {
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        ),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toMatchObject({
      name: "LlmProviderError",
      retryable: true,
      message: expect.stringContaining("[DONE] without a finish_reason"),
    });
  });

  it.each([
    ["stop", "end"],
    ["tool_calls", "tool-use"],
    ["length", "max-tokens"],
    ["content_filter", "filtered"],
    ["refusal", "refusal"],
    ["context_length_exceeded", "context-exceeded"],
    ["unknown_reason", "filtered"],
  ] as const)("maps finish_reason %s to %s", async (finishReason, expected) => {
    const events: LlmStreamEvent[] = [];
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      fetch: jest.fn().mockResolvedValue(
        streamResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: finishReason }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      ),
    });

    await provider.stream({ system: "", messages: [], tools: [] }, (event) =>
      events.push(event),
    );

    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: expected,
      finalContent: [],
      finalContentFormat: "provider-neutral",
    });
  });

  it("caps non-200 response bodies at 64 KiB", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const releaseLock = jest.fn();
    const read = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode("sensitive".repeat(100_000)),
      })
      .mockResolvedValue({ done: true, value: undefined });
    const response = {
      ok: false,
      status: 500,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest.fn().mockResolvedValue(response),
    });

    let caught: unknown;
    try {
      await provider.stream({ system: "", messages: [], tools: [] }, jest.fn());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 500 });
    expect((caught as Error).message.length).toBeLessThan(66_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("rejects responses whose cumulative bytes exceed 32 MiB", async () => {
    const frame = new TextEncoder().encode(`:${"x".repeat(999_996)}\n\n`);
    let reads = 0;
    const cancel = jest.fn().mockResolvedValue(undefined);
    const releaseLock = jest.fn();
    const response = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: jest.fn(async () => {
            reads++;
            return { done: false, value: frame };
          }),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response;
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest.fn().mockResolvedValue(response),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toThrow(`${OPENAI_MAX_RESPONSE_BYTES} bytes`);
    expect(reads).toBeGreaterThan(32);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("caps the number of accumulated tool calls", async () => {
    const toolCalls = Array.from(
      { length: OPENAI_MAX_TOOL_CALLS + 1 },
      (_, index) => ({
        index,
        id: `call-${index}`,
        function: { name: "vtd_detail", arguments: "{}" },
      }),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "key",
      baseUrl: "https://llm.example/v1",
      model: "model-a",
      maxRetries: 0,
      fetch: jest
        .fn()
        .mockResolvedValue(
          streamResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] })}\n\n`,
          ]),
        ),
    });

    await expect(
      provider.stream({ system: "", messages: [], tools: [] }, jest.fn()),
    ).rejects.toThrow(`${OPENAI_MAX_TOOL_CALLS} tool calls`);
  });
});
