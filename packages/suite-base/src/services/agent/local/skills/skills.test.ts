// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

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
    // Budget: the whole index stays under 1000 chars even as the registry grows.
    expect(index.length).toBeLessThan(1000);
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

  it("assigns every allowlisted panel type to a per-panel skill or robot-viz", () => {
    // Each non-robot allowlisted panel type owns exactly one panel-* skill that documents it,
    // and the catalog routes to that skill. A missing, extra, or renamed mapping fails here.
    const panelSkillByType: Record<string, string> = {
      "3D": "panel-3d",
      Plot: "panel-plot",
      Image: "panel-image",
      RawMessages: "panel-raw-messages",
      RawMessagesVirtual: "panel-raw-messages-virtual",
      Table: "panel-table",
      Gauge: "panel-gauge",
      map: "panel-map",
      StateTransitions: "panel-state-transitions",
      Indicator: "panel-indicator",
      PieChart: "panel-pie-chart",
      SourceInfo: "panel-source-info",
      RosOut: "panel-rosout",
    };
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    for (const [panelType, skillId] of Object.entries(panelSkillByType)) {
      const skill = SKILL_REGISTRY.get(skillId);
      expect(skill).toBeDefined();
      expect(skill!.indexed).toBe(false);
      // The body documents the exact panel-type string, not just a lookalike substring.
      expect(skill!.body).toContain(`\`${panelType}\``);
      expect(catalog).toContain(skillId);
    }

    // The two robot panels are the explicit exception: no per-panel skill; robot-viz documents
    // them and the catalog points there.
    for (const robotType of [QUADRUPED_VIZ_PANEL_TYPE, HUMANOID_VIZ_PANEL_TYPE]) {
      const documented = [...SKILL_REGISTRY.values()].filter((skill) =>
        skill.body.includes(robotType),
      );
      expect(documented.length).toBeGreaterThan(0);
    }
    expect(SKILL_REGISTRY.get("robot-viz")!.indexed).not.toBe(false);
    expect(catalog).toContain("robot-viz");
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
    expect(catalog).not.toContain("Panels not listed here cannot be proposed");
  });

  it("requires relative VTD dates to be resolved before calling a tool", () => {
    const vtdQuery = SKILL_REGISTRY.get("vtd-query")!.body;
    expect(vtdQuery).toContain(
      'relative dates such as "yesterday", "today", or "last week"',
    );
    expect(vtdQuery).toContain("current time and browser");
    expect(vtdQuery).toContain(
      "Never pass relative-date words directly to a tool",
    );
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
    expect(layoutAuthoring).toContain("Call `propose_layout` exactly once");
    expect(layoutAuthoring).toContain("Never submit a skeleton, placeholder, or partial layout");
    expect(layoutAuthoring).toContain("`get_data_catalog`");
    expect(layoutAuthoring).toContain("Available panels");
    expect(layoutAuthoring).toContain("Only propose again within the same request");
    expect(layoutAuthoring).toContain("one complete revised version at a time");
  });

  it("routes panel selection on catalog evidence and forbids guessing fields", () => {
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    // T2: catalog evidence first — get_data_catalog only for truncation, a missing topic, or a
    // needed field chain.
    expect(catalog).toMatch(/workspace summary/);
    expect(catalog).toMatch(/catalog-ready/);
    expect(catalog).toMatch(/Call `get_data_catalog` \*\*only\*\* when/);
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
    // The layout pattern library example carries the same corrected path.
    expect(SKILL_REGISTRY.get("layout-authoring")!.body).toContain(
      '"path": "/system/healthy.data"',
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
});
