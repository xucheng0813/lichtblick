// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  HUMANOID_VIZ_PANEL_TYPE,
  QUADRUPED_VIZ_PANEL_TYPE,
} from "@lichtblick/suite-base/services/agent/layoutSchema";

import { COLLECTD_METRICS_SKILL } from "./collectdMetrics";
import { DATA_DIAGNOSIS_SKILL } from "./dataDiagnosis";
import { DATA_QUERY_SKILL } from "./dataQuery";
import { LAYOUT_AUTHORING_SKILL } from "./layoutAuthoring";
import { MESSAGE_PATH_SKILL } from "./messagePath";
import { PANEL_CATALOG_SKILL } from "./panelCatalog";
import { PANEL_3D_SKILL } from "./panels/3d";
import { PANEL_AUDIO_SKILL } from "./panels/audio";
import { PANEL_CALL_SERVICE_SKILL } from "./panels/callService";
import { PANEL_DIAGNOSTIC_STATUS_SKILL } from "./panels/diagnosticStatus";
import { PANEL_DIAGNOSTIC_SUMMARY_SKILL } from "./panels/diagnosticSummary";
import { PANEL_GAUGE_SKILL } from "./panels/gauge";
import { PANEL_IMAGE_SKILL } from "./panels/image";
import { PANEL_INDICATOR_SKILL } from "./panels/indicator";
import { PANEL_MAP_SKILL } from "./panels/map";
import { PANEL_PARAMETERS_SKILL } from "./panels/parameters";
import { PANEL_PIE_CHART_SKILL } from "./panels/pieChart";
import { PANEL_PLAYBACK_PERFORMANCE_SKILL } from "./panels/playbackPerformance";
import { PANEL_PLOT_SKILL } from "./panels/plot";
import { PANEL_PUBLISH_SKILL } from "./panels/publish";
import { PANEL_RAW_MESSAGES_SKILL } from "./panels/rawMessages";
import { PANEL_RAW_MESSAGES_VIRTUAL_SKILL } from "./panels/rawMessagesVirtual";
import { PANEL_ROSOUT_SKILL } from "./panels/rosOut";
import { PANEL_SOURCE_INFO_SKILL } from "./panels/sourceInfo";
import { PANEL_STATE_TRANSITIONS_SKILL } from "./panels/stateTransitions";
import { PANEL_TAB_SKILL } from "./panels/tab";
import { PANEL_TABLE_SKILL } from "./panels/table";
import { PANEL_TELEOP_SKILL } from "./panels/teleop";
import { PANEL_TOPIC_GRAPH_SKILL } from "./panels/topicGraph";
import { PANEL_USER_SCRIPT_EDITOR_SKILL } from "./panels/userScriptEditor";
import { PANEL_VARIABLE_SLIDER_SKILL } from "./panels/variableSlider";
import { ROBOT_VIZ_SKILL } from "./robotViz";
import type { Skill } from "./types";
import { USER_SCRIPTS_SKILL } from "./userScripts";
import { VITA_DATA_CONVENTIONS_SKILL } from "./vitaDataConventions";
import { VTD_QUERY_SKILL } from "./vtdQuery";
import { VTD_SLICE_SKILL } from "./vtdSlice";
import { VTD_TRIGGER_SKILL } from "./vtdTrigger";

export type { Skill } from "./types";

