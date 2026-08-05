// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { MessagePathStructureItem, quoteTopicNameIfNeeded } from "@lichtblick/message-path";
import { PLOTABLE_ROS_TYPES } from "@lichtblick/suite-base/panels/shared/constants";
import type { Topic } from "@lichtblick/suite-base/players/types";

import type { PlotPath } from "./config";

const MAX_AUTO_SEEDED_PATHS = 4;
const GENERIC_TARGET_PATHS = 3;
const HIGH_FREQUENCY_TOPIC_PATTERN = /(?:image|lidar|point[_-]?cloud)/iu;

export const NUMERIC_PLOTABLE_ROS_TYPES = PLOTABLE_ROS_TYPES.filter((type) =>
  /^(?:float|int|uint)/u.test(type),
);

const numericPlotableTypes = new Set(NUMERIC_PLOTABLE_ROS_TYPES);

const PRIORITY_PATHS = [
  { value: "/odometry.twist.twist.linear.x", label: "vx" },
  { value: "/bms_state.voltage", label: "voltage" },
  { value: "/imu_raw.linear_acceleration.x", label: "ax" },
  { value: "/imu_raw.linear_acceleration.y", label: "ay" },
  { value: "/imu_raw.linear_acceleration.z", label: "az" },
] as const;

function isNumericLeaf(item: MessagePathStructureItem | undefined): boolean {
  return (
    item?.structureType === "primitive" && numericPlotableTypes.has(item.primitiveType)
  );
}

function createPlotPath(value: string, label?: string): PlotPath {
  return {
    value,
    enabled: true,
    timestampMethod: "receiveTime",
    ...(label == undefined ? {} : { label }),
  };
}

function pathBelongsToTopic(path: string, topicName: string): boolean {
  const prefix = quoteTopicNameIfNeeded(topicName);
  return path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

export function autoSeedPlotPaths(
  structureItemsByPath: ReadonlyMap<string, MessagePathStructureItem>,
  topics: readonly Topic[],
): PlotPath[] {
  if (topics.length === 0) {
    return [];
  }

  const topicNames = new Set(topics.map((topic) => topic.name));
  const selected: PlotPath[] = [];
  const selectedValues = new Set<string>();
  for (const candidate of PRIORITY_PATHS) {
    const separatorIndex = candidate.value.indexOf(".");
    const topicName = separatorIndex === -1 ? candidate.value : candidate.value.slice(0, separatorIndex);
    if (
      topicNames.has(topicName) &&
      isNumericLeaf(structureItemsByPath.get(candidate.value))
    ) {
      selected.push(createPlotPath(candidate.value, candidate.label));
      selectedValues.add(candidate.value);
      if (selected.length === MAX_AUTO_SEEDED_PATHS) {
        return selected;
      }
    }
  }

  if (selected.length >= GENERIC_TARGET_PATHS) {
    return selected;
  }

  for (const topic of topics) {
    if (HIGH_FREQUENCY_TOPIC_PATTERN.test(topic.name)) {
      continue;
    }
    const numericPaths = [...structureItemsByPath.entries()]
      .filter(
        ([path, item]) =>
          !selectedValues.has(path) &&
          pathBelongsToTopic(path, topic.name) &&
          isNumericLeaf(item),
      )
      .map(([path]) => path);
    if (numericPaths.length === 0) {
      continue;
    }
    for (const path of numericPaths) {
      selected.push(createPlotPath(path));
      selectedValues.add(path);
      if (selected.length === GENERIC_TARGET_PATHS) {
        return selected;
      }
    }
    return selected;
  }

  return selected;
}
