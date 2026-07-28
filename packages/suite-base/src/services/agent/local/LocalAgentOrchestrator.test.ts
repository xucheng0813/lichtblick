// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type Anthropic from "@anthropic-ai/sdk";

import type { AgentEvent } from "@lichtblick/suite-base/services/agent/types";
import type { IVtdClient } from "@lichtblick/suite-base/services/vtd/types";

import { AnthropicProvider } from "./AnthropicProvider";
import {
  LOCAL_AGENT_MAX_HISTORY_BYTES,
  LOCAL_AGENT_MAX_HISTORY_TURNS,
  LOCAL_AGENT_MAX_TOOL_RESULT_BYTES,
  LOCAL_AGENT_MAX_TOOL_ROUNDS,
  LOCAL_AGENT_MAX_USER_MESSAGE_BYTES,
  LocalAgentOrchestrator,
} from "./LocalAgentOrchestrator";
import type {
  ILlmProvider,
  LlmContentBlock,
  LlmMessage,
  LlmStreamEvent,
} from "./types";

function makeVtdClient(): jest.Mocked<IVtdClient> {
  return {
    search: jest.fn(),
    detail: jest.fn(),
    topics: jest.fn(),
    sliceStore: jest.fn(),
    sliceGet: jest.fn(),
    url: jest.fn(),
  };
}

