// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import HttpVtdClient from "./HttpVtdClient";
import {
  VtdAbortError,
  VtdHttpError,
  VtdJsonError,
  VtdNetworkError,
  VtdResponseSizeError,
  VtdSchemaError,
  VtdTimeoutError,
} from "./errors";

function textResponse(
  text: string,
  status = 200,
  contentLength?: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const bytes = new TextEncoder().encode(text);
  let consumed = false;
  return {
    body: {
      cancel: jest.fn().mockResolvedValue(undefined),
      getReader: () => ({
        cancel: jest.fn().mockResolvedValue(undefined),
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
    headers: {
      get: (name: string) => {
        const lowerName = name.toLowerCase();
        if (lowerName === "content-length") {
          return contentLength;
        }
        return extraHeaders[lowerName] ?? undefined;
      },
    },
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
  } as unknown as Response;
}

function jsonResponse(data: unknown, status = 200): Response {
  const json = JSON.stringify(data);
  if (json == undefined) {
    throw new Error("Test response is not JSON serializable");
  }
  return textResponse(json, status);
}

function invalidJsonResponse(): Response {
  return textResponse("not-json");
}

describe("HttpVtdClient", () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.useRealTimers();
    mockFetch = jest.fn();
  });

  it("posts search parameters and normalizes CLI list output", async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            bot_name: "robot",
            bot_sn: "SN001",
            data_size: 42,
            data_type: "1",
            id: 123,
            trigger_time: "2026-07-27T10:00:00Z",
            trigger_type: "nav",
          },
        ],
        total: 9,
      }),
    );
    const client = new HttpVtdClient("http://sidecar.example/api/", mockFetch);
    const params = { botSn: "SN001", page: 2, pageSize: 20 };

    await expect(client.search(params, controller.signal)).resolves.toEqual({
      records: [
        {
          botName: "robot",
          botSn: "SN001",
          dataType: "1",
          id: "123",
          raw: expect.objectContaining({ id: 123 }),
          sizeBytes: 42,
          triggerTime: "2026-07-27T10:00:00Z",
          triggerType: "nav",
        },
      ],
      total: 9,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      new URL("http://sidecar.example/api/vtd/list"),
      {
        body: JSON.stringify(params),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("normalizes numeric trigger times and nanosecond data bounds", async () => {
    const numericStartNs = Number("1912689768838297225");
    const numericEndNs = Number("1912689798835199400");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            data_type: 2,
            data_et: numericEndNs,
            data_st: numericStartNs,
            id: 842046,
            trigger_time: 1912689788000,
          },
          {
            data_et: "1912689898835199400",
            data_st: "1912689868838297225",
            id: "842047",
            trigger_time: "2030-08-11T14:44:48.000Z",
          },
        ],
      }),
    );

    await expect(
      new HttpVtdClient("http://sidecar", mockFetch).search({}),
    ).resolves.toMatchObject({
      records: [
        {
          dataEndNs: String(numericEndNs),
          dataStartNs: String(numericStartNs),
          dataType: "2",
          id: "842046",
          triggerTime: "2030-08-11T14:43:08.000Z",
        },
        {
          dataEndNs: "1912689898835199400",
          dataStartNs: "1912689868838297225",
          id: "842047",
          triggerTime: "2030-08-11T14:44:48.000Z",
        },
      ],
    });
  });

  it("maps every IVtdClient method to its sidecar command", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }))
      .mockResolvedValueOnce(jsonResponse({ topics: { "/imu": 12 } }))
      .mockResolvedValueOnce(
        jsonResponse({ mcap_slice_id: "slice-1", tos: "tos://slice" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          download_url: "https://download/slice",
          mcap_slice_id: "slice-1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ download_url: "https://download/full" }),
      )
      .mockResolvedValueOnce(jsonResponse({ records: [], logs: [] }));
    const client = new HttpVtdClient("http://sidecar", mockFetch);

    await expect(client.detail("record-1")).resolves.toEqual({
      id: "record-1",
    });
    await expect(client.topics("record-1")).resolves.toEqual({ "/imu": 12 });
    await expect(
      client.sliceStore({
        endNs: "20",
        id: "record-1",
        startNs: "10",
        topics: ["/imu"],
      }),
    ).resolves.toMatchObject({ mcapSliceId: "slice-1" });
    await expect(client.sliceGet("slice-1")).resolves.toMatchObject({
      downloadUrl: "https://download/slice",
    });
    await expect(client.url("record-1")).resolves.toEqual({
      downloadUrl: "https://download/full",
    });
    await expect(
      client.trigger({ all: true, triggerId: "trigger-1" }),
    ).resolves.toEqual({
      logs: [],
      records: [],
    });

    const requests = mockFetch.mock.calls.map(([request, init]) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      if (!(request instanceof URL)) {
        throw new Error("Expected a URL request");
      }
      return [request.href, JSON.parse(init.body) as unknown];
    });
    expect(requests).toEqual([
      ["http://sidecar/vtd/detail", { id: "record-1" }],
      ["http://sidecar/vtd/topics", { id: "record-1" }],
      [
        "http://sidecar/vtd/slice-store",
        { endNs: "20", id: "record-1", startNs: "10", topics: ["/imu"] },
      ],
      ["http://sidecar/vtd/slice-get", { sliceId: "slice-1" }],
      ["http://sidecar/vtd/url", { id: "record-1" }],
      ["http://sidecar/vtd/trigger", { all: true, triggerId: "trigger-1" }],
    ]);
  });

  it("omits empty or unselected topics from slice-store request bodies", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ mcap_slice_id: "slice-all-1", tos: "tos://slice-1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ mcap_slice_id: "slice-all-2", tos: "tos://slice-2" }),
      );
    const client = new HttpVtdClient("http://sidecar", mockFetch);

    await client.sliceStore({ id: "record-1", topics: [] });
    await client.sliceStore({ id: "record-2", topics: undefined });

    const bodies = mockFetch.mock.calls.map(([_request, init]) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      return JSON.parse(init.body) as unknown;
    });
    expect(bodies).toStrictEqual([{ id: "record-1" }, { id: "record-2" }]);
  });

  it("classifies HTTP status errors with structured response data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "bad filter" }, 400));

    const error = await new HttpVtdClient("http://sidecar", mockFetch)
      .search({})
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VtdHttpError);
    expect(error).toMatchObject({
      command: "list",
      responseBody: '{"error":"bad filter"}',
      status: 400,
      statusText: "Bad Request",
    });
  });

  it("classifies network, JSON, and schema failures independently", async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const networkCause = new TypeError("connection refused");
      mockFetch
        .mockRejectedValueOnce(networkCause)
        .mockRejectedValueOnce(networkCause)
        .mockRejectedValueOnce(networkCause)
        .mockResolvedValueOnce(invalidJsonResponse())
        .mockResolvedValueOnce(jsonResponse({ download_url: "" }));
      const client = new HttpVtdClient("http://sidecar", mockFetch);

      // A network failure is retryable: after the 2 allowed retries the final error carries the
      // retry context.
      const networkPromise = client
        .detail("record-1")
        .catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(600); // backoff 1 (500ms + deterministic jitter)
      await jest.advanceTimersByTimeAsync(1600); // backoff 2 (1500ms + deterministic jitter)
      const network = await networkPromise;
      expect(network).toBeInstanceOf(VtdNetworkError);
      expect((network as Error & { cause?: unknown }).cause).toBe(networkCause);
      expect(network).toMatchObject({ command: "detail", retries: 2 });
      expect((network as Error).message).toContain("(retried 2 times)");

      // JSON and schema failures are not retryable and surface on the first attempt.
      await expect(client.detail("record-1")).rejects.toBeInstanceOf(
        VtdJsonError,
      );
      await expect(client.url("record-1")).rejects.toBeInstanceOf(
        VtdSchemaError,
      );
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  it("aborts a pending fetch when the caller signal is aborted", async () => {
    mockFetch.mockImplementationOnce(
      async () =>
        await new Promise<Response>(() => {
          // The lifecycle race must reject even if a non-compliant fetch implementation ignores abort.
        }),
    );
    const controller = new AbortController();
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
      controller.signal,
    );
    void request.catch(() => {});

    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toBeInstanceOf(VtdAbortError);
    const fetchSignal = mockFetch.mock.calls[0]?.[1]?.signal;
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("enforces its own timeout across a permanently pending fetch", async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementationOnce(
      async () =>
        await new Promise<Response>(() => {
          // Intentionally pending.
        }),
    );
    const request = new HttpVtdClient("http://sidecar", mockFetch, 100).detail(
      "record-1",
    );
    void request.catch(() => {});

    jest.advanceTimersByTime(100);

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdTimeoutError);
    expect(error).toMatchObject({ command: "detail", timeoutMs: 100 });
    const fetchSignal = mockFetch.mock.calls[0]?.[1]?.signal;
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("validates and composes endpoints with URL semantics", () => {
    expect(() => new HttpVtdClient("", mockFetch)).toThrow("must not be empty");
    expect(() => new HttpVtdClient("ftp://sidecar", mockFetch)).toThrow(
      "HTTP(S)",
    );
    expect(
      () => new HttpVtdClient("https://user:secret@sidecar", mockFetch),
    ).toThrow("without credentials");
    expect(
      () => new HttpVtdClient("https://sidecar/api?tenant=a", mockFetch),
    ).toThrow("without credentials");
  });

  it("adds bearer authorization only when an auth token is configured", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    const client = new HttpVtdClient(
      "http://sidecar",
      mockFetch,
      30_000,
      "secret-token",
    );

    await client.detail("record-1");

    expect(mockFetch).toHaveBeenCalledWith(
      new URL("http://sidecar/vtd/detail"),
      expect.objectContaining({
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
      }),
    );
    expect(
      () =>
        new HttpVtdClient("http://sidecar", mockFetch, 30_000, "bad\ntoken"),
    ).toThrow("must not contain line breaks");
  });

  it("rejects response bodies larger than 32 MiB before reading them", async () => {
    const response = textResponse("{}", 200, String(32 * 1024 * 1024 + 1));
    mockFetch.mockResolvedValueOnce(response);

    const error = await new HttpVtdClient("http://sidecar", mockFetch)
      .detail("record-1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VtdResponseSizeError);
    expect(error).toMatchObject({
      command: "detail",
      maximumBytes: 32 * 1024 * 1024,
    });
    expect((response.body?.cancel as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("cancels a streaming body as soon as the cumulative limit is exceeded", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const releaseLock = jest.fn();
    const read = jest.fn().mockResolvedValueOnce({
      done: false,
      value: { byteLength: 32 * 1024 * 1024 + 1 } as Uint8Array,
    });
    mockFetch.mockResolvedValueOnce({
      body: { getReader: () => ({ cancel, read, releaseLock }) },
      headers: { get: () => undefined },
      ok: true,
      status: 200,
      statusText: "OK",
    } as unknown as Response);

    await expect(
      new HttpVtdClient("http://sidecar", mockFetch).detail("record-1"),
    ).rejects.toBeInstanceOf(VtdResponseSizeError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe("HttpVtdClient retry behavior", () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    // Deterministic jitter: factor 0.5 + 0.5 = 1.0, so backoffs are exactly 500ms/1500ms.
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    mockFetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retries a 502 once and succeeds after the 500ms backoff", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse("upstream hiccup", 502))
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
    );
    void request.catch(() => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(499);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ id: "record-1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after 2 retries and surfaces the retry context", async () => {
    mockFetch.mockResolvedValue(textResponse("upstream hiccup", 502));
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(600); // backoff 1 (500ms + jitter)
    await jest.advanceTimersByTimeAsync(1600); // backoff 2 (1500ms + jitter)
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdHttpError);
    expect(error).toMatchObject({
      command: "detail",
      retries: 2,
      status: 502,
    });
    expect((error as Error).message).toContain("(retried 2 times)");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the retry context when the final attempt fails with a non-retryable error", async () => {
    // Two retried 502s, then an invalid-JSON response: the final VtdJsonError (which itself is
    // never retried) must still carry the retry count.
    mockFetch
      .mockResolvedValueOnce(textResponse("upstream hiccup", 502))
      .mockResolvedValueOnce(textResponse("upstream hiccup", 502))
      .mockResolvedValueOnce(invalidJsonResponse());
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(600);
    await jest.advanceTimersByTimeAsync(1600);
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdJsonError);
    expect(error).toMatchObject({ command: "detail", retries: 2 });
    expect((error as Error).message).toContain("(retried 2 times)");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the retry context when the final attempt fails schema validation", async () => {
    // Two retried 502s, then a 200 response that fails the schema normalization (which runs
    // outside the retry loop): the final VtdSchemaError must still carry the retry count.
    mockFetch
      .mockResolvedValueOnce(textResponse("upstream hiccup", 502))
      .mockResolvedValueOnce(textResponse("upstream hiccup", 502))
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    const request = new HttpVtdClient("http://sidecar", mockFetch).search({});
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(600);
    await jest.advanceTimersByTimeAsync(1600);
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdSchemaError);
    expect(error).toMatchObject({ command: "list", retries: 2 });
    expect((error as Error).message).toContain("(retried 2 times)");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("respects a valid Retry-After seconds value for 429 instead of the backoff", async () => {
    mockFetch
      .mockResolvedValueOnce(
        textResponse("too many requests", 429, undefined, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ id: "record-1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("respects an HTTP-date Retry-After value for 429", async () => {
    // A fixed fake clock keeps Date.parse and Date.now consistent.
    jest.useFakeTimers({ now: Date.parse("2026-08-07T08:00:00.000Z") });
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    const retryAfterDate = "Fri, 07 Aug 2026 08:00:02 GMT";
    mockFetch
      .mockResolvedValueOnce(
        textResponse("too many requests", 429, undefined, {
          "retry-after": retryAfterDate,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ id: "record-1" });
  });

  it("ignores an invalid Retry-After and falls back to the backoff", async () => {
    mockFetch
      .mockResolvedValueOnce(
        textResponse("too many requests", 429, undefined, {
          "retry-after": "soon-ish",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(500);
    await expect(request).resolves.toEqual({ id: "record-1" });
  });

  it("ignores a non-integer Retry-After like 0.5 as malformed", async () => {
    // "0.5" is neither pure-delta-seconds nor a valid HTTP-date; it must not be read as an
    // historical date (Date.parse alone would parse it) and must fall back to the backoff.
    mockFetch
      .mockResolvedValueOnce(
        textResponse("too many requests", 429, undefined, {
          "retry-after": "0.5",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(499);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ id: "record-1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries immediately when Retry-After: 0 fits the remaining budget", async () => {
    // With a tight budget (100ms) the 500ms backoff would not fit, but a valid Retry-After of 0
    // seconds means an immediate retry — it must win over the give-up path.
    mockFetch
      .mockResolvedValueOnce(
        textResponse("too many requests", 429, undefined, {
          "retry-after": "0",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    const request = new HttpVtdClient("http://sidecar", mockFetch, 100).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(0);
    await expect(request).resolves.toEqual({ id: "record-1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("ignores a Retry-After that exceeds the remaining budget", async () => {
    mockFetch
      .mockResolvedValueOnce(
        textResponse("too many requests", 429, undefined, {
          "retry-after": "60",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "record-1" }));
    // The 60s Retry-After does not fit the 1s budget; the 500ms backoff is used instead.
    const request = new HttpVtdClient("http://sidecar", mockFetch, 1000).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(500);
    await expect(request).resolves.toEqual({ id: "record-1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry slice-store (side-effecting) or non-whitelisted statuses", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse("upstream hiccup", 502))
      .mockResolvedValueOnce(jsonResponse({ mcap_slice_id: "slice-1" }));
    await expect(
      new HttpVtdClient("http://sidecar", mockFetch).sliceStore({
        id: "record-1",
      }),
    ).rejects.toBeInstanceOf(VtdHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(textResponse("bad filter", 400))
      .mockResolvedValueOnce(jsonResponse({ records: [] }));
    await expect(
      new HttpVtdClient("http://sidecar", mockFetch).search({}),
    ).rejects.toBeInstanceOf(VtdHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts during the first backoff without issuing the retry and without counting it", async () => {
    mockFetch.mockResolvedValue(textResponse("upstream hiccup", 502));
    const controller = new AbortController();
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
      controller.signal,
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(100); // inside the first backoff
    controller.abort(new Error("caller cancelled"));

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdAbortError);
    // One request was sent and zero retries were ever issued: the interrupted backoff must not
    // inflate the count.
    expect(error).toMatchObject({ command: "detail", retries: 0 });
    expect((error as Error).message).not.toContain("retried");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts during the second backoff after one completed retry and reports retries=1", async () => {
    mockFetch.mockResolvedValue(textResponse("upstream hiccup", 502));
    const controller = new AbortController();
    const request = new HttpVtdClient("http://sidecar", mockFetch).detail(
      "record-1",
      controller.signal,
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(500); // first backoff → retry request issued
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(100); // inside the second backoff
    controller.abort(new Error("caller cancelled"));

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdAbortError);
    expect(error).toMatchObject({ command: "detail", retries: 1 });
    expect((error as Error).message).toContain("(retried 1 times)");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("enforces the total deadline across attempts and backoffs", async () => {
    // Attempt 1 fails instantly; the 500ms backoff fits; attempt 2 fails; the 1500ms backoff no
    // longer fits the remaining budget, so the invocation gives up after 1 retry.
    mockFetch.mockResolvedValue(textResponse("upstream hiccup", 502));
    const request = new HttpVtdClient("http://sidecar", mockFetch, 1200).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(500);
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 502, retries: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up immediately when even the first backoff exceeds the deadline", async () => {
    mockFetch.mockResolvedValue(textResponse("upstream hiccup", 502));
    const request = new HttpVtdClient("http://sidecar", mockFetch, 300).detail(
      "record-1",
    );
    void request.catch(() => {});

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 502, retries: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("carries no retry context when the first backoff wait crosses the deadline", async () => {
    // The first backoff (500ms) exactly consumes the 500ms budget; the deadline is hit before
    // any retry request was issued, so the timeout must not report a retry.
    mockFetch.mockResolvedValue(textResponse("upstream hiccup", 502));
    const request = new HttpVtdClient("http://sidecar", mockFetch, 500).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(500);
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdTimeoutError);
    expect(error).toMatchObject({ command: "detail", retries: 0 });
    expect((error as Error).message).not.toContain("retried");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("carries the retry context when the deadline hits after one completed retry", async () => {
    // Attempt 1 fails; backoff 500ms → retry request issued (retries=1) and fails; the 1500ms
    // backoff exactly consumes the remaining 1500ms of the 2000ms budget, so the next loop
    // iteration hits the deadline with one actually-issued retry.
    mockFetch.mockResolvedValue(textResponse("upstream hiccup", 502));
    const request = new HttpVtdClient("http://sidecar", mockFetch, 2000).detail(
      "record-1",
    );
    void request.catch(() => {});

    await jest.advanceTimersByTimeAsync(2000);
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VtdTimeoutError);
    expect(error).toMatchObject({ command: "detail", retries: 1 });
    expect((error as Error).message).toContain("(retried 1 times)");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("classifies sidecar JSON errors and ALB HTML pages in the error detail", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "upstream-error" }, 400));
    const sidecarError = await new HttpVtdClient("http://sidecar", mockFetch)
      .detail("record-1")
      .catch((caught: unknown) => caught);
    expect(sidecarError).toBeInstanceOf(VtdHttpError);
    expect((sidecarError as VtdHttpError).detail()).toBe("upstream-error");
    expect((sidecarError as Error).message).toContain("upstream-error");
    expect((sidecarError as Error).message).not.toContain('{"error"');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      textResponse("<html><body>502 Bad Gateway</body></html>", 400),
    );
    const htmlError = await new HttpVtdClient("http://sidecar", mockFetch)
      .detail("record-1")
      .catch((caught: unknown) => caught);
    expect(htmlError).toBeInstanceOf(VtdHttpError);
    expect((htmlError as VtdHttpError).detail()).toBe(
      "gateway returned an HTML error page",
    );
    expect((htmlError as Error).message).toContain(
      "gateway returned an HTML error page",
    );
    expect((htmlError as Error).message).not.toContain("<html>");
  });
});
