// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { makeStyles } from "tss-react/mui";

import { customTypography } from "@lichtblick/theme";

export const useStyles = makeStyles()((theme) => ({
  root: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: 0,
    backgroundColor: theme.palette.background.paper,
  },
  header: {
    flex: "none",
    minHeight: theme.spacing(4.5),
    padding: theme.spacing(0.75, 1.5),
    borderBottom: `1px solid ${theme.palette.divider}`,
  },
  messages: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    padding: theme.spacing(1.5),
  },
  messageList: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(1.5),
  },
  showEarlierButton: {
    alignSelf: "center",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing(0.5),
    minHeight: "100%",
    padding: theme.spacing(3),
    textAlign: "center",
  },
  message: {
    maxWidth: "92%",
    padding: theme.spacing(1, 1.25),
    borderRadius: theme.shape.borderRadius,
    overflowWrap: "anywhere",
  },
  userMessage: {
    alignSelf: "flex-end",
    color: theme.palette.primary.contrastText,
    backgroundColor: theme.palette.primary.main,
  },
  assistantMessage: {
    alignSelf: "flex-start",
    color: theme.palette.text.primary,
    backgroundColor: theme.palette.action.hover,
    border: `1px solid ${theme.palette.divider}`,
  },
  roleLabel: {
    display: "block",
    marginBottom: theme.spacing(0.5),
    color: theme.palette.text.secondary,
  },
  userRoleLabel: {
    color: theme.palette.primary.contrastText,
  },
  markdown: {
    fontFamily: theme.typography.body2.fontFamily,
    fontSize: theme.typography.body2.fontSize,
    lineHeight: theme.typography.body2.lineHeight,

    "p, ul, ol, pre, blockquote": {
      margin: theme.spacing(0.75, 0),

      "&:first-child": {
        marginTop: 0,
      },
      "&:last-child": {
        marginBottom: 0,
      },
    },
    "ul, ol": {
      paddingLeft: theme.spacing(2.5),
    },
    pre: {
      maxWidth: "100%",
      overflowX: "auto",
      padding: theme.spacing(1),
      backgroundColor: theme.palette.background.default,
      borderRadius: theme.shape.borderRadius,
    },
    code: {
      fontFamily: customTypography.fontMonospace,
      padding: theme.spacing(0, 0.25),
      backgroundColor: theme.palette.action.selected,
      borderRadius: theme.shape.borderRadius,
    },
    "pre code": {
      padding: 0,
      backgroundColor: "transparent",
    },
    a: {
      color: "inherit",
      textDecoration: "underline",
    },
  },
  markdownImage: {
    display: "block",
    maxWidth: "100%",
    height: "auto",
    margin: theme.spacing(0.75, 0),
  },
  imagePlaceholder: {
    maxWidth: "100%",
    overflowWrap: "anywhere",
    textAlign: "left",
    textTransform: "none",
  },
  toolCard: {
    marginTop: theme.spacing(1),
    padding: theme.spacing(1),
    color: theme.palette.text.primary,
    backgroundColor: theme.palette.background.paper,
  },
  toolName: {
    minWidth: 0,
    overflow: "hidden",
    fontFamily: customTypography.fontMonospace,
    fontWeight: 500,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  toolSummary: {
    marginTop: theme.spacing(0.75),
  },
  toolError: {
    marginTop: theme.spacing(0.75),
  },
  progress: {
    marginTop: theme.spacing(1),
  },
  cardActions: {
    marginTop: theme.spacing(1),
  },
  proposalCard: {
    alignSelf: "stretch",
    padding: theme.spacing(1.25),
    borderColor: theme.palette.primary.main,
    backgroundColor: theme.palette.background.paper,
  },
  proposalName: {
    margin: theme.spacing(0.25, 0, 0.75),
  },
  proposalPending: {
    marginTop: theme.spacing(0.75),
  },
  error: {
    flex: "none",
    borderRadius: 0,
  },
  liveRegion: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  composer: {
    flex: "none",
    padding: theme.spacing(1),
    borderTop: `1px solid ${theme.palette.divider}`,
    backgroundColor: theme.palette.background.paper,
  },
}));