const SKILLS: readonly Skill[] = [
  COLLECTD_METRICS_SKILL,
  DATA_QUERY_SKILL,
  DATA_DIAGNOSIS_SKILL,
  VTD_QUERY_SKILL,
  VTD_SLICE_SKILL,
  VTD_TRIGGER_SKILL,
  PANEL_CATALOG_SKILL,
  ROBOT_VIZ_SKILL,
  VITA_DATA_CONVENTIONS_SKILL,
  LAYOUT_AUTHORING_SKILL,
  MESSAGE_PATH_SKILL,
  USER_SCRIPTS_SKILL,
  // Per-panel reference detail. Marked indexed: false so the prompt index stays small; the
  // panel-catalog skill routes to them by id before any panel is proposed.
  PANEL_3D_SKILL,
  PANEL_PLOT_SKILL,
  PANEL_IMAGE_SKILL,
  PANEL_RAW_MESSAGES_SKILL,
  PANEL_RAW_MESSAGES_VIRTUAL_SKILL,
  PANEL_TABLE_SKILL,
  PANEL_GAUGE_SKILL,
  PANEL_MAP_SKILL,
  PANEL_STATE_TRANSITIONS_SKILL,
  PANEL_INDICATOR_SKILL,
  PANEL_PIE_CHART_SKILL,
  PANEL_SOURCE_INFO_SKILL,
  PANEL_ROSOUT_SKILL,
  PANEL_AUDIO_SKILL,
  PANEL_DIAGNOSTIC_SUMMARY_SKILL,
  PANEL_DIAGNOSTIC_STATUS_SKILL,
  PANEL_TAB_SKILL,
  PANEL_VARIABLE_SLIDER_SKILL,
  PANEL_TELEOP_SKILL,
  PANEL_PUBLISH_SKILL,
  PANEL_CALL_SERVICE_SKILL,
  PANEL_PARAMETERS_SKILL,
  PANEL_TOPIC_GRAPH_SKILL,
  PANEL_PLAYBACK_PERFORMANCE_SKILL,
  PANEL_USER_SCRIPT_EDITOR_SKILL,
];

/**
 * Panel type → skill routing for the panel inventory. Every built-in panel type and the two
 * robot extension panels map to exactly one skill that documents it; the panel-catalog skill
 * names the same ids for the agent, and tests pin both sides of the mapping.
 */
export const PANEL_SKILL_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ["3D", PANEL_3D_SKILL.id],
  ["Plot", PANEL_PLOT_SKILL.id],
  ["Image", PANEL_IMAGE_SKILL.id],
  ["RawMessages", PANEL_RAW_MESSAGES_SKILL.id],
  ["RawMessagesVirtual", PANEL_RAW_MESSAGES_VIRTUAL_SKILL.id],
  ["Table", PANEL_TABLE_SKILL.id],
  ["Gauge", PANEL_GAUGE_SKILL.id],
  ["map", PANEL_MAP_SKILL.id],
  ["StateTransitions", PANEL_STATE_TRANSITIONS_SKILL.id],
  ["Indicator", PANEL_INDICATOR_SKILL.id],
  ["PieChart", PANEL_PIE_CHART_SKILL.id],
  ["SourceInfo", PANEL_SOURCE_INFO_SKILL.id],
  ["RosOut", PANEL_ROSOUT_SKILL.id],
  ["Audio", PANEL_AUDIO_SKILL.id],
  ["DiagnosticSummary", PANEL_DIAGNOSTIC_SUMMARY_SKILL.id],
  ["DiagnosticStatusPanel", PANEL_DIAGNOSTIC_STATUS_SKILL.id],
  ["Tab", PANEL_TAB_SKILL.id],
  ["GlobalVariableSliderPanel", PANEL_VARIABLE_SLIDER_SKILL.id],
  ["Teleop", PANEL_TELEOP_SKILL.id],
  ["Publish", PANEL_PUBLISH_SKILL.id],
  ["CallService", PANEL_CALL_SERVICE_SKILL.id],
  ["Parameters", PANEL_PARAMETERS_SKILL.id],
  ["TopicGraph", PANEL_TOPIC_GRAPH_SKILL.id],
  ["PlaybackPerformance", PANEL_PLAYBACK_PERFORMANCE_SKILL.id],
  ["NodePlayground", PANEL_USER_SCRIPT_EDITOR_SKILL.id],
  [QUADRUPED_VIZ_PANEL_TYPE, ROBOT_VIZ_SKILL.id],
  [HUMANOID_VIZ_PANEL_TYPE, ROBOT_VIZ_SKILL.id],
]);

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
 *
 * Skills marked `indexed: false` are registered and loadable but deliberately left out of the
 * index: they are reference detail reached through a routing skill (see `panel-catalog`), so the
 * base prompt does not pay for lines the agent should not load directly.
 */
export function buildSkillIndex(skills: readonly Skill[] = SKILLS): string {
  return skills
    .filter((skill) => skill.indexed !== false)
    .map((skill) => `- ${skill.id}: ${skill.whenToUse}`)
    .join("\n");
}

/**
 * Renders a loaded skill for the tool result. Bodies carry their own heading, so this only adds
 * the identifier the agent used to load it.
 */
export function renderSkill(skill: Skill): string {
  return `<skill id="${skill.id}">\n${skill.body}\n</skill>`;
}
