// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  TextField,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { OrgLayoutPermission, UploadToOrgOptions } from "./types";

export function UploadToOrgDialog({
  layoutName,
  open,
  onClose,
  onUpload,
}: {
  layoutName: string;
  open: boolean;
  onClose: () => void;
  onUpload: (options: UploadToOrgOptions) => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation("layoutBrowser");
  const [name, setName] = useState(layoutName);
  const [permission, setPermission] =
    useState<OrgLayoutPermission>("ORG_WRITE");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (open) {
      setName(layoutName);
      setPermission("ORG_WRITE");
      setUploading(false);
    }
  }, [layoutName, open]);

  const upload = async () => {
    setUploading(true);
    try {
      if (await onUpload({ name, permission })) {
        onClose();
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={uploading ? undefined : onClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>{t("uploadToOrgTitle")}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="normal"
          label={t("layoutName")}
          value={name}
          disabled={uploading}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <FormControl disabled={uploading} margin="normal">
          <FormLabel>{t("permission")}</FormLabel>
          <RadioGroup
            value={permission}
            onChange={(event) => {
              setPermission(event.target.value as OrgLayoutPermission);
            }}
          >
            <FormControlLabel
              value="ORG_WRITE"
              control={<Radio />}
              label={t("orgCanEdit")}
            />
            <FormControlLabel
              value="ORG_READ"
              control={<Radio />}
              label={t("orgReadOnly")}
            />
          </RadioGroup>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button disabled={uploading} onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          variant="contained"
          disabled={uploading || name.length === 0}
          onClick={() => {
            void upload();
          }}
        >
          {uploading && <CircularProgress size={16} />}
          {t("upload")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