function validLayoutData(): Record<string, unknown> {
  return {
    configById: {
      "Plot!speed": { paths: [{ value: "/vehicle/speed" }] },
    },
    layout: "Plot!speed",
    globalVariables: {},
    playbackConfig: { speed: 1 },
    userNodes: {},
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition was not reached");
}

function toolResults(
  message: LlmMessage | undefined,
): Extract<LlmContentBlock, { type: "tool-result" }>[] {
  if (!Array.isArray(message?.content)) {
    throw new Error("Expected a tool result message");
  }
  const results = message.content.filter(
    (block): block is Extract<LlmContentBlock, { type: "tool-result" }> =>
      typeof block === "object" &&
      block != undefined &&
      "type" in block &&
      block.type === "tool-result" &&
      "toolCallId" in block &&
      typeof block.toolCallId === "string" &&
      "content" in block,
  );
  if (results.length !== message.content.length) {
    throw new Error("Expected every message block to be a tool result");
  }
  return results;
}

describe("LocalAgentOrchestrator", () => {
  it("runs text, confirmed VTD tools, layout/open events, seq, replay, and catalog follow-up", async () => {
    const vtdClient = makeVtdClient();
    vtdClient.search.mockResolvedValue({
      records: [{ id: "record-1", botSn: "SN1", raw: {} }],
      total: 1,
    });
    vtdClient.detail.mockResolvedValue({
      id: "record-1",
      durationNs: "5000000000",
    });
    vtdClient.topics.mockResolvedValue({ "/vehicle/speed": 50 });
    vtdClient.sliceStore.mockResolvedValue({ mcapSliceId: "slice-1", raw: {} });
    vtdClient.sliceGet.mockResolvedValue({
      downloadUrl: "https://data.example/slice-1.mcap",
      raw: {},
    });
    const rounds: ((onEvent: (event: LlmStreamEvent) => void) => void)[] = [
      (onEvent) => {
        onEvent({ type: "text", delta: "I found a recording. " });
        onEvent({
          type: "tool-call",
          id: "search-1",
          name: "vtd_search",
          input: { botSn: "SN1" },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
      (onEvent) => {
        onEvent({
          type: "tool-call",
          id: "detail-1",
          name: "vtd_detail",
          input: { id: "record-1" },
        });
        onEvent({
          type: "tool-call",
          id: "topics-1",
          name: "vtd_topics",
          input: { id: "record-1" },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
      (onEvent) => {
        onEvent({
          type: "tool-call",
          id: "slice-1",
          name: "vtd_slice_store",
          input: {
            id: "record-1",
            topics: ["/vehicle/speed"],
            startNs: "1000000000000000000",
          },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
      (onEvent) => {
        onEvent({
          type: "tool-call",
          id: "presign-1",
          name: "vtd_presign",
          input: { sliceId: "slice-1" },
        });
        onEvent({
          type: "tool-call",
          id: "open-1",
          name: "open_data_source",
          input: { urls: ["https://data.example/slice-1.mcap"] },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
      (onEvent) => {
        onEvent({
          type: "tool-call",
          id: "catalog-1",
          name: "get_data_catalog",
          input: {},
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
      (onEvent) => {
        onEvent({
          type: "tool-call",
          id: "layout-1",
          name: "propose_layout",
          input: {
            name: "Speed analysis",
            summary: "Plot vehicle speed",
            data: validLayoutData(),
          },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
      (onEvent) => {
        onEvent({ type: "text", delta: "The catalog is now available." });
        onEvent({ type: "done", stopReason: "end" });
      },
    ];
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        const round = rounds.shift();
        if (round == undefined) {
          throw new Error("Unexpected provider round");
        }
        round(onEvent);
      },
    );
    const provider: ILlmProvider = { stream };
    const getCatalog = jest.fn(() => ({
      topics: [{ name: "/vehicle/speed", schemaName: "std_msgs/Float64" }],
      datatypes: new Map([["std_msgs/Float64", { definitions: [] }]]),
    }));
    const orchestrator = new LocalAgentOrchestrator({
      provider,
      vtdClient,
      getCatalog,
      model: "test-model",
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const subscriptionController = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      subscriptionController.signal,
    );

    const send = orchestrator.sendMessage(
      sessionId,
      "Analyze SN1",
      "request-1",
    );
    await waitUntil(() =>
      events.some(
        (event) =>
          event.type === "tool-update" &&
          event.toolRun.id === "slice-1" &&
          event.toolRun.status === "awaiting-confirmation",
      ),
    );
    expect(vtdClient.sliceStore.mock.calls).toHaveLength(0);

    await orchestrator.confirmToolRun(sessionId, "slice-1", { approve: true });
    await send;

    expect(vtdClient.search.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ botSn: "SN1" }),
    );
    expect(vtdClient.search.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(vtdClient.detail.mock.calls[0]?.[0]).toBe("record-1");
    expect(vtdClient.topics.mock.calls[0]?.[0]).toBe("record-1");
    expect(vtdClient.sliceStore.mock.calls[0]?.[0]).toEqual({
      id: "record-1",
      topics: ["/vehicle/speed"],
      startNs: "1000000000000000000",
      endNs: undefined,
    });
    expect(vtdClient.sliceGet.mock.calls[0]?.[0]).toBe("slice-1");
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_event, index) => index + 1),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "token",
          delta: "I found a recording. ",
          requestId: "request-1",
        }),
        expect.objectContaining({
          type: "open-data-source",
          urls: ["https://data.example/slice-1.mcap"],
          requestId: "request-1",
        }),
        expect.objectContaining({ type: "done", requestId: "request-1" }),
      ]),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "tool-update" && event.toolRun.id === "slice-1",
      ),
    ).toEqual([
      expect.objectContaining({
        toolRun: expect.objectContaining({ status: "queued" }),
      }),
      expect.objectContaining({
        toolRun: expect.objectContaining({ status: "awaiting-confirmation" }),
      }),
      expect.objectContaining({
        toolRun: expect.objectContaining({ status: "running" }),
      }),
      expect.objectContaining({
        toolRun: expect.objectContaining({ status: "succeeded" }),
      }),
    ]);

    const replayCursor = events.at(-3)!.seq;
    const replayed: AgentEvent[] = [];
    const replayController = new AbortController();
    const replaySubscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => replayed.push(event),
      replayController.signal,
      { lastSeq: replayCursor },
    );
    replayController.abort();
    await expect(replaySubscription).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(replayed).toEqual(
      events.filter((event) => event.seq > replayCursor),
    );

    await orchestrator.notifyCatalogReady(sessionId, "request-1");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "layout-proposal",
          proposal: expect.objectContaining({ name: "Speed analysis" }),
        }),
      ]),
    );
    const catalogReadyMessages = stream.mock.calls[4]?.[0].messages;
    expect(catalogReadyMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("catalog is ready"),
        }),
      ]),
    );
    const catalogToolResult = stream.mock.calls[5]?.[0].messages.at(-1);
    expect(catalogToolResult).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "catalog-1",
            content: expect.objectContaining({
              topics: [
                { name: "/vehicle/speed", schemaName: "std_msgs/Float64" },
              ],
            }),
          }),
        ]),
      }),
    );
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_event, index) => index + 1),
    );
    await orchestrator.notifyCatalogReady(sessionId, "request-1");
    expect(stream).toHaveBeenCalledTimes(7);
    expect(stream.mock.calls[0]?.[0].model).toBe("test-model");

    subscriptionController.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a pending provider stream and cleans up a pending confirmation", async () => {
    const vtdClient = makeVtdClient();
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent, signal) => {
        onEvent({
          type: "tool-call",
          id: "slice-abort",
          name: "vtd_slice_store",
          input: { id: "record-1" },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
        signal?.throwIfAborted();
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const controller = new AbortController();
    const send = orchestrator.sendMessage(
      sessionId,
      "slice it",
      "request-abort",
      controller.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(send).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      orchestrator.confirmToolRun(sessionId, "slice-abort", { approve: true }),
    ).rejects.toThrow("No pending confirmation");
    expect(vtdClient.sliceStore.mock.calls).toHaveLength(0);
  });

  it("retains only the latest 1000 events for lastSeq replay", async () => {
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        for (let index = 0; index < 1005; index++) {
          onEvent({ type: "text", delta: `${index}` });
        }
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    await orchestrator.sendMessage(sessionId, "stream", "request-replay");
    const replayed: AgentEvent[] = [];
    const result = await orchestrator.subscribeEvents(
      sessionId,
      (event) => replayed.push(event),
      undefined,
      { lastSeq: 0 },
    );

    expect(result).toEqual({ reason: "eof" });
    expect(replayed).toEqual([
      expect.objectContaining({
        seq: 1009,
        type: "error",
        error: expect.stringMatching(/replay window.*reset/i),
      }),
    ]);
  });

  it("does not enter confirmation after a provider finishes following abort", async () => {
    let finishProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        onEvent({
          type: "tool-call",
          id: "late-confirm",
          name: "vtd_slice_store",
          input: { id: "record-1" },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
        await providerGate;
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const subscriptionController = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      subscriptionController.signal,
    );
    const controller = new AbortController();
    const send = orchestrator.sendMessage(
      sessionId,
      "slice",
      "abort-before-confirm",
      controller.signal,
    );
    await waitUntil(() => stream.mock.calls.length === 1);
    controller.abort();
    finishProvider();

    await expect(send).rejects.toMatchObject({ name: "AbortError" });
    expect(
      events.some(
        (event) =>
          event.type === "tool-update" &&
          event.toolRun.status === "awaiting-confirmation",
      ),
    ).toBe(false);
    subscriptionController.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an aborted queued send immediately without breaking the session queue", async () => {
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        if (call++ === 0) {
          await firstGate;
        }
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const first = orchestrator.sendMessage(sessionId, "first", "queued-first");
    await waitUntil(() => stream.mock.calls.length === 1);
    const controller = new AbortController();
    const second = orchestrator.sendMessage(
      sessionId,
      "second",
      "queued-second",
      controller.signal,
    );
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(stream).toHaveBeenCalledTimes(1);
    finishFirst();
    await first;
    await orchestrator.sendMessage(sessionId, "third", "queued-third");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("times out confirmation and returns an error tool result to the model", async () => {
    jest.useFakeTimers();
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "tool-call",
            id: "confirm-timeout",
            name: "vtd_slice_store",
            input: { id: "record-1" },
          });
          onEvent({ type: "done", stopReason: "tool-use" });
        } else {
          onEvent({ type: "done", stopReason: "end" });
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
      confirmationTimeoutMs: 10,
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const subscriptionController = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      subscriptionController.signal,
    );
    const send = orchestrator.sendMessage(
      sessionId,
      "slice",
      "confirm-timeout-request",
    );
    await waitUntil(() =>
      events.some(
        (event) =>
          event.type === "tool-update" &&
          event.toolRun.status === "awaiting-confirmation",
      ),
    );
    await jest.advanceTimersByTimeAsync(10);
    await send;

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-update",
          toolRun: expect.objectContaining({
            id: "confirm-timeout",
            status: "failed",
            error: "Tool confirmation timed out",
          }),
        }),
      ]),
    );
    const resultMessage = stream.mock.calls[1]?.[0].messages.at(-1);
    expect(resultMessage).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            toolCallId: "confirm-timeout",
            isError: true,
          }),
        ],
      }),
    );
    subscriptionController.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
    jest.useRealTimers();
  });

  it("caps provider history at the latest configured number of user turns", async () => {
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        onEvent({ type: "done", stopReason: "end", finalContent: [] });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    for (let index = 0; index <= LOCAL_AGENT_MAX_HISTORY_TURNS; index++) {
      await orchestrator.sendMessage(
        sessionId,
        `user-${index}`,
        `history-${index}`,
      );
    }

    const finalMessages = stream.mock.calls.at(-1)![0].messages;
    expect(finalMessages).toHaveLength(LOCAL_AGENT_MAX_HISTORY_TURNS * 2 - 1);
    expect(finalMessages).not.toContainEqual({
      role: "user",
      content: "user-0",
    });
    expect(finalMessages).toContainEqual({
      role: "user",
      content: `user-${LOCAL_AGENT_MAX_HISTORY_TURNS}`,
    });
  });

  it("errors after the bounded number of consecutive tool rounds", async () => {
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        onEvent({
          type: "tool-call",
          id: `catalog-${stream.mock.calls.length}`,
          name: "get_data_catalog",
          input: {},
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await expect(
      orchestrator.sendMessage(sessionId, "loop", "tool-round-limit"),
    ).rejects.toThrow(`${LOCAL_AGENT_MAX_TOOL_ROUNDS} tool-round limit`);
    expect(stream).toHaveBeenCalledTimes(LOCAL_AGENT_MAX_TOOL_ROUNDS);
  });

  it("stops a tool batch at the first open and refuses stale catalog/layout work", async () => {
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        onEvent({
          type: "tool-call",
          id: "stale-layout",
          name: "propose_layout",
          input: { name: "stale", data: validLayoutData() },
        });
        onEvent({
          type: "tool-call",
          id: "stale-catalog",
          name: "get_data_catalog",
          input: {},
        });
        onEvent({
          type: "tool-call",
          id: "open-first",
          name: "open_data_source",
          input: { urls: ["https://data.example/first.mcap"] },
        });
        onEvent({
          type: "tool-call",
          id: "open-second",
          name: "open_data_source",
          input: { urls: ["https://data.example/second.mcap"] },
        });
        onEvent({ type: "done", stopReason: "tool-use" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      controller.signal,
    );
    await orchestrator.sendMessage(sessionId, "open", "same-batch-open");

    expect(
      events.filter((event) => event.type === "open-data-source"),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === "layout-proposal")).toBe(
      false,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-update",
          toolRun: expect.objectContaining({
            id: "stale-layout",
            status: "failed",
          }),
        }),
        expect.objectContaining({
          type: "tool-update",
          toolRun: expect.objectContaining({
            id: "stale-catalog",
            status: "failed",
          }),
        }),
        expect.objectContaining({
          type: "tool-update",
          toolRun: expect.objectContaining({
            id: "open-second",
            status: "failed",
          }),
        }),
      ]),
    );
    controller.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    "http://data.example/file.mcap",
    "file:///tmp/file.mcap",
    "data:text/plain,file.mcap",
    "https://data.example/file.json",
    "https://data.example/file,name.mcap",
  ])("rejects unsafe open_data_source URL %s", async (url) => {
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "tool-call",
            id: "unsafe-open",
            name: "open_data_source",
            input: { urls: [url] },
          });
          onEvent({ type: "done", stopReason: "tool-use" });
        } else {
          onEvent({ type: "done", stopReason: "end" });
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      controller.signal,
    );
    await orchestrator.sendMessage(
      sessionId,
      "open unsafe",
      `unsafe-${call}-${url}`,
    );

    expect(events.some((event) => event.type === "open-data-source")).toBe(
      false,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-update",
          toolRun: expect.objectContaining({
            id: "unsafe-open",
            status: "failed",
            error: expect.stringContaining(
              url.includes(",") ? "%2C" : "HTTPS .mcap",
            ),
          }),
        }),
      ]),
    );
    controller.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps catalog-ready pending when continuation fails and permits a retry", async () => {
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        switch (call++) {
          case 0:
            onEvent({
              type: "tool-call",
              id: "open-for-catalog",
              name: "open_data_source",
              input: { urls: ["https://data.example/catalog.mcap"] },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 1:
            throw new Error("temporary continuation failure");
          default:
            onEvent({ type: "done", stopReason: "end" });
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      controller.signal,
    );
    await orchestrator.sendMessage(sessionId, "open", "catalog-source");

    await expect(
      orchestrator.notifyCatalogReady(sessionId, "catalog-source"),
    ).rejects.toThrow("temporary continuation failure");
    expect(
      events.filter(
        (event) =>
          event.requestId === "catalog-source" &&
          (event.type === "done" || event.type === "error"),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "done",
        requestId: "catalog-source",
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "error" &&
          event.requestId !== "catalog-source" &&
          event.error.includes("temporary continuation failure"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "error" && event.requestId === "catalog-source",
      ),
    ).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === "done" && event.requestId === "catalog-source",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.error.includes("Catalog-ready continuation failed"),
      ),
    ).toBe(false);
    await expect(
      orchestrator.notifyCatalogReady(sessionId, "catalog-source"),
    ).resolves.toBeUndefined();
    await orchestrator.notifyCatalogReady(sessionId, "catalog-source");
    expect(stream).toHaveBeenCalledTimes(3);
    controller.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not let one catalog-ready caller's signal cancel the shared continuation", async () => {
    let releaseBlockingSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBlockingSend = resolve;
    });
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        switch (call++) {
          case 0:
            onEvent({
              type: "tool-call",
              id: "open-before-queue",
              name: "open_data_source",
              input: { urls: ["https://data.example/queued.mcap"] },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 1:
            await gate;
            onEvent({ type: "done", stopReason: "end" });
            return;
          default:
            onEvent({ type: "done", stopReason: "end" });
        }
      },
    );
    const cyclicTopic: Record<string, unknown> = { name: "/cyclic" };
    cyclicTopic.self = cyclicTopic;
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({
        topics: [cyclicTopic, { name: "/bigint", count: 1n }],
        datatypes: new Map(),
      }),
    });
    const { sessionId } = await orchestrator.createSession();
    await orchestrator.sendMessage(sessionId, "open", "queued-catalog-source");
    const blocking = orchestrator.sendMessage(
      sessionId,
      "block",
      "blocking-request",
    );
    await waitUntil(() => stream.mock.calls.length === 2);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstNotification = orchestrator.notifyCatalogReady(
      sessionId,
      "queued-catalog-source",
      firstController.signal,
    );
    const secondNotification = orchestrator.notifyCatalogReady(
      sessionId,
      "queued-catalog-source",
      secondController.signal,
    );
    const laterController = new AbortController();
    const laterNotification = orchestrator.notifyCatalogReady(
      sessionId,
      "queued-catalog-source",
      laterController.signal,
    );
    firstController.abort();
    laterController.abort();

    await expect(firstNotification).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(laterNotification).rejects.toMatchObject({
      name: "AbortError",
    });
    releaseBlockingSend();
    await blocking;
    await expect(secondNotification).resolves.toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(3);
  });

  it("surfaces abnormal model stop reasons as token and error events", async () => {
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        onEvent({ type: "text", delta: "partial" });
        onEvent({ type: "done", stopReason: "max-tokens", finalContent: [] });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      controller.signal,
    );

    await expect(
      orchestrator.sendMessage(sessionId, "long answer", "abnormal-stop"),
    ).rejects.toThrow("max-tokens");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "token",
          delta: expect.stringContaining("output-token limit"),
        }),
        expect.objectContaining({
          type: "error",
          error: expect.stringContaining("max-tokens"),
        }),
      ]),
    );
    controller.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stores provider-native assistant content unchanged for the next tool round", async () => {
    const nativeContent = [
      { type: "thinking", thinking: "reason", signature: "signature" },
      {
        type: "tool_use",
        id: "catalog-native",
        name: "get_data_catalog",
        input: {},
      },
    ];
    let call = 0;
    let replayedAssistantContent: unknown;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "tool-call",
            id: "catalog-native",
            name: "get_data_catalog",
            input: {},
          });
          onEvent({
            type: "done",
            stopReason: "tool-use",
            finalContent: nativeContent,
            finalContentFormat: "anthropic-native",
          });
        } else {
          replayedAssistantContent = args.messages[1];
          onEvent({ type: "done", stopReason: "end" });
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await orchestrator.sendMessage(sessionId, "catalog", "native-history");
    expect(stream).toHaveBeenCalledTimes(2);
    expect(replayedAssistantContent).toEqual({
      role: "assistant",
      content: nativeContent,
      contentFormat: "anthropic-native",
    });
  });

  it("rolls back an assistant tool round when a later tool is aborted", async () => {
    let call = 0;
    let messagesAfterAbort: Parameters<ILlmProvider["stream"]>[0]["messages"] =
      [];
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "tool-call",
            id: "completed-before-abort",
            name: "get_data_catalog",
            input: {},
          });
          onEvent({
            type: "tool-call",
            id: "aborted-confirmation",
            name: "vtd_slice_store",
            input: { id: "record-1", startNs: "1" },
          });
          onEvent({
            type: "done",
            stopReason: "tool-use",
            finalContent: [
              {
                type: "thinking",
                thinking: "signed thought before abort",
                signature: "abort-signature",
              },
              {
                type: "tool_use",
                id: "completed-before-abort",
                name: "get_data_catalog",
                input: {},
              },
              {
                type: "tool_use",
                id: "aborted-confirmation",
                name: "vtd_slice_store",
                input: { id: "record-1", startNs: "1" },
              },
            ],
            finalContentFormat: "anthropic-native",
          });
          return;
        }
        messagesAfterAbort = args.messages;
        onEvent({
          type: "done",
          stopReason: "end",
          finalContent: [{ type: "text", text: "recovered" }],
          finalContentFormat: "provider-neutral",
        });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const subscriptionController = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      subscriptionController.signal,
    );
    const requestController = new AbortController();
    const aborted = orchestrator.sendMessage(
      sessionId,
      "start tools",
      "aborted-tool-round",
      requestController.signal,
    );
    await waitUntil(() =>
      events.some(
        (event) =>
          event.type === "tool-update" &&
          event.toolRun.id === "aborted-confirmation" &&
          event.toolRun.status === "awaiting-confirmation",
      ),
    );
    requestController.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    await orchestrator.sendMessage(
      sessionId,
      "recover",
      "after-aborted-tool-round",
    );
    expect(messagesAfterAbort).not.toContainEqual(
      expect.objectContaining({ role: "assistant" }),
    );
    expect(
      messagesAfterAbort.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              typeof block === "object" &&
              block != undefined &&
              ("toolCallId" in block || "id" in block),
          ),
      ),
    ).toBe(false);

    subscriptionController.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the session queue usable when the provider ignores its abort signal", async () => {
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        if (call++ === 0) {
          await new Promise<void>(() => {});
        }
        onEvent({ type: "done", stopReason: "end", finalContent: [] });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
      dependencyTimeoutMs: 5,
    });
    const { sessionId } = await orchestrator.createSession();

    await expect(
      orchestrator.sendMessage(sessionId, "hang", "provider-hang"),
    ).rejects.toThrow("LLM provider did not settle within 5 ms");
    await expect(
      orchestrator.sendMessage(sessionId, "recover", "provider-recovered"),
    ).resolves.toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("turns an uncooperative VTD timeout into a paired tool result and continues", async () => {
    const vtdClient = makeVtdClient();
    vtdClient.detail.mockImplementation(async () => {
      await new Promise<void>(() => {});
      return { id: "never" };
    });
    let call = 0;
    let continuationMessages:
      Parameters<ILlmProvider["stream"]>[0]["messages"] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "tool-call",
            id: "slow-detail",
            name: "vtd_detail",
            input: { id: "record-1" },
          });
          onEvent({ type: "done", stopReason: "tool-use" });
          return;
        }
        continuationMessages = args.messages;
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
      dependencyTimeoutMs: 5,
    });
    const { sessionId } = await orchestrator.createSession();

    await expect(
      orchestrator.sendMessage(sessionId, "inspect", "slow-vtd"),
    ).resolves.toBeUndefined();
    expect(continuationMessages?.at(-1)).toEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "slow-detail",
          isError: true,
          content: {
            error: "Tool vtd_detail did not settle within 5 ms",
          },
        }),
      ],
    });
  });

  it("resumes pause responses with their complete native content", async () => {
    const pausedContent = [
      { type: "thinking", thinking: "signed thought", signature: "sig" },
      { type: "text", text: "Working..." },
    ];
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "done",
            stopReason: "pause",
            finalContent: pausedContent,
            finalContentFormat: "anthropic-native",
          });
          return;
        }
        expect(args.messages.at(-1)).toEqual({
          role: "assistant",
          content: pausedContent,
          contentFormat: "anthropic-native",
        });
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await orchestrator.sendMessage(sessionId, "continue", "pause-turn");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["filtered", "content filter"],
    ["refusal", "refused this request"],
  ] as const)(
    "distinguishes the %s terminal reason",
    async (reason, message) => {
      const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
        async (_args, onEvent) => {
          onEvent({
            type: "done",
            stopReason: reason,
            finalContent: [{ type: "text", text: "partial" }],
          });
        },
      );
      const orchestrator = new LocalAgentOrchestrator({
        provider: { stream },
        vtdClient: makeVtdClient(),
        getCatalog: () => ({ topics: [], datatypes: new Map() }),
      });
      const { sessionId } = await orchestrator.createSession();
      const events: AgentEvent[] = [];
      const controller = new AbortController();
      const subscription = orchestrator.subscribeEvents(
        sessionId,
        (event) => events.push(event),
        controller.signal,
      );

      await expect(
        orchestrator.sendMessage(sessionId, "answer", `stop-${reason}`),
      ).rejects.toThrow(`LLM response stopped: ${reason}`);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "token",
            delta: expect.stringContaining(message),
          }),
          expect.objectContaining({
            type: "error",
            error: expect.stringContaining(reason),
          }),
        ]),
      );
      controller.abort();
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("rejects oversized user messages before calling the provider", async () => {
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>();
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await expect(
      orchestrator.sendMessage(
        sessionId,
        "x".repeat(LOCAL_AGENT_MAX_USER_MESSAGE_BYTES + 1),
        "large-user",
      ),
    ).rejects.toThrow(`${LOCAL_AGENT_MAX_USER_MESSAGE_BYTES} byte limit`);
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects a single oversized history group and removes its assistant response", async () => {
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "done",
            stopReason: "end",
            finalContent: [
              {
                type: "text",
                text: "x".repeat(LOCAL_AGENT_MAX_HISTORY_BYTES + 1),
              },
            ],
            finalContentFormat: "provider-neutral",
          });
          return;
        }
        expect(args.messages).not.toContainEqual(
          expect.objectContaining({
            role: "assistant",
          }),
        );
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await expect(
      orchestrator.sendMessage(sessionId, "large answer", "large-history"),
    ).rejects.toThrow(`${LOCAL_AGENT_MAX_HISTORY_BYTES} byte history budget`);
    await expect(
      orchestrator.sendMessage(sessionId, "recover", "after-large-history"),
    ).resolves.toBeUndefined();
  });

  it("stops a tool batch at the first cumulative result-budget overflow", async () => {
    const toolCount = 24;
    const vtdClient = makeVtdClient();
    vtdClient.detail.mockResolvedValue({
      payload: "界".repeat(120_000),
    });
    let call = 0;
    let continuationMessages: LlmMessage[] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          for (let index = 0; index < toolCount; index++) {
            onEvent({
              type: "tool-call",
              id: `large-detail-${index}`,
              name: "vtd_detail",
              input: { id: `record-${index}` },
            });
          }
          onEvent({ type: "done", stopReason: "tool-use" });
          return;
        }
        continuationMessages = args.messages;
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await orchestrator.sendMessage(
      sessionId,
      "inspect a large batch",
      "large-tool-batch",
    );

    const results = toolResults(continuationMessages?.at(-1));
    const overflowIndex = results.findIndex(
      (result) =>
        result.isError === true &&
        typeof result.content === "object" &&
        result.content != undefined &&
        "executed" in result.content &&
        result.content.executed === true,
    );
    expect(overflowIndex).toBeGreaterThan(0);
    expect(results).toHaveLength(toolCount);
    expect(vtdClient.detail.mock.calls).toHaveLength(overflowIndex + 1);
    expect(results.slice(0, overflowIndex)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isError: undefined,
          content: expect.objectContaining({ truncated: true }),
        }),
      ]),
    );
    expect(results[overflowIndex]).toEqual(
      expect.objectContaining({
        isError: true,
        content: expect.objectContaining({
          error: expect.stringContaining("execution completed"),
          executed: true,
        }),
      }),
    );
    expect(results.slice(overflowIndex + 1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isError: true,
          content: expect.objectContaining({
            error: expect.stringContaining("was not executed"),
            executed: false,
          }),
        }),
      ]),
    );
    for (const result of results.slice(0, overflowIndex)) {
      expect(
        new TextEncoder().encode(JSON.stringify(result.content)).byteLength,
      ).toBeLessThanOrEqual(LOCAL_AGENT_MAX_TOOL_RESULT_BYTES);
    }
    expect(
      new TextEncoder().encode(JSON.stringify(continuationMessages)).byteLength,
    ).toBeLessThanOrEqual(LOCAL_AGENT_MAX_HISTORY_BYTES);
  });

  it("rejects a repeated tool-call ID before execution and rolls back the assistant round", async () => {
    const vtdClient = makeVtdClient();
    vtdClient.detail.mockImplementation(async (id) => ({ id }));
    let call = 0;
    let nextRequestMessages: LlmMessage[] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "tool-call",
            id: "repeated-call",
            name: "vtd_detail",
            input: { id: "first" },
          });
          onEvent({
            type: "tool-call",
            id: "repeated-call",
            name: "vtd_detail",
            input: { id: "must-not-run" },
          });
          onEvent({
            type: "tool-call",
            id: "unique-call",
            name: "vtd_detail",
            input: { id: "third" },
          });
          onEvent({
            type: "done",
            stopReason: "tool-use",
            finalContent: [
              {
                type: "tool_use",
                id: "repeated-call",
                name: "vtd_detail",
                input: { id: "first" },
              },
              {
                type: "tool_use",
                id: "repeated-call",
                name: "vtd_detail",
                input: { id: "must-not-run" },
              },
            ],
            finalContentFormat: "anthropic-native",
          });
          return;
        }
        nextRequestMessages = args.messages;
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      controller.signal,
    );

    await expect(
      orchestrator.sendMessage(
        sessionId,
        "run repeated tools",
        "duplicate-tool-call",
      ),
    ).rejects.toThrow('duplicate tool-call ID "repeated-call"');

    expect(vtdClient.detail.mock.calls).toHaveLength(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          requestId: "duplicate-tool-call",
          error: expect.stringContaining(
            'duplicate tool-call ID "repeated-call"',
          ),
        }),
      ]),
    );
    expect(events.some((event) => event.type === "tool-update")).toBe(false);

    await orchestrator.sendMessage(
      sessionId,
      "continue after malformed response",
      "after-duplicate-tool-call",
    );
    expect(nextRequestMessages?.some((message) => message.role === "assistant")).toBe(
      false,
    );

    controller.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an empty tool-call ID before execution and keeps later requests usable", async () => {
    const vtdClient = makeVtdClient();
    let call = 0;
    let nextRequestMessages: LlmMessage[] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        if (call++ === 0) {
          onEvent({
            type: "tool-call",
            id: "",
            name: "vtd_detail",
            input: { id: "must-not-run" },
          });
          onEvent({ type: "done", stopReason: "tool-use" });
          return;
        }
        nextRequestMessages = args.messages;
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await expect(
      orchestrator.sendMessage(
        sessionId,
        "run an empty-id tool",
        "empty-tool-call",
      ),
    ).rejects.toThrow("empty tool-call ID");
    expect(vtdClient.detail.mock.calls).toHaveLength(0);

    await orchestrator.sendMessage(
      sessionId,
      "continue after empty ID",
      "after-empty-tool-call",
    );
    expect(nextRequestMessages?.some((message) => message.role === "assistant")).toBe(
      false,
    );
  });

  it("rejects a reused session tool-call ID without blocking fresh calls and releases IDs on dispose", async () => {
    const vtdClient = makeVtdClient();
    vtdClient.detail.mockImplementation(async (id) => ({ id }));
    let call = 0;
    let continuationMessages: LlmMessage[] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        switch (call++) {
          case 0:
            onEvent({
              type: "tool-call",
              id: "session-call",
              name: "vtd_detail",
              input: { id: "first" },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 1:
            onEvent({
              type: "tool-call",
              id: "session-call",
              name: "vtd_slice_store",
              input: { id: "must-not-confirm" },
            });
            onEvent({
              type: "tool-call",
              id: "fresh-call",
              name: "vtd_detail",
              input: { id: "fresh" },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 2:
            continuationMessages = args.messages;
            onEvent({ type: "done", stopReason: "end" });
            return;
          case 3:
            onEvent({
              type: "tool-call",
              id: "session-call",
              name: "vtd_detail",
              input: { id: "new-session" },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 4:
            onEvent({ type: "done", stopReason: "end" });
            return;
          default:
            throw new Error("Unexpected provider round");
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const first = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const subscriptionController = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      first.sessionId,
      (event) => events.push(event),
      subscriptionController.signal,
    );

    await orchestrator.sendMessage(
      first.sessionId,
      "reuse a tool ID across rounds",
      "session-tool-call-reuse",
    );

    expect(vtdClient.detail.mock.calls.map(([id]) => id)).toEqual([
      "first",
      "fresh",
    ]);
    expect(vtdClient.sliceStore.mock.calls).toHaveLength(0);
    const reusedResults = toolResults(continuationMessages?.at(-1));
    expect(reusedResults).toEqual([
      expect.objectContaining({
        toolCallId: "session-call",
        isError: true,
        content: expect.objectContaining({
          error: expect.stringContaining("already been used in this session"),
          executed: false,
        }),
      }),
      expect.objectContaining({
        toolCallId: "fresh-call",
        isError: undefined,
      }),
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "tool-update" &&
          event.toolRun.status === "awaiting-confirmation",
      ),
    ).toBe(false);
    const rejectedUpdates = events.filter(
      (event) =>
        event.type === "tool-update" &&
        event.toolRun.name === "vtd_slice_store",
    );
    expect(rejectedUpdates).toEqual([
      expect.objectContaining({
        toolRun: expect.objectContaining({
          status: "queued",
          id: expect.not.stringMatching(/^session-call$/),
        }),
      }),
      expect.objectContaining({
        toolRun: expect.objectContaining({
          status: "failed",
          id: expect.not.stringMatching(/^session-call$/),
          error: expect.stringContaining("already been used in this session"),
        }),
      }),
    ]);

    orchestrator.disposeSession(first.sessionId);
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
    const second = await orchestrator.createSession();
    await orchestrator.sendMessage(
      second.sessionId,
      "reuse the ID in a new session",
      "new-session-tool-call",
    );
    expect(vtdClient.detail.mock.calls.map(([id]) => id)).toEqual([
      "first",
      "fresh",
      "new-session",
    ]);
  });

  it("bounds session tool-call ID retention with FIFO eviction", async () => {
    const vtdClient = makeVtdClient();
    vtdClient.detail.mockImplementation(async (id) => ({ id }));
    let call = 0;
    let secondRequestMessages: LlmMessage[] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        switch (call++) {
          case 0:
            for (const id of ["fifo-1", "fifo-2", "fifo-3"]) {
              onEvent({
                type: "tool-call",
                id,
                name: "vtd_detail",
                input: { id },
              });
            }
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 1:
            onEvent({ type: "done", stopReason: "end" });
            return;
          case 2:
            onEvent({
              type: "tool-call",
              id: "fifo-1",
              name: "vtd_detail",
              input: { id: "fifo-1-again" },
            });
            onEvent({
              type: "tool-call",
              id: "fifo-3",
              name: "vtd_detail",
              input: { id: "must-not-run" },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 3:
            secondRequestMessages = args.messages;
            onEvent({ type: "done", stopReason: "end" });
            return;
          default:
            throw new Error("Unexpected provider round");
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
      maxSeenToolCallIds: 2,
    });
    const { sessionId } = await orchestrator.createSession();

    await orchestrator.sendMessage(sessionId, "fill FIFO window", "fifo-fill");
    await orchestrator.sendMessage(
      sessionId,
      "reuse old and retained IDs",
      "fifo-reuse",
    );

    expect(vtdClient.detail.mock.calls.map(([id]) => id)).toEqual([
      "fifo-1",
      "fifo-2",
      "fifo-3",
      "fifo-1-again",
    ]);
    expect(toolResults(secondRequestMessages?.at(-1))).toEqual([
      expect.objectContaining({
        toolCallId: "fifo-1",
        isError: undefined,
      }),
      expect.objectContaining({
        toolCallId: "fifo-3",
        isError: true,
        content: expect.objectContaining({
          error: expect.stringContaining("already been used in this session"),
          executed: false,
        }),
      }),
    ]);
  });

  it("does not evict tool-call IDs while their request is still active", async () => {
    const vtdClient = makeVtdClient();
    vtdClient.detail.mockImplementation(async (id) => ({ id }));
    let call = 0;
    let finalMessages: LlmMessage[] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        switch (call++) {
          case 0:
            for (const id of ["retired-1", "retired-2"]) {
              onEvent({
                type: "tool-call",
                id,
                name: "vtd_detail",
                input: { id },
              });
            }
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 1:
            onEvent({ type: "done", stopReason: "end" });
            return;
          case 2:
            for (const id of ["active-1", "active-2", "active-3"]) {
              onEvent({
                type: "tool-call",
                id,
                name: "vtd_detail",
                input: { id },
              });
            }
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 3:
            onEvent({
              type: "tool-call",
              id: "active-1",
              name: "vtd_slice_store",
              input: { id: "must-not-confirm" },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 4:
            finalMessages = args.messages;
            onEvent({ type: "done", stopReason: "end" });
            return;
          default:
            throw new Error("Unexpected provider round");
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
      confirmationTimeoutMs: 50,
      maxSeenToolCallIds: 2,
    });
    const { sessionId } = await orchestrator.createSession();
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const subscription = orchestrator.subscribeEvents(
      sessionId,
      (event) => events.push(event),
      controller.signal,
    );

    await orchestrator.sendMessage(
      sessionId,
      "fill the terminal ID pool",
      "terminal-pool-fill",
    );
    await expect(
      orchestrator.sendMessage(
        sessionId,
        "keep active IDs beyond the terminal pool limit",
        "active-id-retention",
      ),
    ).resolves.toBeUndefined();

    expect(vtdClient.detail.mock.calls.map(([id]) => id)).toEqual([
      "retired-1",
      "retired-2",
      "active-1",
      "active-2",
      "active-3",
    ]);
    expect(vtdClient.sliceStore.mock.calls).toHaveLength(0);
    expect(toolResults(finalMessages?.at(-1))).toEqual([
      expect.objectContaining({
        toolCallId: "active-1",
        isError: true,
        content: expect.objectContaining({
          error: expect.stringContaining("already been used in this session"),
          executed: false,
        }),
      }),
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "tool-update" &&
          event.toolRun.status === "awaiting-confirmation",
      ),
    ).toBe(false);

    controller.abort();
    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rolls back active request tool-call IDs without changing the terminal FIFO pool", async () => {
    const vtdClient = makeVtdClient();
    vtdClient.detail.mockImplementation(async (id) => ({ id }));
    let call = 0;
    let recoveryMessages: LlmMessage[] | undefined;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (args, onEvent) => {
        switch (call++) {
          case 0:
            for (const id of ["seed-1", "seed-2"]) {
              onEvent({
                type: "tool-call",
                id,
                name: "vtd_detail",
                input: { id },
              });
            }
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 1:
            onEvent({ type: "done", stopReason: "end" });
            return;
          case 2:
            onEvent({
              type: "tool-call",
              id: "rolled-back-call",
              name: "vtd_detail",
              input: { id: "must-not-run-before-rollback" },
            });
            onEvent({
              type: "done",
              stopReason: "tool-use",
              finalContent: [
                {
                  type: "text",
                  text: "x".repeat(LOCAL_AGENT_MAX_HISTORY_BYTES - 256),
                },
              ],
              finalContentFormat: "provider-neutral",
            });
            return;
          case 3:
            onEvent({
              type: "tool-call",
              id: "rolled-back-call",
              name: "vtd_detail",
              input: { id: "runs-after-rollback" },
            });
            onEvent({
              type: "tool-call",
              id: "seed-1",
              name: "vtd_detail",
              input: { id: "must-remain-seen" },
            });
            onEvent({ type: "done", stopReason: "tool-use" });
            return;
          case 4:
            recoveryMessages = args.messages;
            onEvent({ type: "done", stopReason: "end" });
            return;
          default:
            throw new Error("Unexpected provider round");
        }
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient,
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
      maxSeenToolCallIds: 2,
    });
    const { sessionId } = await orchestrator.createSession();

    await orchestrator.sendMessage(
      sessionId,
      "seed the FIFO window",
      "rollback-seed",
    );
    await expect(
      orchestrator.sendMessage(
        sessionId,
        "force a post-registration failure",
        "rollback-failure",
      ),
    ).rejects.toThrow(`${LOCAL_AGENT_MAX_HISTORY_BYTES} byte history budget`);
    await orchestrator.sendMessage(
      sessionId,
      "verify the restored window",
      "rollback-recovery",
    );

    expect(vtdClient.detail.mock.calls.map(([id]) => id)).toEqual([
      "seed-1",
      "seed-2",
      "runs-after-rollback",
    ]);
    expect(toolResults(recoveryMessages?.at(-1))).toEqual([
      expect.objectContaining({
        toolCallId: "rolled-back-call",
        isError: undefined,
      }),
      expect.objectContaining({
        toolCallId: "seed-1",
        isError: true,
        content: expect.objectContaining({
          error: expect.stringContaining("already been used in this session"),
          executed: false,
        }),
      }),
    ]);
  });

  it("trims complete history groups without splitting tool-use/result pairs", async () => {
    let call = 0;
    const stream = jest.fn<Promise<void>, Parameters<ILlmProvider["stream"]>>(
      async (_args, onEvent) => {
        const turn = Math.floor(call / 2);
        if (call++ % 2 === 0) {
          onEvent({
            type: "tool-call",
            id: `catalog-${turn}`,
            name: "get_data_catalog",
            input: {},
          });
          onEvent({ type: "done", stopReason: "tool-use" });
          return;
        }
        onEvent({ type: "done", stopReason: "end" });
      },
    );
    const orchestrator = new LocalAgentOrchestrator({
      provider: { stream },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();
    for (let index = 0; index <= LOCAL_AGENT_MAX_HISTORY_TURNS; index++) {
      await orchestrator.sendMessage(
        sessionId,
        `turn-${index}`,
        `paired-history-${index}`,
      );
    }

    const finalMessages = stream.mock.calls.at(-2)![0].messages;
    for (const [index, message] of finalMessages.entries()) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        continue;
      }
      const toolCalls = message.content.filter(
        (block) => block.type === "tool-call",
      );
      if (toolCalls.length === 0) {
        continue;
      }
      const resultMessage = finalMessages[index + 1];
      expect(resultMessage?.role).toBe("user");
      expect(
        Array.isArray(resultMessage?.content)
          ? resultMessage.content.map((block) =>
              block.type === "tool-result" ? block.toolCallId : undefined,
            )
          : [],
      ).toEqual(toolCalls.map((block) => block.id));
    }
    expect(finalMessages).not.toContainEqual({
      role: "user",
      content: "turn-0",
    });
  });

  it("preserves every Anthropic native block through three orchestrator rounds", async () => {
    const firstContent = [
      {
        type: "thinking",
        thinking: "private signed thought",
        signature: "signature-1",
      },
      {
        type: "tool_use",
        id: "catalog-1",
        name: "get_data_catalog",
        input: {},
      },
    ];
    const secondContent = [
      { type: "redacted_thinking", data: "opaque" },
      {
        type: "tool_use",
        id: "catalog-2",
        name: "get_data_catalog",
        input: {},
      },
    ];
    const finalContent = [
      {
        type: "text",
        text: "Finished",
        citations: [{ type: "page_location", cited_text: "source" }],
      },
      { type: "future_block", opaque: { nested: true } },
    ];
    const sdkStream = jest
      .fn()
      .mockReturnValueOnce({
        on: jest.fn(),
        finalMessage: jest.fn().mockResolvedValue({
          content: firstContent,
          stop_reason: "tool_use",
        }),
      })
      .mockReturnValueOnce({
        on: jest.fn(),
        finalMessage: jest.fn().mockResolvedValue({
          content: secondContent,
          stop_reason: "tool_use",
        }),
      })
      .mockReturnValueOnce({
        on: jest.fn(),
        finalMessage: jest.fn().mockResolvedValue({
          content: finalContent,
          stop_reason: "end_turn",
        }),
      });
    const provider = new AnthropicProvider({
      apiKey: "key",
      maxRetries: 0,
      client: { messages: { stream: sdkStream } } as unknown as Anthropic,
    });
    const orchestrator = new LocalAgentOrchestrator({
      provider,
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const { sessionId } = await orchestrator.createSession();

    await orchestrator.sendMessage(sessionId, "analyze", "native-three-rounds");

    expect(sdkStream).toHaveBeenCalledTimes(3);
    expect(sdkStream.mock.calls[1]?.[0].messages).toEqual(
      expect.arrayContaining([{ role: "assistant", content: firstContent }]),
    );
    expect(sdkStream.mock.calls[2]?.[0].messages).toEqual(
      expect.arrayContaining([
        { role: "assistant", content: firstContent },
        { role: "assistant", content: secondContent },
      ]),
    );
  });

  it("disposes sessions explicitly and when the createSession signal aborts", async () => {
    const orchestrator = new LocalAgentOrchestrator({
      provider: {
        stream: async (_args, onEvent) => {
          onEvent({ type: "done", stopReason: "end" });
        },
      },
      vtdClient: makeVtdClient(),
      getCatalog: () => ({ topics: [], datatypes: new Map() }),
    });
    const parent = new AbortController();
    const { sessionId } = await orchestrator.createSession(parent.signal);
    const subscription = orchestrator.subscribeEvents(sessionId, jest.fn());
    parent.abort();

    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      orchestrator.sendMessage(sessionId, "after dispose", "disposed"),
    ).rejects.toThrow("Unknown local agent session");

    const second = await orchestrator.createSession();
    orchestrator.disposeSession(second.sessionId);
    orchestrator.reset();
    orchestrator.dispose();
    await expect(
      orchestrator.sendMessage(second.sessionId, "after dispose", "disposed-2"),
    ).rejects.toThrow("Unknown local agent session");
  });
});
