// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { buildToolDefinitions } from "@lichtblick/suite-base/services/agent/local/toolDefinitions";
import type { ToolConfirmationDecision } from "@lichtblick/suite-base/services/agent/types";
import type { IVtdClient } from "@lichtblick/suite-base/services/vtd/types";

import { buildPiTools } from "./piTools";
import type { ToolRuntimeDeps } from "./toolRuntime";

function makeVtdClient() {
  const search = jest
    .fn<ReturnType<IVtdClient["search"]>, Parameters<IVtdClient["search"]>>()
    .mockResolvedValue({ records: [] });
  const detail = jest
    .fn<ReturnType<IVtdClient["detail"]>, Parameters<IVtdClient["detail"]>>()
    .mockResolvedValue({ id: "record-1" });
  const topics = jest
    .fn<ReturnType<IVtdClient["topics"]>, Parameters<IVtdClient["topics"]>>()
    .mockResolvedValue({});
  const sliceStore = jest
    .fn<
      ReturnType<IVtdClient["sliceStore"]>,
      Parameters<IVtdClient["sliceStore"]>
    >()
    .mockResolvedValue({ mcapSliceId: "slice-1", raw: {} });
  const sliceGet = jest
    .fn<
      ReturnType<IVtdClient["sliceGet"]>,
      Parameters<IVtdClient["sliceGet"]>
    >()
    .mockResolvedValue({ downloadUrl: "https://data/slice.mcap", raw: {} });
  const url = jest
    .fn<ReturnType<IVtdClient["url"]>, Parameters<IVtdClient["url"]>>()
    .mockResolvedValue({ downloadUrl: "https://data/record.mcap" });
  const trigger = jest
    .fn<ReturnType<IVtdClient["trigger"]>, Parameters<IVtdClient["trigger"]>>()
    .mockResolvedValue({});

  return {
    search,
    detail,
    topics,
    sliceStore,
    sliceGet,
    url,
    trigger,
  } satisfies IVtdClient;
}

function makeDeps() {
  return {
    vtdClient: makeVtdClient(),
    skills: [
      { id: "enabled", name: "Enabled", whenToUse: "test", body: "# Enabled" },
      {
        id: "disabled",
        name: "Disabled",
        whenToUse: "test",
        body: "# Disabled",
      },
    ],
    memoryStore: {
      list: jest.fn().mockReturnValue([]),
      add: jest.fn(),
      remove: jest.fn(),
    },
    getCatalog: jest.fn().mockReturnValue({ topics: [], datatypes: new Map() }),
    getInstalledPanelTypes: jest.fn().mockReturnValue(new Set<string>()),
    emitOpenDataSource: jest.fn(),
    emitLayoutProposal: jest.fn(),
  } satisfies ToolRuntimeDeps;
}

