// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { Button, Typography } from "@mui/material";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentMarkdown } from "@lichtblick/suite-base/components/AgentMarkdown";
import type { AgentChatStatus } from "@lichtblick/suite-base/context/AgentChatContext";
import {
  ChatMessage,
  LayoutProposal,
} from "@lichtblick/suite-base/services/agent/types";
import { VtdRecord } from "@lichtblick/suite-base/services/vtd/types";

import { useStyles } from "./AgentChatSidebar.style";
import { LayoutPreviewCard } from "./LayoutPreviewCard";
import { ToolRunGroup } from "./ToolRunGroup";
import { parseVtdSearchResult, VtdRecordListCard } from "./VtdRecordListCard";

type MessageListProps = {
  messages: readonly ChatMessage[];
  pendingProposal?: LayoutProposal;
  pendingProposalMessageId?: string;
  pendingProposalRequestId?: string;
  onLoadVtdRecord: (id: string) => Promise<void>;
  status?: AgentChatStatus;
};

const MESSAGE_WINDOW_SIZE = 100;

const MessageItem = memo(function MemoizedMessageItem({
  isProcessing,
  message,
  onLoadVtdRecord,
  vtdRecords,
}: {
  isProcessing: boolean;
  message: ChatMessage;
  onLoadVtdRecord: (id: string) => Promise<void>;
  vtdRecords?: VtdRecord[];
}): React.JSX.Element {
  const { classes, cx } = useStyles();
  const { t } = useTranslation("agentChat");
  const isUser = message.role === "user";

  return (
    <div
      aria-label={isUser ? t("you") : t("assistant")}
      className={cx(classes.message, {
        [classes.userMessage]: isUser,
        [classes.assistantMessage]: !isUser,
      })}
      data-testid={`agent-chat-message-${message.id}`}
      role="article"
    >
      <Typography
        className={cx(classes.roleLabel, { [classes.userRoleLabel]: isUser })}
        variant="caption"
      >
        {isUser ? t("you") : t("assistant")}
      </Typography>
      {!isProcessing && <AgentMarkdown>{message.content}</AgentMarkdown>}
      {message.toolRuns != undefined && message.toolRuns.length > 0 && (
        <ToolRunGroup toolRuns={message.toolRuns} />
      )}
      {isProcessing && (
        <Typography
          color="text.secondary"
          data-testid="agent-chat-processing"
          variant="body2"
        >
          {t("processing")}
        </Typography>
      )}
      {vtdRecords != undefined && (
        <VtdRecordListCard
          records={vtdRecords}
          onLoadRecord={onLoadVtdRecord}
        />
      )}
    </div>
  );
});

export function MessageList(props: MessageListProps): React.JSX.Element {
  const {
    messages,
    pendingProposal,
    pendingProposalMessageId,
    pendingProposalRequestId,
    onLoadVtdRecord,
    status = "idle",
  } = props;
  const { classes } = useStyles();
  const { t } = useTranslation("agentChat");
  const [oldestVisibleMessageId, setOldestVisibleMessageId] =
    useState<string>();
  const mergedVtdSearch = useMemo(() => {
    const recordsById = new Map<string, VtdRecord>();
    let lastMessageId: string | undefined;
    for (const message of messages) {
      let messageHasResult = false;
      for (const toolRun of message.toolRuns ?? []) {
        if (toolRun.name !== "vtd_search") {
          continue;
        }
        const result = parseVtdSearchResult(toolRun.result);
        if (result == undefined) {
          continue;
        }
        messageHasResult = true;
        for (const record of result.records) {
          recordsById.set(record.id, record);
        }
      }
      if (messageHasResult) {
        lastMessageId = message.id;
      }
    }
    return {
      lastMessageId,
      records: [...recordsById.values()],
    };
  }, [messages]);
  const anchorIndex =
    oldestVisibleMessageId == undefined
      ? -1
      : messages.findIndex((message) => message.id === oldestVisibleMessageId);

  useEffect(() => {
    if (oldestVisibleMessageId != undefined && anchorIndex === -1) {
      setOldestVisibleMessageId(undefined);
    }
  }, [anchorIndex, oldestVisibleMessageId]);

  if (messages.length === 0 && pendingProposal == undefined) {
    return (
      <div className={classes.emptyState}>
        <Typography variant="subtitle2">{t("emptyTitle")}</Typography>
        <Typography color="text.secondary" variant="body2">
          {t("emptyDescription")}
        </Typography>
      </div>
    );
  }

  const oldestVisibleIndex =
    anchorIndex === -1
      ? Math.max(0, messages.length - MESSAGE_WINDOW_SIZE)
      : anchorIndex;
  const visibleMessages = messages.slice(oldestVisibleIndex);
  const latestMessage = messages.at(-1);
  const processingMessageId =
    (status === "streaming" || status === "waiting-for-catalog") &&
    latestMessage?.role === "assistant" &&
    latestMessage.toolRuns != undefined &&
    latestMessage.toolRuns.length > 0
      ? latestMessage.id
      : undefined;

  return (
    <div className={classes.messageList}>
      {oldestVisibleIndex > 0 && (
        <Button
          className={classes.showEarlierButton}
          size="small"
          onClick={() => {
            const expandedStartIndex = Math.max(
              0,
              oldestVisibleIndex - MESSAGE_WINDOW_SIZE,
            );
            setOldestVisibleMessageId(messages[expandedStartIndex]?.id);
          }}
        >
          {t("showEarlierMessages", { defaultValue: "Show earlier messages" })}
        </Button>
      )}
      {visibleMessages.map((message) => (
        <MessageItem
          isProcessing={message.id === processingMessageId}
          key={message.id}
          message={message}
          onLoadVtdRecord={onLoadVtdRecord}
          vtdRecords={
            message.id === mergedVtdSearch.lastMessageId
              ? mergedVtdSearch.records
              : undefined
          }
        />
      ))}
      {pendingProposal != undefined && (
        <LayoutPreviewCard
          proposal={pendingProposal}
          proposalMessageId={pendingProposalMessageId}
          proposalRequestId={pendingProposalRequestId}
        />
      )}
    </div>
  );
}
