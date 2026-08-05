// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Paper,
  Slider,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import Log from "@lichtblick/log";

import {
  type AgentChatState,
  type VtdSliceProgress,
  useAgentChat,
} from "@lichtblick/suite-base/context/AgentChatContext";
import type { VtdRecord } from "@lichtblick/suite-base/services/vtd/types";

const log = Log.getLogger(__filename);

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

type SliceCardStatus = "configuring" | "slicing" | "loading" | "done" | "error";
type FailureKind = "topics" | "slice";

type SliceTimeRange = {
  durationMs: number;
  durationNs: bigint;
  endNs: bigint;
  startNs: bigint;
};

const selectGetVtdTopics = (state: AgentChatState) => state.actions.getVtdTopics;
const selectSliceVtdRecord = (state: AgentChatState) => state.actions.sliceVtdRecord;

const useStyles = makeStyles()((theme) => ({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(1.25),
    padding: theme.spacing(1.5),
  },
  heading: {
    fontWeight: 600,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(0.5),
  },
  slider: {
    margin: theme.spacing(0, 2),
    width: `calc(100% - ${theme.spacing(4)})`,
    "& .MuiSlider-markLabel": {
      fontSize: theme.typography.caption.fontSize,
      whiteSpace: "nowrap",
    },
    "& .MuiSlider-valueLabel": {
      whiteSpace: "nowrap",
    },
  },
  selection: {
    display: "grid",
    gap: theme.spacing(0.25, 1),
    gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  },
  topicActions: {
    display: "flex",
    gap: theme.spacing(0.5),
  },
  topicList: {
    border: `1px solid ${theme.palette.divider}`,
    display: "flex",
    flexDirection: "column",
    maxHeight: 200,
    overflowY: "auto",
    padding: theme.spacing(0.5),
  },
  topicLabel: {
    margin: 0,
    minWidth: 0,
    "& .MuiFormControlLabel-label": {
      overflowWrap: "anywhere",
    },
  },
  actions: {
    display: "flex",
    gap: theme.spacing(1),
    justifyContent: "flex-end",
  },
  processing: {
    alignItems: "center",
    display: "flex",
    gap: theme.spacing(1),
  },
}));

export type VtdSliceConfigCardProps = {
  onCancel: () => void;
  record: VtdRecord;
};

export function createSliceTimeRange(record: VtdRecord): SliceTimeRange | undefined {
  if (
    record.dataStartNs == undefined ||
    record.dataEndNs == undefined ||
    !/^\d+$/.test(record.dataStartNs) ||
    !/^\d+$/.test(record.dataEndNs)
  ) {
    return undefined;
  }
  const startNs = BigInt(record.dataStartNs);
  const endNs = BigInt(record.dataEndNs);
  const durationNs = endNs - startNs;
  if (durationNs <= 0n) {
    return undefined;
  }
  const wholeMilliseconds = durationNs / NANOSECONDS_PER_MILLISECOND;
  if (wholeMilliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  const fractionalMilliseconds = Number(durationNs % NANOSECONDS_PER_MILLISECOND) / 1e6;
  return {
    durationMs: Number(wholeMilliseconds) + fractionalMilliseconds,
    durationNs,
    endNs,
    startNs,
  };
}

function offsetToNanoseconds(range: SliceTimeRange, offsetMs: number): bigint {
  if (offsetMs <= 0) {
    return range.startNs;
  }
  if (offsetMs >= range.durationMs) {
    return range.endNs;
  }
  const relativeNs = BigInt(Math.round(offsetMs * 1e6));
  return range.startNs + (relativeNs > range.durationNs ? range.durationNs : relativeNs);
}

function formatLocalNanoseconds(nanoseconds: bigint): string {
  const milliseconds = nanoseconds / NANOSECONDS_PER_MILLISECOND;
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.getTime()) ? nanoseconds.toString() : date.toLocaleString();
}

function formatSelectedDuration(milliseconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const remainder = totalMilliseconds % 1000;
  const parts = [hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : ""];
  if (seconds > 0 || remainder > 0 || parts.every((part) => part.length === 0)) {
    parts.push(remainder > 0 ? `${seconds}.${String(remainder).padStart(3, "0")}s` : `${seconds}s`);
  }
  return parts.filter((part) => part.length > 0).join(" ");
}

