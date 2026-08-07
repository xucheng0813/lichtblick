// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  resolveManagementBaseUrl,
  resolveManagementEndpoint,
} from "./managementBaseUrl";

describe("resolveManagementBaseUrl", () => {
  it("strips a trailing /lichtblick path segment", () => {
    expect(resolveManagementBaseUrl("https://viz.example.com/lichtblick")).toBe(
      "https://viz.example.com",
    );
  });

  it("strips /lichtblick with a trailing slash", () => {
    expect(resolveManagementBaseUrl("https://viz.example.com/lichtblick/")).toBe(
      "https://viz.example.com",
    );
  });

  it("returns the origin unchanged when there is no path", () => {
    expect(resolveManagementBaseUrl("https://viz.example.com")).toBe(
      "https://viz.example.com",
    );
    expect(resolveManagementBaseUrl("https://viz.example.com/")).toBe(
      "https://viz.example.com",
    );
  });

  it("strips /lichtblick from a deeper path", () => {
    expect(
      resolveManagementBaseUrl("https://viz.example.com/robotics/lichtblick"),
    ).toBe("https://viz.example.com/robotics");
  });

  it("keeps the path when lichtblick is not the last segment", () => {
    expect(
      resolveManagementBaseUrl("https://viz.example.com/lichtblick/extra"),
    ).toBe("https://viz.example.com/lichtblick/extra");
  });

  it("returns undefined for unparseable input", () => {
    expect(resolveManagementBaseUrl("not a url")).toBeUndefined();
    expect(resolveManagementBaseUrl("")).toBeUndefined();
    expect(resolveManagementBaseUrl(undefined)).toBeUndefined();
  });

  it("returns undefined for non-http(s) protocols", () => {
    expect(resolveManagementBaseUrl("ftp://viz.example.com/lichtblick")).toBeUndefined();
    expect(resolveManagementBaseUrl("file:///tmp/lichtblick")).toBeUndefined();
  });
});

describe("resolveManagementEndpoint", () => {
  const apiPath = "/api/v1/layouts/abc123/default";

  it("walks up one segment from a /lichtblick base", () => {
    expect(
      resolveManagementEndpoint(
        "https://viz.example.com/lichtblick",
        "https://viz.example.com",
        apiPath,
      ),
    ).toBe("../api/v1/layouts/abc123/default");
  });

  it("uses the plain path when base and management base coincide", () => {
    expect(
      resolveManagementEndpoint(
        "https://viz.example.com",
        "https://viz.example.com",
        apiPath,
      ),
    ).toBe("api/v1/layouts/abc123/default");
  });

  it("walks up multiple segments for a deep base with a shared prefix", () => {
    expect(
      resolveManagementEndpoint(
        "https://viz.example.com/robotics/lichtblick",
        "https://viz.example.com",
        apiPath,
      ),
    ).toBe("../../api/v1/layouts/abc123/default");
  });

  it("walks up past a non-shared base path", () => {
    expect(
      resolveManagementEndpoint(
        "https://viz.example.com/lichtblick",
        "https://viz.example.com/robotics",
        apiPath,
      ),
    ).toBe("../robotics/api/v1/layouts/abc123/default");
  });

  it("handles trailing slashes on both inputs", () => {
    expect(
      resolveManagementEndpoint(
        "https://viz.example.com/lichtblick/",
        "https://viz.example.com/",
        apiPath,
      ),
    ).toBe("../api/v1/layouts/abc123/default");
  });
});
