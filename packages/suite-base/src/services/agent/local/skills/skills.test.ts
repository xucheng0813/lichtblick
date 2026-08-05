// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  ALLOWED_PANEL_TYPES,
  HUMANOID_VIZ_PANEL_TYPE,
  QUADRUPED_VIZ_PANEL_TYPE,
} from "@lichtblick/suite-base/services/agent/layoutSchema";

import { LOCAL_AGENT_TOOL_DEFINITIONS } from "../toolDefinitions";
import {
  SKILL_IDS,
  SKILL_REGISTRY,
  buildSkillIndex,
  renderSkill,
} from "./index";

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
      // Short enough to stay cheap in the prompt index, which carries one line per skill.
      expect(skill.whenToUse.length).toBeLessThan(140);
      expect(skill.body.length).toBeGreaterThan(500);
    }
  });

  it("indexes every skill on its own line without leaking bodies", () => {
    const index = buildSkillIndex();
    for (const skill of SKILL_REGISTRY.values()) {
      expect(index).toContain(`- ${skill.id}: ${skill.whenToUse}`);
    }
    expect(index.split("\n")).toHaveLength(SKILL_REGISTRY.size);
    expect(index.length).toBeLessThan(1000);
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

  it("records the rendering constraints that layout validation cannot enforce", () => {
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    // A Plot path without `enabled` validates but renders nothing — the failure this skill exists
    // to prevent.
    expect(catalog).toContain('"enabled": true');
    expect(catalog).toContain("float32[]");
    expect(catalog).toContain('"visible": true');
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
