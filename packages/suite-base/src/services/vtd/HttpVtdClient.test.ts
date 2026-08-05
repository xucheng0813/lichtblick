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
      get: (name: string) =>
        name.toLowerCase() === "content-length" ? contentLength : undefined,
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
    const networkCause = new TypeError("connection refused");
    mockFetch
      .mockRejectedValueOnce(networkCause)
      .mockResolvedValueOnce(invalidJsonResponse())
      .mockResolvedValueOnce(jsonResponse({ download_url: "" }));
    const client = new HttpVtdClient("http://sidecar", mockFetch);

    const network = await client
      .detail("record-1")
      .catch((caught: unknown) => caught);
    expect(network).toBeInstanceOf(VtdNetworkError);
    expect((network as Error & { cause?: unknown }).cause).toBe(networkCause);

    await expect(client.detail("record-1")).rejects.toBeInstanceOf(
      VtdJsonError,
    );
    await expect(client.url("record-1")).rejects.toBeInstanceOf(VtdSchemaError);
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
