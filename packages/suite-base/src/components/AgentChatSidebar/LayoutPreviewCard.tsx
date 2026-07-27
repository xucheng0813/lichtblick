// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { Button, Paper, Typography } from "@mui/material";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Stack from "@lichtblick/suite-base/components/Stack";
import {
  AgentChatState,
  useAgentChat,
} from "@lichtblick/suite-base/context/AgentChatContext";
import { LayoutProposal } from "@lichtblick/suite-base/services/agent/types";

import { useStyles } from "./AgentChatSidebar.style";

const selectActions = (state: AgentChatState) => state.actions;

type LayoutPreviewCardProps = {
  proposal: LayoutProposal;
  proposalMessageId?: string;
  proposalRequestId?: string;
};

type ProposalLock = {
  kind: "apply" | "dismiss";
  proposal: LayoutProposal;
  proposalMessageId?: string;
  proposalRequestId?: string;
  token: symbol;
};

export function LayoutPreviewCard({
  proposal,
  proposalMessageId,
  proposalRequestId,
}: LayoutPreviewCardProps): React.JSX.Element {
  const { classes } = useStyles();
  const { t } = useTranslation("agentChat");
  const actions = useAgentChat(selectActions);
  const [actionLock, setActionLock] = useState<ProposalLock>();
  const actionLockRef = useRef<ProposalLock>();
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearLock = useCallback((lock: ProposalLock) => {
    if (actionLockRef.current !== lock) {
      return;
    }
    actionLockRef.current = undefined;
    if (mountedRef.current) {
      setActionLock(undefined);
    }
  }, []);

  const dismiss = useCallback(() => {
    if (actionLockRef.current != undefined) {
      return;
    }
    const lock: ProposalLock = {
      kind: "dismiss",
      proposal,
      proposalMessageId,
      proposalRequestId,
      token: Symbol("dismiss-layout-proposal"),
    };
    actionLockRef.current = lock;
    setActionLock(lock);
    try {
      actions.dismissProposal();
    } finally {
      queueMicrotask(() => {
        clearLock(lock);
      });
    }
  }, [actions, clearLock, proposal, proposalMessageId, proposalRequestId]);

  const apply = useCallback(async () => {
    if (actionLockRef.current != undefined) {
      return;
    }
    const lock: ProposalLock = {
      kind: "apply",
      proposal,
      proposalMessageId,
      proposalRequestId,
      token: Symbol("apply-layout-proposal"),
    };
    actionLockRef.current = lock;
    setActionLock(lock);
    try {
      await actions.applyProposal();
    } finally {
      clearLock(lock);
    }
  }, [actions, clearLock, proposal, proposalMessageId, proposalRequestId]);

  const actionPending = actionLock != undefined;
  const applyingPreviousProposal =
    actionLock?.kind === "apply" &&
    (actionLock.proposal !== proposal ||
      actionLock.proposalMessageId !== proposalMessageId ||
      actionLock.proposalRequestId !== proposalRequestId);

  return (
    <Paper aria-busy={actionPending} className={classes.proposalCard} variant="outlined">
      <Typography color="text.secondary" variant="caption">
        {t("layoutProposal")}
      </Typography>
      <Typography className={classes.proposalName} variant="subtitle2">
        {proposal.name}
      </Typography>
      {proposal.summary != undefined && (
        <Typography color="text.secondary" variant="body2">
          {proposal.summary}
        </Typography>
      )}
      {applyingPreviousProposal && (
        <Typography className={classes.proposalPending} color="text.secondary" variant="body2">
          {t("previousProposalApplying", {
            defaultValue: "Previous proposal is still applying",
          })}
        </Typography>
      )}
      <Stack className={classes.cardActions} direction="row" justifyContent="flex-end" gap={1}>
        <Button
          disabled={actionPending}
          size="small"
          variant="text"
          onClick={dismiss}
        >
          {t("ignore")}
        </Button>
        <Button
          disabled={actionPending}
          size="small"
          variant="contained"
          onClick={() => {
            void apply();
          }}
        >
          {t("apply")}
        </Button>
      </Stack>
    </Paper>
  );
}
