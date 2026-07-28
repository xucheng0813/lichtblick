// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  type ILlmProvider,
  type LlmContentBlock,
  type LlmMessage,
  LlmProviderError,
  type LlmStopReason,
  isLlmContentBlock,
} from "./types";

export const OPENAI_MAX_SSE_FRAME_BYTES = 1024 * 1024;
export const OPENAI_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const OPENAI_MAX_ERROR_BODY_BYTES = 64 * 1024;
export const OPENAI_MAX_TOOL_CALLS = 1024;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 16_000;

export type OpenAICompatProviderOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
};

type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

function serialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function blocks(content: unknown): LlmContentBlock[] {
  return Array.isArray(content) ? content.filter(isLlmContentBlock) : [];
}

function toOpenAIMessages(message: LlmMessage): Record<string, unknown>[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }

  const messageBlocks = blocks(message.content);
  if (message.role === "assistant") {
    const text = messageBlocks
      .filter(
        (block): block is Extract<LlmContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    const toolCalls = messageBlocks
      .filter(
        (block): block is Extract<LlmContentBlock, { type: "tool-call" }> =>
          block.type === "tool-call",
      )
      .map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: serialize(block.input) },
      }));
    return [
      {
        role: "assistant",
        content: text.length > 0 ? text : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
    ];
  }

  const result: Record<string, unknown>[] = [];
  const text = messageBlocks
    .filter(
      (block): block is Extract<LlmContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  if (text.length > 0) {
    result.push({ role: "user", content: text });
  }
  for (const block of messageBlocks) {
    if (block.type === "tool-result") {
      result.push({
        role: "tool",
        tool_call_id: block.toolCallId,
        content: serialize(block.content),
      });
    }
  }
  return result.length > 0
    ? result
    : [{ role: "user", content: serialize(message.content) }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value != undefined && !Array.isArray(value)
  );
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function retryDelay(
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

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function appendStreamFragment(current: string, fragment: string): string {
  if (fragment.length === 0 || current.endsWith(fragment)) {
    return current;
  }
  if (fragment.startsWith(current)) {
    return fragment;
  }
  return current + fragment;
}

function mapStopReason(reason: string): LlmStopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool-use";
    case "length":
      return "max-tokens";
    case "content_filter":
      return "filtered";
    case "refusal":
      return "refusal";
    case "stop":
      return "end";
    default:
      return reason.includes("context") ? "context-exceeded" : "filtered";
  }
}

function errorEnvelope(
  parsed: Record<string, unknown>,
): LlmProviderError | undefined {
  if (!isRecord(parsed.error)) {
    return undefined;
  }
  const status =
    typeof parsed.error.status === "number" &&
    Number.isSafeInteger(parsed.error.status)
      ? parsed.error.status
      : undefined;
  const message =
    typeof parsed.error.message === "string"
      ? parsed.error.message.slice(0, 64 * 1024)
      : "OpenAI-compatible endpoint emitted an error";
  return new LlmProviderError(
    message,
    "openai-compatible",
    status != undefined && retryableStatus(status),
    {
      status,
    },
  );
}

