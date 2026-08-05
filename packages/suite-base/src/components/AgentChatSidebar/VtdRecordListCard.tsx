// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { Button, CircularProgress, Paper, Typography } from "@mui/material";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import { formatByteSize } from "@lichtblick/den/format";
import Logger from "@lichtblick/log";
import { VtdRecord } from "@lichtblick/suite-base/services/vtd/types";

import { VtdSliceConfigCard } from "./VtdSliceConfigCard";

const PAGE_SIZE = 10;
const FIVE_MINUTES_NS = 300_000_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const log = Logger.getLogger(__filename);

const useStyles = makeStyles()((theme) => ({
  card: {
    marginTop: theme.spacing(1),
    overflow: "hidden",
  },
  summary: {
    display: "block",
    padding: theme.spacing(1, 1.5),
  },
  row: {
    alignItems: "center",
    borderTop: `1px solid ${theme.palette.divider}`,
    display: "grid",
    gap: theme.spacing(0.5, 1),
    gridTemplateColumns: "minmax(0, 1fr) auto",
    padding: theme.spacing(1, 1.5),
  },
  details: {
    minWidth: 0,
  },
  id: {
    overflowWrap: "anywhere",
  },
  metadata: {
    display: "flex",
    flexWrap: "wrap",
    gap: theme.spacing(0.25, 1),
  },
  actions: {
    display: "flex",
    gap: theme.spacing(0.5),
  },
  error: {
    gridColumn: "1 / -1",
  },
  expanded: {
    gridColumn: "1 / -1",
  },
  pagination: {
    alignItems: "center",
    borderTop: `1px solid ${theme.palette.divider}`,
    display: "flex",
    gap: theme.spacing(1),
    justifyContent: "flex-end",
    padding: theme.spacing(1, 1.5),
  },
}));

export type VtdSearchResult = {
  records: VtdRecord[];
  total?: number;
};

type VtdRecordListCardProps = {
  records: VtdRecord[];
  onLoadRecord: (id: string) => Promise<void>;
};

type RecordDuration = {
  humanReadable: string;
  nanoseconds: bigint;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value != undefined && !Array.isArray(value)
  );
}

function normalizeOptionalString(
  value: unknown,
  options: { allowNumber?: boolean } = {},
): { valid: boolean; value?: string } {
  if (value == undefined) {
    return { valid: true };
  }
  if (typeof value === "string") {
    return { valid: true, value };
  }
  if (
    options.allowNumber === true &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return { valid: true, value: String(value) };
  }
  return { valid: false };
}

function normalizeTriggerTime(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeEpochNanoseconds(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^\d+$/.test(value) ? value : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? String(Math.trunc(value))
    : undefined;
}

function parseRecord(value: unknown): VtdRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record = value;
  const rawRecord = isRecord(record.raw) ? record.raw : record;
  const idValue = record.id ?? rawRecord.id;
  const id =
    typeof idValue === "string" && idValue.length > 0
      ? idValue
      : typeof idValue === "number" && Number.isFinite(idValue)
        ? String(idValue)
        : undefined;
  const botName = normalizeOptionalString(
    record.botName ?? record.bot_name ?? rawRecord.bot_name,
  );
  const botSn = normalizeOptionalString(
    record.botSn ?? record.bot_sn ?? rawRecord.bot_sn,
  );
  const triggerType = normalizeOptionalString(
    record.triggerType ?? record.trigger_type ?? rawRecord.trigger_type,
  );
  const dataType = normalizeOptionalString(
    record.dataType ?? record.data_type ?? rawRecord.data_type,
    { allowNumber: true },
  );
  const triggerTimeValue =
    record.triggerTime ?? record.trigger_time ?? rawRecord.trigger_time;
  const triggerTime = normalizeTriggerTime(triggerTimeValue);
  const dataStartValue =
    record.dataStartNs ?? record.data_st ?? rawRecord.data_st;
  const dataStartNs = normalizeEpochNanoseconds(dataStartValue);
  const dataEndValue = record.dataEndNs ?? record.data_et ?? rawRecord.data_et;
  const dataEndNs = normalizeEpochNanoseconds(dataEndValue);
  const sizeBytesValue =
    record.sizeBytes ??
    record.size_bytes ??
    record.data_size ??
    rawRecord.data_size;
  const sizeBytes = sizeBytesValue ?? undefined;
  if (
    id == undefined ||
    !botName.valid ||
    !botSn.valid ||
    !triggerType.valid ||
    !dataType.valid ||
    (triggerTimeValue != undefined && triggerTime == undefined) ||
    (dataStartValue != undefined && dataStartNs == undefined) ||
    (dataEndValue != undefined && dataEndNs == undefined) ||
    (sizeBytes != undefined &&
      (typeof sizeBytes !== "number" ||
        !Number.isFinite(sizeBytes) ||
        sizeBytes < 0))
  ) {
    return undefined;
  }
  return {
    id,
    botName: botName.value,
    botSn: botSn.value,
    triggerType: triggerType.value,
    dataType: dataType.value,
    triggerTime,
    dataStartNs,
    dataEndNs,
    sizeBytes,
    raw: Object.hasOwn(record, "raw") ? record.raw : record,
  };
}

