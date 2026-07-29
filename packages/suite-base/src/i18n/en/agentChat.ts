// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

export const agentChat = {
  newConversation: "New conversation",
  conversationList: {
    history: "Conversation history",
    newConversation: "New conversation",
    loading: "Loading conversations…",
    empty: "No conversation history",
    offline: "Conversation history is offline. Local chat remains available.",
    untitled: "Untitled conversation",
    delete: "Delete {{title}}",
    metadata: "{{time}} · {{count}} messages",
  },
  title: "Agent Chat",
  assistant: "Assistant",
  you: "You",
  emptyTitle: "How can I help?",
  emptyDescription:
    "Ask about the current data, find a recording, or create a visualization.",
  inputPlaceholder: "Ask the agent…",
  inputLabel: "Message to Agent Chat",
  send: "Send",
  reset: "Reset",
  confirm: "Confirm",
  cancel: "Cancel",
  apply: "Apply",
  ignore: "Ignore",
  layoutProposal: "Layout proposal",
  toolProgress: "Progress for {{name}}",
  catalogLoadTimeout:
    "The data catalog did not become ready within 120 seconds. Check whether the data source loaded successfully.",
  status: {
    idle: "Ready",
    connecting: "Connecting",
    streaming: "Responding",
    waitingForCatalog: "Waiting for data",
    error: "Error",
  },
  toolStatus: {
    queued: "Queued",
    running: "Running",
    awaitingConfirmation: "Needs confirmation",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
  },
};
