// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PanelExtensionContext } from "@lichtblick/suite";
import { SaveConfig } from "@lichtblick/suite-base/types/panels";

export const DEFAULT_CONFIG: AudioConfig = {
  topicPath: "",
  volume: 1,
  muted: false,
};

export type AudioConfig = {
  topicPath: string;
  volume: number;
  muted: boolean;
};

export type AudioPanelAdapterProps = {
  config: AudioConfig;
  saveConfig: SaveConfig<AudioConfig>;
};

export type AudioPanelProps = {
  context: PanelExtensionContext;
};