export function VtdSliceConfigCard({
  onCancel,
  record,
}: VtdSliceConfigCardProps): React.JSX.Element {
  const { classes } = useStyles();
  const { t } = useTranslation("agentChat");
  const getVtdTopics = useAgentChat(selectGetVtdTopics);
  const sliceVtdRecord = useAgentChat(selectSliceVtdRecord);
  const timeRange = useMemo(() => createSliceTimeRange(record), [record]);
  const [status, setStatus] = useState<SliceCardStatus>("configuring");
  const [failureKind, setFailureKind] = useState<FailureKind>();
  const [topics, setTopics] = useState<ReadonlyArray<readonly [string, number]>>([]);
  const [topicsLoaded, setTopicsLoaded] = useState(false);
  const [selectedTopics, setSelectedTopics] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedRange, setSelectedRange] = useState<[number, number]>(() => [
    0,
    timeRange?.durationMs ?? 0,
  ]);
  const mountedRef = useRef(true);
  const topicsGenerationRef = useRef(0);
  const operationRef = useRef(false);
  const lastProgressRef = useRef<VtdSliceProgress>("slicing");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadTopics = useCallback(async () => {
    if (timeRange == undefined) {
      setFailureKind("topics");
      setStatus("error");
      return;
    }
    const generation = ++topicsGenerationRef.current;
    setFailureKind(undefined);
    setStatus("configuring");
    setTopicsLoaded(false);
    setTopics([]);
    setSelectedTopics(new Set());
    try {
      const result = await getVtdTopics(record.id);
      if (!mountedRef.current || topicsGenerationRef.current !== generation) {
        return;
      }
      const loadedTopics = Object.entries(result).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      setTopics(loadedTopics);
      setTopicsLoaded(true);
      setSelectedTopics(new Set(loadedTopics.map(([topic]) => topic)));
    } catch (error) {
      log.warn("Failed to load VTD topics for slice configuration", error);
      if (mountedRef.current && topicsGenerationRef.current === generation) {
        setFailureKind("topics");
        setStatus("error");
      }
    }
  }, [getVtdTopics, record.id, timeRange]);

  useEffect(() => {
    void loadTopics();
  }, [loadTopics]);

  const submit = useCallback(async () => {
    if (
      timeRange == undefined ||
      operationRef.current ||
      selectedTopics.size === 0 ||
      selectedRange[0] >= selectedRange[1]
    ) {
      return;
    }
    operationRef.current = true;
    lastProgressRef.current = "slicing";
    setFailureKind(undefined);
    setStatus("slicing");
    const startNs = offsetToNanoseconds(timeRange, selectedRange[0]);
    const endNs = offsetToNanoseconds(timeRange, selectedRange[1]);
    try {
      await sliceVtdRecord(
        {
          id: record.id,
          topics: [...selectedTopics].sort(),
          startNs: startNs.toString(),
          endNs: endNs.toString(),
        },
        (progress) => {
          lastProgressRef.current = progress;
          if (mountedRef.current) {
            setStatus(progress);
          }
        },
      );
      if (mountedRef.current) {
        setStatus("done");
      }
    } catch (error) {
      log.warn("VTD slice request failed", error);
      if (mountedRef.current) {
        setFailureKind("slice");
        setStatus("error");
      }
    } finally {
      operationRef.current = false;
    }
  }, [record.id, selectedRange, selectedTopics, sliceVtdRecord, timeRange]);

  const retry = useCallback(() => {
    if (failureKind === "topics") {
      void loadTopics();
      return;
    }
    setStatus(lastProgressRef.current);
    void submit();
  }, [failureKind, loadTopics, submit]);

  const startNs =
    timeRange == undefined ? undefined : offsetToNanoseconds(timeRange, selectedRange[0]);
  const endNs =
    timeRange == undefined ? undefined : offsetToNanoseconds(timeRange, selectedRange[1]);
  const validSelection =
    timeRange != undefined && selectedTopics.size > 0 && selectedRange[0] < selectedRange[1];

  return (
    <Paper className={classes.root} data-testid="vtd-slice-config-card" variant="outlined">
      <Typography className={classes.heading} variant="body2">
        {t("sliceConfigure")}
      </Typography>

      {status === "configuring" && (
        <>
          <div className={classes.section}>
            <Typography variant="caption">{t("timeRange")}</Typography>
            {timeRange != undefined && startNs != undefined && endNs != undefined ? (
              <>
                <Slider
                  className={classes.slider}
                  disableSwap
                  getAriaLabel={(index) => (index === 0 ? t("sliceStartTime") : t("sliceEndTime"))}
                  marks={[
                    { value: 0, label: formatLocalNanoseconds(timeRange.startNs) },
                    {
                      value: timeRange.durationMs,
                      label: formatLocalNanoseconds(timeRange.endNs),
                    },
                  ]}
                  max={timeRange.durationMs}
                  min={0}
                  step={1}
                  value={selectedRange}
                  valueLabelDisplay="on"
                  valueLabelFormat={(value) =>
                    formatLocalNanoseconds(offsetToNanoseconds(timeRange, value))
                  }
                  onChange={(_event, value) => {
                    if (Array.isArray(value) && value[0] != undefined && value[1] != undefined) {
                      setSelectedRange([value[0], value[1]]);
                    }
                  }}
                />
                <div className={classes.selection}>
                  <Typography variant="caption">
                    {t("selectedStart", { time: formatLocalNanoseconds(startNs) })}
                  </Typography>
                  <Typography variant="caption">
                    {t("selectedEnd", { time: formatLocalNanoseconds(endNs) })}
                  </Typography>
                  <Typography variant="caption">
                    {t("selectedDuration", {
                      duration: formatSelectedDuration(selectedRange[1] - selectedRange[0]),
                    })}
                  </Typography>
                </div>
              </>
            ) : (
              <Typography color="error" role="alert" variant="caption">
                {t("sliceFailed")}
              </Typography>
            )}
          </div>

          <div className={classes.section}>
            <Typography variant="caption">{t("selectTopics")}</Typography>
            {!topicsLoaded ? (
              <div className={classes.processing} role="status">
                <CircularProgress size={16} />
                <Typography variant="caption">{t("topicsLoading")}</Typography>
              </div>
            ) : topics.length === 0 ? (
              <Typography color="text.secondary" variant="caption">
                {t("noTopics")}
              </Typography>
            ) : (
              <>
                <div className={classes.topicActions}>
                  <Button
                    size="small"
                    onClick={() => {
                      setSelectedTopics(new Set(topics.map(([topic]) => topic)));
                    }}
                  >
                    {t("selectAll")}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setSelectedTopics(new Set());
                    }}
                  >
                    {t("selectNone")}
                  </Button>
                </div>
                <div className={classes.topicList}>
                  {topics.map(([topic, count]) => (
                    <FormControlLabel
                      className={classes.topicLabel}
                      control={
                        <Checkbox
                          checked={selectedTopics.has(topic)}
                          size="small"
                          onChange={(_event, checked) => {
                            setSelectedTopics((current) => {
                              const next = new Set(current);
                              if (checked) {
                                next.add(topic);
                              } else {
                                next.delete(topic);
                              }
                              return next;
                            });
                          }}
                        />
                      }
                      key={topic}
                      label={t("topicMessageCount", { topic, count })}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          <div className={classes.actions}>
            <Button size="small" onClick={onCancel}>
              {t("sliceCancel")}
            </Button>
            <Button
              disabled={!validSelection || topics.length === 0}
              size="small"
              variant="contained"
              onClick={() => {
                void submit();
              }}
            >
              {t("sliceStart")}
            </Button>
          </div>
        </>
      )}

      {(status === "slicing" || status === "loading") && (
        <div className={classes.processing} role="status">
          <CircularProgress size={18} />
          <Typography variant="caption">
            {status === "slicing" ? t("slicing") : t("sliceLoading")}
          </Typography>
        </div>
      )}

      {status === "done" && (
        <>
          <Typography role="status" variant="caption">
            {t("sliceDone")}
          </Typography>
          <div className={classes.actions}>
            <Button size="small" onClick={onCancel}>
              {t("sliceCancel")}
            </Button>
          </div>
        </>
      )}

      {status === "error" && (
        <>
          <Typography color="error" role="alert" variant="caption">
            {failureKind === "topics" ? t("topicsFailed") : t("sliceFailed")}
          </Typography>
          <div className={classes.actions}>
            <Button size="small" onClick={onCancel}>
              {t("sliceCancel")}
            </Button>
            <Button size="small" variant="outlined" onClick={retry}>
              {t("retry")}
            </Button>
          </div>
        </>
      )}
    </Paper>
  );
}
