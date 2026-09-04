// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { mathFunctions } from "@lichtblick/suite-base/panels/Plot/utils/mathFunctions";
import generateRosLib from "@lichtblick/suite-base/players/UserScriptPlayer/transformerWorker/generateRosLib";
import { generateTypesLib } from "@lichtblick/suite-base/players/UserScriptPlayer/transformerWorker/generateTypesLib";
import transform from "@lichtblick/suite-base/players/UserScriptPlayer/transformerWorker/transform";
import {
  AGENT_SAFE_LAYOUT_MAX_COLLECTION_ENTRIES,
  AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES,
  AGENT_SAFE_LAYOUT_MAX_GRAPH_DEPTH,
  AGENT_SAFE_LAYOUT_MAX_GRAPH_NODES,
  AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH,
  AGENT_SAFE_LAYOUT_MAX_STRING_BYTES,
  ALLOWED_PANEL_TYPES,
  HUMANOID_VIZ_PANEL_TYPE,
  QUADRUPED_VIZ_PANEL_TYPE,
  validateLayoutProposalData,
} from "@lichtblick/suite-base/services/agent/layoutSchema";


import { LOCAL_AGENT_TOOL_DEFINITIONS } from "../toolDefinitions";
import {
  PANEL_SKILL_BY_TYPE,
  SKILL_IDS,
  SKILL_REGISTRY,
  buildSkillIndex,
  renderSkill,
} from "./index";
import {
  LOG_TROUBLESHOOTING_LAYOUT,
  REPLAY_ANALYSIS_LAYOUT,
  ROBOT_DEBUG_LAYOUT,
  SENSOR_MONITORING_LAYOUT,
} from "./layoutAuthoring";

