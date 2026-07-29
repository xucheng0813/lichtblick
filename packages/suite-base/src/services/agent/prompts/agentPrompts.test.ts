// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { SKILL_REGISTRY } from "@lichtblick/suite-base/services/agent/local/skills";
import { makeMockAppConfiguration } from "@lichtblick/suite-base/util/makeMockAppConfiguration";

import {
  AGENT_PROMPT_MAX_CUSTOM_SKILLS,
  AgentPromptValidationError,
  EMPTY_CUSTOMIZATION,
  readAgentPromptCustomization,
  resolveSkills,
  validateAgentPromptCustomization,
  writeAgentPromptCustomization,
  type AgentPromptCustomization,
} from "./agentPrompts";

const customSkill = {
  id: "team-conventions",
  name: "Team conventions",
  whenToUse: "When naming layouts.",
  body: "Prefix every layout with the squad name.",
};

function customization(overrides: Partial<AgentPromptCustomization> = {}): AgentPromptCustomization {
  return { ...EMPTY_CUSTOMIZATION, ...overrides };
}

describe("agent prompt customization", () => {
  it("round-trips through app configuration and clears the key when empty", async () => {
    const configuration = makeMockAppConfiguration();
    const value = customization({
      instructions: "Always answer in Chinese.",
      customSkills: [customSkill],
    });

    await writeAgentPromptCustomization(configuration, value);
    expect(readAgentPromptCustomization(configuration)).toEqual(value);

    await writeAgentPromptCustomization(configuration, EMPTY_CUSTOMIZATION);
    expect(configuration.get(AppSetting.AGENT_PROMPT_CUSTOMIZATION)).toBeUndefined();
    expect(readAgentPromptCustomization(configuration)).toEqual(EMPTY_CUSTOMIZATION);
  });

  it("degrades to no customization rather than throwing on corrupt storage", () => {
    expect(
      readAgentPromptCustomization(
        makeMockAppConfiguration([[AppSetting.AGENT_PROMPT_CUSTOMIZATION, "{oops"]]),
      ),
    ).toEqual(EMPTY_CUSTOMIZATION);
  });

  it("drops overrides for skills that no longer exist", () => {
    const stored = JSON.stringify({
      instructions: "",
      skillOverrides: { "vtd-query": "kept", "removed-skill": "dropped" },
      customSkills: [],
    });
    const result = readAgentPromptCustomization(
      makeMockAppConfiguration([[AppSetting.AGENT_PROMPT_CUSTOMIZATION, stored]]),
    );
    expect(result.skillOverrides).toEqual({ "vtd-query": "kept" });
  });

  it("rejects custom skills that collide with or shadow built-ins", () => {
    expect(() =>
      { validateAgentPromptCustomization(
        customization({ customSkills: [{ ...customSkill, id: "vtd-query" }] }),
      ); },
    ).toThrow(AgentPromptValidationError);
    expect(() =>
      { validateAgentPromptCustomization(
        customization({ skillOverrides: { "not-a-skill": "body" } }),
      ); },
    ).toThrow(/not a built-in skill/);
  });

  it("rejects malformed ids, duplicates, empty bodies, and too many skills", () => {
    expect(() =>
      { validateAgentPromptCustomization(
        customization({ customSkills: [{ ...customSkill, id: "Not Kebab" }] }),
      ); },
    ).toThrow(/lowercase words/);
    expect(() =>
      { validateAgentPromptCustomization(
        customization({ customSkills: [customSkill, customSkill] }),
      ); },
    ).toThrow(/Duplicate skill id/);
    expect(() =>
      { validateAgentPromptCustomization(
        customization({ customSkills: [{ ...customSkill, body: "   " }] }),
      ); },
    ).toThrow(/needs both/);
    expect(() =>
      { validateAgentPromptCustomization(
        customization({
          customSkills: Array.from({ length: AGENT_PROMPT_MAX_CUSTOM_SKILLS + 1 }, (_u, i) => ({
            ...customSkill,
            id: `skill-${String(i)}`,
          })),
        }),
      ); },
    ).toThrow(/At most/);
  });

  it("applies overrides without mutating the built-in skill", () => {
    const original = SKILL_REGISTRY.get("vtd-query")!.body;
    const resolved = resolveSkills(
      customization({ skillOverrides: { "vtd-query": "my own instructions" } }),
    );

    expect(resolved.find((skill) => skill.id === "vtd-query")?.body).toBe("my own instructions");
    // Reverting must be possible, so the shipped text has to survive an override.
    expect(SKILL_REGISTRY.get("vtd-query")!.body).toBe(original);
  });

  it("appends custom skills after the built-ins and keeps built-in order", () => {
    const resolved = resolveSkills(customization({ customSkills: [customSkill] }));
    const builtInIds = [...SKILL_REGISTRY.keys()];

    expect(resolved.map((skill) => skill.id)).toEqual([...builtInIds, customSkill.id]);
  });

  it("drops a stored custom skill whose id has since become a built-in", () => {
    // Stored data can predate a newly shipped skill; shadowing it would hide the built-in silently.
    const resolved = resolveSkills(
      customization({ customSkills: [{ ...customSkill, id: "robot-viz" }] }),
    );
    expect(resolved.filter((skill) => skill.id === "robot-viz")).toHaveLength(1);
    expect(resolved.find((skill) => skill.id === "robot-viz")?.body).toBe(
      SKILL_REGISTRY.get("robot-viz")!.body,
    );
  });
});
