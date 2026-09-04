// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import HttpVtdClient from "@lichtblick/suite-base/services/vtd/HttpVtdClient";
import { VtdHttpError, VtdJsonError } from "@lichtblick/suite-base/services/vtd/errors";
import type { IVtdClient } from "@lichtblick/suite-base/services/vtd/types";

import {
  executeToolRuntime,
  runDescribeTopicTool,
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
    configById: { "Plot!speed": { paths: [{ value: "/speed.data" }] } },
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
      datatypes: new Map([
        ["std_msgs/msg/Float64", { definitions: [{ name: "data", type: "float64" }] }],
      ]),
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

  it("surfaces VTD failures with their retry context to the agent", async () => {
    // The HttpVtdClient embeds the retry count in the error message; the tool runtime must pass
    // it through unchanged so the agent can tell a retried upstream failure apart from a first
    // attempt.
    const deps = makeDeps();
    deps.vtdClient.search.mockRejectedValueOnce(
      new VtdHttpError("list", 502, "Bad Gateway", "upstream hiccup", 2),
    );

    await expect(runVtdSearchTool({ botSn: "SN001" }, deps)).rejects.toThrow(
      "(retried 2 times)",
    );
  });

  it("surfaces the retry context through a real mixed failure chain", async () => {
    // Two retried 502s followed by a non-retryable JSON failure: the final error must still
    // carry the retry context, and it must survive the toolRuntime passthrough.
    const textResponse = (status: number, text: string): Response => {
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
        headers: { get: () => undefined },
        ok: status >= 200 && status < 300,
        status,
        statusText: "X",
      } as unknown as Response;
    };
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const mockFetch = jest.fn()
        .mockResolvedValueOnce(textResponse(502, "upstream hiccup"))
        .mockResolvedValueOnce(textResponse(502, "upstream hiccup"))
        .mockResolvedValueOnce(textResponse(200, "not-json"));
      const deps = makeDeps() as ToolRuntimeDeps;
      deps.vtdClient = new HttpVtdClient("http://sidecar", mockFetch);

      const promise = runVtdSearchTool({ botSn: "SN001" }, deps).catch(
        (caught: unknown) => caught,
      );
      await jest.advanceTimersByTimeAsync(600); // backoff 1
      await jest.advanceTimersByTimeAsync(1600); // backoff 2
      const error = await promise;
      expect(error).toBeInstanceOf(VtdJsonError);
      expect(error).toMatchObject({ command: "list", retries: 2 });
      expect((error as Error).message).toContain("(retried 2 times)");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
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

    deps.vtdClient.sliceStore.mockClear();
    await runVtdSliceStoreTool({ id: "record-1" }, deps);
    const paramsWithoutTopics = deps.vtdClient.sliceStore.mock.calls[0]?.[0];
    expect(paramsWithoutTopics).toStrictEqual({ id: "record-1" });
    expect(Object.hasOwn(paramsWithoutTopics ?? {}, "topics")).toBe(false);

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

  it("lists the active catalog with filters and forwards catalog read failures", async () => {
    const deps = makeDeps();

    await expect(runGetDataCatalogTool({}, deps)).resolves.toEqual({
      topicCount: 1,
      matchedCount: 1,
      returnedCount: 1,
      topics: [{ name: "/speed", schemaName: "std_msgs/msg/Float64" }],
    });
    await expect(
      runGetDataCatalogTool({ query: "speed", limit: 5 }, deps),
    ).resolves.toEqual({
      topicCount: 1,
      matchedCount: 1,
      returnedCount: 1,
      topics: [{ name: "/speed", schemaName: "std_msgs/msg/Float64" }],
    });
    await expect(
      runGetDataCatalogTool({ schema: "missing/Type" }, deps),
    ).resolves.toEqual({
      topicCount: 1,
      matchedCount: 0,
      returnedCount: 0,
      topics: [],
    });
    await expect(runGetDataCatalogTool({ limit: 501 }, deps)).rejects.toThrow(
      "get_data_catalog.limit must be a positive safe integer",
    );
    jest.mocked(deps.getCatalog).mockImplementationOnce(() => {
      throw new Error("catalog unavailable");
    });
    await expect(runGetDataCatalogTool({}, deps)).rejects.toThrow(
      "catalog unavailable",
    );
  });

  it("describes topic fields, prefers the ready catalog, and validates input", async () => {
    const deps = makeDeps();

    await expect(
      runDescribeTopicTool({ topics: ["/speed"], maxDepth: 3 }, deps),
    ).resolves.toEqual({
      topics: [
        {
          name: "/speed",
          schemaName: "std_msgs/msg/Float64",
          fields: ["data: float64"],
        },
      ],
    });
    // Unknown names come back with suggestions instead of failing the call.
    await expect(
      runDescribeTopicTool({ topics: ["/spped"] }, deps),
    ).resolves.toEqual({
      topics: [],
      unknownTopics: [{ name: "/spped", suggestions: ["/speed"] }],
    });
    // The catalog-ready snapshot from the context is used instead of calling the getter.
    jest.mocked(deps.getCatalog).mockClear();
    const catalogReady = {
      topics: [{ name: "/speed", schemaName: "std_msgs/msg/Float64" }],
      datatypes: new Map([
        ["std_msgs/msg/Float64", { definitions: [{ name: "data", type: "float64" }] }],
      ]),
    };
    await runDescribeTopicTool({ topics: ["/speed"] }, deps, { catalogReady });
    expect(deps.getCatalog).not.toHaveBeenCalled();

    await expect(runDescribeTopicTool({}, deps)).rejects.toThrow(
      "describe_topic.topics is required",
    );
    await expect(
      runDescribeTopicTool({ topics: Array.from({ length: 11 }, (_u, i) => `/t${i}`) }, deps),
    ).rejects.toThrow("describe_topic.topics supports at most 10 topics per call");
    await expect(
      runDescribeTopicTool({ topics: ["/speed"], maxDepth: 11 }, deps),
    ).rejects.toThrow("describe_topic.maxDepth must be a positive safe integer");
  });

  it("rejects unknown properties on catalog tools at the runtime boundary", async () => {
    const deps = makeDeps();

    await expect(
      executeToolRuntime("get_data_catalog", { query: "speed", bogus: true }, deps),
    ).rejects.toThrow('get_data_catalog does not support property "bogus"');
    await expect(
      executeToolRuntime(
        "describe_topic",
        { topics: ["/speed"], includeFields: true },
        deps,
      ),
    ).rejects.toThrow('describe_topic does not support property "includeFields"');
    expect(deps.getCatalog).not.toHaveBeenCalled();
  });

  it("rejects proposals referencing unknown topics with did-you-mean suggestions", async () => {
    const deps = makeDeps();
    jest.mocked(deps.getCatalog).mockReturnValue({
      topics: [{ name: "/odometry", schemaName: "nav_msgs/msg/Odometry" }],
      datatypes: new Map(),
    });
    const input = {
      name: "Unknown topic",
      data: {
        ...validLayoutData(),
        configById: { "Plot!odom": { paths: [{ value: "/odomentry.data" }] } },
        layout: "Plot!odom",
      },
    };

    await expect(runProposeLayoutTool(input, deps)).rejects.toThrow(
      /unknown topic "\/odomentry"/,
    );
    await expect(runProposeLayoutTool(input, deps)).rejects.toThrow(
      /did you mean "\/odometry"/,
    );
    expect(deps.emitLayoutProposal).not.toHaveBeenCalled();
  });

  it("passes catalog warnings through and accepts the proposal", async () => {
    const deps = makeDeps();
    const input = {
      name: "Log warning",
      data: {
        ...validLayoutData(),
        configById: {
          "Plot!speed": { paths: [{ value: "/speed.data" }] },
          "RosOut!log": { topicToRender: "/speed" },
        },
        layout: { direction: "row", first: "Plot!speed", second: "RosOut!log" },
      },
    };

    await expect(runProposeLayoutTool(input, deps)).resolves.toEqual({
      accepted: true,
      name: "Log warning",
      warnings: [
        'configById["RosOut!log"].topicToRender: topic "/speed" uses unsupported schema "std_msgs/msg/Float64" (expected one of: foxglove_msgs/Log, foxglove_msgs/msg/Log, foxglove.Log, foxglove::Log, rcl_interfaces/msg/Log, ros.rcl_interfaces.Log, ros.rosgraph_msgs.Log, rosgraph_msgs/Log)',
      ],
    });
  });

  it("accepts proposals when the catalog read fails", async () => {
    const deps = makeDeps();
    jest.mocked(deps.getCatalog).mockImplementation(() => {
      throw new Error("catalog unavailable");
    });
    const input = {
      name: "Speed",
      data: validLayoutData(),
    };

    await expect(runProposeLayoutTool(input, deps)).resolves.toEqual({
      accepted: true,
      name: "Speed",
    });
    expect(deps.emitLayoutProposal).toHaveBeenCalled();
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
    // The same (empty) snapshot that validated the proposal is forwarded to the emitter.
    expect(deps.getInstalledPanelTypes).toHaveBeenCalledTimes(1);
    expect(deps.emitLayoutProposal).toHaveBeenCalledWith(input, new Set(), undefined);
    await expect(
      runProposeLayoutTool(
        {
          name: "Unsafe",
          data: {
            ...validLayoutData(),
            configById: { "Bogus!bad": {} },
            layout: "Bogus!bad",
          },
        },
        deps,
      ),
    ).rejects.toThrow('uses unsupported panel type "Bogus"');
  });

  it("takes a single host snapshot for validation and baseline emission", async () => {
    const deps = makeDeps();
    const panelType = "Acme Extension.Custom Panel";
    const panelId = `${panelType}!main`;
    // First call returns the extension-admitting set; a second call would return empty.
    const getInstalledPanelTypes = jest.mocked(deps.getInstalledPanelTypes);
    getInstalledPanelTypes
      .mockReturnValueOnce(new Set([panelType]))
      .mockReturnValue(new Set());
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
    expect(getInstalledPanelTypes).toHaveBeenCalledTimes(1);
    // Validation and the emitter saw the same first-call snapshot.
    expect(deps.emitLayoutProposal).toHaveBeenCalledWith(
      input,
      new Set([panelType]),
      undefined,
    );
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
    expect(deps.emitLayoutProposal).toHaveBeenCalledWith(
      input,
      new Set([panelType]),
      undefined,
    );
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

    jest.mocked(deps.vtdClient.topics).mockResolvedValueOnce({
      ["/" + "x".repeat(TOOL_RUNTIME_MAX_RESULT_BYTES)]: 1,
    });
    await expect(
      executeToolRuntime("vtd_topics", { id: "record-1" }, deps),
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