export function parseVtdSearchResult(
  result: unknown,
): VtdSearchResult | undefined {
  if (
    typeof result !== "object" ||
    result == undefined ||
    Array.isArray(result)
  ) {
    return undefined;
  }
  const candidate = result as Record<string, unknown>;
  const total = candidate.total;
  if (!Array.isArray(candidate.records) || candidate.records.length === 0) {
    return undefined;
  }
  const records: VtdRecord[] = [];
  let invalidRecordCount = 0;
  for (const value of candidate.records) {
    const record = parseRecord(value);
    if (record == undefined) {
      invalidRecordCount++;
    } else {
      records.push(record);
    }
  }
  if (invalidRecordCount > 0) {
    log.warn(`Skipped ${invalidRecordCount} invalid VTD search record(s)`);
  }
  if (records.length === 0) {
    return undefined;
  }
  if (
    typeof total !== "undefined" &&
    (typeof total !== "number" || !Number.isFinite(total) || total < 0)
  ) {
    return undefined;
  }
  return {
    records,
    ...(total == undefined ? {} : { total }),
  };
}

function triggerTimeMillis(
  triggerTime: string | undefined,
): number | undefined {
  if (triggerTime == undefined) {
    return undefined;
  }
  const milliseconds = /^\d+$/.test(triggerTime)
    ? Number(triggerTime)
    : Date.parse(triggerTime);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function formatTriggerTime(
  triggerTime: string | undefined,
): string | undefined {
  const milliseconds = triggerTimeMillis(triggerTime);
  return milliseconds == undefined
    ? undefined
    : new Date(milliseconds).toLocaleString();
}

function formatDurationSeconds(totalSeconds: bigint): string {
  const hours = totalSeconds / 3600n;
  const minutes = (totalSeconds % 3600n) / 60n;
  const seconds = totalSeconds % 60n;
  return [
    hours > 0n ? `${hours}h` : "",
    minutes > 0n ? `${minutes}m` : "",
    seconds > 0n || (hours === 0n && minutes === 0n) ? `${seconds}s` : "",
  ].join("");
}

function getRecordDuration(record: VtdRecord): RecordDuration | undefined {
  if (
    record.dataStartNs == undefined ||
    record.dataEndNs == undefined ||
    !/^\d+$/.test(record.dataStartNs) ||
    !/^\d+$/.test(record.dataEndNs)
  ) {
    return undefined;
  }
  const nanoseconds = BigInt(record.dataEndNs) - BigInt(record.dataStartNs);
  if (nanoseconds < 0n) {
    return undefined;
  }
  return {
    humanReadable: formatDurationSeconds(nanoseconds / NANOSECONDS_PER_SECOND),
    nanoseconds,
  };
}

function dedupeAndSortRecords(records: VtdRecord[]): VtdRecord[] {
  const recordsById = new Map<string, VtdRecord>();
  for (const record of records) {
    recordsById.set(record.id, record);
  }
  return [...recordsById.values()].sort((left, right) => {
    const leftTime = triggerTimeMillis(left.triggerTime);
    const rightTime = triggerTimeMillis(right.triggerTime);
    if (leftTime == undefined) {
      return rightTime == undefined ? 0 : 1;
    }
    return rightTime == undefined ? -1 : rightTime - leftTime;
  });
}

export function VtdRecordListCard({
  records,
  onLoadRecord,
}: VtdRecordListCardProps): React.JSX.Element {
  const { classes } = useStyles();
  const { t } = useTranslation("agentChat");
  const mountedRef = useRef(true);
  const loadingIdsRef = useRef<Set<string>>(new Set<string>());
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [expandedRecordId, setExpandedRecordId] = useState<string>();
  const [page, setPage] = useState(0);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sortedRecords = useMemo(() => dedupeAndSortRecords(records), [records]);
  const pageCount = Math.max(1, Math.ceil(sortedRecords.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount - 1);
  const visibleRecords = sortedRecords.slice(
    visiblePage * PAGE_SIZE,
    (visiblePage + 1) * PAGE_SIZE,
  );

  const clearError = useCallback((id: string) => {
    setErrors((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const loadRecord = useCallback(
    async (id: string) => {
      if (loadingIdsRef.current.has(id)) {
        return;
      }
      const nextLoadingIds = new Set(loadingIdsRef.current).add(id);
      loadingIdsRef.current = nextLoadingIds;
      setLoadingIds(nextLoadingIds);
      clearError(id);
      try {
        await onLoadRecord(id);
      } catch {
        if (mountedRef.current) {
          setErrors((current) => new Map(current).set(id, t("loadDataFailed")));
        }
      } finally {
        const remainingLoadingIds = new Set(loadingIdsRef.current);
        remainingLoadingIds.delete(id);
        loadingIdsRef.current = remainingLoadingIds;
        if (mountedRef.current) {
          setLoadingIds(remainingLoadingIds);
        }
      }
    },
    [clearError, onLoadRecord, t],
  );

  return (
    <Paper
      className={classes.card}
      data-testid="vtd-record-list-card"
      variant="outlined"
    >
      <Typography
        className={classes.summary}
        color="text.secondary"
        variant="caption"
      >
        {t("dedupedTotal", { count: sortedRecords.length })}
      </Typography>
      {visibleRecords.map((record) => {
        const loading = loadingIds.has(record.id);
        const error = errors.get(record.id);
        const duration = getRecordDuration(record);
        const expanded = expandedRecordId === record.id;
        const localizedTriggerTime = formatTriggerTime(record.triggerTime);
        const metadata = [
          record.botName,
          record.triggerType,
          localizedTriggerTime,
          record.sizeBytes == undefined
            ? undefined
            : formatByteSize(record.sizeBytes),
          duration == undefined
            ? undefined
            : t("durationLabel", { duration: duration.humanReadable }),
        ].filter((value): value is string => value != undefined);
        return (
          <div
            className={classes.row}
            data-testid="vtd-record-row"
            key={record.id}
          >
            <div className={classes.details}>
              <Typography className={classes.id} variant="body2">
                {record.id}
              </Typography>
              <div className={classes.metadata}>
                {metadata.map((value, metadataIndex) => (
                  <Typography
                    color="text.secondary"
                    key={`${value}-${metadataIndex}`}
                    variant="caption"
                  >
                    {value}
                  </Typography>
                ))}
              </div>
            </div>
            <div className={classes.actions}>
              {duration != undefined &&
                duration.nanoseconds > FIVE_MINUTES_NS && (
                  <Button
                    aria-expanded={expanded}
                    size="small"
                    variant="outlined"
                    onClick={() => {
                      setExpandedRecordId((current) =>
                        current === record.id ? undefined : record.id,
                      );
                    }}
                  >
                    {t("sliceData")}
                  </Button>
                )}
              <Button
                aria-busy={loading}
                disabled={loading}
                size="small"
                startIcon={loading ? <CircularProgress size={14} /> : undefined}
                variant="outlined"
                onClick={() => {
                  void loadRecord(record.id);
                }}
              >
                {t("loadData")}
              </Button>
            </div>
            {error != undefined && (
              <Typography
                className={classes.error}
                color="error"
                role="alert"
                variant="caption"
              >
                {error}
              </Typography>
            )}
            {expanded && (
              <div className={classes.expanded}>
                <VtdSliceConfigCard
                  record={record}
                  onCancel={() => {
                    setExpandedRecordId(undefined);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className={classes.pagination}>
        <Button
          disabled={visiblePage === 0}
          size="small"
          onClick={() => {
            setPage((current) => Math.max(0, current - 1));
          }}
        >
          {t("previousPage")}
        </Button>
        <Typography color="text.secondary" variant="caption">
          {t("pageOf", { page: visiblePage + 1, pages: pageCount })}
        </Typography>
        <Button
          disabled={visiblePage >= pageCount - 1}
          size="small"
          onClick={() => {
            setPage((current) => Math.min(pageCount - 1, current + 1));
          }}
        >
          {t("nextPage")}
        </Button>
      </div>
    </Paper>
  );
}
