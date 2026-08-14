// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { globalRequestQueue } from "@lichtblick/suite-base/util/RequestQueue";
import { BasicBuilder } from "@lichtblick/test-builders";

import FetchReader from "./FetchReader";

// Mock the global request queue
jest.mock("@lichtblick/suite-base/util/RequestQueue", () => ({
  globalRequestQueue: {
    run: jest.fn(),
  },
}));

const mockGlobalRequestQueue = globalRequestQueue as jest.Mocked<typeof globalRequestQueue>;
const url = "https://example.com/data.mcap";

describe("FetchReader", () => {
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.spyOn(global, "fetch");

    // Default: globalRequestQueue.run passes through the function
    mockGlobalRequestQueue.run.mockImplementation(async (fn) => fn);
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe("constructor and fetch queueing", () => {
    it("passes options and abort signal to fetch when queued request executes", async () => {
      const options: RequestInit = {
        headers: { "Custom-Header": BasicBuilder.string() },
        method: "GET",
      };

      const mockResponse = new Response(new ReadableStream(), { status: 200 });
      mockFetch.mockResolvedValue(mockResponse);

      const reader = new FetchReader(url, options);

      // Execute the queued fetch
      const queuedFn = mockGlobalRequestQueue.run.mock.calls[0]![0];
      await queuedFn();

      expect(mockFetch).toHaveBeenCalledWith(url, {
        ...options,
        signal: expect.any(AbortSignal),
      });

      reader.destroy();
    });

    it("queues fetch request through globalRequestQueue", () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const runGlobalRequestQueueMock = mockGlobalRequestQueue.run;
      new FetchReader(url);

      // Verify fetch is queued, not called directly
      expect(runGlobalRequestQueueMock).toHaveBeenCalledTimes(1);
      expect(runGlobalRequestQueueMock).toHaveBeenCalledWith(expect.any(Function));
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("streaming events", () => {
    // Make the queue execute the queued fetch and resolve with the fetch promise.
    beforeEach(() => {
      mockGlobalRequestQueue.run.mockImplementation(async (fn) => await fn());
    });

    it("emits data chunks and end while streaming a response body", async () => {
      const encoder = new TextEncoder();
      mockFetch.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("hello "));
              controller.enqueue(encoder.encode("world"));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );

      const reader = new FetchReader(url);
      const chunks: string[] = [];
      const errorPromise = new Promise<Error>((resolve) => reader.on("error", resolve));
      const ended = new Promise<void>((resolve) => reader.on("end", resolve));
      reader.on("data", (chunk) => chunks.push(new TextDecoder().decode(chunk)));
      reader.read();

      await Promise.race([
        ended,
        errorPromise.then((error) => {
          throw error;
        }),
      ]);
      expect(chunks).toEqual(["hello ", "world"]);
      reader.destroy();
    });

    it("emits an error when the fetch fails", async () => {
      mockFetch.mockRejectedValue(new Error("network down"));

      const reader = new FetchReader(url);
      const errorPromise = new Promise<Error>((resolve) => reader.on("error", resolve));
      reader.read();

      await expect(errorPromise).resolves.toThrow(
        "GET <https://example.com/data.mcap> failed: Error: network down",
      );
      reader.destroy();
    });

    it("emits an error for a non-ok response", async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" }));

      const reader = new FetchReader(url);
      const errorPromise = new Promise<Error>((resolve) => reader.on("error", resolve));
      reader.read();

      await expect(errorPromise).resolves.toThrow("failed with status 404 (Not Found)");
      reader.destroy();
    });

    it("emits end instead of error when destroyed mid-read", async () => {
      // A response body that never produces data, but errors when the request is aborted.
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            });
          },
        });
        return new Response(stream, { status: 200 });
      });

      const reader = new FetchReader(url);
      const errorPromise = new Promise<Error>((resolve) => reader.on("error", resolve));
      let ended = false;
      const endedPromise = new Promise<void>((resolve) => {
        reader.on("end", () => {
          ended = true;
          resolve();
        });
      });
      reader.read();
      reader.destroy();

      await Promise.race([
        endedPromise,
        errorPromise.then((error) => {
          throw error;
        }),
      ]);
      expect(ended).toBe(true);
    });
  });
});
