// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LayoutID } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import {
  ILayoutStorage,
  ISO8601Timestamp,
  LayoutPermission,
} from "@lichtblick/suite-base/services/ILayoutStorage";
import {
  IRemoteLayoutStorage,
  RemoteLayout,
} from "@lichtblick/suite-base/services/IRemoteLayoutStorage";
import LayoutManager from "@lichtblick/suite-base/services/LayoutManager/LayoutManager";
import LayoutBuilder from "@lichtblick/suite-base/testing/builders/LayoutBuilder";
import { BasicBuilder } from "@lichtblick/test-builders";

jest.mock("@lichtblick/log", () => ({
  getLogger: jest.fn(() => ({ debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() })),
}));

describe("LayoutManager", () => {
  let mockLocalStorage: jest.Mocked<ILayoutStorage>;
  let mockRemoteStorage: jest.Mocked<IRemoteLayoutStorage>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLocalStorage = {
      list: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue(undefined),
      put: jest.fn().mockImplementation(async (_namespace: string, layout) => layout),
      delete: jest.fn().mockResolvedValue(undefined),
      importLayouts: jest.fn().mockResolvedValue(undefined),
      migrateUnnamespacedLayouts: jest.fn().mockResolvedValue(undefined),
    };

    mockRemoteStorage = {
      workspace: BasicBuilder.string(),
      getLayouts: jest.fn().mockResolvedValue([]),
      getLayout: jest.fn().mockResolvedValue(undefined),
      saveNewLayout: jest.fn(),
      updateLayout: jest.fn(),
      deleteLayout: jest.fn().mockResolvedValue(true),
    };
  });

  describe("constructor", () => {
    it("should initialize with supportsSharing=true when remote storage is provided", () => {
      // Given, When
      const manager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });

      // Then
      expect(manager.supportsSharing).toBe(true);
    });

    it("should initialize with supportsSharing=false when remote storage is not provided", () => {
      // Given, When
      const manager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // Then
      expect(manager.supportsSharing).toBe(false);
    });
  });

  describe("setOnline", () => {
    it("should set isOnline=true and emit onlinechange event", () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const mockOnlineChangeListener = jest.fn();
      layoutManager.on("onlinechange", mockOnlineChangeListener);

      // When
      layoutManager.setOnline({ online: true });

      // Then
      expect(layoutManager.isOnline).toBe(true);
      expect(mockOnlineChangeListener).toHaveBeenCalledTimes(1);
    });

    it("should set isOnline=false and emit onlinechange event", () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const mockOnlineChangeListener = jest.fn();
      layoutManager.on("onlinechange", mockOnlineChangeListener);

      // When
      layoutManager.setOnline({ online: false });

      // Then
      expect(layoutManager.isOnline).toBe(false);
      expect(mockOnlineChangeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe("setError", () => {
    it("should set error and emit errorchange event", () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const mockErrorChangeListener = jest.fn();
      const testError = new Error("Test error");
      layoutManager.on("errorchange", mockErrorChangeListener);

      // When
      layoutManager.setError(testError);

      // Then
      expect(layoutManager.error).toBe(testError);
      expect(mockErrorChangeListener).toHaveBeenCalledTimes(1);
    });

    it("should clear error and emit errorchange event", () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const mockErrorChangeListener = jest.fn();
      layoutManager.on("errorchange", mockErrorChangeListener);

      // When
      layoutManager.setError(undefined);

      // Then
      expect(layoutManager.error).toBe(undefined);
      expect(mockErrorChangeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLayouts", () => {
    it("should return layouts that are not deleted", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const activeLayout = LayoutBuilder.layout({
        syncInfo: { status: "tracked", lastRemoteSavedAt: undefined },
      });
      const deletedLayout = LayoutBuilder.layout({
        syncInfo: { status: "locally-deleted", lastRemoteSavedAt: undefined },
      });
      const listSpy = jest.spyOn(mockLocalStorage, "list");
      listSpy.mockResolvedValue([activeLayout, deletedLayout]);

      // When
      const result = await layoutManager.getLayouts();

      // Then
      expect(result).toEqual([activeLayout]);
      expect(listSpy).toHaveBeenCalledWith(expect.any(String));
    });

    it("should return empty array when no layouts exist", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      mockLocalStorage.list.mockResolvedValue([]);

      // When
      const result = await layoutManager.getLayouts();

      // Then
      expect(result).toEqual([]);
    });
  });

  describe("getLayout", () => {
    it("should return layout when it exists locally and is not deleted", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const existingLayout = LayoutBuilder.layout({
        id: layoutId,
        syncInfo: { status: "tracked", lastRemoteSavedAt: undefined },
      });

      // Include the layout in list results so it gets cached
      mockLocalStorage.list.mockResolvedValue([existingLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // When
      const result = await layoutManager.getLayout(layoutId);

      // Then
      expect(result).toEqual(existingLayout);
    });

    it("should return undefined when layout exists locally but is deleted", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const deletedLayout = LayoutBuilder.layout({
        id: layoutId,
        syncInfo: { status: "locally-deleted", lastRemoteSavedAt: undefined },
      });

      // Include the deleted layout in list results
      mockLocalStorage.list.mockResolvedValue([deletedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // When
      const result = await layoutManager.getLayout(layoutId);

      // Then
      expect(result).toBe(undefined);
    });

    it("should return undefined when layout does not exist locally and no remote storage", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      mockLocalStorage.list.mockResolvedValue([]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // When
      const result = await layoutManager.getLayout(layoutId);

      // Then
      expect(result).toBe(undefined);
    });

    it("should return undefined when layout does not exist locally and offline", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      mockLocalStorage.list.mockResolvedValue([]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: false });

      // When
      const result = await layoutManager.getLayout(layoutId);

      // Then
      expect(result).toBe(undefined);
      expect(mockRemoteStorage.getLayout).not.toHaveBeenCalled();
    });

    it("should fetch from remote and cache when layout does not exist locally but exists remotely", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const remoteLayoutData = LayoutBuilder.remoteLayout({
        id: layoutId,
        name: "Remote Layout",
      });

      mockLocalStorage.list.mockResolvedValue([]);
      mockRemoteStorage.getLayout.mockResolvedValue(remoteLayoutData);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // When
      const result = await layoutManager.getLayout(layoutId);

      // Then
      expect(result).toBeDefined();
      expect(result?.id).toBe(layoutId);
      expect(result?.name).toBe("Remote Layout");
      expect(mockRemoteStorage.getLayout).toHaveBeenCalledWith(layoutId);
      expect(jest.spyOn(mockLocalStorage, "put")).toHaveBeenCalled();
    });

    it("should return undefined when layout does not exist locally or remotely", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      mockLocalStorage.list.mockResolvedValue([]);
      mockRemoteStorage.getLayout.mockResolvedValue(undefined);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // When
      const result = await layoutManager.getLayout(layoutId);

      // Then
      expect(result).toBe(undefined);
      expect(mockRemoteStorage.getLayout).toHaveBeenCalledWith(layoutId);
      expect(jest.spyOn(mockLocalStorage, "put")).not.toHaveBeenCalled();
    });
  });

  describe("saveNewLayout", () => {
    it("should throw error when trying to save shared layout without remote storage", async () => {
      // Given
      const manager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const layoutName = BasicBuilder.string();
      const layoutData = LayoutBuilder.data();
      const permission: LayoutPermission = "ORG_WRITE";

      // When & Then
      await expect(
        manager.saveNewLayout({
          name: layoutName,
          data: layoutData,
          permission,
        }),
      ).rejects.toThrow("Shared layouts are not supported without remote layout storage");
    });

    it("should save new personal layout locally", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const layoutName = BasicBuilder.string();
      const layoutData = LayoutBuilder.data();
      const permission: LayoutPermission = "CREATOR_WRITE";
      const savedLayout = LayoutBuilder.layout({
        name: layoutName,
        permission,
      });

      const putSpy = jest.spyOn(mockLocalStorage, "put");
      putSpy.mockResolvedValue(savedLayout);
      putSpy.mockResolvedValue(savedLayout);

      // When
      const result = await layoutManager.saveNewLayout({
        name: layoutName,
        data: layoutData,
        permission,
      });

      // Then
      expect(result).toBe(savedLayout);
      expect(putSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          name: layoutName,
          permission,
          baseline: expect.objectContaining({ data: layoutData }),
          working: undefined,
        }),
      );
      expect(mockRemoteStorage.saveNewLayout).not.toHaveBeenCalled();
    });

    it("should save new personal layout locally and remotelly", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      const layoutName = BasicBuilder.string();
      const layoutData = LayoutBuilder.data();
      const permission: LayoutPermission = "ORG_WRITE";
      const savedRemoteLayout = LayoutBuilder.remoteLayout({
        name: layoutName,
        permission,
      });
      const savedLocalLayout = LayoutBuilder.layout({
        id: savedRemoteLayout.id,
        name: layoutName,
        permission,
      });

      mockRemoteStorage.saveNewLayout.mockResolvedValue(savedRemoteLayout);
      const putSpy = jest.spyOn(mockLocalStorage, "put");
      putSpy.mockResolvedValue(savedLocalLayout);
      layoutManager.setOnline({ online: true });

      // When
      const result = await layoutManager.saveNewLayout({
        name: layoutName,
        data: layoutData,
        permission,
      });

      // Then
      expect(result).toBe(savedLocalLayout);
      expect(mockRemoteStorage.saveNewLayout).toHaveBeenCalled();
      expect(mockRemoteStorage.saveNewLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          name: layoutName,
          data: expect.any(Object),
          permission,
        }),
      );
      expect(putSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          id: savedRemoteLayout.id,
          name: savedRemoteLayout.name,
          permission: savedRemoteLayout.permission,
          baseline: expect.objectContaining({
            data: savedRemoteLayout.data,
            savedAt: savedRemoteLayout.savedAt,
          }),
          working: undefined,
          syncInfo: { status: "tracked", lastRemoteSavedAt: savedRemoteLayout.savedAt },
        }),
      );
    });

    it("should throw error when trying to share layout while offline", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      const layoutName = BasicBuilder.string();
      const layoutData = LayoutBuilder.data();
      const permission: LayoutPermission = "ORG_WRITE";
      layoutManager.setOnline({ online: false });

      // When & Then
      await expect(
        layoutManager.saveNewLayout({
          name: layoutName,
          data: layoutData,
          permission,
        }),
      ).rejects.toThrow("Cannot share a layout while offline");
    });
  });

  describe("updateLayout", () => {
    it("should throw error when layout does not exist", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const layoutId = LayoutBuilder.layoutId();
      mockLocalStorage.get.mockResolvedValue(undefined);

      const randomLayoutName = BasicBuilder.string();

      // When & Then
      await expect(
        layoutManager.updateLayout({
          id: layoutId,
          name: randomLayoutName,
          data: undefined,
        }),
      ).rejects.toThrow(
        `Cannot update layout ${layoutId} (${randomLayoutName}) because it does not exist`,
      );
    });

    it("should throw error when trying to update shared layout while offline", async () => {
      // Given
      const newName = BasicBuilder.string();
      const sharedLayout = LayoutBuilder.layout({
        permission: "ORG_WRITE",
      });

      // Need to include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: false });

      // When & Then
      await expect(
        layoutManager.updateLayout({
          id: sharedLayout.id,
          name: newName,
          data: undefined,
        }),
      ).rejects.toThrow("Cannot update a shared layout while offline");
    });

    it("should update shared layout while online", async () => {
      // Given
      const newName = BasicBuilder.string();
      const sharedLayout = LayoutBuilder.layout({
        permission: "ORG_WRITE",
      });
      const remoteLayout = LayoutBuilder.remoteLayout({
        id: sharedLayout.id,
        name: newName,
        permission: sharedLayout.permission,
      });

      mockLocalStorage.list.mockResolvedValue([sharedLayout]);
      mockRemoteStorage.updateLayout.mockResolvedValue({
        status: "success",
        newLayout: remoteLayout,
      });

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // When
      await layoutManager.updateLayout({
        id: sharedLayout.id,
        name: newName,
        data: undefined,
      });

      // Then
      expect(mockRemoteStorage.updateLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          id: sharedLayout.id,
          name: newName,
        }),
      );
    });

    it("should update when is only local layout", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const newName = BasicBuilder.string();
      const localLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "CREATOR_WRITE",
      });

      mockLocalStorage.list.mockResolvedValue([localLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      layoutManager.setOnline({ online: true });

      // When
      await layoutManager.updateLayout({
        id: layoutId,
        name: newName,
        data: undefined,
      });

      // Then
      expect(jest.spyOn(mockLocalStorage, "put")).toHaveBeenCalledWith(
        "local",
        expect.objectContaining({
          id: layoutId,
          name: newName,
        }),
      );
    });

    it("should throw if layout does not contain externalId", async () => {
      // Given
      const newName = BasicBuilder.string();
      const sharedLayout = LayoutBuilder.layout({
        permission: "ORG_WRITE",
      });

      sharedLayout.externalId = undefined;

      // Need to include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // When & Then
      await expect(
        layoutManager.updateLayout({
          id: sharedLayout.id,
          name: newName,
          data: undefined,
        }),
      ).rejects.toThrow("Local layout does not have externalId");
    });
  });

  describe("deleteLayout", () => {
    it("should throw error when layout does not exist", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const layoutId = LayoutBuilder.layoutId();
      mockLocalStorage.get.mockResolvedValue(undefined);

      // When & Then
      await expect(layoutManager.deleteLayout({ id: layoutId })).rejects.toThrow(
        `Cannot delete layout ${layoutId} because it does not exist`,
      );
    });

    it("should throw error when trying to delete and is not remote", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const sharedLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "ORG_WRITE",
        syncInfo: {
          status: "tracked",
          lastRemoteSavedAt: "2023-01-01T00:00:00Z" as ISO8601Timestamp,
        },
      });

      // Need to include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      layoutManager.setOnline({ online: false });

      // When & Then
      await expect(layoutManager.deleteLayout({ id: layoutId })).rejects.toThrow(
        "Shared layouts are not supported without remote layout storage",
      );
    });

    it("should throw error when trying to delete shared layout while offline", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const sharedLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "ORG_WRITE",
        syncInfo: {
          status: "tracked",
          lastRemoteSavedAt: "2023-01-01T00:00:00Z" as ISO8601Timestamp,
        },
      });

      // Need to include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: false });

      // When & Then
      await expect(layoutManager.deleteLayout({ id: layoutId })).rejects.toThrow(
        "Cannot delete a shared layout while offline",
      );
    });

    it("should throw if layout does not contain externalId", async () => {
      // Given
      const sharedLayout = LayoutBuilder.layout({
        permission: "ORG_WRITE",
      });

      sharedLayout.externalId = undefined;

      // Need to include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // When & Then
      await expect(layoutManager.deleteLayout({ id: sharedLayout.id })).rejects.toThrow(
        "Local layout does not have externalId",
      );
    });

    it("should delete layout when online", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const sharedLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "CREATOR_WRITE",
        syncInfo: {
          status: "tracked",
          lastRemoteSavedAt: "2023-01-01T00:00:00Z" as ISO8601Timestamp,
        },
      });

      // Need to include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // When
      await layoutManager.deleteLayout({ id: layoutId });

      // Then
      expect(jest.spyOn(mockLocalStorage, "put")).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          id: layoutId,
        }),
      );
    });
  });

  describe("overwriteLayout", () => {
    it("should throw error when layout does not exist", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const layoutId = LayoutBuilder.layoutId();
      mockLocalStorage.get.mockResolvedValue(undefined);

      // When & Then
      await expect(layoutManager.overwriteLayout({ id: layoutId })).rejects.toThrow(
        `Cannot overwrite layout ${layoutId} because it does not exist`,
      );
    });

    it("should throw error when trying to overwrite shared layout while offline", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const sharedLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "ORG_WRITE",
      });

      // Need to include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: false });

      // When & Then
      await expect(layoutManager.overwriteLayout({ id: layoutId })).rejects.toThrow(
        "Cannot save a shared layout while offline",
      );
    });

    it("should overwrite shared layout when online", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const sharedLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "ORG_WRITE",
        working: {
          data: LayoutBuilder.data(),
          savedAt: "2023-01-01T00:00:00Z" as ISO8601Timestamp,
        },
      });
      const remoteLayout = LayoutBuilder.remoteLayout({
        id: layoutId,
        permission: "ORG_WRITE",
        data: sharedLayout.working!.data,
      });

      // Include the shared layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([sharedLayout]);
      mockRemoteStorage.updateLayout.mockResolvedValue({
        status: "success",
        newLayout: remoteLayout,
      });

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // When
      const result = await layoutManager.overwriteLayout({ id: layoutId });

      // Then
      expect(mockRemoteStorage.updateLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          id: layoutId,
          data: sharedLayout.working!.data,
        }),
      );
      expect(result.working).toBe(undefined);
      expect(result.baseline.data).toEqual(remoteLayout.data);
      expect(result.syncInfo?.status).toBe("tracked");
    });

    it("should overwrite non-shared layout locally", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const localLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "CREATOR_WRITE",
        working: {
          data: LayoutBuilder.data(),
          savedAt: "2023-01-01T00:00:00Z" as ISO8601Timestamp,
        },
      });

      // Include the layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([localLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // When
      const result = await layoutManager.overwriteLayout({ id: layoutId });

      // Then
      expect(jest.spyOn(mockLocalStorage, "put")).toHaveBeenCalledWith(
        "local",
        expect.objectContaining({
          id: layoutId,
          baseline: expect.objectContaining({
            data: localLayout.working!.data,
          }),
          working: undefined,
        }),
      );
      expect(result.working).toBe(undefined);
      expect(result.baseline.data).toEqual(localLayout.working!.data);
      expect(mockRemoteStorage.updateLayout).not.toHaveBeenCalled();
    });

    it("should overwrite a purely-local personal layout without remote calls", async () => {
      // Given: a personal layout with no externalId — it does not exist on the remote, so the
      // explicit save stays local (no upload, no syncInfo).
      const layoutId = LayoutBuilder.layoutId();
      const localLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "CREATOR_WRITE",
        syncInfo: undefined,
        working: {
          data: LayoutBuilder.data(),
          savedAt: "2023-01-01T00:00:00Z" as ISO8601Timestamp,
        },
      });
      // LayoutBuilder fills defaults for missing fields; a purely-local personal layout has no
      // externalId (it has never been uploaded).
      delete (localLayout as Partial<typeof localLayout>).externalId;

      // Include the layout in the list results for the cache
      mockLocalStorage.list.mockResolvedValue([localLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });

      // When
      const result = await layoutManager.overwriteLayout({ id: layoutId });

      // Then
      expect(jest.spyOn(mockLocalStorage, "put")).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          id: layoutId,
          baseline: expect.objectContaining({
            data: localLayout.working!.data,
          }),
          working: undefined,
          syncInfo: undefined,
        }),
      );
      expect(result.working).toBe(undefined);
      expect(result.syncInfo?.status).toBe(undefined);
      expect(mockRemoteStorage.updateLayout).not.toHaveBeenCalled();
    });
  });

  describe("revertLayout", () => {
    it("should throw error when layout does not exist", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const layoutId = LayoutBuilder.layoutId();
      mockLocalStorage.get.mockResolvedValue(undefined);

      // When & Then
      await expect(layoutManager.revertLayout({ id: layoutId })).rejects.toThrow(
        `Cannot revert layout id ${layoutId} because it does not exist`,
      );
    });

    it("should revert layout", async () => {
      // Given
      const layoutId = LayoutBuilder.layoutId();
      const existingLayout = LayoutBuilder.layout({
        id: layoutId,
        working: {
          data: LayoutBuilder.data(),
          savedAt: "2023-01-01T00:00:00Z" as ISO8601Timestamp,
        },
      });

      // Include the layout in list results so it gets cached
      mockLocalStorage.list.mockResolvedValue([existingLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // When
      const result = await layoutManager.revertLayout({ id: layoutId });

      // Then
      expect(result.id).toBe(layoutId);
      expect(result.working).toBe(undefined);
      expect(result.baseline).toEqual(existingLayout.baseline);
      expect(jest.spyOn(mockLocalStorage, "put")).toHaveBeenCalledWith(
        "local",
        expect.objectContaining({
          id: layoutId,
          working: undefined,
        }),
      );
    });
  });

  describe("makePersonalCopy", () => {
    it("should throw error when original layout does not exist", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const originalLayoutId = "non-existent" as LayoutID;
      const copyName = BasicBuilder.string();
      mockLocalStorage.get.mockResolvedValue(undefined);

      // When & Then
      await expect(
        layoutManager.makePersonalCopy({
          id: originalLayoutId,
          name: copyName,
        }),
      ).rejects.toThrow(
        `Cannot make a personal copy of layout id ${originalLayoutId} because it does not exist`,
      );
    });

    it("should make a personal copy", async () => {
      // Given
      const originalLayout = LayoutBuilder.layout({
        name: BasicBuilder.string(),
        permission: "ORG_WRITE",
      });
      originalLayout.working = undefined;
      const copyName = BasicBuilder.string();

      mockLocalStorage.list.mockResolvedValue([originalLayout]);
      mockLocalStorage.put.mockImplementation(async (_namespace: string, layout) => layout);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // When
      const result = await layoutManager.makePersonalCopy({
        id: originalLayout.id,
        name: copyName,
      });

      // Then
      expect(result.id).not.toBe(originalLayout.id);
      expect(result.name).toBe(copyName);
      expect(result.permission).toBe("CREATOR_WRITE");
      expect(result.baseline.data).toEqual(originalLayout.baseline.data);
      expect(result.working).toBe(undefined);
      expect(result.syncInfo?.status).toBe("new");
      expect(result.syncInfo?.lastRemoteSavedAt).toBeDefined();
      expect(jest.spyOn(mockLocalStorage, "put")).toHaveBeenCalledTimes(2);
    });
  });

  describe("syncWithRemote", () => {
    it("should do nothing when no remote storage is configured", async () => {
      // Given
      const manager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const abortController = new AbortController();

      // When
      await manager.syncWithRemote(abortController.signal);

      // Then
      expect(jest.spyOn(mockLocalStorage, "list")).not.toHaveBeenCalled();
    });

    it("should do nothing when there is an ongoing sync", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      (layoutManager as any).currentSync = {}; // Simulate ongoing sync
      const abortController = new AbortController();

      // When
      await layoutManager.syncWithRemote(abortController.signal);

      // Then
      expect(jest.spyOn(mockLocalStorage, "list")).not.toHaveBeenCalled();
      expect(mockRemoteStorage.getLayouts).not.toHaveBeenCalled();
    });

    it("should set error on failed sync", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      const syncError = new Error("Sync failed");
      const abortController = new AbortController();

      mockLocalStorage.list.mockRejectedValue(syncError);
      layoutManager.setOnline({ online: true });

      // When & Then
      await expect(layoutManager.syncWithRemote(abortController.signal)).rejects.toThrow(
        "Sync failed",
      );
      expect(layoutManager.error).toBe(syncError);
    });

    it("should clear error on successful sync", async () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      const testError = new Error("Previous error");
      const abortController = new AbortController();

      jest.spyOn(mockLocalStorage, "list").mockResolvedValue([]);
      jest.spyOn(mockRemoteStorage, "getLayouts").mockResolvedValue([]);
      layoutManager.setOnline({ online: true });
      layoutManager.setError(testError);

      // When
      await layoutManager.syncWithRemote(abortController.signal);

      // Then
      expect(layoutManager.error).toBe(undefined);
    });

    it("uploads a committed shared edit and clears working (working→baseline→remote→清 working)", async () => {
      // Given: a shared layout whose edit has landed in working (debounced updateLayout) and was
      // then committed with the explicit-save semantics (overwriteLayout) — the auto-save chain.
      const layoutId = LayoutBuilder.layoutId();
      const editedData = LayoutBuilder.data();
      const sharedLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "ORG_WRITE",
        working: {
          data: editedData,
          savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp,
        },
      });
      const remoteLayout = LayoutBuilder.remoteLayout({
        id: layoutId,
        permission: "ORG_WRITE",
        data: editedData,
        savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp,
      });

      mockLocalStorage.list.mockResolvedValue([sharedLayout]);
      mockLocalStorage.get.mockResolvedValue(sharedLayout);
      mockRemoteStorage.getLayouts.mockResolvedValue([remoteLayout]);
      mockRemoteStorage.updateLayout.mockResolvedValue({
        status: "success",
        newLayout: remoteLayout,
      });

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      // The explicit-save step uploads immediately and clears working for shared layouts.
      const committed = await layoutManager.overwriteLayout({ id: layoutId });
      expect(committed.working).toBe(undefined);
      expect(committed.baseline.data).toEqual(editedData);
      expect(committed.syncInfo?.status).toBe("tracked");
      expect(mockRemoteStorage.updateLayout).toHaveBeenCalledWith(
        expect.objectContaining({ id: layoutId, data: editedData }),
      );

      // The kicked sync then has nothing left to upload: tracked and up to date.
      const syncSpy = jest.spyOn(mockRemoteStorage, "saveNewLayout");
      await layoutManager.syncWithRemote(new AbortController().signal);
      expect(syncSpy).not.toHaveBeenCalled();
      expect(mockRemoteStorage.updateLayout).toHaveBeenCalledTimes(1);
    });

    it("uploads a committed personal-remote edit directly and keeps the no-syncInfo invariant", async () => {
      // Given: a personal layout that already exists remotely (personal-remote, has externalId).
      // Its edit landed in working and is committed with overwriteLayout, which uploads directly
      // (explicit-save semantics) while keeping the personal “no syncInfo” invariant.
      const layoutId = LayoutBuilder.layoutId();
      const editedData = LayoutBuilder.data();
      const personalLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "CREATOR_WRITE",
        externalId: "external-personal",
        syncInfo: undefined,
        working: {
          data: editedData,
          savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp,
        },
      });
      const remoteLayout = LayoutBuilder.remoteLayout({
        id: layoutId,
        permission: "CREATOR_WRITE",
        data: editedData,
        savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp,
      });

      // A stateful in-memory store so post-sync assertions re-read what is actually stored.
      let stored: ReturnType<typeof LayoutBuilder.layout> = personalLayout;
      mockLocalStorage.get.mockImplementation(async (_namespace, key) =>
        stored.id === key ? stored : undefined,
      );
      mockLocalStorage.put.mockImplementation(async (_namespace, layout) => {
        stored = layout;
        return stored;
      });
      mockLocalStorage.list.mockImplementation(async () => [stored]);
      mockRemoteStorage.updateLayout.mockResolvedValue({
        status: "success",
        newLayout: remoteLayout,
      });
      mockRemoteStorage.getLayouts.mockResolvedValue([remoteLayout]);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      const committed = await layoutManager.overwriteLayout({ id: layoutId });
      expect(mockRemoteStorage.updateLayout).toHaveBeenCalledWith(
        expect.objectContaining({ id: layoutId, data: editedData }),
      );
      expect(committed.working).toBe(undefined);
      expect(committed.syncInfo).toBeUndefined(); // personal invariant: never syncInfo
      expect(committed.baseline.data).toEqual(editedData);

      // A subsequent sync must NOT re-upload the personal-remote layout (no upload-new, no
      // update) and must leave the stored layout without syncInfo.
      await layoutManager.syncWithRemote(new AbortController().signal);

      expect(mockRemoteStorage.saveNewLayout).not.toHaveBeenCalled();
      expect(mockRemoteStorage.updateLayout).toHaveBeenCalledTimes(1);
      // Re-read from storage: the personal invariant holds after the sync, working is cleared,
      // and the committed data is the baseline.
      const afterSync = await layoutManager.getLayout(layoutId);
      expect(afterSync).toBeDefined();
      expect(afterSync?.syncInfo).toBeUndefined();
      expect(afterSync?.working).toBeUndefined();
      expect(afterSync?.baseline.data).toEqual(editedData);
    });

    it("rejects saving a personal-remote layout while offline", async () => {
      const layoutId = LayoutBuilder.layoutId();
      const personalLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "CREATOR_WRITE",
        externalId: "external-personal",
        working: {
          data: LayoutBuilder.data(),
          savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp,
        },
      });
      mockLocalStorage.list.mockResolvedValue([personalLayout]);
      mockLocalStorage.get.mockResolvedValue(personalLayout);

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: false });

      await expect(layoutManager.overwriteLayout({ id: layoutId })).rejects.toThrow(
        "Cannot save a personal remote layout while offline",
      );
    });

    it("preserves edits made while the shared overwrite upload was in flight (no lost edits)", async () => {
      // Given: a shared layout whose commit upload is slow. While the remote request is pending,
      // the user keeps editing; the new working copy must survive the stale pre-request snapshot.
      const layoutId = LayoutBuilder.layoutId();
      const firstEdit = LayoutBuilder.data();
      const secondEdit = LayoutBuilder.data();
      const initialLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "ORG_WRITE",
        externalId: "external-shared",
        baseline: { data: LayoutBuilder.data(), savedAt: "2023-01-01T00:00:00.000Z" as ISO8601Timestamp },
        working: { data: firstEdit, savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp },
        syncInfo: { status: "tracked", lastRemoteSavedAt: "2023-01-01T00:00:00.000Z" as ISO8601Timestamp },
      });

      // A tiny in-memory layout store so the two operations observe each other's writes.
      let stored: { layout: ReturnType<typeof LayoutBuilder.layout> } | undefined = {
        layout: initialLayout,
      };
      mockLocalStorage.get.mockImplementation(async (_namespace, key) => {
        return stored?.layout.id === key ? stored.layout : undefined;
      });
      mockLocalStorage.put.mockImplementation(async (_namespace, layout) => {
        stored = { layout };
        return layout;
      });
      mockLocalStorage.list.mockImplementation(async () => (stored ? [stored.layout] : []));

      let resolveRemoteUpload:
        | ((value: { status: "success"; newLayout: RemoteLayout }) => void)
        | undefined;
      const deferredRemote = new Promise<{ status: "success"; newLayout: RemoteLayout }>(
        (resolve) => {
          resolveRemoteUpload = resolve;
        },
      );
      mockRemoteStorage.updateLayout.mockImplementation(async () => {
        return await deferredRemote;
      });

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      const overwritePromise = layoutManager.overwriteLayout({ id: layoutId });
      // While the upload is in flight, a new edit lands in working.
      await layoutManager.updateLayout({
        id: layoutId,
        name: undefined,
        data: secondEdit,
      });
      resolveRemoteUpload!({
        status: "success",
        newLayout: LayoutBuilder.remoteLayout({
          id: layoutId,
          permission: "ORG_WRITE",
          data: firstEdit,
          savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp,
        }),
      });

      const result = await overwritePromise;
      // The edit made during the upload survives; the baseline holds the uploaded data.
      expect(result.working?.data).toEqual(secondEdit);
      expect(result.baseline.data).toEqual(firstEdit);
      expect(result.syncInfo?.status).toBe("tracked");
    });

    it("upload-updated uploads the committed baseline data, never the stale working copy", async () => {
      // Given: a shared layout in the “updated” state (e.g. after a rename) whose baseline holds
      // the committed edits. The upload must carry baseline.data — the data the user committed —
      // and not the pre-commit baseline.
      const layoutId = LayoutBuilder.layoutId();
      const committedData = LayoutBuilder.data();
      const sharedLayout = LayoutBuilder.layout({
        id: layoutId,
        permission: "ORG_WRITE",
        baseline: { data: committedData, savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp },
        working: { data: LayoutBuilder.data(), savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp },
        syncInfo: { status: "updated", lastRemoteSavedAt: "2023-01-01T00:00:00.000Z" as ISO8601Timestamp },
      });
      const remoteLayout = LayoutBuilder.remoteLayout({
        id: layoutId,
        permission: "ORG_WRITE",
        data: committedData,
        savedAt: "2023-01-02T00:00:00.000Z" as ISO8601Timestamp,
      });

      mockLocalStorage.list.mockResolvedValue([sharedLayout]);
      mockRemoteStorage.getLayouts.mockResolvedValue([remoteLayout]);
      mockRemoteStorage.updateLayout.mockResolvedValue({
        status: "success",
        newLayout: remoteLayout,
      });

      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: mockRemoteStorage,
      });
      layoutManager.setOnline({ online: true });

      await layoutManager.syncWithRemote(new AbortController().signal);

      expect(mockRemoteStorage.updateLayout).toHaveBeenCalledWith(
        expect.objectContaining({ id: layoutId, data: committedData }),
      );
    });
  });

  describe("isBusy", () => {
    it("should return false when no operations are running", () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });

      // When, Then
      expect(layoutManager.isBusy()).toBe(false);
    });
  });

  describe("event handling", () => {
    it("should support adding and removing event listeners", () => {
      // Given
      const layoutManager = new LayoutManager({
        local: mockLocalStorage,
        remote: undefined,
      });
      const mockListener = jest.fn();

      // When
      layoutManager.on("onlinechange", mockListener);
      layoutManager.setOnline({ online: true });
      layoutManager.off("onlinechange", mockListener);
      layoutManager.setOnline({ online: false });

      // Then
      expect(mockListener).toHaveBeenCalledTimes(1);
    });
  });
});
