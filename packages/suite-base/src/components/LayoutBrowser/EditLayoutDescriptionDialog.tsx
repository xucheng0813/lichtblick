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
  DialogContentText,
  DialogTitle,
  TextField,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function EditLayoutDescriptionDialog({
  layoutName,
  open,
  onClose,
  onSave,
}: {
  layoutName: string;
  open: boolean;
  onClose: () => void;
  onSave: (description: string) => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation("layoutBrowser");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDescription("");
      setSaving(false);
    }
  }, [layoutName, open]);

  const save = async () => {
    setSaving(true);
    try {
      if (await onSave(description)) {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("editDescriptionTitle")}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t("editDescriptionText", { layoutName })}</DialogContentText>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={4}
          margin="normal"
          label={t("descriptionLabel")}
          placeholder={t("descriptionPlaceholder")}
          value={description}
          disabled={saving}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button disabled={saving} onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          variant="contained"
          disabled={saving}
          onClick={() => {
            void save();
          }}
        >
          {saving && <CircularProgress size={16} />}
          {t("save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