describe("skill registry", () => {
  it("keeps ids unique and in sync with the load_skill schema enum", () => {
    const registryIds = [...SKILL_REGISTRY.keys()];
    expect(new Set(registryIds).size).toBe(registryIds.length);
    expect([...SKILL_IDS].sort()).toEqual([...registryIds].sort());

    const loadSkill = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "load_skill",
    );
    const schemaEnum = (
      loadSkill?.inputSchema as {
        properties?: { skillId?: { enum?: string[] } };
      }
    ).properties?.skillId?.enum;
    expect(schemaEnum?.slice().sort()).toEqual([...registryIds].sort());
  });

  it("gives every skill a kebab-case id, a trigger line, and a non-trivial body", () => {
    for (const skill of SKILL_REGISTRY.values()) {
      expect(skill.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.whenToUse.length).toBeGreaterThan(0);
      expect(skill.body.length).toBeGreaterThan(500);
    }
    // The prompt index budget applies to indexed skills only: their trigger line is the one the
    // agent sees up front, so it must stay cheap.
    for (const skill of [...SKILL_REGISTRY.values()].filter((s) => s.indexed !== false)) {
      expect(skill.whenToUse.length).toBeLessThan(140);
    }
  });

  it("marks exactly the per-panel skills as non-indexed", () => {
    const nonIndexed = [...SKILL_REGISTRY.values()].filter((skill) => skill.indexed === false);
    // Every non-indexed skill is a panel-* reference skill, and every panel-* skill is
    // non-indexed: the two sets coincide.
    expect(nonIndexed.length).toBeGreaterThan(0);
    for (const skill of nonIndexed) {
      expect(skill.id).toMatch(/^panel-[a-z0-9-]+$/);
      expect(skill.id).not.toBe("panel-catalog");
    }
    for (const skill of [...SKILL_REGISTRY.values()].filter(
      (s) => s.id.startsWith("panel-") && s.id !== "panel-catalog",
    )) {
      expect(skill.indexed).toBe(false);
    }
  });

  it("indexes only indexed skills on their own lines without leaking bodies", () => {
    const indexed = [...SKILL_REGISTRY.values()].filter((skill) => skill.indexed !== false);
    const index = buildSkillIndex();
    for (const skill of indexed) {
      expect(index).toContain(`- ${skill.id}: ${skill.whenToUse}`);
    }
    // Non-indexed skills must not sneak into the index through any formatting variant.
    for (const skill of [...SKILL_REGISTRY.values()].filter((s) => s.indexed === false)) {
      expect(index).not.toContain(`- ${skill.id}:`);
    }
    // Bodies stay behind load_skill for every skill, indexed or not.
    for (const skill of SKILL_REGISTRY.values()) {
      expect(index).not.toContain(skill.body);
    }
    expect(index.split("\n")).toHaveLength(indexed.length);
    // Budget: the whole index stays under 1200 chars even as the registry grows (raised from
    // 1000 when the vita-data-conventions skill was added).
    expect(index.length).toBeLessThan(1200);
  });

  it("reaches every non-indexed skill from the panel-catalog body", () => {
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    const nonIndexed = [...SKILL_REGISTRY.values()].filter((skill) => skill.indexed === false);
    // No dangling references: each non-indexed skill must be named by the router that the agent
    // reads before choosing panels, so it stays discoverable without an index line.
    for (const skill of nonIndexed) {
      expect(catalog).toContain(skill.id);
    }
  });

  it("tags a rendered skill with the id used to load it", () => {
    const skill = SKILL_REGISTRY.get("vtd-query")!;
    const rendered = renderSkill(skill);
    expect(rendered).toContain('<skill id="vtd-query">');
    expect(rendered).toContain(skill.body);
  });

  it("documents every allowlisted panel type in some skill", () => {
    // A panel the agent may propose but no skill describes is a panel it will use badly.
    const documented = [...SKILL_REGISTRY.values()]
      .map((skill) => skill.body)
      .join("\n");
    for (const panelType of ALLOWED_PANEL_TYPES) {
      expect(documented).toContain(panelType);
    }
  });

  it("documents the RosOut panel's exact schema allowlist and config defaults", () => {
    const catalog = SKILL_REGISTRY.get("panel-rosout")!.body;
    const expectedSchemas = [
      "foxglove_msgs/Log",
      "foxglove_msgs/msg/Log",
      "foxglove.Log",
      "foxglove::Log",
      "rcl_interfaces/msg/Log",
      "ros.rcl_interfaces.Log",
      "ros.rosgraph_msgs.Log",
      "rosgraph_msgs/Log",
    ];
    // The documented schema list must be exactly these eight, in order: a missing, extra, or
    // renamed entry fails the exact equality.
    const schemasBlock = catalog.match(
      /never through `convertibleTo`:\n\n```\n([\s\S]*?)\n```/,
    );
    expect(schemasBlock?.[1]).toBeDefined();
    const documentedSchemas = schemasBlock![1]!
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(documentedSchemas).toEqual(expectedSchemas);

    // Exact matching: convertibleTo must not qualify a topic for RosOut.
    expect(catalog).toMatch(/RosOut is the exception/);
    expect(catalog).toMatch(/does not qualify/);
    expect(catalog).toMatch(/matched exactly/);
    // Config fields, defaults, fallback behavior, and bare-config validity, as read from
    // panels/Log.
    for (const field of ["topicToRender", "minLogLevel", "searchTerms", "nameFilter"]) {
      expect(catalog).toContain(field);
    }
    expect(catalog).toContain("minLogLevel` (default `1`)");
    expect(catalog).toContain("searchTerms` (default `[]`)");
    expect(catalog).toMatch(/the first available topic with a\s+supported schema/);
    expect(catalog).toContain("falls back to `/rosout`");
    expect(catalog).toContain("A bare `{}` config is valid");
    expect(catalog).toMatch(/DEBUG=1,\s+INFO=2,\s+WARN=3,\s+ERROR=4,\s+FATAL=5/);
  });

  describe("panel-* skill config documentation", () => {
    // Table-driven: for each new panel skill, every JSON example config in its body must only
    // use keys the panel's source type really accepts (plus lichtblickPanelTitle), and the body
    // must carry the schema/topic facts and example keys listed. Key sources:
    // panels/Audio/types.ts, DiagnosticSummary/types.ts, DiagnosticStatus/types.ts,
    // types/layouts.ts TabPanelConfig, VariableSlider/types.ts, Teleop/types.ts,
    // Publish/types.ts, CallService/types.ts, UserScriptEditor/Config.ts.
    const PANEL_CONFIG_EXPECTATIONS: ReadonlyArray<{
      skillId: string;
      panelType: string;
      allowedKeys: readonly string[];
      forbiddenKeys?: readonly string[];
      requiredExampleKeys?: readonly string[];
      requiredTexts: readonly string[];
    }> = [
      {
        skillId: "panel-audio",
        panelType: "Audio",
        allowedKeys: ["topicPath", "volume", "muted"],
        forbiddenKeys: ["topic", "slidingViewWidth"],
        requiredExampleKeys: ["topicPath", "volume", "muted"],
        requiredTexts: ["foxglove.RawAudio", "pcm-s16"],
      },
      {
        skillId: "panel-diagnostic-summary",
        panelType: "DiagnosticSummary",
        allowedKeys: [
          "minLevel",
          "pinnedIds",
          "topicToRender",
          "hardwareIdFilter",
          "sortByLevel",
          "secondsUntilStale",
        ],
        forbiddenKeys: ["selectedHardwareId", "selectedName"],
        requiredExampleKeys: ["topicToRender", "minLevel"],
        requiredTexts: [
          "diagnostic_msgs/DiagnosticArray",
          "diagnostic_msgs/msg/DiagnosticArray",
          "ros.diagnostic_msgs.DiagnosticArray",
        ],
      },
      {
        skillId: "panel-diagnostic-status",
        panelType: "DiagnosticStatusPanel",
        allowedKeys: [
          "selectedHardwareId",
          "selectedName",
          "splitFraction",
          "topicToRender",
          "numericPrecision",
          "secondsUntilStale",
        ],
        forbiddenKeys: ["minLevel", "pinnedIds"],
        requiredExampleKeys: ["topicToRender"],
        requiredTexts: ["diagnostic_msgs/DiagnosticArray"],
      },
      {
        skillId: "panel-tab",
        panelType: "Tab",
        allowedKeys: ["activeTabIdx", "tabs"],
        requiredExampleKeys: ["activeTabIdx", "tabs"],
        requiredTexts: ["-1"],
      },
      {
        skillId: "panel-variable-slider",
        panelType: "GlobalVariableSliderPanel",
        allowedKeys: ["sliderProps", "globalVariableName"],
        requiredExampleKeys: ["globalVariableName", "sliderProps"],
        requiredTexts: ["$name"],
      },
      {
        skillId: "panel-teleop",
        panelType: "Teleop",
        allowedKeys: [
          "topic",
          "publishRate",
          "upButton",
          "downButton",
          "leftButton",
          "rightButton",
        ],
        requiredExampleKeys: ["topic", "upButton"],
        requiredTexts: ["geometry_msgs/Twist"],
      },
      {
        skillId: "panel-publish",
        panelType: "Publish",
        allowedKeys: [
          "topicName",
          "datatype",
          "buttonText",
          "buttonTooltip",
          "buttonColor",
          "advancedView",
          "value",
        ],
        requiredExampleKeys: ["advancedView", "value"],
        requiredTexts: [],
      },
      {
        skillId: "panel-call-service",
        panelType: "CallService",
        allowedKeys: [
          "serviceName",
          "requestPayload",
          "layout",
          "buttonText",
          "buttonTooltip",
          "buttonColor",
        ],
        requiredExampleKeys: ["serviceName", "requestPayload"],
        requiredTexts: [],
      },
      {
        skillId: "panel-parameters",
        panelType: "Parameters",
        allowedKeys: [],
        requiredTexts: ["getParameters"],
      },
      {
        skillId: "panel-topic-graph",
        panelType: "TopicGraph",
        allowedKeys: [],
        requiredTexts: ["publishedTopics"],
      },
      {
        skillId: "panel-playback-performance",
        panelType: "PlaybackPerformance",
        allowedKeys: [],
        requiredTexts: ["sparklines"],
      },
      {
        skillId: "panel-user-script-editor",
        panelType: "NodePlayground",
        allowedKeys: ["selectedNodeId", "autoFormatOnSave"],
        forbiddenKeys: [
          "editorForStorybook",
          "additionalBackStackItems",
          "sourceCode",
          "inputs",
          "output",
        ],
        requiredExampleKeys: ["selectedNodeId", "autoFormatOnSave"],
        requiredTexts: ["userNodes"],
      },
    ];

    function panelConfigsInBody(
      body: string,
      panelType: string,
    ): Record<string, unknown>[] {
      const blocks = [...body.matchAll(/^[ \t]*```json\n([\s\S]*?)\n[ \t]*```/gm)]
        .map((match) => match[1] ?? "")
        .filter((block) => block.length > 0);
      const configs: Record<string, unknown>[] = [];
      for (const block of blocks) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
          continue;
        }
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.configById === "object" && obj.configById != null) {
          for (const [panelId, config] of Object.entries(
            obj.configById as Record<string, Record<string, unknown>>,
          )) {
            if (panelId.startsWith(`${panelType}!`)) {
              configs.push(config);
            }
          }
        } else {
          configs.push(obj);
        }
      }
      return configs;
    }

    for (const entry of PANEL_CONFIG_EXPECTATIONS) {
      it(`documents only source-typed config keys for ${entry.skillId}`, () => {
        const skill = SKILL_REGISTRY.get(entry.skillId);
        expect(skill).toBeDefined();
        const body = skill!.body;
        const allowed = new Set([...entry.allowedKeys, "lichtblickPanelTitle"]);
        const configs = panelConfigsInBody(body, entry.panelType);
        expect(configs.length).toBeGreaterThan(0);
        const exampleKeys = new Set<string>();
        for (const config of configs) {
          for (const key of Object.keys(config)) {
            expect(allowed.has(key)).toBe(true);
            exampleKeys.add(key);
          }
        }
        for (const key of entry.forbiddenKeys ?? []) {
          expect(exampleKeys.has(key)).toBe(false);
        }
        for (const key of entry.requiredExampleKeys ?? []) {
          expect(exampleKeys.has(key)).toBe(true);
        }
      });

      it(`documents the schema facts ${entry.skillId} depends on`, () => {
        const body = SKILL_REGISTRY.get(entry.skillId)!.body;
        for (const text of entry.requiredTexts) {
          expect(body).toContain(text);
        }
      });
    }

    it("spells the extension-panel `{}` strategy in layout-authoring and panel-catalog", () => {
      for (const id of ["layout-authoring", "panel-catalog"]) {
        const body = SKILL_REGISTRY.get(id)!.body;
        expect(body).toContain("get_current_layout");
        expect(body).toMatch(/propose `\{\}`/);
        expect(body).toMatch(/Never guess\s+config keys/);
      }
    });
  });

  it("assigns every panel type to a per-panel skill or robot-viz", () => {
    // Each panel type owns exactly one skill that documents it (the two robot panels share
    // robot-viz). A missing, extra, or renamed mapping fails here.
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    for (const [panelType, skillId] of PANEL_SKILL_BY_TYPE) {
      const skill = SKILL_REGISTRY.get(skillId);
      expect(skill).toBeDefined();
      // The body documents the exact panel-type string, not just a lookalike substring.
      expect(skill!.body).toContain(`\`${panelType}\``);
      // Every entry except robot-viz maps to a non-indexed panel-* skill; the two robot
      // panels are the indexed exception documented by robot-viz.
      expect(skill!.indexed === false).toBe(skillId !== "robot-viz");
    }

    // Every entry's skill must be reachable: panel-* ids are named by the catalog router's
    // per-panel table, and robot-viz by its "Two robot panels" section.
    for (const skillId of PANEL_SKILL_BY_TYPE.values()) {
      expect(catalog).toContain(skillId);
    }
    for (const robotType of [QUADRUPED_VIZ_PANEL_TYPE, HUMANOID_VIZ_PANEL_TYPE]) {
      expect(PANEL_SKILL_BY_TYPE.get(robotType)).toBe("robot-viz");
    }
    expect(SKILL_REGISTRY.get("robot-viz")!.indexed).not.toBe(false);
    expect(catalog).toContain("robot-viz");
  });

  it("documents the vita/aorta platform conventions", () => {
    const vita = SKILL_REGISTRY.get("vita-data-conventions")!;
    expect(vita.indexed).not.toBe(false);
    expect(buildSkillIndex()).toContain("- vita-data-conventions:");
    // Key facts distilled from the recorded Vita sessions (plan D7): topic naming, log lookup,
    // audio, joints, collectd, battery, and the analysis recipes.
    for (const keyword of [
      "raw_audio_dump",
      "motor_state",
      "no leading slash",
      "s100/vlog",
      "x5/vlog_batch",
      "aorta/default/pub/log",
      "get_data_catalog({query:\"log\"})",
      "describe_topic",
      "/speech_dog_to_phone",
      "string_value",
      "gnss/fusion",
      "h265_quarter",
      "bms_state.voltage_mv",
      "emergency_stop_active",
      "core_id",
      "Joystick lag",
    ]) {
      expect(vita.body).toContain(keyword);
    }
    // The catalog router mentions the platform skill for Vita recordings.
    expect(SKILL_REGISTRY.get("panel-catalog")!.body).toContain("vita-data-conventions");
  });

  it("registers every non-indexed skill in the load_skill enum", () => {
    const loadSkill = LOCAL_AGENT_TOOL_DEFINITIONS.find(
      (tool) => tool.name === "load_skill",
    );
    const schemaEnum = (
      loadSkill?.inputSchema as {
        properties?: { skillId?: { enum?: string[] } };
      }
    ).properties?.skillId?.enum;
    for (const skill of [...SKILL_REGISTRY.values()].filter((s) => s.indexed === false)) {
      expect(schemaEnum).toContain(skill.id);
    }
  });

  it("tells the agent to prefer the quadruped panel for robot 3D views", () => {
    const robotViz = SKILL_REGISTRY.get("robot-viz")!.body;
    expect(robotViz).toContain(QUADRUPED_VIZ_PANEL_TYPE);
    expect(robotViz).toContain(HUMANOID_VIZ_PANEL_TYPE);
    expect(robotViz).toMatch(/Default to the quadruped panel/);
    // The generic 3D panel must not be reachable without an explicit request, so the catalog entry
    // has to point back here rather than reading as a free choice.
    expect(SKILL_REGISTRY.get("panel-catalog")!.body).toContain(
      "read the robot-viz skill",
    );
  });

  it("points panel availability decisions to the live inventory", () => {
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    expect(catalog).toContain('"Available panels" is authoritative');
    expect(catalog).toContain("`list_panels`");
    expect(catalog).not.toContain("Panels not listed here cannot be proposed");
  });

  it("requires relative VTD dates to be resolved before calling a tool", () => {
    const vtdQuery = SKILL_REGISTRY.get("vtd-query")!;
    expect(vtdQuery.body).toContain(
      'relative dates such as "yesterday", "today", or "last week"',
    );
    expect(vtdQuery.body).toContain("current time and browser");
    expect(vtdQuery.body).toContain(
      "Never pass relative-date words directly to a tool",
    );
    // B5: the skill's trigger line scopes it to finding NEW recordings only; questions about
    // already-loaded data never need it.
    expect(vtdQuery.whenToUse).toContain("new VTD recordings");
    expect(vtdQuery.whenToUse).toContain("already-loaded data");
  });

  it("keeps textual replies to vtd_search results brief instead of listing records", () => {
    const vtdQuery = SKILL_REGISTRY.get("vtd-query")!.body;
    expect(vtdQuery).toContain("interactive list card");
    expect(vtdQuery).toContain("Never enumerate matching records one by one");
    expect(vtdQuery).toContain("brief");
    expect(vtdQuery).toContain("1-3 sentences");
  });

  it("distinguishes data-coverage windows from trigger-time windows", () => {
    const vtdQuery = SKILL_REGISTRY.get("vtd-query")!.body;
    expect(vtdQuery).toContain('For "data at a particular time"');
    expect(vtdQuery).toContain("use `queryStart`/`queryEnd`");
    expect(vtdQuery).toContain("Never use `start`/`end` for them");
    expect(vtdQuery).toContain("8010006CHQ26FAA0212");
    expect(vtdQuery).toContain("`start`/`end` returned 0 records");
    expect(vtdQuery).toContain("returned 6 records");
  });

  it("documents the batch time-window slice and single-load playbook", () => {
    const vtdSlice = SKILL_REGISTRY.get("vtd-slice")!.body;
    expect(vtdSlice).toContain("Call `request_batch_consent` exactly once");
    expect(vtdSlice).toContain('`action: "slice_and_load"`');
    expect(vtdSlice).toContain("If it returns `approved: false`, stop the plan");
    expect(vtdSlice).toMatch(/never ask\s+for consent again in conversational text/);
    expect(vtdSlice).not.toContain("Ask for consent exactly once");
    expect(vtdSlice).not.toContain("ask whether to slice all of them");
    expect(vtdSlice).toContain(
      "This intersection prevents out-of-range slices",
    );
    expect(vtdSlice).toContain("Omit `topics` to keep all topics by default");
    expect(vtdSlice).toContain("session-scoped approval");
    expect(vtdSlice).toContain("collect all `downloadUrl` values");
    expect(vtdSlice).toContain("call `open_data_source` exactly once");
    expect(vtdSlice).toContain("Never open each URL separately");
  });

  it("requires one complete layout proposal instead of incremental skeletons", () => {
    const layoutAuthoring = SKILL_REGISTRY.get("layout-authoring")!.body;
    expect(layoutAuthoring).toContain("Build the entire layout internally");
    expect(layoutAuthoring).toContain("Call `propose_layout` once with that");
    expect(layoutAuthoring).toContain("Never submit a skeleton, placeholder, or partial layout");
    expect(layoutAuthoring).toContain("`get_data_catalog`");
    expect(layoutAuthoring).toContain("Available panels");
    expect(layoutAuthoring).toContain("Only propose again within the same request");
    expect(layoutAuthoring).toContain("one complete revised version at a time");
    // Validation rejections are retried with a cap, and raw rejections are never relayed.
    expect(layoutAuthoring).toMatch(/Re-propose at most 2 times/);
    expect(layoutAuthoring).toMatch(/Never relay the raw rejection text/);
  });

  it("documents the studio_script virtual-topic exception in layout authoring", () => {
    const layoutAuthoring = SKILL_REGISTRY.get("layout-authoring")!.body;
    expect(layoutAuthoring).toMatch(/export const output/);
    expect(layoutAuthoring).toMatch(/same proposal/);
    expect(layoutAuthoring).toMatch(/virtual catalog/);
    expect(layoutAuthoring).toMatch(/never reference one/);
  });

  it("exempts output-panel target names from the catalog existence check", () => {
    const layoutAuthoring = SKILL_REGISTRY.get("layout-authoring")!.body;
    expect(layoutAuthoring).toMatch(/Output panels are exempt/);
    expect(layoutAuthoring).toContain("`topicName`");
    expect(layoutAuthoring).toContain("`serviceName`");
    expect(layoutAuthoring).toMatch(/`datatype` is different/);
    expect(layoutAuthoring).toMatch(/schema name present in the catalog/);
    // The read-side rule stays in place: only what the proposal reads is catalog-checked.
    expect(layoutAuthoring).toMatch(/every topic the layout \*\*reads\*\*/);
  });

  it("restricts map followTopic to NavSatFix/LocationFix and documents propose_layout validation", () => {
    const map = SKILL_REGISTRY.get("panel-map")!.body;
    expect(map).toMatch(/cannot follow a GeoJSON\s+layer/);
    expect(map).toContain("sensor_msgs/NavSatFix");
    expect(map).toContain("foxglove.LocationFix");
    expect(map).toMatch(/`propose_layout` validates `followTopic`/);
    expect(map).toMatch(/`topicColors` keys/);
  });

  it("keeps the Plot slice rule consistent between message-path and panel-plot", () => {
    const messagePath = SKILL_REGISTRY.get("message-path")!.body;
    expect(messagePath).not.toContain("one series per element");
    expect(messagePath).toMatch(/one aggregated\s+legend entry/);
    expect(messagePath).toMatch(/\[N-1\]/);
    const plot = SKILL_REGISTRY.get("panel-plot")!.body;
    expect(plot).toMatch(/one legend entry/);
    expect(plot).toMatch(/\[N-1\]/);
  });

  it("makes topic verification and placeholder examples part of layout authoring", () => {
    const layoutAuthoring = SKILL_REGISTRY.get("layout-authoring")!.body;
    expect(layoutAuthoring).toContain("## Topic verification");
    expect(layoutAuthoring).toMatch(/byte for byte/);
    expect(layoutAuthoring).toMatch(/did you mean/);
    expect(layoutAuthoring).toMatch(/`get_current_layout\(/);
    expect(layoutAuthoring).toMatch(/root mosaic/);
    expect(layoutAuthoring).toMatch(/tooLarge/);
    // Plot slicing, colors, and the no-arithmetic rule.
    expect(layoutAuthoring).toMatch(/one legend entry/);
    expect(layoutAuthoring).toMatch(/no arithmetic/);
    // Every pattern-library example uses the /example/ placeholder prefix.
    for (const example of [
      ROBOT_DEBUG_LAYOUT,
      SENSOR_MONITORING_LAYOUT,
      LOG_TROUBLESHOOTING_LAYOUT,
      REPLAY_ANALYSIS_LAYOUT,
    ]) {
      expect(JSON.stringify(example)).toContain("/example/");
    }
  });

  it("keeps layout-authoring sections on the get_current_layout/describe_topic contract", () => {
    const body = SKILL_REGISTRY.get("layout-authoring")!.body;
    const extendIdx = body.indexOf("## Extending the layout the user has open");
    const topicIdx = body.indexOf("## Topic verification");
    const plotIdx = body.indexOf("## Plot rules");
    expect(extendIdx).toBeGreaterThan(0);
    expect(topicIdx).toBeGreaterThan(extendIdx);
    expect(plotIdx).toBeGreaterThan(topicIdx);
    const extendSection = body.slice(extendIdx, topicIdx);
    const topicSection = body.slice(topicIdx, plotIdx);
    // Contract strings: in-place extension goes through get_current_layout; topic verification
    // goes through describe_topic / get_data_catalog({ query }).
    expect(extendSection).toMatch(/`get_current_layout\(/);
    expect(extendSection).toContain("tooLarge");
    expect(topicSection).toMatch(/`describe_topic`/);
    expect(topicSection).toMatch(/`get_data_catalog\(\{ query \}\)`/);
    // The obsolete contract parameters must not leak into these sections (or anywhere else).
    for (const section of [extendSection, topicSection]) {
      expect(section).not.toContain("includeFields");
      expect(section).not.toContain('query:"log|');
    }
    expect(body).not.toContain("includeFields");
    expect(body).not.toContain('query:"log|');
    // The layout examples these sections reference still parse as JSON.
    const blocks = [...body.matchAll(/^[ \t]*```json\n([\s\S]*?)\n[ \t]*```/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(blocks.length).toBeGreaterThan(0);
    let parsedBlocks = 0;
    for (const block of blocks) {
      try {
        JSON.parse(block);
        parsedBlocks++;
      } catch {
        // The Structure sketch with /* comments */ is intentionally not parseable JSON.
      }
    }
    expect(parsedBlocks).toBeGreaterThan(0);
  });

  it("routes panel selection on catalog evidence and forbids guessing fields", () => {
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    // T2: catalog evidence first — the new get_data_catalog is a cheap listing tool, so the
    // skill encourages query-then-describe instead of gating it behind three conditions.
    expect(catalog).toMatch(/workspace summary/);
    expect(catalog).toMatch(/catalog-ready/);
    expect(catalog).toMatch(/use `get_data_catalog` freely/);
    expect(catalog).toMatch(/`get_data_catalog\(\{ query \}\)`/);
    expect(catalog).toMatch(/`describe_topic\(\{ topics: \[\.\.\.\] \}\)`/);
    expect(catalog).toMatch(/truncated/);
    expect(catalog).toMatch(/field structure/);
    // Degradation for a truncated catalog: minimal fetch, schema-driven fallback.
    expect(catalog).toMatch(/one call per need/);
    // Never guess fields when the datatype structure is not visible.
    expect(catalog).toMatch(/never guess a field name or a messagePath/);
    expect(catalog).toMatch(/schema-driven panel/);
    expect(catalog).toMatch(/ask the user/);
    // The decision table is a multi-to-many candidate map, not a hard rule.
    expect(catalog).toMatch(/\*\*candidates, not hard rules\*\*/);
    expect(catalog).toMatch(/Available panels.*always wins/);
    // Schema aliases and the convertibleTo boundary live at routing level.
    expect(catalog).toContain("pkg/msg/Type");
    expect(catalog).toContain("convertibleTo");
    // Per-panel loading instruction.
    expect(catalog).toMatch(/load its `panel-\*` skill/);
  });

  it("records the rendering constraints that layout validation cannot enforce", () => {
    // A Plot path without `enabled` validates but renders nothing — the failure the per-panel
    // skills exist to prevent.
    expect(SKILL_REGISTRY.get("panel-plot")!.body).toContain('"enabled": true');
    expect(SKILL_REGISTRY.get("panel-pie-chart")!.body).toContain("float32[]");
    expect(SKILL_REGISTRY.get("panel-3d")!.body).toContain('"visible": true');
    // The router points at the per-panel skills instead of repeating every constraint.
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    for (const skillId of ["panel-plot", "panel-pie-chart", "panel-3d"]) {
      expect(catalog).toContain(skillId);
    }
  });

  it("documents the Indicator scalar-path rule and the Gauge reverse semantics", () => {
    // Verified against the sources: Indicator.tsx maps a resolved message object to undefined, so
    // a topic root must not be proposed; Gauge's reverse only mirrors the color gradient.
    const indicator = SKILL_REGISTRY.get("panel-indicator")!.body;
    expect(indicator).toMatch(/must resolve to the scalar field itself/);
    expect(indicator).toMatch(/\/std_msgs_bool_topic\.data/);
    expect(indicator).toMatch(/treats as no value/);
    // The worked example itself must point at a scalar field, never at a topic root.
    expect(indicator).toContain('"path": "/system/healthy.data"');
    expect(indicator).not.toContain('"path": "/system/healthy"');
    // The layout-authoring examples carry the same corrected path with the /example/ placeholder
    // topic prefix.
    expect(SKILL_REGISTRY.get("layout-authoring")!.body).toContain(
      '"path": "/example/system/healthy.data"',
    );
    const gauge = SKILL_REGISTRY.get("panel-gauge")!.body;
    expect(gauge).toMatch(/pointer position is unaffected/);
    // The catalog decision table says the same thing.
    expect(SKILL_REGISTRY.get("panel-catalog")!.body).toMatch(
      /topic root resolves to the message object/,
    );
  });

  it("validates every layout pattern library example as executable layout data", () => {
    const examples = [
      ROBOT_DEBUG_LAYOUT,
      SENSOR_MONITORING_LAYOUT,
      LOG_TROUBLESHOOTING_LAYOUT,
      REPLAY_ANALYSIS_LAYOUT,
    ];
    for (const example of examples) {
      // The example must be a valid proposal as written in the skill body...
      expect(() => validateLayoutProposalData(example)).not.toThrow();
      // ...and after the JSON round-trip a proposal crosses in transit. The examples are pure
      // JSON, so stringify never returns undefined; the fallback only satisfies the type.
      const roundTripped: unknown = JSON.parse(JSON.stringify(example) ?? "null");
      expect(() => validateLayoutProposalData(roundTripped)).not.toThrow();
      // Examples stay far inside the documented budgets: at most 5 panels.
      expect(Object.keys(example.configById).length).toBeLessThanOrEqual(5);
    }
  });

  it("documents the layout pattern library and every budget boundary in the skill body", () => {
    const layoutAuthoring = SKILL_REGISTRY.get("layout-authoring")!.body;
    expect(layoutAuthoring).toContain("Layout pattern library");
    for (const heading of [
      "Robot debugging",
      "Sensor monitoring",
      "Log troubleshooting",
      "Replay analysis",
      "Budget boundaries",
    ]) {
      expect(layoutAuthoring).toContain(heading);
    }
    // Proportions are advice, not enforced limits.
    expect(layoutAuthoring).toMatch(/suggestions, not hard\s+limits/);
    // Every exported budget constant is spelled out with its current value.
    for (const budget of [
      AGENT_SAFE_LAYOUT_MAX_COLLECTION_ENTRIES,
      AGENT_SAFE_LAYOUT_MAX_CONFIG_BY_ID_ENTRIES,
      AGENT_SAFE_LAYOUT_MAX_GRAPH_DEPTH,
      AGENT_SAFE_LAYOUT_MAX_GRAPH_NODES,
      AGENT_SAFE_LAYOUT_MAX_MOSAIC_DEPTH,
      AGENT_SAFE_LAYOUT_MAX_STRING_BYTES,
    ]) {
      expect(layoutAuthoring).toContain(String(budget));
    }
  });

  it("checks slash-less topic spellings first in data-diagnosis", () => {
    const diagnosis = SKILL_REGISTRY.get("data-diagnosis")!.body;
    expect(diagnosis).toMatch(/with the leading slash and once\s+without/);
    expect(diagnosis).toMatch(/one spelling returns 0\s+messages/);
    // The check forks on the source kind: only recordings can read messages.
    expect(diagnosis).toContain("Source kind: recording");
    expect(diagnosis).toContain("Source kind: live");
    expect(diagnosis).toMatch(/Waiting for data…/);
  });

  it("documents the data-query tools: usage, first-error flow, live-source limits, and scan caps", () => {
    const dataQuery = SKILL_REGISTRY.get("data-query")!;
    expect(dataQuery.id).toBe("data-query");
    // Indexed: the capability is advertised in the prompt index, not hidden behind a router.
    expect(buildSkillIndex()).toContain("- data-query:");

    for (const tool of ["read_messages", "search_messages", "playback_control"]) {
      expect(dataQuery.body).toContain(tool);
    }
    // The first-error playbook: search level=error limit=1 then seek its receiveTimeNs.
    expect(dataQuery.body).toMatch(/level: "error", limit: 1/);
    expect(dataQuery.body).toMatch(/receiveTimeNs/);
    // Live sources cannot be read; playback may be per-action unavailable.
    expect(dataQuery.body).toMatch(/live source/);
    expect(dataQuery.body).toMatch(/50,000/);
    expect(dataQuery.body).toMatch(/decimal nanoseconds/);
  });

  it("documents seek undo, window sizing, and live-source behavior in data-query", () => {
    const dataQuery = SKILL_REGISTRY.get("data-query")!.body;
    expect(dataQuery).toMatch(/previousTimeNs/);
    // previousTimeNs is optional: undo depends on the player reporting a current time.
    expect(dataQuery).toMatch(/optionally.*`previousTimeNs`/s);
    expect(dataQuery).toMatch(/when it is absent/);
    expect(dataQuery).toMatch(/10× the period/);
    expect(dataQuery).toMatch(/Source kind: live/);
    expect(dataQuery).toMatch(/do not sweep second by second/);
  });

  it("documents the vtd_search 502 fallback ladder", () => {
    const vtdQuery = SKILL_REGISTRY.get("vtd-query")!.body;
    expect(vtdQuery).toMatch(/502/);
    expect(vtdQuery).toContain("Retry the identical call once");
    expect(vtdQuery).toMatch(/`dataDay` per-day queries/);
    expect(vtdQuery).toMatch(/report the search as failed/);
  });

  it("puts verbatim topic copying before the message-path grammar", () => {
    const body = SKILL_REGISTRY.get("message-path")!.body;
    expect(body).toMatch(/Copy the topic exactly as the catalog spells it/);
    expect(body).toMatch(/no arithmetic, no numeric constants/);
    const copyIdx = body.indexOf("Copy the topic exactly");
    const grammarIdx = body.indexOf("## Grammar");
    expect(copyIdx).toBeGreaterThan(0);
    expect(copyIdx).toBeLessThan(grammarIdx);
  });

  it("forbids guessing the Gauge range and routes enums away from Gauge", () => {
    const gauge = SKILL_REGISTRY.get("panel-gauge")!.body;
    expect(gauge).toMatch(/never guess/);
    expect(gauge).toContain("read_messages");
    expect(gauge).toContain("StateTransitions");
  });

  it("requires RosOut proposals to name topicToRender explicitly", () => {
    const rosOut = SKILL_REGISTRY.get("panel-rosout")!.body;
    expect(rosOut).toMatch(/always write it explicitly/);
  });

  it("documents the live-source restriction in panel-catalog", () => {
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    expect(catalog).toMatch(/Source kind: live/);
    expect(catalog).toMatch(/field-level verification needs a recording file/);
  });

  it("registers the complete collectd metric and conversion reference", () => {
    const collectd = SKILL_REGISTRY.get("collectd-metrics")!;
    expect(collectd.id).toBe("collectd-metrics");
    expect(collectd.whenToUse).toContain("collectd/*");
    expect(collectd.whenToUse).toMatch(
      /CPU.*memory.*disk.*network.*process.*thermal/i,
    );
    expect(collectd.body.length).toBeLessThanOrEqual(20_000);

    for (const keyword of [
      "diff_rate",
      "ValuesPercentage=true",
      "CPU cores",
      "bytes/s",
      "NaN",
    ]) {
      expect(collectd.body).toContain(keyword);
    }

    for (const plugin of [
      "cpu",
      "memory",
      "load",
      "df",
      "disk",
      "interface",
      "irq",
      "tasks_cpu",
      "processes",
      "soc_thermal",
      "perf_trigger",
      "vita_basic",
    ]) {
      expect(collectd.body).toContain(plugin);
    }

    for (const metric of [
      "cpu-user",
      "cpu-system",
      "cpu-idle",
      "cpu-wait",
      "cpu-nice",
      "cpu-softirq",
      "cpu-interrupt",
      "cpu-steal",
      "memory-used",
      "memory-free",
      "memory-buffered",
      "memory-cached",
      "memory-slab_recl",
      "memory-slab_unrecl",
      "load-shortterm",
      "load-midterm",
      "load-longterm",
      "df_complex-used",
      "df_complex-free",
      "df_complex-reserved",
      "df_inodes-used",
      "df_inodes-free",
      "df_inodes-reserved",
      "disk_octets",
      "disk_ops",
      "disk_time",
      "disk_merged",
      "disk_io_time",
      "weighted_io_time",
      "pending_operations",
      "if_octets",
      "if_packets",
      "if_errors",
      "if_dropped",
      "irq-<name>",
      "proc_cpu (user)",
      "proc_cpu (syst)",
      "ps_rss",
      "proc_cpu (thread, user)",
      "proc_cpu (thread, syst)",
      "temperature-cpu_<n>",
      "temperature-mcu_<n>",
      "temperature-bpu_<n>",
      "percent-bpu_0",
      "gauge-heartbeat",
    ]) {
      expect(collectd.body).toContain(metric);
    }
  });

  describe("user-scripts skill", () => {
    it("is indexed in the prompt index", () => {
      const index = buildSkillIndex();
      expect(index).toContain("- user-scripts:");
    });

    it("documents the script format, constraints, and the NodePlayground editor", () => {
      const userScripts = SKILL_REGISTRY.get("user-scripts")!;
      expect(userScripts.whenToUse).toMatch(/derived|transformed|aggregated/i);
      const body = userScripts.body;
      // Format elements: inputs/output/default export with the collision-avoiding prefix.
      expect(body).toContain("export const inputs");
      expect(body).toContain("export const output");
      expect(body).toContain("export default function");
      expect(body).toContain("/studio_script/");
      expect(body).toContain("must start with `/studio_script/`");
      // Inputs come from the catalog, never from memory.
      expect(body).toMatch(/inputs` must name real topics from the loaded catalog/);
      // Scripts travel in userNodes with exactly { name, sourceCode }.
      expect(body).toContain("userNodes");
      expect(body).toContain("name` and `sourceCode`");
      expect(body).toContain("Layout validation enforces exactly");
      // Self-containment is a behavior convention, not a security control.
      expect(body).toContain("no `fetch`");
      expect(body).toMatch(/behavior convention, not a security control/);
      // The return value must be an object: the pipeline derives the datatype from it, and a
      // bare number/string return is rejected (BAD_TYPE_RETURN).
      expect(body).toMatch(/must return an object with at least one field/);
      expect(body).toContain("BAD_TYPE_RETURN");
      // NodePlayground may be proposed as an editor, but scripts still live in userNodes.
      expect(body).toContain("NodePlayground");
      expect(body).toContain("panel-user-script-editor");
      expect(body).toMatch(/must still be written in\s+`userNodes`/);
      // The recorded risk decision is present.
      expect(body).toMatch(/without CPU or loop limits/);
    });

    it("keeps script bodies in userNodes, separate from the editor panel config", () => {
      const body = SKILL_REGISTRY.get("user-scripts")!.body;
      // G9: NodePlayground is proposable as an editor, but scripts still live in userNodes.
      expect(body).toMatch(/script itself always lives in `userNodes`/);
      expect(body).toMatch(/Propose layouts, not editors alone/);
      // The editor skill documents the same separation: script keys belong to userNodes
      // entries, never to the panel config.
      const editor = SKILL_REGISTRY.get("panel-user-script-editor")!.body;
      expect(editor).toContain("userNodes");
      expect(editor).toMatch(/`sourceCode`, `inputs`, `output` on the panel config/);
      expect(editor).toMatch(/belong to `userNodes` entries/);
    });

    it("compiles a representative agent-generated script through the transformer worker", () => {
      const sourceCode = `import { Input, Message } from "./types";

type Twist = Message<"geometry_msgs/TwistStamped">;

type Output = {
  speedKmh: number;
};

export const inputs = ["/odom"];

export const output = "/studio_script/speed_kmh";

export default function script(event: Input<"/odom">): Output {
  const twist: Twist = event.message;
  return { speedKmh: twist.twist.linear.x * 3.6 };
}`;
      const topics = [{ name: "/odom", schemaName: "geometry_msgs/TwistStamped" }];
      const datatypes = new Map([
        [
          "geometry_msgs/TwistStamped",
          {
            name: "geometry_msgs/TwistStamped",
            definitions: [
              {
                arrayLength: undefined,
                isArray: false,
                isComplex: true,
                name: "twist",
                type: "geometry_msgs/Twist",
              },
            ],
          },
        ],
        [
          "geometry_msgs/Twist",
          {
            name: "geometry_msgs/Twist",
            definitions: [
              {
                arrayLength: undefined,
                isArray: false,
                isComplex: true,
                name: "linear",
                type: "geometry_msgs/Vector3",
              },
            ],
          },
        ],
        [
          "geometry_msgs/Vector3",
          {
            name: "geometry_msgs/Vector3",
            definitions: [
              {
                arrayLength: undefined,
                isArray: false,
                isComplex: false,
                name: "x",
                type: "float64",
              },
            ],
          },
        ],
      ]);
      // Run the full production pipeline (getOutputTopic → compile → getInputTopics →
      // validateInputTopics → extractDatatypes → extractGlobalVariables), not just compile(): the
      // return type must yield an object datatype or extractDatatypes reports BAD_TYPE_RETURN and
      // the output topic is untyped.
      const result = transform({
        datatypes,
        name: "speed-converter",
        rosLib: generateRosLib({ topics, datatypes }),
        sourceCode,
        topics,
        typesLib: generateTypesLib({ topics, datatypes }),
      });

      expect(result.diagnostics).toHaveLength(0);
      expect(result.transpiledCode.length).toBeGreaterThan(0);
      expect(result.inputTopics).toEqual(["/odom"]);
      expect(result.outputTopic).toEqual("/studio_script/speed_kmh");
      // The object return type derives a datatype named after the script, and it is registered.
      expect(result.outputDatatype).toBe("speed-converter");
      expect(result.datatypes.has("speed-converter")).toBe(true);
    });
  });

  describe("layout panel titles", () => {
    // Panels whose custom toolbar never renders the title (see the layout-authoring skill).
    const TITLELESS_EXCEPTIONS = new Set(["Table", "RawMessages", "RawMessagesVirtual"]);

    it("documents the lichtblickPanelTitle rule and its exceptions", () => {
      const layoutAuthoring = SKILL_REGISTRY.get("layout-authoring")!.body;
      expect(layoutAuthoring).toContain("lichtblickPanelTitle");
      expect(layoutAuthoring).toMatch(/must include `lichtblickPanelTitle`/);
      for (const exception of ["Table", "RawMessages", "RawMessagesVirtual"]) {
        expect(layoutAuthoring).toContain(`\`${exception}\``);
      }
      // Extension panels write a title anyway.
      expect(layoutAuthoring).toMatch(/Extension panels/);
    });

    it("gives every non-exception panel in the four pattern layouts a non-empty title", () => {
      const examples = [
        ROBOT_DEBUG_LAYOUT,
        SENSOR_MONITORING_LAYOUT,
        LOG_TROUBLESHOOTING_LAYOUT,
        REPLAY_ANALYSIS_LAYOUT,
      ];
      for (const example of examples) {
        for (const [panelId, config] of Object.entries(example.configById)) {
          const panelType = panelId.slice(0, panelId.indexOf("!"));
          if (TITLELESS_EXCEPTIONS.has(panelType)) {
            continue;
          }
          const title = (config as { lichtblickPanelTitle?: unknown })
            .lichtblickPanelTitle;
          expect(typeof title).toBe("string");
          expect((title as string).length).toBeGreaterThan(0);
        }
      }
    });

    it("leaves no title-less example config in the layout-authoring body", () => {
      const body = SKILL_REGISTRY.get("layout-authoring")!.body;
      const blocks = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)]
        .map((match) => match[1])
        .filter((block): block is string => block != undefined);
      expect(blocks.length).toBeGreaterThan(0);
      let checkedConfigs = 0;
      for (const block of blocks) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block);
        } catch {
          // Placeholder examples (e.g. the Structure sketch with `/* panel config */`) are not
          // parseable JSON; they carry no concrete panel config to check.
          continue;
        }
        if (
          typeof parsed !== "object" ||
          parsed == undefined ||
          Array.isArray(parsed) ||
          typeof (parsed as { configById?: unknown }).configById !== "object" ||
          (parsed as { configById?: unknown }).configById == undefined
        ) {
          // Split-only snippets without configById have nothing to check.
          continue;
        }
        for (const [panelId, config] of Object.entries(
          (parsed as { configById: Record<string, Record<string, unknown>> })
            .configById,
        )) {
          const panelType = panelId.slice(0, panelId.indexOf("!"));
          if (TITLELESS_EXCEPTIONS.has(panelType)) {
            continue;
          }
          expect(typeof config.lichtblickPanelTitle).toBe("string");
          checkedConfigs++;
        }
      }
      expect(checkedConfigs).toBeGreaterThan(0);
    });
  });

  it("indexes message-path and data-diagnosis and routes to them from the catalog", () => {
    const index = buildSkillIndex();
    for (const id of ["message-path", "data-diagnosis"]) {
      const skill = SKILL_REGISTRY.get(id);
      expect(skill).toBeDefined();
      expect(skill!.indexed).not.toBe(false);
      expect(index).toContain(`- ${id}: `);
    }
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    expect(catalog).toContain("message-path");
    expect(catalog).toContain("data-diagnosis");
  });

  it("documents exactly the Plot math modifiers the panel implements", () => {
    // The modifier list is the one place the agent learns what .@fn can do; a function added
    // to the Plot panel without a skill update, or a Foxglove-only function documented here,
    // both fail.
    const body = SKILL_REGISTRY.get("message-path")!.body;
    for (const fn of Object.keys(mathFunctions)) {
      expect(body).toContain(`\`${fn}\``);
    }
    for (const missing of ["@derivative", "@mul", "@norm", "@rpy"]) {
      expect(body).not.toContain(missing);
    }
  });

});
