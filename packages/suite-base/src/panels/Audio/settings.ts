// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useShallowMemo } from "@lichtblick/hooks";
import { SettingsTreeAction, SettingsTreeNode, Topic } from "@lichtblick/suite";

import { AudioConfig } from "./types";

export const RAW_AUDIO_SCHEMA_NAME = "foxglove.RawAudio";

export type AudioSettingsTreeProps = {
  config: AudioConfig;
  topics: readonly Topic[];
  error: string | undefined;
};

export function useAudioSettingsTree({
  config,
  topics,
  error,
}: AudioSettingsTreeProps): Record<"general", SettingsTreeNode> {
  const { t } = useTranslation("audio");

  const generalSettings = useMemo((): SettingsTreeNode => {
    // Only offer topics whose schema is RawAudio; the panel never decodes anything else.
    const candidates = topics.filter((topic) => topic.schemaName === RAW_AUDIO_SCHEMA_NAME);
    return {
      error,
      fields: {
        topic: {
          label: t("settings.topic.label"),
          input: "select",
          value: config.topicPath,
          options: candidates.map((topic) => ({ label: topic.name, value: topic.name })),
        },
        volume: {
          label: t("settings.volume.label"),
          input: "number",
          value: config.volume,
          min: 0,
          max: 1,
          step: 0.05,
        },
        muted: {
          label: t("settings.muted.label"),
          input: "boolean",
          value: config.muted,
        },
      },
    };
  }, [config.muted, config.topicPath, config.volume, error, t, topics]);

  return useShallowMemo({
    general: generalSettings,
  });
}

export function audioSettingsActionReducer(
  prevConfig: AudioConfig,
  action: SettingsTreeAction,
): AudioConfig {
  if (action.action !== "update") {
    return prevConfig;
  }
  const field = action.payload.path[action.payload.path.length - 1];
  switch (field) {
    case "topic":
      return { ...prevConfig, topicPath: String(action.payload.value ?? "") };
    case "volume": {
      const volume = Number(action.payload.value);
      return {
        ...prevConfig,
        volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : prevConfig.volume,
      };
    }
    case "muted":
      return { ...prevConfig, muted: Boolean(action.payload.value) };
    default:
      return prevConfig;
  }
}
