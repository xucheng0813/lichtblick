// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  CLOUD_DEFAULT_LAYOUT_POLLING_INTERVAL_MS,
  CLOUD_DEFAULT_LAYOUT_TIMEOUT_MS,
  selectCloudDefaultLayout,
} from "@lichtblick/suite-base/providers/CurrentLayoutProvider/selectCloudDefaultLayout";
import { IRemoteLayoutStorage } from "@lichtblick/suite-base/services/IRemoteLayoutStorage";
import LayoutBuilder from "@lichtblick/suite-base/testing/builders/LayoutBuilder";

type MockRemoteLayoutStorage = jest.Mocked<IRemoteLayoutStorage> & {
  getDefaultLayout: jest.MockedFunction<NonNullable<IRemoteLayoutStorage["getDefaultLayout"]>>;
};

function makeRemoteLayoutStorage(): MockRemoteLayoutStorage {
  return {
    workspace: "test-workspace",
    getLayouts: jest.fn(),
    getDefaultLayout: jest.fn(),
    getLayout: jest.fn(),
    saveNewLayout: jest.fn(),
    updateLayout: jest.fn(),
    deleteLayout: jest.fn(),
  };
}

describe("selectCloudDefaultLayout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("waits for the synced layout id and selects it without saving another layout", async () => {
    const remoteLayoutStorage = makeRemoteLayoutStorage();
    const remoteDefault = LayoutBuilder.remoteLayout();
    const cachedDefault = LayoutBuilder.layout({ id: remoteDefault.id });
    remoteLayoutStorage.getDefaultLayout.mockResolvedValue(remoteDefault);
    const getLayouts = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([cachedDefault]);
    const selectLayout = jest.fn().mockResolvedValue(undefined);

    const selection = selectCloudDefaultLayout({
      layoutManager: { getLayouts },
      remoteLayoutStorage,
      selectLayout,
    });
    await jest.advanceTimersByTimeAsync(CLOUD_DEFAULT_LAYOUT_POLLING_INTERVAL_MS);

    await expect(selection).resolves.toBe(true);
    expect(selectLayout).toHaveBeenCalledWith(remoteDefault.id);
    expect(remoteLayoutStorage.saveNewLayout).not.toHaveBeenCalled();
  });

  it.each([
    [
      "has no default",
      async (storage: MockRemoteLayoutStorage) => {
        storage.getDefaultLayout.mockResolvedValue(undefined);
      },
    ],
    [
      "fails to fetch the default",
      async (storage: MockRemoteLayoutStorage) => {
        storage.getDefaultLayout.mockRejectedValue(new Error("Network error"));
      },
    ],
  ])("does not select a layout when the server %s", async (_name, arrange) => {
    const remoteLayoutStorage = makeRemoteLayoutStorage();
    await arrange(remoteLayoutStorage);
    const getLayouts = jest.fn();
    const selectLayout = jest.fn();

    await expect(
      selectCloudDefaultLayout({
        layoutManager: { getLayouts },
        remoteLayoutStorage,
        selectLayout,
      }),
    ).resolves.toBe(false);

    expect(getLayouts).not.toHaveBeenCalled();
    expect(selectLayout).not.toHaveBeenCalled();
  });

  it("stops waiting after ten seconds without creating or selecting a layout", async () => {
    const remoteLayoutStorage = makeRemoteLayoutStorage();
    remoteLayoutStorage.getDefaultLayout.mockResolvedValue(LayoutBuilder.remoteLayout());
    const getLayouts = jest.fn().mockResolvedValue([]);
    const selectLayout = jest.fn();

    const selection = selectCloudDefaultLayout({
      layoutManager: { getLayouts },
      remoteLayoutStorage,
      selectLayout,
    });
    await jest.advanceTimersByTimeAsync(CLOUD_DEFAULT_LAYOUT_TIMEOUT_MS);

    await expect(selection).resolves.toBe(false);
    expect(selectLayout).not.toHaveBeenCalled();
    expect(remoteLayoutStorage.saveNewLayout).not.toHaveBeenCalled();
  });
});
