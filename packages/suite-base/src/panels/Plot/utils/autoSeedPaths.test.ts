// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { MessagePathStructureItem } from "@lichtblick/message-path";
import type { Topic } from "@lichtblick/suite-base/players/types";

import { autoSeedPlotPaths } from "./autoSeedPaths";

const floatLeaf: MessagePathStructureItem = {
  structureType: "primitive",
  primitiveType: "float64",
  datatype: "float64",
};
const integerLeaf: MessagePathStructureItem = {
  structureType: "primitive",
  primitiveType: "int32",
  datatype: "int32",
};
const stringLeaf: MessagePathStructureItem = {
  structureType: "primitive",
  primitiveType: "string",
  datatype: "string",
};
const booleanLeaf: MessagePathStructureItem = {
  structureType: "primitive",
  primitiveType: "bool",
  datatype: "bool",
};

function topic(name: string): Topic {
  return { name, schemaName: `${name}/Schema` };
}

describe("autoSeedPlotPaths", () => {
  it("selects known robot paths in priority order and caps the result at four", () => {
    const items = new Map<string, MessagePathStructureItem>([
      ["/imu_raw.linear_acceleration.z", floatLeaf],
      ["/bms_state.voltage", floatLeaf],
      ["/odometry.twist.twist.linear.x", floatLeaf],
      ["/imu_raw.linear_acceleration.x", floatLeaf],
      ["/imu_raw.linear_acceleration.y", floatLeaf],
    ]);

    expect(
      autoSeedPlotPaths(items, [topic("/imu_raw"), topic("/bms_state"), topic("/odometry")]),
    ).toEqual([
      {
        value: "/odometry.twist.twist.linear.x",
        enabled: true,
        timestampMethod: "receiveTime",
        label: "vx",
      },
      {
        value: "/bms_state.voltage",
        enabled: true,
        timestampMethod: "receiveTime",
        label: "voltage",
      },
      {
        value: "/imu_raw.linear_acceleration.x",
        enabled: true,
        timestampMethod: "receiveTime",
        label: "ax",
      },
      {
        value: "/imu_raw.linear_acceleration.y",
        enabled: true,
        timestampMethod: "receiveTime",
        label: "ay",
      },
    ]);
  });

  it("fills partial priority matches from the first topic with unused numeric leaves", () => {
    const items = new Map<string, MessagePathStructureItem>([
      ["/status.temperature", floatLeaf],
      ["/status.error_count", integerLeaf],
      ["/status.mode", stringLeaf],
      ["/odometry.twist.twist.linear.x", floatLeaf],
    ]);

    expect(autoSeedPlotPaths(items, [topic("/status"), topic("/odometry")])).toEqual([
      {
        value: "/odometry.twist.twist.linear.x",
        enabled: true,
        timestampMethod: "receiveTime",
        label: "vx",
      },
      {
        value: "/status.temperature",
        enabled: true,
        timestampMethod: "receiveTime",
      },
      {
        value: "/status.error_count",
        enabled: true,
        timestampMethod: "receiveTime",
      },
    ]);
  });

  it("filters non-numeric leaves and high-frequency raw stream topics", () => {
    const items = new Map<string, MessagePathStructureItem>([
      ["/camera/image_raw.width", integerLeaf],
      ["/front_lidar.range", floatLeaf],
      ["/diagnostics.healthy", booleanLeaf],
      ["/diagnostics.message", stringLeaf],
      ["/diagnostics.temperature", floatLeaf],
    ]);

    expect(
      autoSeedPlotPaths(items, [
        topic("/camera/image_raw"),
        topic("/front_lidar"),
        topic("/diagnostics"),
      ]),
    ).toEqual([
      {
        value: "/diagnostics.temperature",
        enabled: true,
        timestampMethod: "receiveTime",
      },
    ]);
  });

  it("returns no paths when the catalog has no numeric leaf", () => {
    const items = new Map<string, MessagePathStructureItem>([
      ["/status.mode", stringLeaf],
      ["/status.healthy", booleanLeaf],
    ]);

    expect(autoSeedPlotPaths(items, [topic("/status")])).toEqual([]);
    expect(autoSeedPlotPaths(new Map([["/status.temperature", floatLeaf]]), [])).toEqual([]);
  });
});
