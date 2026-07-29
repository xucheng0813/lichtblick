// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { getHttpBaseUrl, setHttpBaseUrl } from "./httpBaseUrl";

jest.mock("@lichtblick/suite-base/constants/config", () => ({
  APP_CONFIG: {
    apiUrl: "https://default.example.com/lichtblick///",
  },
}));

describe("httpBaseUrl", () => {
  beforeEach(() => {
    setHttpBaseUrl(undefined);
  });

  it("uses the normalized build-time URL when no override is set", () => {
    expect(getHttpBaseUrl()).toBe("https://default.example.com/lichtblick");
  });

  it("uses a normalized runtime override", () => {
    setHttpBaseUrl("http://viz.example.com:9903/lichtblick/");

    expect(getHttpBaseUrl()).toBe("http://viz.example.com:9903/lichtblick");
  });

  it("falls back to the build-time URL after clearing the override", () => {
    setHttpBaseUrl("http://viz.example.com:9903/lichtblick");
    setHttpBaseUrl(undefined);

    expect(getHttpBaseUrl()).toBe("https://default.example.com/lichtblick");
  });
});
