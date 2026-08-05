/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useTranslation } from "react-i18next";

import { VtdRecord } from "@lichtblick/suite-base/services/vtd/types";

import { parseVtdSearchResult, VtdRecordListCard } from "./VtdRecordListCard";

jest.mock("react-i18next", () => ({
  useTranslation: jest.fn(),
}));

jest.mock("./VtdSliceConfigCard", () => ({
  VtdSliceConfigCard: ({
    onCancel,
    record: sliceRecord,
  }: {
    onCancel: () => void;
    record: VtdRecord;
  }) => (
    <div data-testid="mock-slice-config-card">
      {sliceRecord.id}
      <button onClick={onCancel}>Close slice</button>
    </div>
  ),
}));

const record: VtdRecord = {
  id: "record-1",
  botName: "Robot One",
  botSn: "VBOT-001",
  triggerType: "collision",
  dataType: "mcap",
  triggerTime: "2026-08-04T01:02:03Z",
  sizeBytes: 1024,
  raw: {},
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("VtdRecordListCard", () => {
  beforeEach(() => {
    (useTranslation as jest.Mock).mockReturnValue({
      t: (
        key: string,
        options?: {
          count?: number;
          duration?: string;
          page?: number;
          pages?: number;
        },
      ) => {
        const translations: Record<string, string> = {
          loadData: "Load data",
          loadDataFailed: "Failed to load data. Try again.",
          nextPage: "Next",
          previousPage: "Previous",
          sliceData: "Slice",
          sliceDataFailed: "Failed to request data slicing. Try again.",
        };
        if (key === "dedupedTotal") {
          return `Total ${options?.count ?? 0} records (deduplicated)`;
        }
        if (key === "durationLabel") {
          return `Duration: ${options?.duration ?? ""}`;
        }
        if (key === "pageOf") {
          return `Page ${options?.page ?? 0} of ${options?.pages ?? 0}`;
        }
        return translations[key] ?? key;
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sorts newest first, puts missing times last, and renders browser-local time", async () => {
    jest.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
      this: Date,
    ) {
      return `local:${this.toISOString()}`;
    });
    const parsed = parseVtdSearchResult({
      records: [{ ...record, id: "latest", triggerTime: 1912689788000 }],
    });
    if (parsed == undefined) {
      throw new Error("Expected numeric trigger time to parse");
    }
    const onLoadRecord = jest.fn().mockResolvedValue(undefined);
    render(
      <VtdRecordListCard
        records={[
          { ...record, id: "earlier", triggerTime: "2026-08-04T01:02:03Z" },
          { ...record, id: "missing", triggerTime: undefined },
          ...parsed.records,
        ]}
        onLoadRecord={onLoadRecord}
      />,
    );

    const rows = screen.getAllByTestId("vtd-record-row");
    expect(within(rows[0]!).getByText("latest")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("earlier")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("missing")).toBeInTheDocument();
    expect(
      screen.getByText("local:2030-08-11T14:43:08.000Z"),
    ).toBeInTheDocument();
    expect(within(rows[0]!).getByText("1.0 KiB")).toBeInTheDocument();

    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: "Load data" }),
    );
    await waitFor(() => {
      expect(onLoadRecord).toHaveBeenCalledWith("latest");
    });
  });

  it("keeps row loading and error feedback local to the selected record", async () => {
    const pending = deferred();
    const onLoadRecord = jest
      .fn()
      .mockImplementationOnce(async () => {
        await pending.promise;
      })
      .mockRejectedValueOnce(new Error("offline"));
    render(
      <VtdRecordListCard
        records={[record, { ...record, id: "record-2" }]}
        onLoadRecord={onLoadRecord}
      />,
    );

    const firstButton = within(
      screen.getAllByTestId("vtd-record-row")[0]!,
    ).getByRole("button", {
      name: "Load data",
    });
    fireEvent.click(firstButton);
    expect(firstButton).toBeDisabled();
    expect(
      within(screen.getAllByTestId("vtd-record-row")[0]!).getByRole(
        "progressbar",
      ),
    ).toBeInTheDocument();

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(firstButton).toBeEnabled();

    fireEvent.click(
      within(screen.getAllByTestId("vtd-record-row")[1]!).getByRole("button", {
        name: "Load data",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load data. Try again.",
    );
  });

  it("paginates sorted records ten at a time", () => {
    const records = Array.from({ length: 12 }, (_, index): VtdRecord => ({
      ...record,
      id: `record-${index + 1}`,
      triggerTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }));
    render(
      <VtdRecordListCard
        records={records}
        onLoadRecord={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getAllByTestId("vtd-record-row")).toHaveLength(10);
    expect(screen.getByText("record-12")).toBeInTheDocument();
    expect(screen.getByText("record-3")).toBeInTheDocument();
    expect(screen.queryByText("record-2")).not.toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getAllByTestId("vtd-record-row")).toHaveLength(2);
    expect(screen.getByText("record-2")).toBeInTheDocument();
    expect(screen.getByText("record-1")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("deduplicates records with the later value winning", () => {
    render(
      <VtdRecordListCard
        records={[
          { ...record, botName: "Old robot", id: "duplicate" },
          { ...record, id: "unique" },
          { ...record, botName: "New robot", id: "duplicate" },
        ]}
        onLoadRecord={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getAllByTestId("vtd-record-row")).toHaveLength(2);
    expect(
      screen.getByText("Total 2 records (deduplicated)"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Old robot")).not.toBeInTheDocument();
    expect(screen.getByText("New robot")).toBeInTheDocument();
  });

  it("offers slicing only above five minutes and expands at most one config card", () => {
    render(
      <VtdRecordListCard
        records={[
          {
            ...record,
            dataEndNs: "751000000000",
            dataStartNs: "1000000000",
            id: "long-record",
          },
          {
            ...record,
            dataEndNs: "901000000000",
            dataStartNs: "1000000000",
            id: "second-long-record",
          },
          {
            ...record,
            dataEndNs: "301000000000",
            dataStartNs: "1000000000",
            id: "five-minute-record",
          },
          { ...record, id: "unknown-duration" },
        ]}
        onLoadRecord={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("Duration: 12m30s")).toBeInTheDocument();
    expect(screen.getByText("Duration: 15m")).toBeInTheDocument();
    expect(screen.getByText("Duration: 5m")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Slice" })).toHaveLength(2);

    const rows = screen.getAllByTestId("vtd-record-row");
    const firstSliceButton = within(rows[0]!).getByRole("button", {
      name: "Slice",
    });
    const secondSliceButton = within(rows[1]!).getByRole("button", {
      name: "Slice",
    });
    fireEvent.click(firstSliceButton);

    expect(firstSliceButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("mock-slice-config-card")).toHaveTextContent(
      "long-record",
    );

    fireEvent.click(secondSliceButton);

    expect(firstSliceButton).toHaveAttribute("aria-expanded", "false");
    expect(secondSliceButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("mock-slice-config-card")).toHaveLength(1);
    expect(screen.getByTestId("mock-slice-config-card")).toHaveTextContent(
      "second-long-record",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close slice" }));
    expect(
      screen.queryByTestId("mock-slice-config-card"),
    ).not.toBeInTheDocument();
  });

  it("does not render a card for an invalid result shape", () => {
    function InvalidResult(): React.JSX.Element | null {
      const result = parseVtdSearchResult({ records: [{ id: null }] });
      return result == undefined ? null : (
        <VtdRecordListCard
          records={result.records}
          onLoadRecord={jest.fn().mockResolvedValue(undefined)}
        />
      );
    }

    render(<InvalidResult />);

    expect(
      screen.queryByTestId("vtd-record-list-card"),
    ).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith(
      "Skipped 1 invalid VTD search record(s)",
    );
    (console.warn as jest.Mock).mockClear();
  });

  it("accepts real sidecar field types and skips only malformed siblings", () => {
    const parsed = parseVtdSearchResult({
      records: [
        {
          bot_name: "Robot One",
          bot_sn: "8010006BHQ26E8A0078",
          data_et: 1785766828725015000,
          data_size: 2143078,
          data_st: 1785766807770895400,
          data_type: 2,
          id: 864794,
          trigger_time: 1785766827000,
          trigger_type: "wokeup_sound_detected",
        },
        { id: null, trigger_time: "invalid" },
        { id: "second-valid" },
      ],
      total: 3,
    });

    expect(parsed).toEqual({
      records: [
        expect.objectContaining({
          botName: "Robot One",
          botSn: "8010006BHQ26E8A0078",
          dataType: "2",
          id: "864794",
          sizeBytes: 2143078,
          triggerTime: "2026-08-03T14:20:27.000Z",
          triggerType: "wokeup_sound_detected",
        }),
        expect.objectContaining({ id: "second-valid" }),
      ],
      total: 3,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "Skipped 1 invalid VTD search record(s)",
    );
    (console.warn as jest.Mock).mockClear();
  });
});
