// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import Anthropic, {
  APIError,
  APIConnectionError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";

import {
  type ILlmProvider,
  type LlmContentBlock,
  type LlmMessage,
  LlmProviderError,
  type LlmStopReason,
  isLlmContentBlock,
} from "./types";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_MAX_RETRIES = 2;

export type AnthropicProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  maxRetries?: number;
  /** Test seam for the SDK transport. Production callers should omit this. */
  client?: Anthropic;
};

function serialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const json = JSON.stringify(value);
  return json ?? String(value);
}

function contentBlocks(content: unknown): LlmContentBlock[] {
  return Array.isArray(content) ? content.filter(isLlmContentBlock) : [];
}

function toAnthropicMessage(message: LlmMessage): Anthropic.MessageParam {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  if (
    message.role === "assistant" &&
    message.contentFormat === "anthropic-native" &&
    Array.isArray(message.content)
  ) {
    // All SDK-native blocks are opaque history. This includes signed thinking, citations, and
    // future content block variants that this adapter does not otherwise understand.
    return {
      role: "assistant",
      content: message.content as Anthropic.ContentBlockParam[],
    };
  }

  const blocks: Anthropic.ContentBlockParam[] = contentBlocks(
    message.content,
  ).map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool-call":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      case "tool-result":
        return {
          type: "tool_result",
          tool_use_id: block.toolCallId,
          content: serialize(block.content),
          is_error: block.isError,
        };
    }
  });

  return {
    role: message.role,
    content: blocks.length > 0 ? blocks : serialize(message.content),
  };
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof APIConnectionError ||
    (error instanceof APIError &&
      error.status != undefined &&
      (error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        error.status >= 500))
  );
}

function stopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case "tool_use":
      return "tool-use";
    case "max_tokens":
      return "max-tokens";
    case "model_context_window_exceeded":
      return "context-exceeded";
    case "pause_turn":
      return "pause";
    case "refusal":
      return "refusal";
    case "end_turn":
    case "stop_sequence":
      return "end";
    case null:
      return "truncated";
    default:
      return "filtered";
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function waitBeforeRetry(
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      250 * 2 ** attempt,
    );
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AnthropicProvider implements ILlmProvider {
  public constructor(options: AnthropicProviderOptions) {
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        dangerouslyAllowBrowser: true,
        maxRetries: 0,
      });
  }

  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #maxRetries: number;

  public async stream(
    args: Parameters<ILlmProvider["stream"]>[0],
    onEvent: Parameters<ILlmProvider["stream"]>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      signal?.throwIfAborted();
      let emitted = false;
      try {
        const stream = this.#client.messages.stream(
          {
            model: args.model ?? this.#model,
            max_tokens: this.#maxTokens,
            thinking: { type: "adaptive" },
            system: args.system,
            messages: args.messages.map(toAnthropicMessage),
            tools: args.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
          },
          { signal, maxRetries: 0 },
        );

        stream.on("text", (delta) => {
          emitted = true;
          onEvent({ type: "text", delta });
        });
        const message = await stream.finalMessage();
        for (const block of message.content) {
          if (block.type === "tool_use") {
            emitted = true;
            onEvent({
              type: "tool-call",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        onEvent({
          type: "done",
          stopReason: stopReason(message.stop_reason),
          // Do not reconstruct thinking/redacted-thinking blocks: their signatures are opaque.
          finalContent: message.content,
          finalContentFormat: "anthropic-native",
        });
        return;
      } catch (error) {
        if (signal?.aborted === true || error instanceof APIUserAbortError) {
          throw abortReason(signal);
        }
        const retryable = isRetryable(error);
        if (!emitted && retryable && attempt < this.#maxRetries) {
          await waitBeforeRetry(attempt, signal);
          continue;
        }
        const status =
          typeof error === "object" &&
          error != undefined &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : undefined;
        throw new LlmProviderError(
          error instanceof Error ? error.message : "Anthropic request failed",
          "anthropic",
          retryable,
          { cause: error, status },
        );
      }
    }
    throw new LlmProviderError(
      "Anthropic retry limit exhausted",
      "anthropic",
      true,
    );
  }
}
