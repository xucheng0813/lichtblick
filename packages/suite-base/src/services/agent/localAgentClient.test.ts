// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PiAgentOrchestrator } from "@lichtblick/suite-base/services/agent/pi/PiAgentOrchestrator";

import { createLocalAgentClient } from "./localAgentClient";

const mockPiAgentOrchestrator = jest.fn();

jest.mock("@lichtblick/suite-base/services/agent/pi/PiAgentOrchestrator", () => ({
  PiAgentOrchestrator: function OrchestratorMock(...args: unknown[]) {
    return mockPiAgentOrchestrator(...args);
  },
}));

function validConfiguration() {
  return {
    apiKey: "test-key",
    baseUrl: "http://localhost:8080",
    desktop: false,
    getCatalog: jest.fn().mockReturnValue({ topics: [], datatypes: new Map() }),
    model: "test-model",
    provider: "anthropic" as const,
    vtdAuthToken: undefined,
    vtdEndpoint: "http://localhost:8090",
  };
}

describe("createLocalAgentClient data-query wiring", () => {
  beforeEach(() => {
    mockPiAgentOrchestrator.mockClear();
  });

  it("passes the dataQuery adapter into the orchestrator tool runtime deps", () => {
    const dataQuery = { getContext: jest.fn() };
    createLocalAgentClient({ ...validConfiguration(), dataQuery });

    expect(mockPiAgentOrchestrator).toHaveBeenCalledTimes(1);
    const options = mockPiAgentOrchestrator.mock.calls[0]![0] as {
      toolRuntime: { deps: { dataQuery?: unknown } };
    };
    expect(options.toolRuntime.deps.dataQuery).toBe(dataQuery);
  });

  it("omits dataQuery when the workspace does not provide one", () => {
    createLocalAgentClient(validConfiguration());

    const options = mockPiAgentOrchestrator.mock.calls[0]![0] as {
      toolRuntime: { deps: { dataQuery?: unknown } };
    };
    expect(options.toolRuntime.deps.dataQuery).toBeUndefined();
  });
});

void PiAgentOrchestrator;
