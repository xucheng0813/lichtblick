// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { Alert, AlertTitle, Button } from "@mui/material";
import { useSnackbar } from "notistack";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Logger from "@lichtblick/log";
import { ExtensionDetails } from "@lichtblick/suite-base/components/ExtensionDetails";
import useExtensionSettings from "@lichtblick/suite-base/components/ExtensionsSettings/hooks/useExtensionSettings";
import { FocusedExtension } from "@lichtblick/suite-base/components/ExtensionsSettings/types";
import SearchBar from "@lichtblick/suite-base/components/SearchBar/SearchBar";
import Stack from "@lichtblick/suite-base/components/Stack";
import { AllowedFileExtensions } from "@lichtblick/suite-base/constants/allowedFileExtensions";
import { useAppConfiguration } from "@lichtblick/suite-base/context/AppConfigurationContext";
import { useInstallingExtensionsState } from "@lichtblick/suite-base/hooks/useInstallingExtensionsState";
import {
  resolveVizServerConfigured,
  resolveWorkspace,
} from "@lichtblick/suite-base/util/vizServerParams";

import ExtensionList from "./components/ExtensionList/ExtensionList";
import OrganizationExtensions from "./components/OrganizationExtensions/OrganizationExtensions";
import { useStyles } from "./index.style";

const log = Logger.getLogger(__filename);

export default function ExtensionsSettings(): React.ReactElement {
  const { t } = useTranslation("extensionsSettings");
  const { classes } = useStyles();
  const { enqueueSnackbar } = useSnackbar();
  const appConfiguration = useAppConfiguration();
  const workspace = resolveWorkspace(appConfiguration);
  const vizServerConfigured = resolveVizServerConfigured(workspace);
  const fileInputRef = useRef<HTMLInputElement>(ReactNull);

  const [focusedExtension, setFocusedExtension] = useState<
    FocusedExtension | undefined
  >();

  const { installFoxeExtensions } = useInstallingExtensionsState({
    isPlaying: false,
    playerEvents: { play: undefined },
  });

  const handleUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file == undefined) {
        return;
      }
      if (!file.name.endsWith(AllowedFileExtensions.FOXE)) {
        enqueueSnackbar(t("uploadExtensionOnlyFoxe"), { variant: "error" });
        return;
      }
      let buffer: ArrayBuffer;
      try {
        buffer = await file.arrayBuffer();
      } catch (error) {
        log.error(`Error reading file ${file.name}`, error);
        enqueueSnackbar(t("uploadExtensionReadFailed"), { variant: "error" });
        return;
      }
      try {
        await installFoxeExtensions([
          { buffer: new Uint8Array(buffer), file, namespace: "org" },
        ]);
      } catch (error) {
        log.error(`Error installing extension ${file.name}`, error);
      }
    },
    [enqueueSnackbar, installFoxeExtensions, t],
  );

  const {
    setUndebouncedFilterText,
    marketplaceEntries,
    refreshMarketplaceEntries,
    undebouncedFilterText,
    namespacedData,
    groupedMarketplaceData,
    debouncedFilterText,
  } = useExtensionSettings();

  const onClear = () => {
    setUndebouncedFilterText("");
  };

  const selectFocusedExtension = useCallback(
    (newFocusedExtension: FocusedExtension) => {
      setFocusedExtension(newFocusedExtension);
    },
    [setFocusedExtension],
  );

  if (focusedExtension != undefined) {
    return (
      <ExtensionDetails
        installed={focusedExtension.installed}
        extension={focusedExtension.entry}
        onClose={() => {
          setFocusedExtension(undefined);
        }}
      />
    );
  }

  return (
    <Stack gap={1}>
      {vizServerConfigured && (
        <>
          <Button
            variant="outlined"
            size="small"
            startIcon={<CloudUploadIcon />}
            data-testid="upload-extension-button"
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            {t("uploadExtensionToOrganization")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".foxe"
            style={{ display: "none" }}
            data-testid="upload-extension-input"
            onChange={(event) => {
              void handleUpload(event);
            }}
          />
        </>
      )}
      {marketplaceEntries.error && (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              onClick={async () => await refreshMarketplaceEntries()}
            >
              Retry
            </Button>
          }
        >
          <AlertTitle>{t("failedToRetrieveMarketplaceExtensions")}</AlertTitle>
          {t("checkInternetConnection")}
        </Alert>
      )}
      <div className={classes.searchBarDiv}>
        <SearchBar
          data-testid="SearchBarComponent"
          className={classes.searchBarPadding}
          id="extension-filter"
          placeholder={t("searchExtensions")}
          variant="outlined"
          onChange={(event) => {
            setUndebouncedFilterText(event.target.value);
          }}
          value={undebouncedFilterText}
          showClearIcon={!!debouncedFilterText}
          onClear={onClear}
        />
      </div>
      {vizServerConfigured && (
        <OrganizationExtensions
          workspace={workspace}
          filterText={debouncedFilterText}
          installFoxeExtensions={installFoxeExtensions}
        />
      )}
      {namespacedData.map(({ namespace, entries }) => (
        <ExtensionList
          key={namespace}
          filterText={debouncedFilterText}
          entries={entries}
          namespace={namespace}
          selectExtension={selectFocusedExtension}
          allowUploadToOrganization={vizServerConfigured}
        />
      ))}
      {groupedMarketplaceData.map(({ namespace, entries }) => (
        <ExtensionList
          key={namespace}
          filterText={debouncedFilterText}
          entries={entries}
          namespace={namespace}
          selectExtension={selectFocusedExtension}
          allowUploadToOrganization={vizServerConfigured}
        />
      ))}
    </Stack>
  );
}
