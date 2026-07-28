// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";

import VtdCliService, { VtdCliError } from "./VtdCliService";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

type FakeChild = EventEmitter & {
  kill: jest.Mock<boolean, [NodeJS.Signals]>;
  stderr: EventEmitter;
  stdout: EventEmitter;
};

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = jest.fn<boolean, [NodeJS.Signals]>().mockReturnValue(true);
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

function mockChild(child: FakeChild): void {
  mockSpawn.mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
}

function finishWithJson(child: FakeChild, value: unknown): void {
  const json = JSON.stringify(value);
  if (json == undefined) {
    throw new Error("Test value is not JSON serializable");
  }
  child.stdout.emit("data", Buffer.from(json));
  child.emit("close", 0);
}

describe("VtdCliService", () => {
  const originalCliPath = process.env.VTD_CLI_PATH;
  let requestSequence = 0;

  async function invoke(
    service: VtdCliService,
    command: unknown,
    params: unknown,
    requestId = `request-${++requestSequence}`,
    ownerId = 1,
  ): Promise<unknown> {
    return await service.invoke(ownerId, requestId, command, params);
  }

  beforeEach(() => {
    jest.useRealTimers();
    mockSpawn.mockReset();
    requestSequence = 0;
    delete process.env.VTD_CLI_PATH;
  });

  afterAll(() => {
    if (originalCliPath == undefined) {
      delete process.env.VTD_CLI_PATH;
    } else {
      process.env.VTD_CLI_PATH = originalCliPath;
    }
  });

  it("rejects non-whitelisted commands, parameters, and request IDs before spawning", async () => {
    const service = new VtdCliService();

    await expect(invoke(service, "download", { id: "record-1" })).rejects.toThrow(
      "Unsupported vtd command",
    );
    await expect(invoke(service, "list", { env: "test" })).rejects.toThrow("Unsupported parameter");
    await expect(invoke(service, "detail", { id: "--env" })).rejects.toThrow(
      "must not start with a hyphen",
    );
    await expect(service.invoke(1, "../bad", "detail", { id: "record-1" })).rejects.toThrow(
      "Invalid vtd request id",
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("constructs list arguments item by item and parses stdout JSON", async () => {
    const child = createFakeChild();
    mockChild(child);
    const service = new VtdCliService();

    const invocation = invoke(service, "list", {
      at: "2026-07-27 12:00:00",
      botName: "robot",
      botSn: "SN001",
      end: "2026-07-28",
      page: 2,
      pageSize: 30,
      start: "2026-07-27",
      triggerType: "nav",
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "vtd",
      [
        "list",
        "--bot-sn",
        "SN001",
        "--bot-name",
        "robot",
        "--trigger-type",
        "nav",
        "--start",
        "2026-07-27",
        "--end",
        "2026-07-28",
        "--at",
        "2026-07-27 12:00:00",
        "--page",
        "2",
        "--page-size",
        "30",
        "--json",
      ],
      { shell: false },
    );
    child.stderr.emit("data", Buffer.from("progress: 50%"));
    finishWithJson(child, { data: [{ id: 1 }] });
    await expect(invocation).resolves.toEqual({ data: [{ id: 1 }] });
  });

  it("constructs positional and slice arguments without a shell", async () => {
    const sliceChild = createFakeChild();
    const detailChild = createFakeChild();
    mockChild(sliceChild);
    mockChild(detailChild);
    const service = new VtdCliService();

    const sliceInvocation = invoke(service, "slice-store", {
      endNs: "2000000000000000000",
      id: "record-1",
      startNs: "1000000000000000000",
      topics: ["/imu/data", "/nav odom"],
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "vtd",
      [
        "slice-store",
        "record-1",
        "--topics",
        "/imu/data,/nav odom",
        "--start-ns",
        "1000000000000000000",
        "--end-ns",
        "2000000000000000000",
        "--json",
      ],
      { shell: false },
    );
    finishWithJson(sliceChild, { mcap_slice_id: "slice-1" });
    await sliceInvocation;

    const detailInvocation = invoke(service, "detail", { id: "record-1" });
    expect(mockSpawn).toHaveBeenNthCalledWith(2, "vtd", ["detail", "record-1", "--json"], {
      shell: false,
    });
    finishWithJson(detailChild, { id: "record-1" });
    await detailInvocation;
  });

  it("uses only an absolute VTD_CLI_PATH override", async () => {
    process.env.VTD_CLI_PATH = "relative/vtd";
    const service = new VtdCliService();
    await expect(invoke(service, "topics", { id: "record-1" })).rejects.toThrow(
      "must be an absolute path",
    );
    expect(mockSpawn).not.toHaveBeenCalled();

    process.env.VTD_CLI_PATH = "/opt/lichtblick/bin/vtd";
    const child = createFakeChild();
    mockChild(child);
    const invocation = invoke(service, "topics", { id: "record-1" });
    expect(mockSpawn).toHaveBeenCalledWith(
      "/opt/lichtblick/bin/vtd",
      ["topics", "record-1", "--json"],
      { shell: false },
    );
    finishWithJson(child, { "/imu": 1 });
    await invocation;
  });

  it.each([
    ["url", { id: "record-1" }, ["url", "record-1", "--json"]],
    ["slice-get", { sliceId: "slice-1" }, ["slice-get", "slice-1", "--json"]],
    ["trigger", { triggerId: "trigger-1" }, ["trigger", "trigger-1", "--json"]],
  ] as const)("constructs %s positional arguments", async (command, params, expectedArgs) => {
    const child = createFakeChild();
    mockChild(child);

    const invocation = invoke(new VtdCliService(), command, params);

    expect(mockSpawn).toHaveBeenCalledWith("vtd", expectedArgs, {
      shell: false,
    });
    finishWithJson(child, {});
    await invocation;
  });

  it("validates business limits even when all execution slots are occupied", async () => {
    const children = Array.from({ length: 4 }, createFakeChild);
    for (const child of children) {
      mockChild(child);
    }
    const service = new VtdCliService();
    const invocations = children.map(
      async (_child, index) => await invoke(service, "detail", { id: `record-${index}` }),
    );

    await expect(invoke(service, "detail", { id: "x".repeat(4097) })).rejects.toThrow(
      "at most 4096",
    );
    await expect(
      invoke(service, "slice-store", {
        id: "record",
        topics: Array.from({ length: 201 }, (_, index) => `/topic/${index}`),
      }),
    ).rejects.toThrow("at most 200");
    await expect(invoke(service, "list", { pageSize: 1001 })).rejects.toThrow("between 1 and 1000");
    expect(mockSpawn).toHaveBeenCalledTimes(4);

    children.forEach((child, index) => {
      finishWithJson(child, { id: `record-${index}` });
    });
    await Promise.all(invocations);
  });

  it("uses SIGTERM then SIGKILL on timeout and holds the slot until close", async () => {
    jest.useFakeTimers();
    const children = Array.from({ length: 5 }, createFakeChild);
    for (const child of children.slice(0, 4)) {
      mockChild(child);
    }
    const service = new VtdCliService();
    const timedOut = invoke(service, "url", { id: "record-1" }, "timeout-request");
    void timedOut.catch(() => {});
    children[0]!.kill.mockReturnValue(false);
    jest.advanceTimersByTime(29_999);
    const peers = children.slice(1, 4).map((child, index) => ({
      child,
      result: invoke(service, "detail", { id: `peer-${index}` }),
    }));

    jest.advanceTimersByTime(1);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(invoke(service, "detail", { id: "blocked" })).rejects.toThrow(
      "concurrency limit reached",
    );

    jest.advanceTimersByTime(5_000);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    children[0]!.emit("close", null);
    await expect(timedOut).rejects.toThrow("timed out after 30000ms");

    mockChild(children[4]!);
    const replacement = invoke(service, "detail", { id: "replacement" });
    finishWithJson(children[4]!, { id: "replacement" });
    await replacement;

    for (const [index, peer] of peers.entries()) {
      finishWithJson(peer.child, { id: `peer-${index}` });
      await peer.result;
    }
  });

  it("clears timeout and force-kill timers when the child closes", async () => {
    jest.useFakeTimers();
    const cancelledChild = createFakeChild();
    const successfulChild = createFakeChild();
    mockChild(cancelledChild);
    mockChild(successfulChild);
    const service = new VtdCliService();

    const cancelled = invoke(service, "detail", { id: "cancelled" }, "cancelled");
    void cancelled.catch(() => {});
    service.cancel(1, "cancelled");
    cancelledChild.emit("close", null);
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });

    const successful = invoke(service, "detail", { id: "successful" }, "successful");
    finishWithJson(successfulChild, { id: "successful" });
    await successful;

    jest.advanceTimersByTime(35_000);
    expect(cancelledChild.kill).toHaveBeenCalledTimes(1);
    expect(cancelledChild.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(successfulChild.kill).not.toHaveBeenCalled();
  });

  it("cancels by request id and releases the slot only after close", async () => {
    const children = Array.from({ length: 5 }, createFakeChild);
    for (const child of children.slice(0, 4)) {
      mockChild(child);
    }
    const service = new VtdCliService();
    const cancelled = invoke(service, "detail", { id: "record-0" }, "cancel-me");
    void cancelled.catch(() => {});
    const peers = children
      .slice(1, 4)
      .map(async (_child, index) => await invoke(service, "detail", { id: `record-${index + 1}` }));

    service.cancel(1, "cancel-me");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(invoke(service, "detail", { id: "blocked" })).rejects.toThrow(
      "concurrency limit reached",
    );

    children[0]!.emit("close", null);
    await expect(cancelled).rejects.toThrow("was cancelled");

    mockChild(children[4]!);
    const replacement = invoke(service, "detail", { id: "replacement" });
    finishWithJson(children[4]!, { id: "replacement" });
    await replacement;

    children.slice(1, 4).forEach((child, index) => {
      finishWithJson(child, { id: `record-${index + 1}` });
    });
    await Promise.all(peers);
  });

  it("scopes duplicate IDs and cancellation to the invoking renderer owner", async () => {
    const ownerOneChild = createFakeChild();
    const ownerTwoChild = createFakeChild();
    mockChild(ownerOneChild);
    mockChild(ownerTwoChild);
    const service = new VtdCliService();

    const ownerOne = invoke(service, "detail", { id: "record-1" }, "shared-id", 101);
    const ownerTwo = invoke(service, "detail", { id: "record-2" }, "shared-id", 202);
    void ownerOne.catch(() => {});
    void ownerTwo.catch(() => {});

    service.cancel(202, "shared-id");
    expect(ownerOneChild.kill).not.toHaveBeenCalled();
    expect(ownerTwoChild.kill).toHaveBeenCalledWith("SIGTERM");

    finishWithJson(ownerOneChild, { id: "record-1" });
    ownerTwoChild.emit("close", null);
    await expect(ownerOne).resolves.toEqual({ id: "record-1" });
    await expect(ownerTwo).rejects.toMatchObject({
      code: "cancelled",
      message: "vtd CLI invocation was cancelled",
    });
  });

  it("rejects cancel-before-invoke for ten seconds without spawning", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const service = new VtdCliService();

    service.cancel(101, "cancel-before-start");
    const cancelled = invoke(service, "detail", { id: "record-1" }, "cancel-before-start", 101);
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    expect(mockSpawn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10_001);
    const child = createFakeChild();
    mockChild(child);
    const afterExpiry = invoke(service, "detail", { id: "record-1" }, "cancel-before-start", 101);
    finishWithJson(child, { id: "record-1" });
    await expect(afterExpiry).resolves.toEqual({ id: "record-1" });
  });

  it("bounds each owner's cancel tombstones to its newest 1000 entries", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const service = new VtdCliService();

    for (let index = 0; index <= 1_000; index++) {
      service.cancel(101, `cancel-${index}`);
    }

    await expect(
      invoke(service, "detail", { id: "record-1000" }, "cancel-1000", 101),
    ).rejects.toMatchObject({ code: "cancelled" });

    const child = createFakeChild();
    mockChild(child);
    const evicted = invoke(service, "detail", { id: "record-0" }, "cancel-0", 101);
    finishWithJson(child, { id: "record-0" });
    await expect(evicted).resolves.toEqual({ id: "record-0" });
  });

  it("does not let one owner evict another owner's cancel tombstone", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T00:00:00Z"));
    const service = new VtdCliService();

    service.cancel(101, "owner-one-cancel");
    for (let index = 0; index <= 1_000; index++) {
      service.cancel(202, `owner-two-cancel-${index}`);
    }

    await expect(
      invoke(service, "detail", { id: "owner-one" }, "owner-one-cancel", 101),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      invoke(service, "detail", { id: "owner-two-latest" }, "owner-two-cancel-1000", 202),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(mockSpawn).not.toHaveBeenCalled();

    const child = createFakeChild();
    mockChild(child);
    const evicted = invoke(
      service,
      "detail",
      { id: "owner-two-oldest" },
      "owner-two-cancel-0",
      202,
    );
    finishWithJson(child, { id: "owner-two-oldest" });
    await expect(evicted).resolves.toEqual({ id: "owner-two-oldest" });
  });

  it("terminates all commands owned by a destroyed renderer and all owners on dispose", async () => {
    const children = Array.from({ length: 3 }, createFakeChild);
    children.forEach(mockChild);
    const service = new VtdCliService();
    const ownerOneA = invoke(service, "detail", { id: "one-a" }, "one-a", 101);
    const ownerOneB = invoke(service, "detail", { id: "one-b" }, "one-b", 101);
    const ownerTwo = invoke(service, "detail", { id: "two" }, "two", 202);
    [ownerOneA, ownerOneB, ownerTwo].forEach((invocation) => {
      void invocation.catch(() => {});
    });

    service.cancelOwner(101);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[2]!.kill).not.toHaveBeenCalled();

    service.dispose();
    expect(children[2]!.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(invoke(service, "detail", { id: "late" }, "late", 303)).rejects.toMatchObject({
      code: "cancelled",
    });

    children.forEach((child) => {
      child.emit("close", null);
    });
    await expect(ownerOneA).rejects.toMatchObject({ code: "cancelled" });
    await expect(ownerOneB).rejects.toMatchObject({ code: "cancelled" });
    await expect(ownerTwo).rejects.toMatchObject({ code: "cancelled" });
  });

  it("waits at most two seconds before force-killing commands during shutdown", async () => {
    jest.useFakeTimers();
    const child = createFakeChild();
    mockChild(child);
    const service = new VtdCliService();
    const invocation = invoke(service, "detail", { id: "record-1" });
    void invocation.catch(() => {});

    const shutdown = service.shutdown();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    jest.advanceTimersByTime(1_999);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    jest.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(shutdown).resolves.toBeUndefined();

    child.emit("close", null);
    await expect(invocation).rejects.toMatchObject({ code: "cancelled" });
  });

  it("classifies process startup failures with stable codes", async () => {
    const notFoundChild = createFakeChild();
    mockChild(notFoundChild);
    const invocation = invoke(new VtdCliService(), "detail", {
      id: "record-1",
    });
    void invocation.catch(() => {});
    const error = Object.assign(new Error("spawn vtd ENOENT"), {
      code: "ENOENT",
    });

    notFoundChild.emit("error", error);
    notFoundChild.emit("close", -2);

    const caught = await invocation.catch((reason: unknown) => reason);
    expect(caught).toBeInstanceOf(VtdCliError);
    expect(caught).toMatchObject({ code: "not-found" });
  });

  it("captures only the bounded stderr tail in non-zero exit errors", async () => {
    const child = createFakeChild();
    mockChild(child);
    const invocation = invoke(new VtdCliService(), "detail", {
      id: "record-1",
    });

    child.stderr.emit("data", Buffer.from(`BEGIN${"x".repeat(5000)}ACTIONABLE_TAIL`));
    child.emit("close", 1);

    const error = await invocation.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ACTIONABLE_TAIL");
    expect((error as Error).message).not.toContain("BEGIN");
  });

  it("handles stdout stream errors and waits for close before rejecting", async () => {
    const child = createFakeChild();
    mockChild(child);
    const invocation = invoke(new VtdCliService(), "detail", {
      id: "record-1",
    });
    void invocation.catch(() => {});

    child.stdout.emit("error", new Error("pipe broke"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null);

    await expect(invocation).rejects.toThrow("stdout failed: pipe broke");
  });

  it("handles stderr stream and asynchronous spawn errors without an unhandled error", async () => {
    const stderrChild = createFakeChild();
    const spawnErrorChild = createFakeChild();
    mockChild(stderrChild);
    mockChild(spawnErrorChild);
    const service = new VtdCliService();

    const stderrFailure = invoke(service, "detail", { id: "record-1" });
    void stderrFailure.catch(() => {});
    stderrChild.stderr.emit("error", new Error("stderr pipe broke"));
    expect(stderrChild.kill).toHaveBeenCalledWith("SIGTERM");
    stderrChild.emit("close", null);
    await expect(stderrFailure).rejects.toThrow("stderr failed: stderr pipe broke");

    const spawnFailure = invoke(service, "detail", { id: "record-2" });
    void spawnFailure.catch(() => {});
    spawnErrorChild.emit("error", new Error("spawn EACCES"));
    spawnErrorChild.emit("close", -2);
    await expect(spawnFailure).rejects.toThrow("spawn EACCES");
  });

  it("terminates output overflow and rejects invalid JSON", async () => {
    const overflowChild = createFakeChild();
    const jsonChild = createFakeChild();
    mockChild(overflowChild);
    mockChild(jsonChild);
    const service = new VtdCliService();

    const overflow = invoke(service, "url", { id: "record-1" });
    void overflow.catch(() => {});
    overflowChild.stdout.emit("data", Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(overflowChild.kill).toHaveBeenCalledWith("SIGTERM");
    overflowChild.emit("close", null);
    await expect(overflow).rejects.toThrow("output exceeded 10485760 bytes");

    const invalidJson = invoke(service, "url", { id: "record-2" });
    jsonChild.stdout.emit("data", Buffer.from("{"));
    jsonChild.emit("close", 0);
    await expect(invalidJson).rejects.toThrow("returned invalid JSON");
  });
});
