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
      <DialogTitle>编辑布局描述</DialogTitle>
      <DialogContent>
        <DialogContentText>
          说明“{layoutName}”是做什么的。描述会用于生成智能助手技能。
        </DialogContentText>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={4}
          margin="normal"
          label="布局描述"
          placeholder="例如：用于查看设备诊断数据和故障趋势"
          value={description}
          disabled={saving}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button disabled={saving} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={saving}
          onClick={() => {
            void save();
          }}
        >
          {saving && <CircularProgress size={16} />}
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
