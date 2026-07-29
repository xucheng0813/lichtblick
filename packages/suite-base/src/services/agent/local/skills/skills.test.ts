// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  ALLOWED_PANEL_TYPES,
  HUMANOID_VIZ_PANEL_TYPE,
  QUADRUPED_VIZ_PANEL_TYPE,
} from "@lichtblick/suite-base/services/agent/layoutSchema";

import { LOCAL_AGENT_TOOL_DEFINITIONS } from "../toolDefinitions";
import { SKILL_IDS, SKILL_REGISTRY, buildSkillIndex, renderSkill } from "./index";

describe("skill registry", () => {
  it("keeps ids unique and in sync with the load_skill schema enum", () => {
    const registryIds = [...SKILL_REGISTRY.keys()];
    expect(new Set(registryIds).size).toBe(registryIds.length);
    expect([...SKILL_IDS].sort()).toEqual([...registryIds].sort());

    const loadSkill = LOCAL_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === "load_skill");
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
    const documented = [...SKILL_REGISTRY.values()].map((skill) => skill.body).join("\n");
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
    expect(SKILL_REGISTRY.get("panel-catalog")!.body).toContain("read the robot-viz skill");
  });

  it("records the rendering constraints that layout validation cannot enforce", () => {
    const catalog = SKILL_REGISTRY.get("panel-catalog")!.body;
    // A Plot path without `enabled` validates but renders nothing — the failure this skill exists
    // to prevent.
    expect(catalog).toContain('"enabled": true');
    expect(catalog).toContain("float32[]");
    expect(catalog).toContain('"visible": true');
  });
});
