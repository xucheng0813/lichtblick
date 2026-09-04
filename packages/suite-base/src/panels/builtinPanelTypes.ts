// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Single source of truth for the built-in panel types, in the same order as `getBuiltin` in
 * `panels/index.ts`. Deliberately free of React and i18n imports so non-UI modules (agent layout
 * validation, skills, system prompt) can import it without pulling in the panel registry.
 */
export const BUILTIN_PANEL_TYPES = [
  "3D",
  "Audio",
  "DiagnosticStatusPanel",
  "DiagnosticSummary",
  "Image",
  "Indicator",
  "Gauge",
  "Teleop",
  "map",
  "Parameters",
  "Plot",
  "PieChart",
  "Publish",
  "CallService",
  "RawMessages",
  "RawMessagesVirtual",
  "RosOut",
  "StateTransitions",
  "Table",
  "TopicGraph",
  "SourceInfo",
  "GlobalVariableSliderPanel",
  "NodePlayground",
  "Tab",
  "PlaybackPerformance",
] as const;
