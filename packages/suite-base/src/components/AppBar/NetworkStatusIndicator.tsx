// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CloudOff20Regular } from "@fluentui/react-icons";
import { Tooltip, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useNetworkState } from "react-use";

import {
  resolveVizServerConfigured,
  resolveWorkspaceBestEffort,
} from "@lichtblick/suite-base/util/vizServerParams";

import { useStyles } from "./NetworkStatusIndicator.style";

export function NetworkStatusIndicator(): React.JSX.Element | undefined {
  const { classes } = useStyles();
  const { t } = useTranslation("appBar");
  const { online = true } = useNetworkState();

  const workspace: string | undefined = resolveWorkspaceBestEffort();
  const hasRemoteConfig: boolean = resolveVizServerConfigured(workspace);

  if (!hasRemoteConfig || online) {
    return undefined;
  }

  const statusText = t("networkStatusOffline");

  const tooltipContent = (
    <div className={classes.tooltipContent}>
      <Typography variant="body2" component="div" className={classes.tooltipTitle}>
        {statusText}
      </Typography>
      <Typography variant="body2" component="div">
        {t("networkStatusOfflineDescription", {
          workspace,
        })}
      </Typography>
    </div>
  );

  return (
    <Tooltip title={tooltipContent} arrow placement="bottom">
      <div
        className={classes.indicator}
        aria-label={statusText}
        data-testid="network-status-indicator"
      >
        <CloudOff20Regular className={classes.icon} />
        <Typography variant="body2" component="span">
          {statusText}
        </Typography>
      </div>
    </Tooltip>
  );
}
