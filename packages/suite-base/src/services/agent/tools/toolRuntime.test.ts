// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { IVtdClient } from "@lichtblick/suite-base/services/vtd/types";

import {
  executeToolRuntime,
  runGetDataCatalogTool,
  runLoadSkillTool,
  runMemoryForgetTool,
  runMemoryListTool,
  runMemoryWriteTool,
  runOpenDataSourceTool,
  runProposeLayoutTool,
  runRequestBatchConsentTool,
  runVtdDetailTool,
  runVtdPresignTool,
  runVtdSearchTool,
  runVtdSliceStoreTool,
  runVtdTopicsTool,
  runVtdTriggerTool,
  TOOL_RUNTIME_MAX_RESULT_BYTES,
  type ToolRuntimeDeps,
} from "./toolRuntime";

function makeVtdClient() {
  const search = jest
    .fn<ReturnType<IVtdClient["search"]>, Parameters<IVtdClient["search"]>>()
    .mockResolvedValue({ records: [], total: 0 });
  const detail = jest
    .fn<ReturnType<IVtdClient["detail"]>, Parameters<IVtdClient["detail"]>>()
    .mockResolvedValue({ id: "record-1" });
  const topics = jest
    .fn<ReturnType<IVtdClient["topics"]>, Parameters<IVtdClient["topics"]>>()
    .mockResolvedValue({ "/speed": 2 });
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
    .mockResolvedValue({
      downloadUrl: "https://data.example/slice-1.mcap",
      raw: {},
    });
  const url = jest
    .fn<ReturnType<IVtdClient["url"]>, Parameters<IVtdClient["url"]>>()
    .mockResolvedValue({ downloadUrl: "https://data.example/record-1.mcap" });
  const trigger = jest
    .fn<ReturnType<IVtdClient["trigger"]>, Parameters<IVtdClient["trigger"]>>()
    .mockResolvedValue({ records: ["record-1"] });

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

function validLayoutData(): Record<string, unknown> {
  return {
    configById: { "Plot!speed": { paths: [{ value: "/speed" }] } },
    layout: "Plot!speed",
    globalVariables: {},
    playbackConfig: { speed: 1 },
    userNodes: {},
  };
}

function makeDeps() {
  return {
    vtdClient: makeVtdClient(),
    skills: [
      {
        id: "test-skill",
        name: "Test",
        whenToUse: "For tests",
        body: "# Test skill",
      },
    ],
    memoryStore: {
      list: jest.fn().mockReturnValue([
        {
          id: "memory-1",
          text: "A fact",
          createdAt: "2026-08-04T00:00:00.000Z",
        },
      ]),
      add: jest.fn().mockResolvedValue({
        id: "memory-2",
        text: "Another fact",
        createdAt: "2026-08-04T00:00:00.000Z",
      }),
      remove: jest.fn().mockResolvedValue(true),
    },
    getCatalog: jest.fn().mockReturnValue({
      topics: [{ name: "/speed", schemaName: "std_msgs/msg/Float64" }],
      datatypes: new Map([["std_msgs/msg/Float64", { definitions: [] }]]),
    }),
    getInstalledPanelTypes: jest.fn().mockReturnValue(new Set<string>()),
    emitOpenDataSource: jest.fn(),
    emitLayoutProposal: jest.fn(),
  } satisfies ToolRuntimeDeps;
}

describe("toolRuntime", () => {
  it("loads an enabled skill and preserves the legacy invalid-id error", async () => {
    const deps = makeDeps();

    await expect(
      runLoadSkillTool({ skillId: "test-skill" }, deps),
    ).resolves.toBe('<skill id="test-skill">\n# Test skill\n</skill>');
    await expect(
      runLoadSkillTool({ skillId: "missing" }, deps),
    ).rejects.toThrow("load_skill.skillId must be one of: test-skill");
  });

  it("writes memory and reports unavailable memory with the legacy error", async () => {
    const deps = makeDeps();

    await expect(
      runMemoryWriteTool({ text: "Another fact" }, deps),
    ).resolves.toEqual({
      remembered: "memory-2",
    });
    await expect(
      runMemoryWriteTool(
        { text: "Another fact" },
        { ...deps, memoryStore: undefined },
      ),
    ).rejects.toThrow("memory_write is unavailable: memory is not configured");
  });

  it("forgets memory and preserves the not-stored error", async () => {
    const deps = makeDeps();

    await expect(
      runMemoryForgetTool({ id: "memory-1" }, deps),
    ).resolves.toEqual({
      forgotten: "memory-1",
    });
    jest.mocked(deps.memoryStore.remove).mockResolvedValueOnce(false);
    await expect(runMemoryForgetTool({ id: "missing" }, deps)).rejects.toThrow(
      'memory_forget.id "missing" is not a stored memory',
    );
  });

  it("lists memory and validates object input", async () => {
    const deps = makeDeps();

    await expect(runMemoryListTool({}, deps)).resolves.toEqual({
      memories: [
        {
          id: "memory-1",
          text: "A fact",
          createdAt: "2026-08-04T00:00:00.000Z",
        },
      ],
    });
    await expect(runMemoryListTool([], deps)).rejects.toThrow(
      "memory_list input must be an object",
    );
  });

  it("maps all VTD search filters and preserves pagination validation", async () => {
    const deps = makeDeps();
    const input = {
      id: "record-1",
      botSn: "SN",
      botSnExact: "SN-1",
      botName: "Robot",
      triggerType: "nav",
      dataType: "2",
      inspection: "1",
      fixData: "0",
      start: "2026-08-04 00:00:00",
      end: "2026-08-04 01:00:00",
      at: "2026-08-04 00:30:00",
      triggerTime: "2026-08-04 00:30:00",
      queryStart: "2026-08-04 00:00:00",
      queryEnd: "2026-08-04 01:00:00",
      queryTime: "2026-08-04 00:30:00",
      dataDay: "20260804",
      dataTos: "tos/path",
      orderBy: "trigger_time",
      orderDir: "DESC",
      page: 2,
      pageSize: 50,
    };

    await expect(runVtdSearchTool(input, deps)).resolves.toEqual({
      records: [],
      total: 0,
    });
    expect(deps.vtdClient.search.mock.calls).toEqual([[input, undefined]]);
    await expect(runVtdSearchTool({ pageSize: 101 }, deps)).rejects.toThrow(
      "vtd_search.pageSize must be a positive safe integer",
    );
  });

  it("looks up a VTD trigger and preserves required-string validation", async () => {
    const deps = makeDeps();

    await expect(
      runVtdTriggerTool({ triggerId: "trigger-1", all: true }, deps),
    ).resolves.toEqual({
      records: ["record-1"],
    });
    expect(deps.vtdClient.trigger.mock.calls).toEqual([
      [{ triggerId: "trigger-1", all: true }, undefined],
    ]);
    await expect(runVtdTriggerTool({}, deps)).rejects.toThrow(
      "vtd_trigger.triggerId must be a non-empty string",
    );
  });

  it("gets VTD detail and forwards dependency failures", async () => {
    const deps = makeDeps();

    await expect(runVtdDetailTool({ id: "record-1" }, deps)).resolves.toEqual({
      id: "record-1",
    });
    deps.vtdClient.detail.mockRejectedValueOnce(new Error("detail failed"));
    await expect(runVtdDetailTool({ id: "record-1" }, deps)).rejects.toThrow(
      "detail failed",
    );
  });

  it("gets VTD topics and preserves required-string validation", async () => {
    const deps = makeDeps();

    await expect(runVtdTopicsTool({ id: "record-1" }, deps)).resolves.toEqual({
      "/speed": 2,
    });
    await expect(runVtdTopicsTool({ id: " " }, deps)).rejects.toThrow(
      "vtd_topics.id must be a non-empty string",
    );
  });

  it("returns a validated batch consent decision without side effects", async () => {
    const deps = makeDeps();
    const input = {
      action: "slice_and_load",
      summary: "Slice 6 records from 10:00:00 to 10:00:10 and load 6 MCAP files.",
      itemCount: 6,
    };

    await expect(
      runRequestBatchConsentTool(input, deps, {
        confirmationDecision: { approved: true, scope: "session" },
      }),
    ).resolves.toEqual({ approved: true, scope: "session" });
    expect(deps.vtdClient.search).not.toHaveBeenCalled();
    expect(deps.vtdClient.detail).not.toHaveBeenCalled();
    expect(deps.vtdClient.topics).not.toHaveBeenCalled();
    expect(deps.vtdClient.sliceStore).not.toHaveBeenCalled();
    expect(deps.vtdClient.sliceGet).not.toHaveBeenCalled();
    expect(deps.vtdClient.url).not.toHaveBeenCalled();
    expect(deps.vtdClient.trigger).not.toHaveBeenCalled();
    expect(deps.emitOpenDataSource).not.toHaveBeenCalled();
    expect(deps.emitLayoutProposal).not.toHaveBeenCalled();

    await expect(runRequestBatchConsentTool(input, deps)).rejects.toThrow(
      "request_batch_consent requires a confirmation decision",
    );
    await expect(
      runRequestBatchConsentTool(
        { ...input, itemCount: 0 },
        deps,
        { confirmationDecision: { approved: false, scope: "once" } },
      ),
    ).rejects.toThrow("request_batch_consent.itemCount must be a positive safe integer");
  });

  it("stores a VTD slice with lossless nanoseconds and rejects decimals", async () => {
    const deps = makeDeps();
    const input = {
      id: "record-1",
      topics: ["/speed"],
      startNs: "1000000000000000001",
      endNs: "1000000000000000002",
    };

    await expect(runVtdSliceStoreTool(input, deps)).resolves.toEqual({
      mcapSliceId: "slice-1",
      raw: {},
    });
    expect(deps.vtdClient.sliceStore.mock.calls).toEqual([[input, undefined]]);
    await expect(
      runVtdSliceStoreTool({ id: "record-1", startNs: "1.5" }, deps),
    ).rejects.toThrow(
      "vtd_slice_store.startNs must be an unsigned decimal string",
    );
  });

  it("presigns both stored slices and complete records and rejects ambiguous input", async () => {
    const deps = makeDeps();

    await expect(
      runVtdPresignTool({ sliceId: "slice-1" }, deps),
    ).resolves.toEqual({
      downloadUrl: "https://data.example/slice-1.mcap",
      raw: {},
    });
    await expect(runVtdPresignTool({ id: "record-1" }, deps)).resolves.toEqual({
      downloadUrl: "https://data.example/record-1.mcap",
    });
    await expect(
      runVtdPresignTool({ id: "record-1", sliceId: "slice-1" }, deps),
    ).rejects.toThrow("vtd_presign requires exactly one of sliceId or id");
  });

  it("emits open-data requests and preserves strict MCAP URL validation", async () => {
    const deps = makeDeps();
    const input = {
      urls: ["https://data.example/record%2C1.mcap"],
      sessionId: "session-1",
    };

    await expect(runOpenDataSourceTool(input, deps)).resolves.toEqual({
      status: "opening",
      message: "打开中，等待目录就绪通知",
    });
    expect(deps.emitOpenDataSource).toHaveBeenCalledWith(input, undefined);
    await expect(
      runOpenDataSourceTool(
        { urls: ["http://data.example/record.mcap"] },
        deps,
      ),
    ).rejects.toThrow(
      "open_data_source.urls must contain only HTTPS .mcap URLs without literal commas; encode commas as %2C",
    );
  });

  it("normalizes the active catalog and forwards catalog read failures", async () => {
    const deps = makeDeps();

    await expect(runGetDataCatalogTool({}, deps)).resolves.toEqual({
      topics: [{ name: "/speed", schemaName: "std_msgs/msg/Float64" }],
      datatypes: { "std_msgs/msg/Float64": { definitions: [] } },
    });
    jest.mocked(deps.getCatalog).mockImplementationOnce(() => {
      throw new Error("catalog unavailable");
    });
    await expect(runGetDataCatalogTool({}, deps)).rejects.toThrow(
      "catalog unavailable",
    );
  });

  it("validates and emits layout proposals and rejects unsafe layouts", async () => {
    const deps = makeDeps();
    const input = {
      name: "Speed",
      summary: "Show speed",
      data: validLayoutData(),
    };

    await expect(runProposeLayoutTool(input, deps)).resolves.toEqual({
      accepted: true,
      name: "Speed",
    });
    expect(deps.emitLayoutProposal).toHaveBeenCalledWith(input, undefined);
    await expect(
      runProposeLayoutTool(
        {
          name: "Unsafe",
          data: {
            ...validLayoutData(),
            configById: { "Publish!bad": {} },
            layout: "Publish!bad",
          },
        },
        deps,
      ),
    ).rejects.toThrow('uses unsupported panel type "Publish"');
  });

  it("passes the installed panel type snapshot into layout validation", async () => {
    const deps = makeDeps();
    const panelType = "Acme Extension.Custom Panel";
    const panelId = `${panelType}!main`;
    jest
      .mocked(deps.getInstalledPanelTypes)
      .mockReturnValue(new Set([panelType]));
    const input = {
      name: "Installed extension",
      data: {
        configById: { [panelId]: { customSetting: true } },
        layout: panelId,
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
      },
    };

    await expect(runProposeLayoutTool(input, deps)).resolves.toEqual({
      accepted: true,
      name: "Installed extension",
    });
    expect(deps.getInstalledPanelTypes).toHaveBeenCalledTimes(1);
    expect(deps.emitLayoutProposal).toHaveBeenCalledWith(input, undefined);
  });

  it("preserves aborts, unsupported-tool errors, and the result byte bound", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));

    await expect(
      runVtdDetailTool({ id: "record-1" }, deps, { signal: controller.signal }),
    ).rejects.toThrow("cancelled by caller");
    expect(deps.vtdClient.detail.mock.calls).toHaveLength(0);
    await expect(executeToolRuntime("unknown", {}, deps)).rejects.toThrow(
      'Unsupported local agent tool "unknown"',
    );

    jest.mocked(deps.getCatalog).mockReturnValueOnce({
      topics: ["x".repeat(TOOL_RUNTIME_MAX_RESULT_BYTES + 1)],
      datatypes: new Map(),
    });
    await expect(
      executeToolRuntime("get_data_catalog", {}, deps),
    ).resolves.toMatchObject({
      truncated: true,
    });
  });

  it("preserves all normalized VTD rows when raw metadata exceeds the result byte bound", async () => {
    const deps = makeDeps();
    jest.mocked(deps.vtdClient.search).mockResolvedValueOnce({
      records: Array.from({ length: 22 }, (_, index) => ({
        botSn: "8010006BHQ26E8A0078",
        dataType: "2",
        id: String(900_000 + index),
        raw: { data_topic_info: "x".repeat(14_000) },
      })),
      total: 22,
    });

    const result = await executeToolRuntime(
      "vtd_search",
      { botSnExact: "8010006BHQ26E8A0078", dataDay: "20260803", pageSize: 100 },
      deps,
    );

    expect(result).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ dataType: "2", id: "900000" }),
      ]),
      total: 22,
    });
    const records = (result as { records: Array<Record<string, unknown>> })
      .records;
    expect(records).toHaveLength(22);
    expect(records.every((record) => !Object.hasOwn(record, "raw"))).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(result)).byteLength,
    ).toBeLessThanOrEqual(TOOL_RUNTIME_MAX_RESULT_BYTES);
  });
});
