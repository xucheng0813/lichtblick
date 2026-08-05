// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { COLLECTD_METRICS_SKILL } from "./collectdMetrics";
import { LAYOUT_AUTHORING_SKILL } from "./layoutAuthoring";
import { PANEL_CATALOG_SKILL } from "./panelCatalog";
import { ROBOT_VIZ_SKILL } from "./robotViz";
import type { Skill } from "./types";
import { VTD_QUERY_SKILL } from "./vtdQuery";
import { VTD_SLICE_SKILL } from "./vtdSlice";
import { VTD_TRIGGER_SKILL } from "./vtdTrigger";

export type { Skill } from "./types";

const SKILLS: readonly Skill[] = [
  COLLECTD_METRICS_SKILL,
  VTD_QUERY_SKILL,
  VTD_SLICE_SKILL,
  VTD_TRIGGER_SKILL,
  PANEL_CATALOG_SKILL,
  ROBOT_VIZ_SKILL,
  LAYOUT_AUTHORING_SKILL,
];

export const SKILL_REGISTRY: ReadonlyMap<string, Skill> = new Map(
  SKILLS.map((skill) => [skill.id, skill]),
);

/**
 * Tool-schema enum for `load_skill`. Non-empty tuple type so the schema cannot degrade to an empty
 * enum if the registry is ever emptied.
 */
export const SKILL_IDS: readonly [string, ...string[]] = [
  SKILLS[0]!.id,
  ...SKILLS.slice(1).map((skill) => skill.id),
];

/**
 * The one-line-per-skill index carried in the system prompt. Defaults to the built-ins; callers
 * with user customization pass the resolved set instead.
 */
export function buildSkillIndex(skills: readonly Skill[] = SKILLS): string {
  return skills.map((skill) => `- ${skill.id}: ${skill.whenToUse}`).join("\n");
}

/**
 * Renders a loaded skill for the tool result. Bodies carry their own heading, so this only adds
 * the identifier the agent used to load it.
 */
export function renderSkill(skill: Skill): string {
  return `<skill id="${skill.id}">\n${skill.body}\n</skill>`;
}