describe("buildPiTools", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("passes through every existing tool schema and restricts load_skill to enabled ids", async () => {
    const tools = buildPiTools(makeDeps(), ["enabled"], {
      requestConfirmation: jest.fn(),
    });
    const definitions = buildToolDefinitions(["enabled"]);

    expect(tools.map((tool) => tool.name)).toEqual(
      definitions.map((definition) => definition.name),
    );
    for (const definition of definitions) {
      const tool = tools.find(
        (candidate) => candidate.name === definition.name,
      );
      expect(tool?.description).toBe(definition.description);
      expect(tool?.parameters).toEqual(definition.inputSchema);
    }

    const loadSkill = tools.find((tool) => tool.name === "load_skill")!;
    await expect(
      loadSkill.execute("load-1", { skillId: "enabled" }),
    ).resolves.toMatchObject({
      content: [
        { type: "text", text: '<skill id="enabled">\n# Enabled\n</skill>' },
      ],
    });
    await expect(
      loadSkill.execute("load-2", { skillId: "disabled" }),
    ).rejects.toThrow("load_skill.skillId must be one of: enabled");
  });

  it("executes vtd_slice_store after approval", async () => {
    const deps = makeDeps();
    const requestConfirmation = jest
      .fn()
      .mockResolvedValue({ approved: true, scope: "once" });
    const tool = buildPiTools(deps, ["enabled"], { requestConfirmation }).find(
      (candidate) => candidate.name === "vtd_slice_store",
    )!;

    await expect(
      tool.execute("slice-call", { id: "record-1" }),
    ).resolves.toMatchObject({
      details: {
        status: "succeeded",
        progress: 1,
        result: { mcapSliceId: "slice-1", raw: {} },
      },
    });
    expect(requestConfirmation).toHaveBeenCalledWith(
      "slice-call",
      {
        toolName: "vtd_slice_store",
        input: { id: "record-1" },
        summary: "Waiting for confirmation to store an MCAP slice",
      },
      expect.any(AbortSignal),
    );
    expect(deps.vtdClient.sliceStore.mock.calls).toEqual([
      [{ id: "record-1" }, undefined],
    ]);
  });

  it("returns the legacy cancellation payload after a declined confirmation", async () => {
    const deps = makeDeps();
    const tool = buildPiTools(deps, ["enabled"], {
      requestConfirmation: jest
        .fn()
        .mockResolvedValue({ approved: false, scope: "once" }),
    }).find((candidate) => candidate.name === "vtd_slice_store")!;

    await expect(
      tool.execute("slice-call", { id: "record-1" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"cancelled":true,"reason":"User declined the operation"}',
        },
      ],
      details: {
        status: "cancelled",
        summary: "Cancelled by user",
        result: { cancelled: true, reason: "User declined the operation" },
      },
    });
    expect(deps.vtdClient.sliceStore.mock.calls).toHaveLength(0);
  });

  it("rejects with the confirmation-timeout equivalent", async () => {
    jest.useFakeTimers();
    const deps = makeDeps();
    const tool = buildPiTools(deps, ["enabled"], {
      requestConfirmation: jest.fn(
        async () => await new Promise<ToolConfirmationDecision>(() => {}),
      ),
      confirmationTimeoutMs: 25,
    }).find((candidate) => candidate.name === "vtd_slice_store")!;

    const execution = tool.execute("slice-call", { id: "record-1" });
    const rejection = execution.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(25);

    await expect(rejection).resolves.toMatchObject({
      name: "LocalAgentConfirmationTimeoutError",
      message: "Tool confirmation timed out",
    });
    expect(deps.vtdClient.sliceStore.mock.calls).toHaveLength(0);
  });

  it("returns the batch consent decision after confirmation without running a dependency", async () => {
    const deps = makeDeps();
    const requestConfirmation = jest
      .fn()
      .mockResolvedValue({ approved: true, scope: "session" });
    const tool = buildPiTools(deps, ["enabled"], { requestConfirmation }).find(
      (candidate) => candidate.name === "request_batch_consent",
    )!;
    const input = {
      action: "slice_and_load",
      summary: "Slice 6 records over a 10-second window and load 6 MCAP files.",
      itemCount: 6,
    };

    await expect(tool.execute("consent-call", input)).resolves.toMatchObject({
      content: [{ type: "text", text: '{"approved":true,"scope":"session"}' }],
      details: {
        status: "succeeded",
        summary: input.summary,
        result: { approved: true, scope: "session" },
      },
    });
    expect(requestConfirmation).toHaveBeenCalledWith(
      "consent-call",
      {
        toolName: "request_batch_consent",
        input,
        summary: input.summary,
      },
      expect.any(AbortSignal),
    );
    expect(deps.vtdClient.sliceStore).not.toHaveBeenCalled();
    expect(deps.emitOpenDataSource).not.toHaveBeenCalled();
    expect(deps.emitLayoutProposal).not.toHaveBeenCalled();
  });

  it("returns approved false when batch consent is cancelled", async () => {
    const deps = makeDeps();
    const tool = buildPiTools(deps, ["enabled"], {
      requestConfirmation: jest
        .fn()
        .mockResolvedValue({ approved: false, scope: "once" }),
    }).find((candidate) => candidate.name === "request_batch_consent")!;

    await expect(
      tool.execute("consent-call", {
        action: "slice_and_load",
        summary: "Slice 2 records and load the outputs.",
        itemCount: 2,
      }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: '{"approved":false,"scope":"once"}' }],
      details: {
        status: "cancelled",
        result: { approved: false, scope: "once" },
      },
    });
    expect(deps.vtdClient.sliceStore).not.toHaveBeenCalled();
  });

  it("maps running and completed progress through onUpdate", async () => {
    const tool = buildPiTools(makeDeps(), ["enabled"], {
      requestConfirmation: jest.fn(),
    }).find((candidate) => candidate.name === "vtd_detail")!;
    const onUpdate = jest.fn();

    await tool.execute("detail-call", { id: "record-1" }, undefined, onUpdate);

    expect(onUpdate).toHaveBeenNthCalledWith(1, {
      content: [{ type: "text", text: "Running vtd_detail" }],
      details: { status: "running", progress: 0 },
    });
    expect(onUpdate).toHaveBeenNthCalledWith(2, {
      content: [{ type: "text", text: '{"id":"record-1"}' }],
      details: {
        status: "succeeded",
        progress: 1,
        summary: '{"id":"record-1"}',
        result: { id: "record-1" },
      },
    });
  });
});
