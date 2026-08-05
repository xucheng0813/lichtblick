/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useTranslation } from "react-i18next";

import { useAgentChat } from "@lichtblick/suite-base/context/AgentChatContext";
import type { VtdRecord } from "@lichtblick/suite-base/services/vtd/types";

import { VtdSliceConfigCard } from "./VtdSliceConfigCard";

jest.mock("react-i18next", () => ({
  useTranslation: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/context/AgentChatContext", () => ({
  useAgentChat: jest.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let rejectPromise = (_error: Error) => {};
  let resolvePromise = (_value: T) => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

const record: VtdRecord = {
  id: "record-1",
  dataStartNs: "1912689868838297225",
  dataEndNs: "1912690468838297225",
  raw: {},
};

const getVtdTopics = jest.fn<Promise<Record<string, number>>, [string]>();
const sliceVtdRecord = jest.fn();

function renderCard(onCancel = jest.fn()): ReturnType<typeof render> {
  return render(<VtdSliceConfigCard record={record} onCancel={onCancel} />);
}

function interpolationValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

describe("VtdSliceConfigCard", () => {
  beforeEach(() => {
    getVtdTopics.mockReset().mockResolvedValue({ "/camera": 2, "/imu": 12 });
    sliceVtdRecord.mockReset().mockResolvedValue(undefined);
    (useAgentChat as jest.Mock).mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ actions: { getVtdTopics, sliceVtdRecord } }),
    );
    (useTranslation as jest.Mock).mockReturnValue({
      t: (key: string, options?: Record<string, unknown>) => {
        const translations: Record<string, string> = {
          noTopics: "No topics",
          retry: "Retry",
          selectAll: "Select all",
          selectNone: "Select none",
          selectTopics: "Select topics",
          selectedDuration: `Selected duration: ${interpolationValue(options?.duration)}`,
          selectedEnd: `End: ${interpolationValue(options?.time)}`,
          selectedStart: `Start: ${interpolationValue(options?.time)}`,
          sliceCancel: "Cancel",
          sliceConfigure: "Configure slice",
          sliceDone: "Slice done",
          sliceEndTime: "Slice end time",
          sliceFailed: "Slice failed",
          sliceLoading: "Loading slice",
          sliceStart: "Start slicing",
          sliceStartTime: "Slice start time",
          slicing: "Slicing",
          timeRange: "Time range",
          topicsFailed: "Topics failed",
          topicsLoading: "Loading topics",
        };
        if (key === "topicMessageCount") {
          return `${interpolationValue(options?.topic)} (${interpolationValue(options?.count)} messages)`;
        }
        return translations[key] ?? key;
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("loads topics, shows counts, and supports individual/select-all/select-none choices", async () => {
    const pendingTopics = deferred<Record<string, number>>();
    getVtdTopics.mockReturnValueOnce(pendingTopics.promise);
    renderCard();

    expect(screen.getByText("Loading topics")).toBeInTheDocument();
    expect(getVtdTopics).toHaveBeenCalledWith("record-1");

    await act(async () => {
      pendingTopics.resolve({ "/imu": 12, "/camera": 2 });
      await pendingTopics.promise;
    });

    const camera = screen.getByRole("checkbox", { name: "/camera (2 messages)" });
    const imu = screen.getByRole("checkbox", { name: "/imu (12 messages)" });
    expect(camera).toBeChecked();
    expect(imu).toBeChecked();

    fireEvent.click(camera);
    expect(camera).not.toBeChecked();
    expect(imu).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(camera).not.toBeChecked();
    expect(imu).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Start slicing" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(camera).toBeChecked();
    expect(imu).toBeChecked();
  });

  it("renders topic failure and retries topic loading", async () => {
    getVtdTopics.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ "/imu": 12 });
    renderCard();

    expect(await screen.findByRole("alert")).toHaveTextContent("Topics failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("checkbox", { name: "/imu (12 messages)" })).toBeChecked();
    expect(getVtdTopics).toHaveBeenCalledTimes(2);
    // The failed topic load intentionally logs a warning.
    (console.warn as jest.Mock).mockClear();
  });

  it("uses relative milliseconds in the slider and submits exact decimal nanoseconds", async () => {
    jest.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date) {
      return `local:${this.getTime()}`;
    });
    renderCard();
    await screen.findByRole("checkbox", { name: "/imu (12 messages)" });

    expect(screen.getAllByText("local:1912689868838").length).toBeGreaterThan(0);
    expect(screen.getAllByText("local:1912690468838").length).toBeGreaterThan(0);
    const sliders = screen.getAllByRole("slider");
    expect(sliders).toHaveLength(2);
    fireEvent.change(sliders[0]!, { target: { value: 1250 } });
    fireEvent.change(sliders[1]!, { target: { value: 597500 } });

    fireEvent.click(screen.getByRole("button", { name: "Start slicing" }));

    await waitFor(() => {
      expect(sliceVtdRecord).toHaveBeenCalledTimes(1);
    });
    expect(sliceVtdRecord.mock.calls[0]?.[0]).toEqual({
      id: "record-1",
      topics: ["/camera", "/imu"],
      startNs: "1912689870088297225",
      endNs: "1912690466338297225",
    });
    expect(sliceVtdRecord.mock.calls[0]?.[1]).toEqual(expect.any(Function));
    expect(await screen.findByText("Slice done")).toBeInTheDocument();
  });

  it("renders slicing, loading, and done states", async () => {
    const pendingSlice = deferred<void>();
    let reportProgress: ((progress: "slicing" | "loading") => void) | undefined;
    sliceVtdRecord.mockImplementationOnce(
      async (_params: unknown, onProgress?: (progress: "slicing" | "loading") => void) => {
        reportProgress = onProgress;
        await pendingSlice.promise;
      },
    );
    renderCard();
    await screen.findByRole("checkbox", { name: "/imu (12 messages)" });

    fireEvent.click(screen.getByRole("button", { name: "Start slicing" }));
    expect(screen.getByText("Slicing")).toBeInTheDocument();

    act(() => {
      reportProgress?.("loading");
    });
    expect(screen.getByText("Loading slice")).toBeInTheDocument();

    await act(async () => {
      pendingSlice.resolve();
      await pendingSlice.promise;
    });
    expect(screen.getByText("Slice done")).toBeInTheDocument();
  });

  it("renders slice failure, retries with the same selection, and can close", async () => {
    const onCancel = jest.fn();
    sliceVtdRecord
      .mockRejectedValueOnce(new Error("slice-get failed"))
      .mockResolvedValueOnce(undefined);
    renderCard(onCancel);
    await screen.findByRole("checkbox", { name: "/imu (12 messages)" });

    fireEvent.click(screen.getByRole("button", { name: "Start slicing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Slice failed");
    const firstParams = sliceVtdRecord.mock.calls[0]?.[0];

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Slice done")).toBeInTheDocument();
    expect(sliceVtdRecord).toHaveBeenCalledTimes(2);
    expect(sliceVtdRecord.mock.calls[1]?.[0]).toEqual(firstParams);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The failed slice attempt intentionally logs a warning.
    (console.warn as jest.Mock).mockClear();
  });
});
