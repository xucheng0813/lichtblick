// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  AGENT_SSE_MAX_CONNECTION_BYTES,
  AGENT_SSE_MAX_CONNECTION_EVENTS,
  AGENT_SSE_MAX_EVENT_BYTES,
  AgentClient,
  AgentStreamIdleTimeoutError,
  AgentStreamProtocolError,
  AgentStreamSizeLimitError,
} from "./AgentClient";
import type { AgentEvent } from "./types";

const mockFetch = jest.fn();
global.fetch = mockFetch;

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    headers: new Headers({ "content-type": "application/json" }),
    json: jest.fn().mockResolvedValue(data),
    text: jest.fn().mockResolvedValue(JSON.stringify(data)),
  } as unknown as Response;
}

function eventStreamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
    body,
  } as Response;
}

describe("AgentClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("creates a session with the injected base URL and forwards AbortSignal", async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(jsonResponse({ sessionId: "session-1" }));
    const client = new AgentClient("https://agent.example.com/");

    await expect(client.createSession(controller.signal)).resolves.toEqual({
      sessionId: "session-1",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://agent.example.com/agent/sessions",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
        signal: controller.signal,
      }),
    );
  });

  it("accepts an HttpService-style data envelope when creating a session", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { sessionId: "session-2" } }));

    await expect(new AgentClient("").createSession()).resolves.toEqual({
      sessionId: "session-2",
    });
  });

  it("posts messages to the encoded session URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    const client = new AgentClient("https://agent.example.com");

    await client.sendMessage("session/with space", "show lidar", "request-1");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://agent.example.com/agent/sessions/session%2Fwith%20space/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "show lidar", requestId: "request-1" }),
      }),
    );
  });

  it("rejects an empty sendMessage requestId before making a request", async () => {
    await expect(new AgentClient("").sendMessage("session-1", "hello", "")).rejects.toThrow(
      "requestId must be a non-empty string",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [true, "confirm"],
    [false, "cancel"],
  ])("posts tool-run confirmation action (approve=%s)", async (approve, action) => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const client = new AgentClient("https://agent.example.com");
    const controller = new AbortController();

    await client.confirmToolRun("session-1", "tool/1", { approve }, controller.signal);

    expect(mockFetch).toHaveBeenCalledWith(
      `https://agent.example.com/agent/tool-runs/tool%2F1/${action}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" }),
        signal: controller.signal,
      }),
    );
  });

  it("notifies the session when the catalog is ready", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const controller = new AbortController();

    await new AgentClient("https://agent.example.com").notifyCatalogReady(
      "session/1",
      "request-1",
      controller.signal,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://agent.example.com/agent/sessions/session%2F1/catalog-ready",
      expect.objectContaining({
        body: JSON.stringify({ requestId: "request-1" }),
        method: "POST",
        signal: controller.signal,
      }),
    );
  });

  it("rejects an empty catalog-ready requestId before making a request", async () => {
    await expect(new AgentClient("").notifyCatalogReady("session-1", "")).rejects.toThrow(
      "requestId must be a non-empty string",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("parses SSE events across arbitrary chunk and line-ending boundaries", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([
        ': keep-alive\r\ndata: {"seq":1,"requestId":"r1","type":"message-start","messageId":"m1"}\r',
        '\n\r\ndata: {"seq":2,"requestId":"r1","type":"token","messageId":"m1","delta":"hel',
        'lo"}\n\ndata: {"seq":3,"requestId":"r1","type":"message-end","messageId":"m1"}\n\n',
        'data: {"seq":4,"requestId":"r1","type":"done"}\n\n',
      ]),
    );
    const events: AgentEvent[] = [];
    const client = new AgentClient("https://agent.example.com");

    await client.subscribeEvents("session-1", (event) => events.push(event));

    expect(events).toEqual([
      { seq: 1, requestId: "r1", type: "message-start", messageId: "m1" },
      { seq: 2, requestId: "r1", type: "token", messageId: "m1", delta: "hello" },
      { seq: 3, requestId: "r1", type: "message-end", messageId: "m1" },
      { seq: 4, requestId: "r1", type: "done" },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://agent.example.com/agent/sessions/session-1/events",
      expect.objectContaining({
        credentials: "same-origin",
        method: "GET",
      }),
    );
  });

  it("parses a final v1 frame even when the stream omits the trailing blank line", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([
        'data: {"seq":1,"type":"error","error":"backend unavailable"}\n\n',
        'data: {"seq":2,"requestId":"r1","type":"done"}',
      ]),
    );
    const events: AgentEvent[] = [];

    await new AgentClient("").subscribeEvents("session-1", (event) => events.push(event));

    expect(events).toEqual([
      { seq: 1, type: "error", error: "backend unavailable" },
      { seq: 2, requestId: "r1", type: "done" },
    ]);
  });

  it("skips isolated non-JSON data heartbeats and resumes parsing valid events", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([
        "data: ping\n\n",
        'data: {"seq":1,"requestId":"r1","type":"token","messageId":"m1","delta":"ok"}\n\n',
        "data: still-alive\n\n",
        'data: {"seq":2,"requestId":"r1","type":"done"}\n\n',
      ]),
    );
    const events: AgentEvent[] = [];

    await new AgentClient("").subscribeEvents("session-1", (event) => events.push(event));

    expect(events).toEqual([
      { seq: 1, requestId: "r1", type: "token", messageId: "m1", delta: "ok" },
      { seq: 2, requestId: "r1", type: "done" },
    ]);
  });

  it("rejects after three consecutive non-JSON data frames", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse(["data: ping\n\ndata: ping\n\ndata: ping\n\n"]),
    );

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn()),
    ).rejects.toBeInstanceOf(AgentStreamProtocolError);
  });

  it("treats an event without seq as a bad frame and continues after a valid event", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([
        'data: {"requestId":"r1","type":"token","messageId":"m1","delta":"ignored"}\n\n',
        'data: {"seq":1,"requestId":"r1","type":"done"}\n\n',
      ]),
    );
    const events: AgentEvent[] = [];

    await new AgentClient("").subscribeEvents("session-1", (event) => events.push(event));

    expect(events).toEqual([{ seq: 1, requestId: "r1", type: "done" }]);
  });

  it("rejects after three consecutive events without a valid seq", async () => {
    const missingSeq = 'data: {"requestId":"r1","type":"done"}\n\n';
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([missingSeq, missingSeq, missingSeq]),
    );

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn()),
    ).rejects.toBeInstanceOf(AgentStreamProtocolError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "treats seq=%s as an invalid frame",
    async (seq) => {
      mockFetch.mockResolvedValueOnce(
        eventStreamResponse([
          `data: {"seq":${seq},"requestId":"r1","type":"done"}\n\n`,
          'data: {"seq":1,"requestId":"r1","type":"done"}\n\n',
        ]),
      );
      const events: AgentEvent[] = [];

      await new AgentClient("").subscribeEvents("session-1", (event) => events.push(event));

      expect(events).toEqual([{ seq: 1, requestId: "r1", type: "done" }]);
    },
  );

  it("accepts Number.MAX_SAFE_INTEGER as an event seq", async () => {
    const maxSeq = Number.MAX_SAFE_INTEGER;
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([
        `data: {"seq":${maxSeq},"requestId":"r1","type":"done"}\n\n`,
      ]),
    );
    const events: AgentEvent[] = [];

    await new AgentClient("").subscribeEvents("session-1", (event) => events.push(event));

    expect(events).toEqual([{ seq: maxSeq, requestId: "r1", type: "done" }]);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects lastSeq=%s before opening a connection",
    async (lastSeq) => {
      await expect(
        new AgentClient("").subscribeEvents("session-1", jest.fn(), undefined, { lastSeq }),
      ).rejects.toThrow("lastSeq must be a non-negative safe integer");
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("accepts Number.MAX_SAFE_INTEGER as lastSeq", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([]),
    );

    await new AgentClient("https://agent.example.com").subscribeEvents(
      "session-1",
      jest.fn(),
      undefined,
      { lastSeq: Number.MAX_SAFE_INTEGER },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      `https://agent.example.com/agent/sessions/session-1/events?lastSeq=${Number.MAX_SAFE_INTEGER}`,
      expect.anything(),
    );
  });

  it("requests replay after lastSeq and discards replayed or out-of-order events", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([
        'data: {"seq":3,"requestId":"r1","type":"done"}\n\n',
        'data: {"seq":4,"requestId":"r2","type":"done"}\n\n',
        'data: {"seq":2,"requestId":"r1","type":"done"}\n\n',
      ]),
    );
    const events: AgentEvent[] = [];

    await new AgentClient("https://agent.example.com").subscribeEvents(
      "session/1",
      (event) => events.push(event),
      undefined,
      { lastSeq: 3 },
    );

    expect(events).toEqual([{ seq: 4, requestId: "r2", type: "done" }]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://agent.example.com/agent/sessions/session%2F1/events?lastSeq=3",
      expect.anything(),
    );
  });

  it("resolves normally when a session SSE connection reaches EOF without done", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([
        'data: {"seq":1,"requestId":"r1","type":"message-start","messageId":"m1"}\n\n',
        'data: {"seq":2,"requestId":"r1","type":"token","messageId":"m1","delta":"partial"}\n\n',
      ]),
    );
    const events: AgentEvent[] = [];

    await expect(
      new AgentClient("").subscribeEvents("session-1", (event) => events.push(event)),
    ).resolves.toEqual({ reason: "eof" });
    expect(events).toHaveLength(2);
  });

  it("rejects an SSE frame larger than one MiB and cancels the stream", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([`data: ${"x".repeat(1024 * 1024 + 1)}\n\n`]),
    );

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn()),
    ).rejects.toBeInstanceOf(AgentStreamSizeLimitError);
  });

  it("rejects an incomplete SSE frame that grows beyond one MiB across chunks", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse([`data: ${"x".repeat(600 * 1024)}`, "x".repeat(600 * 1024)]),
    );

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn()),
    ).rejects.toBeInstanceOf(AgentStreamSizeLimitError);
  });

  it("accepts many small frames regardless of whether they share an oversized read chunk", async () => {
    const smallFrame = (seq: number) =>
      `data: {"seq":${seq},"requestId":"r1","type":"token","messageId":"m1","delta":"${"x".repeat(
        10 * 1024,
      )}"}\n\n`;
    const oversizedChunk = Array.from(
      { length: 110 },
      (_, index) => smallFrame(index + 1),
    ).join("");
    expect(new TextEncoder().encode(oversizedChunk).byteLength).toBeGreaterThan(
      AGENT_SSE_MAX_EVENT_BYTES,
    );
    const splitIndex = Math.floor(oversizedChunk.length / 2);
    mockFetch
      .mockResolvedValueOnce(eventStreamResponse([oversizedChunk]))
      .mockResolvedValueOnce(
        eventStreamResponse([
          oversizedChunk.slice(0, splitIndex),
          oversizedChunk.slice(splitIndex),
        ]),
      );
    const oneChunkEvents: AgentEvent[] = [];
    const splitChunkEvents: AgentEvent[] = [];
    const client = new AgentClient("");

    await expect(
      client.subscribeEvents("session-1", (event) => oneChunkEvents.push(event)),
    ).resolves.toEqual({ reason: "eof" });
    await expect(
      client.subscribeEvents("session-1", (event) => splitChunkEvents.push(event)),
    ).resolves.toEqual({ reason: "eof" });
    expect(oneChunkEvents).toEqual(splitChunkEvents);
    expect(oneChunkEvents).toHaveLength(110);
  });

  it("rejects a connection after its cumulative event count budget", async () => {
    const frames = Array.from(
      { length: AGENT_SSE_MAX_CONNECTION_EVENTS + 1 },
      (_, index) =>
        `data: {"seq":${index + 1},"requestId":"r${index}","type":"done"}\n\n`,
    ).join("");
    mockFetch.mockResolvedValueOnce(eventStreamResponse([frames]));

    await expect(
      new AgentClient("").subscribeEvents("session-1", () => {}),
    ).rejects.toThrow(`${AGENT_SSE_MAX_CONNECTION_EVENTS} event connection limit`);
  });

  it("resets cumulative event budgets for each physical connection", async () => {
    const frames = Array.from(
      { length: AGENT_SSE_MAX_CONNECTION_EVENTS },
      (_, index) =>
        `data: {"seq":${index + 1},"requestId":"r${index}","type":"done"}\n\n`,
    ).join("");
    mockFetch
      .mockResolvedValueOnce(eventStreamResponse([frames]))
      .mockResolvedValueOnce(eventStreamResponse([frames]));
    const client = new AgentClient("");

    await expect(client.subscribeEvents("session-1", jest.fn())).resolves.toEqual({
      reason: "eof",
    });
    await expect(client.subscribeEvents("session-1", jest.fn())).resolves.toEqual({
      reason: "eof",
    });
  });

  it("rejects a connection after its cumulative byte budget", async () => {
    const payload = "x".repeat(900 * 1024);
    const chunkCount = Math.ceil(AGENT_SSE_MAX_CONNECTION_BYTES / (900 * 1024)) + 1;
    const chunks = Array.from(
      { length: chunkCount },
      (_, index) =>
        `data: {"seq":${index + 1},"requestId":"r1","type":"token","messageId":"m1","delta":"${payload}"}\n\n`,
    );
    mockFetch.mockResolvedValueOnce(eventStreamResponse(chunks));

    await expect(
      new AgentClient("").subscribeEvents("session-1", () => {}),
    ).rejects.toThrow(`${AGENT_SSE_MAX_CONNECTION_BYTES} byte connection limit`);
  });

  it("rejects when an event stream receives no bytes before the idle timeout", async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Leave the stream open and idle.
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
    });

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn(), undefined, {
        idleTimeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(AgentStreamIdleTimeoutError);
  });

  it("clamps idleTimeoutMs to the maximum platform timer delay", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    mockFetch.mockResolvedValueOnce(eventStreamResponse([]));

    await new AgentClient("").subscribeEvents("session-1", jest.fn(), undefined, {
      idleTimeoutMs: 3_000_000_000,
    });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
    setTimeoutSpy.mockRestore();
  });

  it("rejects malformed agent events", async () => {
    mockFetch.mockResolvedValueOnce(
      eventStreamResponse(['data: {"seq":1,"type":"unknown"}\n\n']),
    );

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn()),
    ).rejects.toThrow("Invalid agent event received");
  });

  it.each([
    { seq: 1, requestId: "", type: "message-start", messageId: "m1" },
    { seq: 1, requestId: "", type: "done" },
    { seq: 1, requestId: "", type: "error", error: "request failed" },
  ])("rejects an empty requestId in request-scoped events", async (event) => {
    mockFetch.mockResolvedValueOnce(eventStreamResponse([`data: ${JSON.stringify(event)}\n\n`]));

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn()),
    ).rejects.toThrow("Invalid agent event received");
  });

  it.each([
    {
      seq: 1,
      requestId: "r1",
      type: "tool-update",
      messageId: "m1",
      toolRun: { id: "t1", name: "slice", status: "running", progress: null },
    },
    {
      seq: 1,
      requestId: "r1",
      type: "layout-proposal",
      messageId: "m1",
      proposal: { name: "layout", data: {}, summary: null },
    },
    {
      seq: 1,
      requestId: "r1",
      type: "open-data-source",
      messageId: "m1",
      urls: ["https://example.com/data.mcap"],
      sessionId: null,
    },
  ])("rejects null in optional event fields", async (event) => {
    mockFetch.mockResolvedValueOnce(eventStreamResponse([`data: ${JSON.stringify(event)}\n\n`]));

    await expect(
      new AgentClient("").subscribeEvents("session-1", jest.fn()),
    ).rejects.toThrow("Invalid agent event received");
  });

  it("aborts an active event subscription", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
    });
    const controller = new AbortController();

    const subscription = new AgentClient("").subscribeEvents(
      "session-1",
      jest.fn(),
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();

    await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
    expect(streamController).toBeDefined();
  });

  it.each([
    [
      "message-end",
      'data: {"seq":1,"requestId":"r1","type":"message-end","messageId":"m1"}\n\n',
    ],
    ["done", 'data: {"seq":1,"requestId":"r1","type":"done"}\n\n'],
  ])("rejects caller abort even after a terminal %s event", async (_name, frame) => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(eventStreamResponse([frame]));

    await expect(
      new AgentClient("").subscribeEvents(
        "session-1",
        () => {
          controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws HttpError with response details for non-successful requests", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "invalid" }, 400));

    await expect(
      new AgentClient("").sendMessage("session-1", "hello", "request-1"),
    ).rejects.toMatchObject({
      name: "HttpError",
      status: 400,
      statusText: "Bad Request",
    });
  });
});
