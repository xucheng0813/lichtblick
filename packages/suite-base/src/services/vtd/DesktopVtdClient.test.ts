// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import DesktopVtdClient, { DESKTOP_VTD_INVOKE_COMMANDS } from "./DesktopVtdClient";
import {
  VtdAbortError,
  VtdDesktopError,
  VtdJsonError,
  VtdNetworkError,
  VtdNotFoundError,
  VtdPermissionError,
  VtdTimeoutError,
} from "./errors";

type InvokeResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      code:
        | "invalid-request"
        | "unsupported-command"
        | "duplicate-request"
        | "concurrency-limit"
        | "cancelled"
        | "timeout"
        | "not-found"
        | "permission-denied"
        | "output-limit"
        | "stream"
        | "exit"
        | "invalid-json"
        | "process";
      message: string;
    };

type TestGlobal = typeof globalThis & {
  desktopBridge?: {
    invokeVtd: jest.Mock<Promise<InvokeResult>, [string, unknown, string]>;
    cancelVtd: jest.Mock<Promise<void>, [string]>;
  };
};

const testGlobal = globalThis as TestGlobal;

describe("DesktopVtdClient", () => {
  const originalBridgeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "desktopBridge");

  it("locks the duplicated bridge command literals to the desktop common contract", () => {
    expect(DESKTOP_VTD_INVOKE_COMMANDS).toEqual([
      "list",
      "detail",
      "topics",
      "url",
      "slice-store",
      "slice-get",
      "trigger",
    ]);
  });

  afterEach(() => {
    if (originalBridgeDescriptor == undefined) {
      delete testGlobal.desktopBridge;
    } else {
      Object.defineProperty(globalThis, "desktopBridge", originalBridgeDescriptor);
    }
  });

  it("fails clearly when the desktop bridge is unavailable", () => {
    delete testGlobal.desktopBridge;

    expect(() => new DesktopVtdClient()).toThrow("Desktop VTD bridge is unavailable");
  });

  it("fails clearly when invokeVtd is not callable", () => {
    Object.defineProperty(globalThis, "desktopBridge", {
      configurable: true,
      value: {},
    });

    expect(() => new DesktopVtdClient()).toThrow("Desktop VTD bridge is unavailable");
  });

  it("maps every IVtdClient method and normalizes command responses", async () => {
    const invokeVtd = jest.fn<Promise<InvokeResult>, [string, unknown, string]>();
    const cancelVtd = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    invokeVtd
      .mockResolvedValueOnce({
        ok: true,
        value: {
          data: [{ bot_name: "robot", bot_sn: "SN001", data_size: 42, id: 123 }],
          total: 1,
        },
      })
      .mockResolvedValueOnce({ ok: true, value: { id: "record-1" } })
      .mockResolvedValueOnce({ ok: true, value: { topics: { "/imu": 12 } } })
      .mockResolvedValueOnce({
        ok: true,
        value: { mcap_slice_id: "slice-1", tos: "tos://slice" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          download_url: "https://download/slice",
          mcap_slice_id: "slice-1",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { download_url: "https://download/full" },
      })
      .mockResolvedValueOnce({ ok: true, value: { records: [], logs: [] } });
    testGlobal.desktopBridge = { cancelVtd, invokeVtd };
    const client = new DesktopVtdClient();
    const searchParams = { botSn: "SN001", page: 2, pageSize: 20 };
    const sliceParams = {
      endNs: "20",
      id: "record-1",
      startNs: "10",
      topics: ["/imu"],
    };

    await expect(client.search(searchParams)).resolves.toEqual({
      records: [
        {
          botName: "robot",
          botSn: "SN001",
          dataType: undefined,
          id: "123",
          raw: expect.objectContaining({ id: 123 }),
          sizeBytes: 42,
          triggerTime: undefined,
          triggerType: undefined,
        },
      ],
      total: 1,
    });
    await expect(client.detail("record-1")).resolves.toEqual({ id: "record-1" });
    await expect(client.topics("record-1")).resolves.toEqual({ "/imu": 12 });
    await expect(client.sliceStore(sliceParams)).resolves.toMatchObject({
      mcapSliceId: "slice-1",
    });
    await expect(client.sliceGet("slice-1")).resolves.toMatchObject({
      downloadUrl: "https://download/slice",
    });
    await expect(client.url("record-1")).resolves.toEqual({
      downloadUrl: "https://download/full",
    });
    await expect(client.trigger({ triggerId: "trigger-1" })).resolves.toEqual({
      records: [],
      logs: [],
    });

    expect(invokeVtd.mock.calls).toEqual([
      ["list", searchParams, expect.any(String)],
      ["detail", { id: "record-1" }, expect.any(String)],
      ["topics", { id: "record-1" }, expect.any(String)],
      ["slice-store", sliceParams, expect.any(String)],
      ["slice-get", { sliceId: "slice-1" }, expect.any(String)],
      ["url", { id: "record-1" }, expect.any(String)],
      ["trigger", { triggerId: "trigger-1" }, expect.any(String)],
    ]);
    const requestIds = invokeVtd.mock.calls.map((call) => call[2]);
    expect(new Set(requestIds).size).toBe(requestIds.length);
    requestIds.forEach((requestId) => {
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  it("omits empty or unselected topics from slice-store bridge parameters", async () => {
    const invokeVtd = jest
      .fn<Promise<InvokeResult>, [string, unknown, string]>()
      .mockResolvedValue({
        ok: true,
        value: { mcap_slice_id: "slice-all", tos: "tos://slice" },
      });
    const cancelVtd = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    testGlobal.desktopBridge = { cancelVtd, invokeVtd };
    const client = new DesktopVtdClient();

    await client.sliceStore({ id: "record-1", topics: [] });
    await client.sliceStore({ id: "record-2", topics: undefined });

    expect(invokeVtd.mock.calls.map(([_command, params]) => params)).toStrictEqual([
      { id: "record-1" },
      { id: "record-2" },
    ]);
  });

  it("does not invoke the bridge when the signal is already aborted", async () => {
    const invokeVtd = jest.fn<Promise<InvokeResult>, [string, unknown, string]>();
    const cancelVtd = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    testGlobal.desktopBridge = { cancelVtd, invokeVtd };
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(
      new DesktopVtdClient().detail("record-1", controller.signal),
    ).rejects.toBeInstanceOf(VtdAbortError);
    expect(invokeVtd).not.toHaveBeenCalled();
    expect(cancelVtd).not.toHaveBeenCalled();
  });

  it("rejects an in-flight invocation when the signal is aborted", async () => {
    const invokeVtd = jest.fn<Promise<InvokeResult>, [string, unknown, string]>(
      async (_command, _params, _requestId) =>
        await new Promise<InvokeResult>(() => {
          // Main owns completion; renderer abort is asserted through cancelVtd below.
        }),
    );
    const cancelVtd = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    testGlobal.desktopBridge = { cancelVtd, invokeVtd };
    const controller = new AbortController();
    const request = new DesktopVtdClient().detail("record-1", controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    const requestId = invokeVtd.mock.calls[0]?.[2];
    expect(requestId).toEqual(expect.any(String));
    expect(invokeVtd).toHaveBeenCalledWith("detail", { id: "record-1" }, requestId);
    expect(cancelVtd).toHaveBeenCalledWith(requestId);
  });

  it("keeps the local abort classification when cancel IPC itself fails", async () => {
    const invokeVtd = jest.fn<Promise<InvokeResult>, [string, unknown, string]>(
      async () =>
        await new Promise<InvokeResult>(() => {
          // Intentionally left in flight.
        }),
    );
    const cancelVtd = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValue(new Error("main exited"));
    testGlobal.desktopBridge = { cancelVtd, invokeVtd };
    const controller = new AbortController();
    const request = new DesktopVtdClient().detail("record-1", controller.signal);

    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toBeInstanceOf(VtdAbortError);
    expect(cancelVtd).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["timeout", VtdTimeoutError],
    ["cancelled", VtdAbortError],
    ["invalid-json", VtdJsonError],
    ["not-found", VtdNotFoundError],
    ["permission-denied", VtdPermissionError],
    ["process", VtdDesktopError],
  ] as const)("reconstructs %s IPC failures as local error classes", async (code, errorType) => {
    const invokeVtd = jest
      .fn<Promise<InvokeResult>, [string, unknown, string]>()
      .mockResolvedValue({ code, message: `main ${code}`, ok: false });
    const cancelVtd = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    testGlobal.desktopBridge = { cancelVtd, invokeVtd };

    const error = await new DesktopVtdClient()
      .detail("record-1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(errorType);
    expect(error).toMatchObject({
      command: "detail",
      message:
        code === "not-found"
          ? "main not-found Install it from Settings → AI Assistant."
          : `main ${code}`,
    });
  });

  it("classifies bridge rejection and malformed envelopes", async () => {
    const invokeVtd = jest
      .fn<Promise<InvokeResult>, [string, unknown, string]>()
      .mockRejectedValueOnce(new Error("IPC closed"))
      .mockResolvedValueOnce({ unexpected: true } as unknown as InvokeResult);
    const cancelVtd = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    testGlobal.desktopBridge = { cancelVtd, invokeVtd };
    const client = new DesktopVtdClient();

    await expect(client.detail("record-1")).rejects.toBeInstanceOf(VtdNetworkError);
    const protocolError = await client.detail("record-2").catch((caught: unknown) => caught);
    expect(protocolError).toBeInstanceOf(VtdDesktopError);
    expect(protocolError).toMatchObject({ code: "protocol" });
  });
});