async function readResponseBodyLimited(
  response: Response,
  limit: number,
): Promise<string> {
  if (response.body == undefined) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < limit) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const remaining = limit - bytes;
      const value = chunk.value.subarray(0, remaining);
      chunks.push(value);
      bytes += value.byteLength;
      if (chunk.value.byteLength > remaining) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export class OpenAICompatProvider implements ILlmProvider {
  public constructor(options: OpenAICompatProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#model = options.model;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;

  public async stream(
    args: Parameters<ILlmProvider["stream"]>[0],
    onEvent: Parameters<ILlmProvider["stream"]>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      signal?.throwIfAborted();
      let emitted = false;
      try {
        const response = await this.#fetch(
          `${this.#baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: args.model ?? this.#model,
              max_tokens: this.#maxTokens,
              stream: true,
              messages: [
                { role: "system", content: args.system },
                ...args.messages.flatMap(toOpenAIMessages),
              ],
              tools: args.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }),
            signal,
          },
        );

        if (!response.ok) {
          const body = await readResponseBodyLimited(
            response,
            OPENAI_MAX_ERROR_BODY_BYTES,
          );
          throw new LlmProviderError(
            `OpenAI-compatible endpoint returned ${response.status}: ${body}`,
            "openai-compatible",
            retryableStatus(response.status),
            { status: response.status },
          );
        }
        if (response.body == undefined) {
          throw new LlmProviderError(
            "OpenAI-compatible endpoint returned an empty stream",
            "openai-compatible",
            true,
          );
        }

        const toolCalls = new Map<number, ToolCallAccumulator>();
        let finalStopReason: LlmStopReason | undefined;
        let responseText = "";
        let selectedChoiceIndex: number | undefined;
        const streamState = {
          sawDoneFrame: false,
          sawFinishReason: false,
        };
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";

        const processFrame = (frame: string): boolean => {
          const data = frame
            .split(/\r\n|\r|\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data.length === 0) {
            return false;
          }
          if (data === "[DONE]") {
            streamState.sawDoneFrame = true;
            return true;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch (error) {
            throw new LlmProviderError(
              "OpenAI-compatible endpoint emitted invalid JSON",
              "openai-compatible",
              false,
              { cause: error },
            );
          }
          if (!isRecord(parsed)) {
            return false;
          }
          const envelope = errorEnvelope(parsed);
          if (envelope != undefined) {
            throw envelope;
          }
          if (!Array.isArray(parsed.choices)) {
            return false;
          }
          const choices = parsed.choices.filter(isRecord);
          const choiceIndexes = new Set(
            choices.map((choice, arrayIndex) =>
              Number.isSafeInteger(choice.index)
                ? (choice.index as number)
                : arrayIndex,
            ),
          );
          if (choiceIndexes.size > 1) {
            throw new LlmProviderError(
              "OpenAI-compatible streaming supports exactly one choice",
              "openai-compatible",
              false,
            );
          }
          const choice = choices[0];
          if (choice == undefined) {
            return false;
          }
          const choiceIndex = [...choiceIndexes][0]!;
          if (
            selectedChoiceIndex != undefined &&
            choiceIndex !== selectedChoiceIndex
          ) {
            throw new LlmProviderError(
              "OpenAI-compatible stream changed its selected choice",
              "openai-compatible",
              false,
            );
          }
          selectedChoiceIndex = choiceIndex;
          if (typeof choice.finish_reason === "string") {
            finalStopReason = mapStopReason(choice.finish_reason);
            streamState.sawFinishReason = true;
          }
          const delta = choice.delta;
          if (!isRecord(delta)) {
            return false;
          }
          if (typeof delta.content === "string" && delta.content.length > 0) {
            emitted = true;
            responseText += delta.content;
            onEvent({ type: "text", delta: delta.content });
          }
          if (!Array.isArray(delta.tool_calls)) {
            return false;
          }
          for (const rawToolCall of delta.tool_calls) {
            if (
              !isRecord(rawToolCall) ||
              !Number.isSafeInteger(rawToolCall.index)
            ) {
              continue;
            }
            const index = rawToolCall.index as number;
            if (
              !toolCalls.has(index) &&
              toolCalls.size >= OPENAI_MAX_TOOL_CALLS
            ) {
              throw new LlmProviderError(
                `OpenAI-compatible stream exceeds ${OPENAI_MAX_TOOL_CALLS} tool calls`,
                "openai-compatible",
                false,
              );
            }
            const current = toolCalls.get(index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (typeof rawToolCall.id === "string") {
              current.id = appendStreamFragment(current.id, rawToolCall.id);
            }
            if (isRecord(rawToolCall.function)) {
              if (typeof rawToolCall.function.name === "string") {
                current.name = appendStreamFragment(
                  current.name,
                  rawToolCall.function.name,
                );
              }
              if (typeof rawToolCall.function.arguments === "string") {
                current.arguments += rawToolCall.function.arguments;
              }
            }
            toolCalls.set(index, current);
          }
          return false;
        };

        try {
          let finished = false;
          let responseBytes = 0;
          while (!finished) {
            const chunk = await reader.read();
            responseBytes += chunk.value?.byteLength ?? 0;
            if (responseBytes > OPENAI_MAX_RESPONSE_BYTES) {
              throw new LlmProviderError(
                `OpenAI-compatible response exceeds ${OPENAI_MAX_RESPONSE_BYTES} bytes`,
                "openai-compatible",
                false,
              );
            }
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            let boundary: RegExpExecArray | null;
            const separator = /(?:\r\n|\r|\n){2}/g;
            while ((boundary = separator.exec(buffer)) != undefined) {
              const frame = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              separator.lastIndex = 0;
              if (
                new TextEncoder().encode(frame).byteLength >
                OPENAI_MAX_SSE_FRAME_BYTES
              ) {
                throw new LlmProviderError(
                  "OpenAI-compatible SSE frame exceeds 1 MiB",
                  "openai-compatible",
                  false,
                );
              }
              finished = processFrame(frame);
              if (finished) {
                break;
              }
            }
            if (
              new TextEncoder().encode(buffer).byteLength >
              OPENAI_MAX_SSE_FRAME_BYTES
            ) {
              throw new LlmProviderError(
                "OpenAI-compatible SSE frame exceeds 1 MiB",
                "openai-compatible",
                false,
              );
            }
            if (chunk.done) {
              if (buffer.trim().length > 0) {
                finished = processFrame(buffer);
              }
              break;
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (!streamState.sawFinishReason || finalStopReason == undefined) {
          throw new LlmProviderError(
            streamState.sawDoneFrame
              ? "OpenAI-compatible stream sent [DONE] without a finish_reason"
              : "OpenAI-compatible stream ended before a finish_reason",
            "openai-compatible",
            true,
          );
        }

        const finalContent: LlmContentBlock[] = [];
        if (responseText.length > 0) {
          finalContent.push({ type: "text", text: responseText });
        }
        for (const [index, call] of [...toolCalls.entries()].sort(
          ([a], [b]) => a - b,
        )) {
          if (call.id.length === 0 || call.name.length === 0) {
            throw new LlmProviderError(
              `OpenAI-compatible tool call ${index} is missing an id or name`,
              "openai-compatible",
              false,
            );
          }
          let input: unknown;
          try {
            input = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
          } catch (error) {
            throw new LlmProviderError(
              `OpenAI-compatible tool call ${call.name} has invalid arguments`,
              "openai-compatible",
              false,
              { cause: error },
            );
          }
          emitted = true;
          onEvent({ type: "tool-call", id: call.id, name: call.name, input });
          finalContent.push({
            type: "tool-call",
            id: call.id,
            name: call.name,
            input,
          });
        }
        onEvent({
          type: "done",
          stopReason: finalStopReason,
          finalContent,
          finalContentFormat: "provider-neutral",
        });
        return;
      } catch (error) {
        if (signal?.aborted === true) {
          throw abortReason(signal);
        }
        const normalized =
          error instanceof LlmProviderError
            ? error
            : new LlmProviderError(
                error instanceof Error
                  ? error.message
                  : "OpenAI-compatible request failed",
                "openai-compatible",
                error instanceof TypeError,
                { cause: error },
              );
        if (!emitted && normalized.retryable && attempt < this.#maxRetries) {
          await retryDelay(attempt, signal);
          continue;
        }
        throw normalized;
      }
    }
    throw new LlmProviderError(
      "OpenAI-compatible retry limit exhausted",
      "openai-compatible",
      true,
    );
  }
}
