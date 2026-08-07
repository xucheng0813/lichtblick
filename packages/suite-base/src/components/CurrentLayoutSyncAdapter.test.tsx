/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { render } from "@testing-library/react";
import { enqueueSnackbar } from "notistack";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { LayoutPermission } from "@lichtblick/suite-base/services/ILayoutStorage";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";

import {
  CLOUD_AUTO_SAVE_SYNC_DELAY_MS,
  CloudLayoutAutoSaveAdapter,
} from "./CurrentLayoutSyncAdapter";

const mockEnqueueSnackbar = jest.mocked(enqueueSnackbar);
jest.mock("notistack", () => ({ enqueueSnackbar: jest.fn() }));
jest.mock("@lichtblick/log", () => ({
  __esModule: true,
  default: { getLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
}));

let mockStoredLayout: unknown;

const mockLayoutManager = {
  getLayout: jest.fn(),
  off: jest.fn(),
  on: jest.fn(),
  overwriteLayout: jest.fn(),
  syncWithRemote: jest.fn(),
};
jest.mock("@lichtblick/suite-base/context/LayoutManagerContext", () => ({
  useLayoutManager: () => mockLayoutManager,
}));

let mockAutoSaveEnabled: boolean | undefined;
jest.mock("@lichtblick/suite-base/hooks", () => ({
  useAppConfigurationValue: () => [mockAutoSaveEnabled, jest.fn()],
}));

const mockGetConfiguration = jest.fn();
jest.mock("@lichtblick/suite-base/context/AppConfigurationContext", () => ({
  useAppConfiguration: () => ({ get: mockGetConfiguration }),
}));

let mockSelectedLayout: { id: string; loading?: boolean } | undefined;
jest.mock("@lichtblick/suite-base/context/CurrentLayoutContext", () => ({
  useCurrentLayoutSelector: (selector: (state: unknown) => unknown) =>
    selector({ selectedLayout: mockSelectedLayout }),
}));

type LayoutOverrides = {
  id?: string;
  permission?: LayoutPermission;
  syncStatus?: "tracked" | "remotely-deleted";
  withWorking?: boolean;
  withExternalId?: boolean;
};

function layout(overrides: LayoutOverrides = {}) {
  const { id = "layout-1", permission = "ORG_WRITE", syncStatus, withWorking = true, withExternalId = true } = overrides;
  const syncInfo =
    syncStatus == undefined ? undefined : { lastRemoteSavedAt: undefined, status: syncStatus };
  return {
    baseline: { data: {}, savedAt: "2026-01-01T00:00:00.000Z" },
    externalId: withExternalId ? "external-1" : undefined,
    id,
    name: "Layout",
    permission,
    syncInfo,
    working: withWorking
      ? { data: { changed: true }, savedAt: "2026-01-02T00:00:00.000Z" }
      : undefined,
  };
}

function emitChange(updatedLayout: unknown): void {
  const listener = mockLayoutManager.on.mock.calls.find(([name]) => name === "change")?.[1];
  expect(listener).toBeDefined();
  listener!({ type: "change", updatedLayout });
}

/** Flushes the microtask queue so chained auto-save commits have run. */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

function configureWorkspace(): void {
  mockGetConfiguration.mockImplementation((key: string) =>
    key === AppSetting.VIZ_SERVER_WORKSPACE ? "workspace-1" : undefined,
  );
  setHttpBaseUrl("http://localhost/lichtblick");
}

describe("CloudLayoutAutoSaveAdapter", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockAutoSaveEnabled = true;
    mockSelectedLayout = { id: "layout-1" };
    mockStoredLayout = layout({});
    mockLayoutManager.getLayout.mockImplementation(async () => mockStoredLayout);
    mockLayoutManager.overwriteLayout.mockResolvedValue(layout({}));
    configureWorkspace();
  });

  afterEach(() => {
    jest.useRealTimers();
    setHttpBaseUrl(undefined);
  });

  it("makes no network calls and no commits when the switch is off", async () => {
    mockAutoSaveEnabled = undefined;
    render(<CloudLayoutAutoSaveAdapter />);

    emitChange(layout());

    await flush();
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS * 2);
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("debounces rapid edits into a single commit and single sync kick after the ≥10s window", async () => {
    render(<CloudLayoutAutoSaveAdapter />);

    // Rapid successive edits within the window…
    emitChange(layout());
    emitChange(layout());
    emitChange(layout());
    await flush();

    // …produce exactly one commit (and therefore one remote write for shared layouts).
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS - 1);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockLayoutManager.overwriteLayout).toHaveBeenCalledTimes(1);
    expect(mockLayoutManager.overwriteLayout).toHaveBeenCalledWith({ id: "layout-1" });
    // The sync kick follows one more window after the commit.
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.syncWithRemote).toHaveBeenCalledTimes(1);
    expect(mockLayoutManager.syncWithRemote.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it("serializes commits: an edit during a pending commit waits for it to finish", async () => {
    let releaseFirstCommit: (() => void) | undefined;
    const firstCommit = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    mockLayoutManager.overwriteLayout
      .mockImplementationOnce(async () => await firstCommit.then(() => layout({})))
      .mockResolvedValue(layout({}));
    render(<CloudLayoutAutoSaveAdapter />);

    emitChange(layout({}));
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    // First commit is now in flight; a new edit starts a fresh debounce window.
    emitChange(layout({}));
    releaseFirstCommit!();
    await flush();
    expect(mockLayoutManager.overwriteLayout).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).toHaveBeenCalledTimes(2);
  });

  it("skips the queued commit when the layout is no longer selected (late arrival)", async () => {
    const { rerender } = render(<CloudLayoutAutoSaveAdapter />);

    emitChange(layout({}));
    await flush();
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();

    // The user switched layouts before the debounce window closed; re-render so the ref follows.
    mockSelectedLayout = { id: "layout-2" };
    rerender(<CloudLayoutAutoSaveAdapter />);
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("cancels a queued commit when the switch is turned off before the window closes", async () => {
    const { rerender } = render(<CloudLayoutAutoSaveAdapter />);

    emitChange(layout({}));
    await flush();
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();

    // The user turns the switch off while the commit is still queued; the effect re-runs and its
    // cleanup cancels the pending commit timer before it can fire.
    mockAutoSaveEnabled = false;
    rerender(<CloudLayoutAutoSaveAdapter />);
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("skips ORG_READ layouts", async () => {
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout({ permission: "ORG_READ" }));
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("skips remotely-deleted layouts", async () => {
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout({ syncStatus: "remotely-deleted" }));
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("skips while the current layout is still loading", async () => {
    mockSelectedLayout = { id: "layout-1", loading: true };
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout());
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("skips layouts without a working copy (and never reacts to its own commits)", async () => {
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout({ withWorking: false }));
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("skips purely-local personal layouts (no externalId) entirely", async () => {
    mockStoredLayout = layout({ permission: "CREATOR_WRITE", withExternalId: false });
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout({ permission: "CREATOR_WRITE", withExternalId: false }));
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("commits personal-remote layouts (externalId present) and kicks the sync", async () => {
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout({ permission: "CREATOR_WRITE" }));
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).toHaveBeenCalledWith({ id: "layout-1" });
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.syncWithRemote).toHaveBeenCalledTimes(1);
  });

  it("skips everything when no viz server is configured", async () => {
    setHttpBaseUrl(undefined);
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout());
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("surfaces commit failures and sync failures through the snackbar", async () => {
    mockLayoutManager.overwriteLayout.mockRejectedValue(new Error("offline"));
    render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout());
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS);
    expect(mockEnqueueSnackbar).toHaveBeenCalledWith(
      expect.stringContaining("could not be saved to the cloud"),
      expect.objectContaining({ variant: "error" }),
    );
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();

    mockEnqueueSnackbar.mockClear();
    mockLayoutManager.overwriteLayout.mockResolvedValue(layout({}));
    mockLayoutManager.syncWithRemote.mockRejectedValue(new Error("sync failed"));
    emitChange(layout());
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS * 3);
    expect(mockEnqueueSnackbar).toHaveBeenCalledWith(
      expect.stringContaining("Cloud auto-save failed"),
      expect.objectContaining({ variant: "error" }),
    );
  });

  it("cancels queued commits and kicks on unmount", async () => {
    const { unmount } = render(<CloudLayoutAutoSaveAdapter />);
    emitChange(layout());
    await flush();
    unmount();
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS * 2);
    expect(mockLayoutManager.overwriteLayout).not.toHaveBeenCalled();
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });

  it("aborts an in-flight sync kick when the switch is turned off", async () => {
    let releaseSync: (() => void) | undefined;
    const deferredSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    mockLayoutManager.syncWithRemote.mockImplementation(async () => {
      await deferredSync;
    });
    const { rerender } = render(<CloudLayoutAutoSaveAdapter />);

    emitChange(layout());
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS); // commit
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS); // kick starts
    expect(mockLayoutManager.syncWithRemote).toHaveBeenCalledTimes(1);
    const signal = mockLayoutManager.syncWithRemote.mock.calls[0]?.[0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    // The switch turns off while the sync is in flight; the effect cleanup aborts the controller
    // that is still registered in pendingKicksRef.
    mockAutoSaveEnabled = false;
    rerender(<CloudLayoutAutoSaveAdapter />);
    expect(signal.aborted).toBe(true);
    releaseSync!();
    await flush();
  });

  it("aborts an in-flight sync kick on unmount", async () => {
    let releaseSync: (() => void) | undefined;
    const deferredSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    mockLayoutManager.syncWithRemote.mockImplementation(async () => {
      await deferredSync;
    });
    const { unmount } = render(<CloudLayoutAutoSaveAdapter />);

    emitChange(layout());
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS); // commit
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS); // kick starts
    const signal = mockLayoutManager.syncWithRemote.mock.calls[0]?.[0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
    releaseSync!();
    await flush();
  });

  it("does not schedule a sync kick when the switch is turned off during an in-flight commit", async () => {
    let releaseCommit: (() => void) | undefined;
    const deferredCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    mockLayoutManager.overwriteLayout.mockImplementation(async () => {
      await deferredCommit;
      return layout({});
    });
    const { rerender } = render(<CloudLayoutAutoSaveAdapter />);

    emitChange(layout());
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS); // commit starts, hangs
    expect(mockLayoutManager.overwriteLayout).toHaveBeenCalledTimes(1);

    // The switch turns off while the commit is in flight; after it resolves, the post-commit
    // re-check must skip the sync kick.
    mockAutoSaveEnabled = false;
    rerender(<CloudLayoutAutoSaveAdapter />);
    releaseCommit!();
    await flush();
    await jest.advanceTimersByTimeAsync(CLOUD_AUTO_SAVE_SYNC_DELAY_MS * 2);
    expect(mockLayoutManager.syncWithRemote).not.toHaveBeenCalled();
  });
});
