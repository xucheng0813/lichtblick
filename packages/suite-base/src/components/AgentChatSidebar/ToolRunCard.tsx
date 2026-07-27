// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { Button, Chip, ChipProps, LinearProgress, Paper, Typography } from "@mui/material";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Stack from "@lichtblick/suite-base/components/Stack";
import {
  AgentChatState,
  useAgentChat,
} from "@lichtblick/suite-base/context/AgentChatContext";
import { ToolRun, ToolRunStatus } from "@lichtblick/suite-base/services/agent/types";

import { useStyles } from "./AgentChatSidebar.style";

const STATUS_LABEL_KEYS = {
  queued: "toolStatus.queued",
  running: "toolStatus.running",
  "awaiting-confirmation": "toolStatus.awaitingConfirmation",
  succeeded: "toolStatus.succeeded",
  failed: "toolStatus.failed",
  cancelled: "toolStatus.cancelled",
} as const satisfies Record<ToolRunStatus, string>;

const STATUS_COLORS: Record<ToolRunStatus, ChipProps["color"]> = {
  queued: "default",
  running: "primary",
  "awaiting-confirmation": "warning",
  succeeded: "success",
  failed: "error",
  cancelled: "default",
};

const selectActions = (state: AgentChatState) => state.actions;

type ToolRunCardProps = {
  toolRun: ToolRun;
};

export function ToolRunCard({ toolRun }: ToolRunCardProps): React.JSX.Element {
  const { classes } = useStyles();
  const { t } = useTranslation("agentChat");
  const actions = useAgentChat(selectActions);
  const [decisionPending, setDecisionPending] = useState(false);
  const [decisionError, setDecisionError] = useState<string>();
  const decisionTokenRef = useRef<symbol>();
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (toolRun.status !== "awaiting-confirmation") {
      const hadPendingDecision = decisionTokenRef.current != undefined;
      decisionTokenRef.current = undefined;
      if (hadPendingDecision) {
        setDecisionPending(false);
      }
      setDecisionError(undefined);
    }
  }, [toolRun.status]);

  const submitDecision = useCallback(
    async (options: { approve: boolean }) => {
      if (decisionTokenRef.current != undefined) {
        return;
      }
      const token = Symbol("tool-run-decision");
      decisionTokenRef.current = token;
      setDecisionPending(true);
      setDecisionError(undefined);
      try {
        await actions.confirmToolRun(toolRun.id, options);
      } catch (error) {
        if (decisionTokenRef.current !== token) {
          return;
        }
        decisionTokenRef.current = undefined;
        if (mountedRef.current && toolRun.status === "awaiting-confirmation") {
          setDecisionError(
            error instanceof Error && error.message !== ""
              ? error.message
              : t("toolDecisionFailed", {
                  defaultValue: "Could not update the tool run. Try again.",
                }),
          );
          setDecisionPending(false);
        }
      }
    },
    [actions, t, toolRun.id, toolRun.status],
  );

  const progress = useMemo(() => {
    if (toolRun.progress == undefined) {
      return undefined;
    }
    return Math.max(0, Math.min(100, toolRun.progress));
  }, [toolRun.progress]);

  const showProgress = toolRun.status === "running" || progress != undefined;
  const needsConfirmation = toolRun.status === "awaiting-confirmation";

  return (
    <Paper className={classes.toolCard} variant="outlined">
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Typography className={classes.toolName} variant="body2">
          {toolRun.name}
        </Typography>
        <Chip
          size="small"
          color={STATUS_COLORS[toolRun.status]}
          label={t(STATUS_LABEL_KEYS[toolRun.status])}
        />
      </Stack>

      {toolRun.summary != undefined && (
        <Typography className={classes.toolSummary} color="text.secondary" variant="body2">
          {toolRun.summary}
        </Typography>
      )}

      {toolRun.error != undefined && (
        <Typography className={classes.toolError} color="error" variant="body2">
          {toolRun.error}
        </Typography>
      )}
      {decisionError != undefined && (
        <Typography className={classes.toolError} color="error" variant="body2">
          {decisionError}
        </Typography>
      )}

      {showProgress && (
        <LinearProgress
          className={classes.progress}
          aria-label={t("toolProgress", { name: toolRun.name })}
          variant={progress == undefined ? "indeterminate" : "determinate"}
          value={progress}
        />
      )}

      {needsConfirmation && (
        <Stack className={classes.cardActions} direction="row" justifyContent="flex-end" gap={1}>
          <Button
            disabled={decisionPending}
            size="small"
            variant="text"
            onClick={() => {
              void submitDecision({ approve: false });
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={decisionPending}
            size="small"
            variant="contained"
            onClick={() => {
              void submitDecision({ approve: true });
            }}
          >
            {t("confirm")}
          </Button>
        </Stack>
      )}
    </Paper>
  );
}
