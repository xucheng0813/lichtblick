// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import {
  Button,
  CircularProgress,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { DataGrid, GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import { useSnackbar } from "notistack";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Logger from "@lichtblick/log";
import { InstallButton } from "@lichtblick/suite-base/components/ExtensionsSettings/components/ExtensionActionButton/InstallButton";
import { UninstallButton } from "@lichtblick/suite-base/components/ExtensionsSettings/components/ExtensionActionButton/UninstallButton";
import {
  ExtensionListProps,
  paginationModel,
} from "@lichtblick/suite-base/components/ExtensionsSettings/components/ExtensionList/types";
import {
  displayNameForNamespace,
  generatePlaceholderList,
} from "@lichtblick/suite-base/components/ExtensionsSettings/components/ExtensionList/utils";
import { useExtensionOperations } from "@lichtblick/suite-base/components/ExtensionsSettings/hooks/useExtensionOperations";
import {
  ExtensionActionsLabel,
  ExtensionOperationStatusLabel,
} from "@lichtblick/suite-base/components/ExtensionsSettings/types";
import Stack from "@lichtblick/suite-base/components/Stack";
import { AllowedFileExtensions } from "@lichtblick/suite-base/constants/allowedFileExtensions";
import { useAnalytics } from "@lichtblick/suite-base/context/AnalyticsContext";
import { useExtensionCatalog } from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { ExtensionMarketplaceDetail } from "@lichtblick/suite-base/context/ExtensionMarketplaceContext";
import { useInstallingExtensionsState } from "@lichtblick/suite-base/hooks/useInstallingExtensionsState";
import { AppEvent } from "@lichtblick/suite-base/services/IAnalytics";
import { canInstallExtension } from "@lichtblick/suite-base/util/canInstallExtension";
import isDesktopApp from "@lichtblick/suite-base/util/isDesktopApp";

const log = Logger.getLogger(__filename);

export default function ExtensionList({
  namespace,
  entries,
  filterText,
  selectExtension,
  allowUploadToOrganization = false,
}: Readonly<ExtensionListProps>): React.JSX.Element {
  const { t } = useTranslation("extensionsSettings");
  const installedExtensions = useExtensionCatalog(
    (state) => state.installedExtensions,
  );
  const getExtensionPackage = useExtensionCatalog(
    (state) => state.getExtensionPackage,
  );
  const refreshAllExtensions = useExtensionCatalog(
    (state) => state.refreshAllExtensions,
  );
  const uninstallExtension = useExtensionCatalog(
    (state) => state.uninstallExtension,
  );
  const { enqueueSnackbar } = useSnackbar();
  const analytics = useAnalytics();
  const [selectedExtensionIds, setSelectedExtensionIds] = useState<string[]>(
    [],
  );
  const [isBulkOperating, setIsBulkOperating] = useState(false);
  const [uploadingExtensionId, setUploadingExtensionId] = useState<
    string | undefined
  >();
  const [fallbackExtension, setFallbackExtension] = useState<
    ExtensionMarketplaceDetail | undefined
  >();
  const uploadInputRef = useRef<HTMLInputElement>(ReactNull);

  const { handleInstall, handleUninstall, operationStatus, isOperating } =
    useExtensionOperations();
  const { installFoxeExtensions } = useInstallingExtensionsState({
    isPlaying: false,
    playerEvents: { play: undefined },
  });
  const isExtensionInstalled = useCallback(
    (id: string) =>
      installedExtensions?.some(
        (installed) => installed.id === id && installed.namespace === namespace,
      ) ?? false,
    [installedExtensions, namespace],
  );

  const uploadPackage = useCallback(
    async (
      extension: ExtensionMarketplaceDetail,
      buffer: Uint8Array,
      file: File,
    ) => {
      setUploadingExtensionId(extension.id);
      try {
        const results = await installFoxeExtensions([
          { buffer, file, namespace: "org" },
        ]);
        const uploadedToServer = results.some((result) =>
          Boolean(
            result.loaderResults?.some(
              (loaderResult) =>
                loaderResult.loaderType === "server" && loaderResult.success,
            ),
          ),
        );
        if (uploadedToServer) {
          try {
            await refreshAllExtensions();
          } catch (error) {
            log.warn(
              "Extension uploaded, but the extension catalog could not be refreshed",
              error,
            );
          }
        }
      } finally {
        setUploadingExtensionId(undefined);
      }
    },
    [installFoxeExtensions, refreshAllExtensions],
  );

  const selectOriginalPackage = useCallback(
    (extension: ExtensionMarketplaceDetail) => {
      setFallbackExtension(extension);
      enqueueSnackbar(
        t("selectOriginalExtensionFile", { name: extension.name }),
        {
          variant: "info",
        },
      );
      uploadInputRef.current?.click();
    },
    [enqueueSnackbar, t],
  );

  const handleUploadToOrganization = useCallback(
    async (extension: ExtensionMarketplaceDetail) => {
      try {
        const buffer = await getExtensionPackage("local", extension.id);
        if (buffer == undefined) {
          selectOriginalPackage(extension);
          return;
        }

        const fileBuffer = new ArrayBuffer(buffer.byteLength);
        new Uint8Array(fileBuffer).set(buffer);
        const file = new File(
          [fileBuffer],
          `${extension.name}-${extension.version}${AllowedFileExtensions.FOXE}`,
          { type: "application/octet-stream" },
        );
        await uploadPackage(extension, buffer, file);
      } catch (error) {
        log.warn(
          `Unable to read stored extension package ${extension.id}`,
          error,
        );
        selectOriginalPackage(extension);
      }
    },
    [getExtensionPackage, selectOriginalPackage, uploadPackage],
  );

  const handleFallbackFileSelection = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file == undefined || fallbackExtension == undefined) {
        return;
      }
      if (!file.name.endsWith(AllowedFileExtensions.FOXE)) {
        enqueueSnackbar(t("uploadExtensionOnlyFoxe"), { variant: "error" });
        return;
      }

      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        await uploadPackage(fallbackExtension, buffer, file);
        setFallbackExtension(undefined);
      } catch (error) {
        log.error(`Error reading file ${file.name}`, error);
        enqueueSnackbar(t("uploadExtensionReadFailed"), { variant: "error" });
      }
    },
    [enqueueSnackbar, fallbackExtension, t, uploadPackage],
  );

  const handleBulkUninstall = useCallback(async () => {
    const selectedExtensions = entries.filter((entry) =>
      selectedExtensionIds.includes(entry.id),
    );
    const extensionsToUninstall = selectedExtensions.filter((ext) =>
      isExtensionInstalled(ext.id),
    );

    if (extensionsToUninstall.length === 0) {
      enqueueSnackbar("No installed extensions to uninstall from selection", {
        variant: "info",
      });
      return;
    }

    setIsBulkOperating(true);

    let successCount = 0;
    let failCount = 0;

    for (const extension of extensionsToUninstall) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await uninstallExtension(extension.namespace ?? "local", extension.id);
        successCount++;
        analytics.logEvent(AppEvent.EXTENSION_UNINSTALL, {
          type: extension.id,
        });
      } catch (error) {
        console.error("Failed to uninstall extension:", error);
        failCount++;
      }
    }

    if (successCount > 0) {
      enqueueSnackbar(`${successCount} extension(s) uninstalled successfully`, {
        variant: "success",
      });
    }
    if (failCount > 0) {
      enqueueSnackbar(`${failCount} extension(s) failed to uninstall`, {
        variant: "error",
      });
    }

    setIsBulkOperating(false);
    setSelectedExtensionIds([]);
  }, [
    analytics,
    enqueueSnackbar,
    entries,
    isExtensionInstalled,
    selectedExtensionIds,
    uninstallExtension,
  ]);

  const columns: GridColDef[] = [
    { field: "name", headerName: "Name", flex: 1, sortable: true },
    { field: "version", headerName: "Version", flex: 0.5, sortable: true },
    { field: "publisher", headerName: "Publisher", flex: 0.5, sortable: true },
    { field: "description", headerName: "Description", flex: 2 },
    {
      field: "actions",
      headerName: "Actions",
      flex: 1,
      sortable: false,
      renderCell: (params: GridRenderCellParams) => {
        const extension = params.row as ExtensionMarketplaceDetail;
        const isInstalled = isExtensionInstalled(extension.id);
        const isExtensionOperating = isOperating(extension.id);

        if (isInstalled) {
          return (
            <Stack direction="row" gap={1} alignItems="center">
              {namespace === "local" && allowUploadToOrganization && (
                <Tooltip
                  title={
                    uploadingExtensionId === extension.id
                      ? t("uploadingExtensionToOrganization")
                      : t("uploadExtensionToOrganization")
                  }
                >
                  <span>
                    <IconButton
                      aria-label={t("uploadExtensionToOrganization")}
                      data-testid={`upload-extension-to-organization-${extension.id}`}
                      size="small"
                      disabled={uploadingExtensionId === extension.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleUploadToOrganization(extension);
                      }}
                    >
                      {uploadingExtensionId === extension.id ? (
                        <CircularProgress size={18} />
                      ) : (
                        <CloudUploadIcon fontSize="small" />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              <UninstallButton
                extension={extension}
                onAction={handleUninstall}
                isOperating={isExtensionOperating}
                operationStatus={operationStatus}
                stopPropagation
                label={ExtensionActionsLabel.UNINSTALL}
                loadingLabel={ExtensionOperationStatusLabel.UNINSTALLING}
              />
            </Stack>
          );
        } else {
          return (
            <InstallButton
              extension={extension}
              onAction={handleInstall}
              isOperating={isExtensionOperating}
              operationStatus={operationStatus}
              stopPropagation
              label={ExtensionActionsLabel.INSTALL}
              loadingLabel={ExtensionOperationStatusLabel.INSTALLING}
            />
          );
        }
      },
    },
  ];

  const renderComponent = () => {
    if (entries.length === 0 && filterText) {
      return generatePlaceholderList(t("noExtensionsFound"));
    } else if (entries.length === 0) {
      return generatePlaceholderList(t("noExtensionsAvailable"));
    }

    const selectedExtensions = entries.filter((entry) =>
      selectedExtensionIds.includes(entry.id),
    );
    const selectedInstalled = selectedExtensions.filter((ext) =>
      isExtensionInstalled(ext.id),
    );

    return (
      <Stack gap={1}>
        <Stack direction="row" gap={1} paddingX={2}>
          <Typography
            variant="body2"
            color="text.secondary"
            alignSelf="center"
            paddingY={1}
            style={{
              visibility: selectedInstalled.length > 0 ? "visible" : "hidden",
            }}
          >
            {selectedExtensionIds.length} selected
          </Typography>
          {selectedInstalled.length > 0 && (
            <Button
              size="small"
              color="inherit"
              variant="outlined"
              onClick={handleBulkUninstall}
              disabled={isBulkOperating}
            >
              {isBulkOperating
                ? ExtensionOperationStatusLabel.UNINSTALLING
                : `${ExtensionActionsLabel.UNINSTALL} ${selectedInstalled.length}`}
            </Button>
          )}
        </Stack>
        <div>
          <DataGrid
            rows={entries}
            columns={columns}
            initialState={{
              pagination: { paginationModel },
              columns: {
                columnVisibilityModel: {
                  actions:
                    (namespace === "local" && allowUploadToOrganization) ||
                    isDesktopApp() ||
                    !entries.some((entry) => canInstallExtension(entry)),
                },
              },
            }}
            pageSizeOptions={[5, 10, 20]}
            checkboxSelection
            disableRowSelectionOnClick
            style={{ cursor: "pointer" }}
            onRowClick={(params) => {
              const extension = params.row as ExtensionMarketplaceDetail;
              const isInstalled = installedExtensions
                ? installedExtensions.some(
                    (installed) =>
                      installed.id === extension.id &&
                      installed.namespace === extension.namespace,
                  )
                : false;
              selectExtension({ installed: isInstalled, entry: extension });
            }}
            onRowSelectionModelChange={(newSelection) => {
              setSelectedExtensionIds(newSelection as string[]);
            }}
            rowSelectionModel={selectedExtensionIds}
            data-testid="extension-list-entry"
          />
        </div>
      </Stack>
    );
  };

  return (
    <Stack key={namespace} gap={1} paddingBottom={2}>
      <Stack paddingY={0} paddingX={2}>
        <Typography component="div" variant="overline" color="text.secondary">
          {displayNameForNamespace(namespace)}
        </Typography>
      </Stack>
      {renderComponent()}
      {namespace === "local" && allowUploadToOrganization && (
        <input
          ref={uploadInputRef}
          type="file"
          accept={AllowedFileExtensions.FOXE}
          name={fallbackExtension?.name}
          aria-label={
            fallbackExtension == undefined
              ? undefined
              : t("selectOriginalExtensionFile", {
                  name: fallbackExtension.name,
                })
          }
          style={{ display: "none" }}
          data-testid="upload-installed-extension-input"
          onChange={(event) => {
            void handleFallbackFileSelection(event);
          }}
        />
      )}
    </Stack>
  );
}
