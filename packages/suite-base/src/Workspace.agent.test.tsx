/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";

import { AgentConfiguration } from "@lichtblick/suite-base/services/agent/agentSettings";
import {
  useLatestAgentCatalog,
  useLocalAgentClient,
} from "@lichtblick/suite-base/services/agent/localAgentClient";
import { PiAgentOrchestrator } from "@lichtblick/suite-base/services/agent/pi/PiAgentOrchestrator";

const validConfiguration: AgentConfiguration = {
  apiKey: "test-api-key",
  baseUrl: "",
  desktop: false,
  model: "claude-test",
  provider: "anthropic",
  vtdEndpoint: "https://vtd.example.com",
};

beforeAll(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: jest.fn(),
    writable: true,
  });
});

describe("local Agent client lifecycle", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses the latest catalog without rebuilding the client", () => {
    const { result, rerender } = renderHook(
      ({ catalogVersion }: { catalogVersion: number }) => {
        const getCatalog = useLatestAgentCatalog(() => ({
          datatypes: new Map(),
          topics: [{ name: `/catalog/${catalogVersion}`, schemaName: "test" }],
        }));
        const client = useLocalAgentClient(validConfiguration, {
          enabled: true,
          getCatalog,
        });
        return { client, getCatalog };
      },
      { initialProps: { catalogVersion: 1 } },
    );
    const initialClient = result.current.client;
    expect(initialClient).toBeInstanceOf(PiAgentOrchestrator);

    rerender({ catalogVersion: 2 });

    expect(result.current.client).toBe(initialClient);
    expect(result.current.getCatalog().topics[0]).toEqual({
      name: "/catalog/2",
      schemaName: "test",
    });
  });

  it("disposes replaced, disabled, and unmounted orchestrators", async () => {
    const dispose = jest.spyOn(PiAgentOrchestrator.prototype, "dispose");
    const { result, rerender, unmount } = renderHook(
      ({
        enabled,
        model,
      }: {
        enabled: boolean;
        model: string;
      }) =>
        useLocalAgentClient({ ...validConfiguration, model }, {
          enabled,
          getCatalog: () => ({ datatypes: new Map(), topics: [] }),
        }),
      { initialProps: { enabled: true, model: "model-1" } },
    );
    const firstClient = result.current;

    rerender({ enabled: true, model: "model-2" });
    expect(result.current).not.toBe(firstClient);
    await act(async () => {
      await Promise.resolve();
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.instances[0]).toBe(firstClient);

    const secondClient = result.current;
    rerender({ enabled: false, model: "model-2" });
    expect(result.current).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose.mock.instances[1]).toBe(secondClient);

    rerender({ enabled: true, model: "model-3" });
    const thirdClient = result.current;
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(dispose.mock.instances[2]).toBe(thirdClient);
  });

  it("replaces the orchestrator when the selected profile changes", async () => {
    const dispose = jest.spyOn(PiAgentOrchestrator.prototype, "dispose");
    const { result, rerender } = renderHook(
      ({ profileId }: { profileId: string }) =>
        useLocalAgentClient(validConfiguration, {
          enabled: true,
          getCatalog: () => ({ datatypes: new Map(), topics: [] }),
          profileId,
        }),
      { initialProps: { profileId: "profile-1" } },
    );
    const firstClient = result.current;

    rerender({ profileId: "profile-2" });

    expect(result.current).not.toBe(firstClient);
    await act(async () => {
      await Promise.resolve();
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.instances[0]).toBe(firstClient);
  });

  it("disposes both committed StrictMode instances without leaking either one", async () => {
    const dispose = jest.spyOn(PiAgentOrchestrator.prototype, "dispose");
    const wrapper = ({ children }: React.PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );
    const { unmount } = renderHook(
      () =>
        useLocalAgentClient(validConfiguration, {
          enabled: true,
          getCatalog: () => ({ datatypes: new Map(), topics: [] }),
        }),
      { wrapper },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(dispose).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("does not construct a client for invalid settings", () => {
    const { result } = renderHook(() =>
      useLocalAgentClient(
        { ...validConfiguration, apiKey: "", vtdEndpoint: "invalid" },
        {
          enabled: true,
          getCatalog: () => ({ datatypes: new Map(), topics: [] }),
        },
      ),
    );

    expect(result.current).toBeUndefined();
  });
});
