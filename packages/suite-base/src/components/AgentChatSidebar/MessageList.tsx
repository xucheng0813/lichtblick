// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { Button, Link, Typography } from "@mui/material";
import { memo, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown, { Components } from "react-markdown";

import LinkHandlerContext from "@lichtblick/suite-base/context/LinkHandlerContext";
import { ChatMessage, LayoutProposal } from "@lichtblick/suite-base/services/agent/types";

import { useStyles } from "./AgentChatSidebar.style";
import { LayoutPreviewCard } from "./LayoutPreviewCard";
import { ToolRunCard } from "./ToolRunCard";

type MessageListProps = {
  messages: readonly ChatMessage[];
  pendingProposal?: LayoutProposal;
  pendingProposalMessageId?: string;
  pendingProposalRequestId?: string;
};

const MESSAGE_WINDOW_SIZE = 100;

const MarkdownLink: NonNullable<Components["a"]> = ({ children, href }) => {
  const handleLink = useContext(LinkHandlerContext);

  return (
    <Link
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      onClick={(event) => {
        handleLink(event, href ?? "");
      }}
    >
      {children}
    </Link>
  );
};

type ImageTarget = {
  hasAdditionalParameters: boolean;
  label: string;
};

function imageTarget(src: string): ImageTarget {
  const parameterIndex = src.search(/[?#]/u);
  const fallbackLabel = parameterIndex === -1 ? src : src.slice(0, parameterIndex);
  try {
    const url = new URL(src, globalThis.location.href);
    return {
      hasAdditionalParameters: url.search !== "" || url.hash !== "",
      label: url.origin === "null" ? fallbackLabel : `${url.origin}${url.pathname}`,
    };
  } catch {
    return {
      hasAdditionalParameters: parameterIndex !== -1,
      label: fallbackLabel,
    };
  }
}

function DeferredMarkdownImage(props: { alt?: string; src: string }): React.JSX.Element {
  const { alt, src } = props;
  const { classes } = useStyles();
  const { t } = useTranslation("agentChat");
  const [approvedSrc, setApprovedSrc] = useState<string>();
  const target = imageTarget(src);
  const additionalParametersLabel = target.hasAdditionalParameters
    ? t("imageHasAdditionalParameters", { defaultValue: "Includes additional parameters" })
    : undefined;
  const approvalLabel =
    additionalParametersLabel == undefined
      ? target.label
      : `${target.label} (${additionalParametersLabel})`;

  if (approvedSrc === src) {
    return (
      <img
        className={classes.markdownImage}
        alt={alt ?? ""}
        decoding="async"
        loading="lazy"
        referrerPolicy="no-referrer"
        src={src}
      />
    );
  }

  return (
    <Button
      aria-label={alt == undefined || alt === "" ? approvalLabel : `${approvalLabel}: ${alt}`}
      className={classes.imagePlaceholder}
      size="small"
      title={src}
      variant="outlined"
      onClick={() => {
        setApprovedSrc(src);
      }}
    >
      {approvalLabel}
    </Button>
  );
}

const MarkdownImage: NonNullable<Components["img"]> = ({ alt, src }) => {
  return src == undefined || src === "" ? <>{alt}</> : <DeferredMarkdownImage alt={alt} src={src} />;
};

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
};

const MessageItem = memo(function MemoizedMessageItem({
  message,
}: {
  message: ChatMessage;
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
      <div className={classes.markdown}>
        <Markdown components={MARKDOWN_COMPONENTS} skipHtml>
          {message.content}
        </Markdown>
      </div>
      {message.toolRuns?.map((toolRun) => (
        <ToolRunCard key={toolRun.id} toolRun={toolRun} />
      ))}
    </div>
  );
});

export function MessageList(props: MessageListProps): React.JSX.Element {
  const {
    messages,
    pendingProposal,
    pendingProposalMessageId,
    pendingProposalRequestId,
  } = props;
  const { classes } = useStyles();
  const { t } = useTranslation("agentChat");
  const [oldestVisibleMessageId, setOldestVisibleMessageId] = useState<string>();
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
    anchorIndex === -1 ? Math.max(0, messages.length - MESSAGE_WINDOW_SIZE) : anchorIndex;
  const visibleMessages = messages.slice(oldestVisibleIndex);

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
        <MessageItem key={message.id} message={message} />
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
