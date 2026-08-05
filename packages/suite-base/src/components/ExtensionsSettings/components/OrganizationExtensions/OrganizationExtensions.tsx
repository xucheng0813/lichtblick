// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from "@mui/material";
import { useSnackbar } from "notistack";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAsyncFn } from "react-use";

import Logger from "@lichtblick/log";
import ExtensionsAPI from "@lichtblick/suite-base/api/extensions/ExtensionsAPI";
import Stack from "@lichtblick/suite-base/components/Stack";
import {
  UseInstallingExtensionsState,
  useExtensionCatalog,
} from "@lichtblick/suite-base/context/ExtensionCatalogContext";
import { HttpError } from "@lichtblick/suite-base/services/http/HttpError";
import { ExtensionInfo } from "@lichtblick/suite-base/types/Extensions";

const log = Logger.getLogger(__filename);

type InstallationStatus = "installed" | "updateAvailable" | "notInstalled";

type OrganizationExtensionsProps = {
  filterText: string;
  installFoxeExtensions: UseInstallingExtensionsState["installFoxeExtensions"];
  workspace: string;
};

function getDownloadErrorReason(error: unknown): string {
  if (error instanceof HttpError) {
    return String(error.status);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getInstallationStatus(
  extension: ExtensionInfo,
  installedExtensions: readonly ExtensionInfo[],
  loadedExtensions: ReadonlySet<string>,
): InstallationStatus {
  const matchingExtensions = installedExtensions.filter(
    (installed) => installed.id === extension.id,
  );
  if (matchingExtensions.length === 0) {
    return loadedExtensions.has(extension.id)
      ? "updateAvailable"
      : "notInstalled";
  }

  if (
    matchingExtensions.some(
      (installed) => installed.version === extension.version,
    )
  ) {
    return "installed";
  }

  // The server is authoritative for its catalog entry. Any different installed version is an
  // available update, including non-semver extension versions.
  return "updateAvailable";
}

export default function OrganizationExtensions({
  filterText,
  installFoxeExtensions,
  workspace,
}: Readonly<OrganizationExtensionsProps>): React.JSX.Element {
  const { t } = useTranslation("extensionsSettings");
  const { enqueueSnackbar } = useSnackbar();
  const installedExtensions =
    useExtensionCatalog((state) => state.installedExtensions) ?? [];
  const loadedExtensions = useExtensionCatalog(
    (state) => state.loadedExtensions,
  );
  const [installingExtensionId, setInstallingExtensionId] = useState<
    string | undefined
  >();
  const api = useMemo(() => new ExtensionsAPI(workspace), [workspace]);
  const [extensionsState, refreshExtensions] = useAsyncFn(
    async () => await api.list(),
    [api],
  );

  useEffect(() => {
    refreshExtensions().catch(() => undefined);
  }, [refreshExtensions]);

  const filteredExtensions = useMemo(() => {
    const normalizedFilter = filterText.trim().toLocaleLowerCase();
    const extensions = extensionsState.value ?? [];
    if (normalizedFilter.length === 0) {
      return extensions;
    }
    return extensions.filter((extension) =>
      [
        extension.displayName,
        extension.name,
        extension.publisher,
        extension.description,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedFilter)),
    );
  }, [extensionsState.value, filterText]);

  const installExtension = useCallback(
    async (extension: ExtensionInfo) => {
      setInstallingExtensionId(extension.id);
      try {
        const content = await api.loadContent(extension.id);
        if (content == undefined) {
          // ExtensionsAPI returns undefined only when the download endpoint returns 404.
          throw new Error("404");
        }
        await installFoxeExtensions([{ buffer: content, namespace: "org" }]);
      } catch (error) {
        log.error(
          `Error installing organization extension ${extension.id}`,
          error,
        );
        enqueueSnackbar(
          t("organizationExtensionInstallFailed", {
            reason: getDownloadErrorReason(error),
          }),
          { variant: "error" },
        );
      } finally {
        setInstallingExtensionId(undefined);
      }
    },
    [api, enqueueSnackbar, installFoxeExtensions, t],
  );

  const retry = useCallback(() => {
    refreshExtensions().catch(() => undefined);
  }, [refreshExtensions]);

  return (
    <Stack testId="organization-extensions-section" gap={1} paddingBottom={2}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        paddingX={2}
      >
        <Typography component="div" variant="overline" color="text.secondary">
          {t("organizationExtensionsCloud")}
        </Typography>
        <Tooltip title={t("refreshOrganizationExtensions")}>
          <span>
            <IconButton
              aria-label={t("refreshOrganizationExtensions")}
              disabled={extensionsState.loading}
              size="small"
              onClick={retry}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {extensionsState.loading && extensionsState.value == undefined && (
        <Stack alignItems="center" padding={2}>
          <CircularProgress size={24} />
        </Stack>
      )}

      {extensionsState.error != undefined && (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              aria-label={t("retryOrganizationExtensions")}
              onClick={retry}
            >
              {t("retryOrganizationExtensions")}
            </Button>
          }
        >
          {t("organizationExtensionsLoadFailed")}
        </Alert>
      )}

      {!extensionsState.loading &&
        extensionsState.error == undefined &&
        filteredExtensions.length === 0 && (
          <Typography color="text.secondary" variant="body2" paddingX={2}>
            {t("noOrganizationExtensions")}
          </Typography>
        )}

      {!extensionsState.loading && extensionsState.error == undefined && (
        <Stack gap={0.5} paddingX={2}>
          {filteredExtensions.map((extension) => {
            const status = getInstallationStatus(
              extension,
              installedExtensions,
              loadedExtensions,
            );
            const installing = installingExtensionId === extension.id;
            const statusLabel =
              status === "installed"
                ? t("organizationExtensionInstalled")
                : status === "updateAvailable"
                  ? t("organizationExtensionUpdateAvailable")
                  : t("organizationExtensionNotInstalled");

            return (
              <Paper
                key={extension.externalId ?? extension.id}
                variant="outlined"
                data-testid={`organization-extension-row-${extension.id}`}
              >
                <Stack
                  direction="row"
                  alignItems="center"
                  gap={1}
                  padding={1}
                  zeroMinWidth
                >
                  <Typography
                    variant="subtitle2"
                    noWrap
                    style={{ minWidth: 120, maxWidth: 240 }}
                  >
                    {extension.displayName || extension.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {extension.publisher} · {extension.version}
                  </Typography>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    noWrap
                    flex={1}
                    minWidth={0}
                  >
                    {extension.description}
                  </Typography>
                  <Chip label={statusLabel} size="small" variant="outlined" />
                  {status !== "installed" && (
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={installingExtensionId != undefined}
                      onClick={() => {
                        void installExtension(extension);
                      }}
                    >
                      {installing
                        ? t("installingOrganizationExtension")
                        : t("installOrganizationExtension")}
                    </Button>
                  )}
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
