// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LOG_DATATYPES, normalizedLogMessage } from "./conversion";
import type { LogMessageEvent } from "./types";
import { LogLevel } from "./types";

describe("normalizedLogMessage (ROS aliases)", () => {
  const stamp = { sec: 1672531200, nsec: 42 };

  it("normalizes the ROS2 alias ros.rcl_interfaces.Log level and stamp", () => {
    const normalized = normalizedLogMessage(
      "ros.rcl_interfaces.Log",
      { level: 40, msg: "wheel slip", name: "nav", stamp } as LogMessageEvent["message"],
    );

    expect(normalized.level).toBe(LogLevel.ERROR);
    expect(normalized.stamp).toEqual(stamp);
    expect(normalized.message).toBe("wheel slip");
  });

  it("normalizes the ROS1 alias ros.rosgraph_msgs.Log level and stamp", () => {
    const normalized = normalizedLogMessage("ros.rosgraph_msgs.Log", {
      header: { stamp, seq: 0, frame_id: "" },
      level: 8,
      msg: "odom timeout",
      name: "nav",
      file: "odom.cpp",
      function: "update",
      line: 120,
      topics: [],
    });

    expect(normalized.level).toBe(LogLevel.ERROR);
    expect(normalized.stamp).toEqual(stamp);
    expect(normalized.message).toBe("odom timeout");
  });

  it.each(LOG_DATATYPES)("handles %s through the shared normalization path", (datatype) => {
    const raw =
      datatype.startsWith("ros.rosgraph") || datatype === "rosgraph_msgs/Log"
        ? { header: { stamp, seq: 0, frame_id: "" }, level: 8, msg: "x" }
        : datatype.startsWith("ros.rcl") || datatype === "rcl_interfaces/msg/Log"
          ? { level: 40, msg: "x", name: "n", stamp }
          : { level: 4, message: "x", timestamp: 1672531200000000042n };

    const normalized = normalizedLogMessage(datatype, raw as LogMessageEvent["message"]);
    expect(normalized.level).toBe(LogLevel.ERROR);
    expect(normalized.stamp).toEqual(stamp);
  });
});
