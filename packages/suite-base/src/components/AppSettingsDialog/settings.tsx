// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import Brightness5Icon from "@mui/icons-material/Brightness5";
import ComputerIcon from "@mui/icons-material/Computer";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import QuestionAnswerOutlinedIcon from "@mui/icons-material/QuestionAnswerOutlined";
import WebIcon from "@mui/icons-material/Web";
import {
  Alert,
  Autocomplete,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  SelectChangeEvent,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  ToggleButtonGroupProps,
} from "@mui/material";
import moment from "moment-timezone";
import { MouseEvent, useCallback, useEffect, useMemo, useRef,
  useState, } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import { filterMap } from "@lichtblick/den/collection";
import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import OsContextSingleton from "@lichtblick/suite-base/OsContextSingleton";
import { AgentMarkdown } from "@lichtblick/suite-base/components/AgentMarkdown";
import Stack from "@lichtblick/suite-base/components/Stack";
import { useAppConfiguration } from "@lichtblick/suite-base/context/AppConfigurationContext";
import { useAppTimeFormat } from "@lichtblick/suite-base/hooks";
import { useAppConfigurationValue } from "@lichtblick/suite-base/hooks/useAppConfigurationValue";
import { Language } from "@lichtblick/suite-base/i18n";
import { reportError } from "@lichtblick/suite-base/reportError";
import {
  AgentCredentialsBackendUnavailableError,
  AgentPlaintextCredentialLockUnavailableError,
  AgentConfigurationErrors,
  AgentLlmProvider,
  AgentProfile,
  AgentSettingsConflictError,
  AgentSettingsDraft,
  DEFAULT_AGENT_LLM_PROVIDER,
  DEFAULT_ANTHROPIC_MODEL,
  commitAgentSettings,
  createAgentSettingsDraft,
  getAgentConfigurationSource,
  getOrgDefaultProfile,
  selectAgentConfiguration,
  useAgentSettings,
  validateAgentConfiguration,
} from "@lichtblick/suite-base/services/agent/agentSettings";
import { SKILL_REGISTRY } from "@lichtblick/suite-base/services/agent/local/skills";
import {
  clearAgentMemories,
  readAgentMemories,
  removeAgentMemory,
} from "@lichtblick/suite-base/services/agent/memory/agentMemory";
import type { MemoryEntry } from "@lichtblick/suite-base/services/agent/memory/agentMemory";
import {
  readAgentPromptCustomization,
  resolveSkills,
  writeAgentPromptCustomization,
} from "@lichtblick/suite-base/services/agent/prompts/agentPrompts";
import type { AgentPromptCustomization } from "@lichtblick/suite-base/services/agent/prompts/agentPrompts";
import {
  type AgentBootstrap,
  fetchAgentBootstrap,
  publishCustomization,
  readCachedAgentBootstrap,
} from "@lichtblick/suite-base/services/agent/prompts/remotePromptCustomization";
import { setHttpBaseUrl } from "@lichtblick/suite-base/services/http/httpBaseUrl";
import { LaunchPreferenceValue } from "@lichtblick/suite-base/types/LaunchPreferenceValue";
import { TimeDisplayMethod } from "@lichtblick/suite-base/types/panels";
import { formatTime } from "@lichtblick/suite-base/util/formatTime";
import { formatTimeRaw } from "@lichtblick/suite-base/util/time";
import {
  resolveVizServerConfigured,
  resolveWorkspace,
} from "@lichtblick/suite-base/util/vizServerParams";

const MESSAGE_RATES = [1, 3, 5, 10, 15, 20, 30, 60];
const LANGUAGE_OPTIONS: { key: Language; value: string }[] = [
  { key: "en", value: "English" },
];

const useStyles = makeStyles()((theme) => ({
  checkbox: {
    "&.MuiCheckbox-root": {
      paddingTop: 0,
    },
  },
  formControlLabel: {
    "&.MuiFormControlLabel-root": {
      alignItems: "start",
    },
  },
  skillPreview: {
    maxHeight: 420,
    padding: theme.spacing(1.5),
    overflowY: "auto",
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.background.default,
  },
  remoteSkillBody: {
    maxHeight: 200,
    overflowY: "auto",
    padding: theme.spacing(1, 1.5),
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.background.default,
  },
  remoteSkillButton: {
    justifyContent: "flex-start",
    width: "100%",
    minWidth: 0,
    textAlign: "left",
    textTransform: "none",
  },
  remoteSkillItem: {
    display: "block",
  },
  remoteSkillItemContent: {
    width: "100%",
    minWidth: 0,
  },
  remoteSkillWhenToUse: {
    display: "block",
    overflow: "hidden",
    color: theme.palette.text.secondary,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  vtdInstallOutput: {
    marginBottom: 0,
    maxHeight: 160,
    overflow: "auto",
    whiteSpace: "pre-wrap",
  },
  toggleButton: {
    display: "flex !important",
    flexDirection: "column",
    gap: theme.spacing(0.75),
    lineHeight: "1 !important",
  },
}));

function formatTimezone(name: string) {
  const tz = moment.tz(name);
  const zoneAbbr = tz.zoneAbbr();
  const offset = tz.utcOffset();
  const offsetStr =
    (offset >= 0 ? "+" : "") + moment.duration(offset, "minutes").format("hh:mm", { trim: false });
  if (name === zoneAbbr) {
    return `${zoneAbbr} (${offsetStr})`;
  }
  return `${name} (${zoneAbbr}, ${offsetStr})`;
}

export function ColorSchemeSettings(): React.JSX.Element {
  const { classes } = useStyles();
  const [colorScheme = "system", setColorScheme] =
    useAppConfigurationValue<string>(AppSetting.COLOR_SCHEME);
  const { t } = useTranslation("appSettings");

  const handleChange = useCallback(
    (_event: MouseEvent<HTMLElement>, value?: string) => {
      if (value != undefined) {
        void setColorScheme(value);
      }
    },
    [setColorScheme],
  );

  return (
    <Stack>
      <FormLabel>{t("colorScheme")}:</FormLabel>
      <ToggleButtonGroup
        color="primary"
        size="small"
        fullWidth
        exclusive
        value={colorScheme}
        onChange={handleChange}
      >
        <ToggleButton className={classes.toggleButton} value="dark">
          <DarkModeIcon /> {t("dark")}
        </ToggleButton>
        <ToggleButton className={classes.toggleButton} value="light">
          <Brightness5Icon /> {t("light")}
        </ToggleButton>
        <ToggleButton className={classes.toggleButton} value="system">
          <ComputerIcon /> {t("followSystem")}
        </ToggleButton>
      </ToggleButtonGroup>
    </Stack>
  );
}

export function TimezoneSettings(): React.ReactElement {
  type Option = { key: string; label: string; data?: string; divider?: boolean; };

  const { t } = useTranslation("appSettings");
  const [timezone, setTimezone] = useAppConfigurationValue<string>(
    AppSetting.TIMEZONE,
  );
  const detectItem: Option = useMemo(
    () => ({
      key: "detect",
      label: `Detect from system: ${formatTimezone(moment.tz.guess())}`,
      data: undefined,
    }),
    [],
  );
  const fixedItems: Option[] = useMemo(
    () => [
      detectItem,
      { key: "zone:UTC", label: formatTimezone("UTC"), data: "UTC" },
      {
        key: "sep",
        label: "",
        divider: true,
      },
    ],
    [detectItem],
  );

  const timezoneItems: Option[] = useMemo(
    () =>
      filterMap(moment.tz.names(), (name) => {
        // UTC is always hoisted to the top in fixedItems
        if (name === "UTC") {
          return undefined;
        }
        return { key: `zone:${name}`, label: formatTimezone(name), data: name };
      }),
    [],
  );

  const allItems = useMemo(
    () => [...fixedItems, ...timezoneItems], [fixedItems, timezoneItems],
  );

  const selectedItem = useMemo(() => {
    if (timezone != undefined) {
      return allItems.find((item) => item.data === timezone) ?? detectItem;
    }
    return detectItem;
  }, [allItems, detectItem, timezone]);

  return (
    <FormControl fullWidth>
      <FormLabel>{t("displayTimestampsIn")}:</FormLabel>
      <Autocomplete
        options={[...fixedItems, ...timezoneItems]}
        value={selectedItem}
        renderOption={(props, option: Option) =>
          option.divider === true ? (
            <Divider key={option.key} />
          ) : (
            <li {...props} key={option.key}>
              {option.label}
            </li>
          )
        }
        renderInput={(params) => <TextField {...params} />}
        onChange={(_event, value) => void setTimezone(value?.data)}
      />
    </FormControl>
  );
}

export function TimeFormat({
  orientation = "vertical",
}: {
  orientation?: ToggleButtonGroupProps["orientation"];
}): React.ReactElement {
  const { timeFormat, setTimeFormat } = useAppTimeFormat();

  const { t } = useTranslation("appSettings");

  const [timezone] = useAppConfigurationValue<string>(AppSetting.TIMEZONE);

  const exampleTime = { sec: 946713600, nsec: 0 };

  return (
    <Stack>
      <FormLabel>{t("timestampFormat")}:</FormLabel>
      <ToggleButtonGroup
        color="primary"
        size="small"
        orientation={orientation}
        fullWidth
        exclusive
        value={timeFormat}
        onChange={(_, value?: TimeDisplayMethod) => value != undefined && void setTimeFormat(value)
        }
      >
        <ToggleButton value="SEC" data-testid="timeformat-seconds">
          {formatTimeRaw(exampleTime)}
        </ToggleButton>
        <ToggleButton value="TOD" data-testid="timeformat-local">
          {formatTime(exampleTime, timezone)}
        </ToggleButton>
      </ToggleButtonGroup>
    </Stack>
  );
}

export function LaunchDefault(): React.ReactElement {
  const { classes } = useStyles();
  const { t } = useTranslation("appSettings");
  const [preference, setPreference] = useAppConfigurationValue<
    string | undefined
  >(AppSetting.LAUNCH_PREFERENCE);
  let sanitizedPreference: LaunchPreferenceValue;
  switch (preference) {
    case LaunchPreferenceValue.WEB:
    case LaunchPreferenceValue.DESKTOP:
    case LaunchPreferenceValue.ASK:
      sanitizedPreference = preference;
      break;
    default:
      sanitizedPreference = LaunchPreferenceValue.WEB;
  }

  return (
    <Stack>
      <FormLabel>{t("openLinksIn")}:</FormLabel>
      <ToggleButtonGroup
        color="primary"
        size="small"
        fullWidth
        exclusive
        value={sanitizedPreference}
        onChange={(_, value?: string) => value != undefined && void setPreference(value)
        }
      >
        <ToggleButton value={LaunchPreferenceValue.WEB}
          className={classes.toggleButton}
        >
          <WebIcon /> {t("webApp")}
        </ToggleButton>
        <ToggleButton value={LaunchPreferenceValue.DESKTOP}
          className={classes.toggleButton}
        >
          <ComputerIcon /> {t("desktopApp")}
        </ToggleButton>
        <ToggleButton value={LaunchPreferenceValue.ASK}
          className={classes.toggleButton}
        >
          <QuestionAnswerOutlinedIcon /> {t("askEachTime")}
        </ToggleButton>
      </ToggleButtonGroup>
    </Stack>
  );
}

export function MessageFramerate(): React.ReactElement {
  const { t } = useTranslation("appSettings");
  const [messageRate, setMessageRate] = useAppConfigurationValue<number>(
    AppSetting.MESSAGE_RATE,
  );
  const options = useMemo(
    () => MESSAGE_RATES.map((rate) => ({ key: rate, text: `${rate}`, data: rate })),
    [],
  );

  return (
    <Stack>
      <FormLabel>{t("messageRate")} (Hz):</FormLabel>
      <Select
        value={messageRate ?? 60}
        fullWidth
        onChange={(event) => void setMessageRate(event.target.value)}
      >
        {options.map((option) => (
          <MenuItem key={option.key} value={option.key}>
            {option.text}
          </MenuItem>
        ))}
      </Select>
    </Stack>
  );
}

export function StepSize(): React.ReactElement {
  const { t } = useTranslation("appSettings");
  const defaultStepSize = 100;
  const minStepSize = 1;

  const [stepSize = defaultStepSize, setStepSize] =
    useAppConfigurationValue<number>(AppSetting.DEFAULT_STEP_SIZE);

  const valueValidation = (value: number) => isNaN(value) || value < minStepSize;
  const isStepSizeInvalid = valueValidation(stepSize);

  const latestStepSizeRef = useRef(stepSize);
  latestStepSizeRef.current = stepSize;

  useEffect(() => {
    return () => {
      const latest = latestStepSizeRef.current;
      if (valueValidation(latest)) {
        void setStepSize(defaultStepSize);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Stack>
      <FormLabel>{t("stepSize")} (ms):</FormLabel>
      <TextField
        id="stepSizeInput"
        fullWidth
        type="number"
        value={stepSize}
        onChange={(event) => {
          void setStepSize(parseInt(event.target.value));
        }}
        slotProps={{
          input: {
            type: "number",
            sx: {
              "& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button": {
                display: "none",
              },
              "& input[type=number]": {
                MozAppearance: "textfield",
              },
            },
          },
        }}
        error={isStepSizeInvalid}
        helperText={isStepSizeInvalid ? "Step size will default to 100ms" : " "}
      ></TextField>
    </Stack>
  );
}

export function AutoUpdate(): React.ReactElement {
  const [updatesEnabled = false, setUpdatedEnabled] =
    useAppConfigurationValue<boolean>(AppSetting.UPDATES_ENABLED);

  const { classes } = useStyles();

  return (
    <>
      <FormLabel>Updates:</FormLabel>
      <FormControlLabel
        className={classes.formControlLabel}
        control={
          <Checkbox
            className={classes.checkbox}
            checked={updatesEnabled}
            onChange={(_event, checked) => void setUpdatedEnabled(checked)}
          />
        }
        label="Automatically install updates"
      />
    </>
  );
}

export function RosPackagePath(): React.ReactElement {
  const [rosPackagePath, setRosPackagePath] = useAppConfigurationValue<string>(
    AppSetting.ROS_PACKAGE_PATH,
  );

  const rosPackagePathPlaceholder = useMemo(
    () => OsContextSingleton?.getEnvVar("ROS_PACKAGE_PATH"),
    [],
  );

  return (
    <TextField
      fullWidth
      label="ROS_PACKAGE_PATH"
      placeholder={rosPackagePathPlaceholder}
      value={rosPackagePath ?? ""}
      onChange={(event) => void setRosPackagePath(event.target.value)}
    />
  );
}

export function LanguageSettings(): React.ReactElement {
  const { t, i18n } = useTranslation("appSettings");
  const [selectedLanguage = "en", setSelectedLanguage] =
    useAppConfigurationValue<Language>(AppSetting.LANGUAGE);
  const onChangeLanguage = useCallback(
    (event: SelectChangeEvent<Language>) => {
      const lang = event.target.value;
      void setSelectedLanguage(lang);
      i18n.changeLanguage(lang).catch((error: unknown) => {
        console.error("Failed to switch languages", error);
        reportError(error as Error);
      });
    },
    [i18n, setSelectedLanguage],
  );
  const options: { key: string; text: string; data: string }[] = useMemo(
    () =>
      LANGUAGE_OPTIONS.map((language) => ({
        key: language.key,
        text: language.value,
        data: language.key,
      })),
    [],
  );

  return (
    <Stack>
      <FormLabel>{t("language")}:</FormLabel>
      <Select<Language> value={selectedLanguage} fullWidth
        onChange={onChangeLanguage}
      >
        {options.map((option) => (
          <MenuItem key={option.key} value={option.key}>
            {option.text}
          </MenuItem>
        ))}
      </Select>
    </Stack>
  );
}

export function VizServerSettings(): React.ReactElement {
  const [vizServerUrl, setVizServerUrl] = useAppConfigurationValue<string>(
    AppSetting.VIZ_SERVER_URL,
  );
  const [vizServerWorkspace, setVizServerWorkspace] =
    useAppConfigurationValue<string>(AppSetting.VIZ_SERVER_WORKSPACE);
  const reloadHelp = "修改后需重新加载应用生效。";

  return (
    <Stack gap={2}>
      <TextField
        fullWidth
        type="url"
        label="可视化服务地址"
        value={vizServerUrl ?? ""}
        helperText={reloadHelp}
        onChange={(event) => {
          const value = event.target.value || undefined;
          setHttpBaseUrl(value);
          void setVizServerUrl(value);
        }}
      />
      <TextField
        fullWidth
        label="工作区"
        value={vizServerWorkspace ?? ""}
        helperText={reloadHelp}
        onChange={(event) => {
          void setVizServerWorkspace(event.target.value || undefined);
        }}
      />
    </Stack>
  );
}

export type AgentSettingsCommitHandler = () => Promise<boolean>;

type AgentSettingsFormProps = {
  desktop: boolean;
  onCommitHandlerChange?: (
    handler: AgentSettingsCommitHandler | undefined,
  ) => void;
};

type DesktopVtdStatus = {
  installed: boolean;
  path?: string;
  version?: string;
};

type DesktopVtdInstallResult = {
  exitCode: number | null;
  ok: boolean;
  output: string;
};

type DesktopVtdSettingsBridge = {
  vtdInstall: () => Promise<DesktopVtdInstallResult>;
  vtdStatus: () => Promise<DesktopVtdStatus>;
};

function desktopVtdSettingsBridge(): DesktopVtdSettingsBridge | undefined {
  const candidate = (
    globalThis as typeof globalThis & { desktopBridge?: unknown }
  ).desktopBridge;
  if (
    typeof candidate !== "object" ||
    candidate == undefined ||
    typeof (candidate as { vtdInstall?: unknown }).vtdInstall !== "function" ||
    typeof (candidate as { vtdStatus?: unknown }).vtdStatus !== "function"
  ) {
    return undefined;
  }
  return candidate as DesktopVtdSettingsBridge;
}

function displayVtdVersion(version: string | undefined): string {
  if (version == undefined || version.trim().length === 0) {
    return "";
  }
  const semanticVersion = /\bv?(\d+(?:\.\d+)+)\b/i.exec(version)?.[1];
  return semanticVersion == undefined ? version.trim() : `v${semanticVersion}`;
}

function isComponentMounted(ref: { readonly current: boolean }): boolean {
  return ref.current;
}

function DesktopVtdCliSettings(): React.JSX.Element | null {
  const { classes } = useStyles();
  const { t } = useTranslation("appSettings");
  const bridge = desktopVtdSettingsBridge();
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<DesktopVtdStatus>();
  const [checking, setChecking] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string>();

  const refreshStatus = useCallback(async () => {
    if (bridge == undefined || !isComponentMounted(mountedRef)) {
      return;
    }
    setChecking(true);
    try {
      const nextStatus = await bridge.vtdStatus();
      if (isComponentMounted(mountedRef)) {
        setStatus(nextStatus);
      }
    } catch {
      if (isComponentMounted(mountedRef)) {
        setStatus({ installed: false });
      }
    } finally {
      if (isComponentMounted(mountedRef)) {
        setChecking(false);
      }
    }
  }, [bridge]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshStatus]);

  const install = useCallback(async () => {
    if (bridge == undefined || installing) {
      return;
    }
    setConfirmOpen(false);
    setInstalling(true);
    setInstallOutput(undefined);
    try {
      const result = await bridge.vtdInstall();
      if (isComponentMounted(mountedRef) && !result.ok) {
        setInstallOutput(result.output || t("agentVtdCliInstallNoOutput"));
      }
    } catch (error) {
      if (isComponentMounted(mountedRef)) {
        setInstallOutput(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (isComponentMounted(mountedRef)) {
        await refreshStatus();
        if (isComponentMounted(mountedRef)) {
          setInstalling(false);
        }
      }
    }
  }, [bridge, installing, refreshStatus, t]);

  if (bridge == undefined) {
    return null;
  }

  const version = displayVtdVersion(status?.version);
  const path = status?.path ?? "";

  return (
    <>
      {checking && status == undefined ? (
        <Alert severity="info">{t("agentVtdCliChecking")}</Alert>
      ) : status?.installed === true ? (
        <Alert severity="success">
          {t("agentVtdCliInstalled", {
            path: path.length > 0 ? ` (${path})` : "",
            version: version.length > 0 ? ` ${version}` : "",
          })}
        </Alert>
      ) : (
        <Alert
          action={
            <Button
              color="inherit"
              disabled={installing}
              size="small"
              startIcon={
                installing ? (
                  <CircularProgress color="inherit" size={14} />
                ) : undefined
              }
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              {installing
                ? t("agentVtdCliInstalling")
                : t("agentVtdCliInstall")}
            </Button>
          }
          severity="warning"
        >
          {t("agentVtdCliNotInstalled")}
        </Alert>
      )}

      {installOutput != undefined && (
        <Alert severity="error">
          {t("agentVtdCliInstallFailed")}
          <details>
            <summary>{t("agentVtdCliInstallOutput")}</summary>
            <pre className={classes.vtdInstallOutput}>{installOutput}</pre>
          </details>
        </Alert>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
        }}
      >
        <DialogTitle>{t("agentVtdCliInstallConfirmTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("agentVtdCliInstallConfirmMessage")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmOpen(false);
            }}
          >
            {t("agentVtdCliInstallCancel")}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              void install();
            }}
          >
            {t("agentVtdCliInstallConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const ORG_AGENT_PROFILE_ID = "__org__";

function createAgentProfileId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`.slice(
    0,
    64,
  );
}

function nextAgentProfileName(profiles: readonly AgentProfile[]): string {
  const profileNames = new Set(profiles.map((profile) => profile.name));
  let index = 1;
  while (profileNames.has(`Profile ${index}`)) {
    index++;
  }
  return `Profile ${index}`;
}

function uniqueAgentProfileName(
  profiles: readonly AgentProfile[],
  preferredName: string,
): string {
  const profileNames = new Set(profiles.map((profile) => profile.name));
  if (!profileNames.has(preferredName)) {
    return preferredName;
  }
  let index = 2;
  while (profileNames.has(`${preferredName} ${index}`)) {
    index++;
  }
  return `${preferredName} ${index}`;
}

function createBlankAgentProfile(
  profiles: readonly AgentProfile[],
): AgentProfile {
  return {
    anthropic: {
      apiKey: "",
      baseUrl: "",
      model: DEFAULT_ANTHROPIC_MODEL,
    },
    id: createAgentProfileId(),
    name: nextAgentProfileName(profiles),
    openAiCompatible: {
      apiKey: "",
      baseUrl: "",
      model: "",
    },
    provider: DEFAULT_AGENT_LLM_PROVIDER,
  };
}

function AgentSettingsForm({
  desktop,
  onCommitHandlerChange,
}: AgentSettingsFormProps): React.ReactElement {
  const { t } = useTranslation("appSettings");
  const { classes } = useStyles();
  const appConfiguration = useAppConfiguration();
  const [agentEnabled = false, setAgentEnabled] =
    useAppConfigurationValue<boolean>(AppSetting.AGENT_ENABLED);
  const {
    credentialBackendUnavailable,
    migrationError,
    migrationReady,
    snapshot,
  } = useAgentSettings(appConfiguration, { desktop });
  const [draft, setDraft] = useState<AgentSettingsDraft>(() =>
    createAgentSettingsDraft(snapshot),
  );
  const [selectedProfileId, setSelectedProfileId] = useState(
    () => draft.activeProfileId ?? draft.profiles?.[0]?.id ?? "",
  );
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [plaintextLockUnavailable, setPlaintextLockUnavailable] =
    useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const commitInFlightRef = useRef<Promise<boolean>>();

  useEffect(() => {
    if (!migrationReady) {
      return;
    }
    if (
      draft.revision !== snapshot.revision &&
      commitInFlightRef.current == undefined
    ) {
      if (dirty) {
        setRevisionConflict(true);
      }
      setDirty(false);
      const nextDraft = createAgentSettingsDraft(snapshot);
      setDraft(nextDraft);
      setSelectedProfileId((current) =>
        current === ORG_AGENT_PROFILE_ID ||
        nextDraft.profiles?.some((profile) => profile.id === current) === true
          ? current
          : (nextDraft.activeProfileId ?? nextDraft.profiles?.[0]?.id ?? ""),
      );
    } else if (!dirty) {
      const nextDraft = createAgentSettingsDraft(snapshot);
      setDraft(nextDraft);
      setSelectedProfileId((current) =>
        current === ORG_AGENT_PROFILE_ID ||
        nextDraft.profiles?.some((profile) => profile.id === current) === true
          ? current
          : (nextDraft.activeProfileId ?? nextDraft.profiles?.[0]?.id ?? ""),
      );
    }
  }, [dirty, draft.revision, migrationReady, snapshot]);

  const formReady = migrationReady && draft.revision === snapshot.revision;

  const profiles = useMemo(() => draft.profiles ?? [], [draft.profiles]);
  const orgProfile = getOrgDefaultProfile();
  const organizationProfileSelected =
    selectedProfileId === ORG_AGENT_PROFILE_ID;
  const selectedStoredProfile = profiles.find(
    (profile) => profile.id === selectedProfileId,
  );
  const selectedProfile = organizationProfileSelected
    ? orgProfile
    : selectedStoredProfile;
  const providerSettings =
    selectedProfile?.provider === "openai-compatible"
      ? selectedProfile.openAiCompatible
      : selectedProfile?.anthropic;
  const selectedConfiguration = selectAgentConfiguration(
    {
      ...draft,
      credentialResaveRequired: snapshot.credentialResaveRequired,
      credentialStorage: snapshot.credentialStorage,
      revision: snapshot.revision,
      storageError: snapshot.storageError,
    },
    { desktop, profileId: selectedProfileId },
  );
  const errors = validateAgentConfiguration(selectedConfiguration);
  const configurationSource = organizationProfileSelected
    ? "server"
    : getAgentConfigurationSource(snapshot, { desktop });

  const markDraftDirty = useCallback(() => {
    setDirty(true);
    setRevisionConflict(false);
    setSaveFailed(false);
  }, []);

  const updateSelectedProfile = useCallback(
    (update: (profile: AgentProfile) => AgentProfile) => {
      if (selectedProfileId === ORG_AGENT_PROFILE_ID) {
        return;
      }
      markDraftDirty();
      setDraft((current) => ({
        ...current,
        profiles: current.profiles?.map((profile) =>
          profile.id === selectedProfileId ? update(profile) : profile,
        ),
      }));
    },
    [markDraftDirty, selectedProfileId],
  );

  const updateProviderSettings = useCallback(
    (update: Partial<AgentSettingsDraft["anthropic"]>) => {
      updateSelectedProfile((profile) => {
        const key =
          profile.provider === "anthropic" ? "anthropic" : "openAiCompatible";
        return {
          ...profile,
          [key]: { ...profile[key], ...update },
        };
      });
    },
    [updateSelectedProfile],
  );

  const createProfile = useCallback(() => {
    const profile = createBlankAgentProfile(profiles);
    markDraftDirty();
    setDraft((current) => ({
      ...current,
      profiles: [...(current.profiles ?? []), profile],
    }));
    setSelectedProfileId(profile.id);
  }, [markDraftDirty, profiles]);

  const copyProfile = useCallback(() => {
    if (selectedProfile == undefined) {
      return;
    }
    const copy: AgentProfile = {
      ...selectedProfile,
      anthropic: { ...selectedProfile.anthropic },
      id: createAgentProfileId(),
      name: uniqueAgentProfileName(
        profiles,
        t("agentProfileCopyName", { name: selectedProfile.name }),
      ),
      openAiCompatible: { ...selectedProfile.openAiCompatible },
    };
    markDraftDirty();
    setDraft((current) => ({
      ...current,
      profiles: [...(current.profiles ?? []), copy],
    }));
    setSelectedProfileId(copy.id);
  }, [markDraftDirty, profiles, selectedProfile, t]);

  const openRenameProfile = useCallback(() => {
    if (selectedStoredProfile == undefined) {
      return;
    }
    setRenameValue(selectedStoredProfile.name);
    setRenameOpen(true);
  }, [selectedStoredProfile]);

  const renameProfile = useCallback(() => {
    const name = renameValue.trim();
    if (selectedStoredProfile == undefined || name === "") {
      return;
    }
    updateSelectedProfile((profile) => ({ ...profile, name }));
    setRenameOpen(false);
  }, [renameValue, selectedStoredProfile, updateSelectedProfile]);

  const deleteProfile = useCallback(() => {
    if (selectedStoredProfile == undefined || profiles.length <= 1) {
      return;
    }
    const remainingProfiles = profiles.filter(
      (profile) => profile.id !== selectedStoredProfile.id,
    );
    const nextSelectedProfile = remainingProfiles[0];
    if (nextSelectedProfile == undefined) {
      return;
    }
    markDraftDirty();
    setDraft((current) => ({
      ...current,
      activeProfileId:
        current.activeProfileId === selectedStoredProfile.id
          ? nextSelectedProfile.id
          : current.activeProfileId,
      profiles: remainingProfiles,
    }));
    setSelectedProfileId(nextSelectedProfile.id);
  }, [markDraftDirty, profiles, selectedStoredProfile]);

  const setDefaultProfile = useCallback(() => {
    if (
      selectedStoredProfile == undefined ||
      draft.activeProfileId === selectedStoredProfile.id
    ) {
      return;
    }
    markDraftDirty();
    setDraft((current) => ({
      ...current,
      activeProfileId: selectedStoredProfile.id,
    }));
  }, [draft.activeProfileId, markDraftDirty, selectedStoredProfile]);

  const commit = useCallback(async (): Promise<boolean> => {
    if (commitInFlightRef.current != undefined) {
      return await commitInFlightRef.current;
    }
    if (!dirty && !snapshot.credentialResaveRequired) {
      return true;
    }
    if (!formReady) {
      return false;
    }
    const pending = (async () => {
      setSaving(true);
      setSaveFailed(false);
      setPlaintextLockUnavailable(false);
      try {
        await commitAgentSettings(appConfiguration, draft, { desktop });
        setDirty(false);
        return true;
      } catch (error) {
        if (error instanceof AgentSettingsConflictError) {
          setRevisionConflict(true);
          setDirty(false);
        } else if (error instanceof AgentCredentialsBackendUnavailableError) {
          setSaveFailed(false);
        } else if (
          error instanceof AgentPlaintextCredentialLockUnavailableError
        ) {
          setPlaintextLockUnavailable(true);
          setSaveFailed(false);
        } else {
          setSaveFailed(true);
          reportError(error);
        }
        return false;
      } finally {
        setSaving(false);
      }
    })();
    commitInFlightRef.current = pending;
    try {
      return await pending;
    } finally {
      if (commitInFlightRef.current === pending) {
        commitInFlightRef.current = undefined;
      }
    }
  }, [
    appConfiguration,
    desktop,
    dirty,
    draft,
    formReady,
    snapshot.credentialResaveRequired,
  ]);

  useEffect(() => {
    onCommitHandlerChange?.(commit);
    return () => {
      onCommitHandlerChange?.(undefined);
    };
  }, [commit, onCommitHandlerChange]);

  const helperText = (
    error: AgentConfigurationErrors[keyof AgentConfigurationErrors],
  ) => {
    if (error === "required") {
      return t("agentFieldRequired");
    }
    if (error === "invalidUrl") {
      return t("agentInvalidUrl");
    }
    if (error === "invalidToken") {
      return t("agentInvalidToken");
    }
    return undefined;
  };

  return (
    <Stack gap={2}>
      <FormControl>
        <FormControlLabel
          className={classes.formControlLabel}
          control={
            <Checkbox
              className={classes.checkbox}
              checked={agentEnabled}
              onChange={(_event, checked) => void setAgentEnabled(checked)}
            />
          }
          label={t("agentEnable")}
        />
        <FormHelperText>{t("agentEnableHelp")}</FormHelperText>
      </FormControl>
      <Alert severity={Object.keys(errors).length === 0 ? "success" : "info"}>
        {Object.keys(errors).length === 0
          ? t("agentConfigured")
          : t("agentNotConfigured")}
      </Alert>
      <FormHelperText>
        {configurationSource === "server"
          ? "当前使用服务器默认配置"
          : "当前使用本地配置"}
      </FormHelperText>
      {(credentialBackendUnavailable ||
        migrationError instanceof AgentCredentialsBackendUnavailableError) && (
        <Alert severity="warning">
          {t("agentCredentialBackendUnavailable")}
        </Alert>
      )}
      {(snapshot.storageError ||
        (migrationError != undefined &&
          !(
            migrationError instanceof AgentCredentialsBackendUnavailableError
          )) ||
        saveFailed) && (
        <Alert severity="error">{t("agentSettingsStorageError")}</Alert>
      )}
      {!migrationReady && migrationError == undefined && (
        <Alert severity="info">{t("agentSettingsLoading")}</Alert>
      )}
      {revisionConflict && (
        <Alert severity="warning">{t("agentSettingsRevisionConflict")}</Alert>
      )}
      {plaintextLockUnavailable && (
        <Alert severity="warning">{t("agentPlaintextLockUnavailable")}</Alert>
      )}
      <Stack direction="row" gap={1} alignItems="flex-end">
        <FormControl fullWidth>
          <FormLabel id="agent-profile-label">{t("agentProfile")}:</FormLabel>
          <Select<string>
            disabled={saving || !formReady}
            inputProps={{ "aria-label": t("agentProfile") }}
            value={selectedProfileId}
            onChange={(event) => {
              setSelectedProfileId(event.target.value);
              setRenameOpen(false);
            }}
          >
            {profiles.map((profile) => (
              <MenuItem key={profile.id} value={profile.id}>
                {profile.name}
                {profile.id === draft.activeProfileId
                  ? ` (${t("agentProfileActive")})`
                  : ""}
              </MenuItem>
            ))}
            {orgProfile != undefined && (
              <MenuItem value={ORG_AGENT_PROFILE_ID}>
                {t("agentProfileOrganization")}
              </MenuItem>
            )}
          </Select>
        </FormControl>
        <IconButton
          aria-label={t("agentProfileCreate")}
          disabled={saving || !formReady}
          onClick={createProfile}
        >
          <AddOutlinedIcon />
        </IconButton>
        <IconButton
          aria-label={t("agentProfileCopy")}
          disabled={saving || !formReady || selectedProfile == undefined}
          onClick={copyProfile}
        >
          <ContentCopyOutlinedIcon />
        </IconButton>
        <IconButton
          aria-label={t("agentProfileRename")}
          disabled={saving || !formReady || selectedStoredProfile == undefined}
          onClick={openRenameProfile}
        >
          <EditOutlinedIcon />
        </IconButton>
        <IconButton
          aria-label={t("agentProfileDelete")}
          disabled={
            saving ||
            !formReady ||
            selectedStoredProfile == undefined ||
            profiles.length <= 1
          }
          onClick={deleteProfile}
        >
          <DeleteOutlineIcon />
        </IconButton>
      </Stack>
      <Button
        disabled={
          saving ||
          !formReady ||
          selectedStoredProfile == undefined ||
          selectedStoredProfile.id === draft.activeProfileId
        }
        onClick={setDefaultProfile}
        size="small"
        variant="outlined"
      >
        {t("agentProfileSetDefault")}
      </Button>
      {organizationProfileSelected && (
        <Alert severity="info">{t("agentProfileOrganizationManaged")}</Alert>
      )}
      <Dialog
        open={renameOpen}
        onClose={() => {
          setRenameOpen(false);
        }}
      >
        <DialogTitle>{t("agentProfileRenameTitle")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={t("agentProfileName")}
            margin="dense"
            value={renameValue}
            onChange={(event) => {
              setRenameValue(event.target.value);
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setRenameOpen(false);
            }}
          >
            {t("agentProfileRenameCancel")}
          </Button>
          <Button
            disabled={renameValue.trim() === ""}
            onClick={renameProfile}
            variant="contained"
          >
            {t("agentProfileRenameSave")}
          </Button>
        </DialogActions>
      </Dialog>
      <FormControl fullWidth>
        <FormLabel id="agent-llm-provider-label">
          {t("agentLlmProvider")}:
        </FormLabel>
        <Select<AgentLlmProvider>
          disabled={saving || !formReady || organizationProfileSelected}
          inputProps={{ "aria-label": t("agentLlmProvider") }}
          value={selectedProfile?.provider ?? DEFAULT_AGENT_LLM_PROVIDER}
          onChange={(event) => {
            updateSelectedProfile((profile) => ({
              ...profile,
              provider: event.target.value,
            }));
          }}
        >
          <MenuItem value="anthropic">{t("agentProviderAnthropic")}</MenuItem>
          <MenuItem value="openai-compatible">
            {t("agentProviderOpenAICompatible")}
          </MenuItem>
        </Select>
      </FormControl>
      <TextField
        disabled={saving || !formReady || organizationProfileSelected}
        fullWidth
        label={t("agentLlmModel")}
        value={providerSettings?.model ?? ""}
        error={errors.model != undefined}
        helperText={helperText(errors.model)}
        onChange={(event) => {
          updateProviderSettings({ model: event.target.value });
        }}
      />
      <TextField
        disabled={saving || !formReady || organizationProfileSelected}
        fullWidth
        type="password"
        autoComplete="off"
        label={t("agentLlmApiKey")}
        value={providerSettings?.apiKey ?? ""}
        error={errors.apiKey != undefined}
        helperText={helperText(errors.apiKey)}
        onChange={(event) => {
          updateProviderSettings({ apiKey: event.target.value });
        }}
      />
      <Alert
        severity={
          desktop && snapshot.credentialStorage === "secure"
            ? "info"
            : "warning"
        }
      >
        {desktop && snapshot.credentialStorage === "secure"
          ? t("agentDesktopCredentialStorageInfo")
          : desktop && snapshot.credentialResaveRequired
            ? t("agentDesktopLegacyPlaintextCredentialStorageWarning")
            : desktop
              ? t("agentDesktopPlaintextCredentialStorageWarning")
              : t("agentWebCredentialStorageWarning")}
      </Alert>
      <TextField
        disabled={saving || !formReady || organizationProfileSelected}
        fullWidth
        type="url"
        label={t("agentLlmBaseUrl")}
        value={providerSettings?.baseUrl ?? ""}
        error={errors.baseUrl != undefined}
        helperText={helperText(errors.baseUrl)}
        onChange={(event) => {
          updateProviderSettings({ baseUrl: event.target.value });
        }}
      />
      {!desktop && (
        <>
          <TextField
            disabled={saving || !formReady}
            fullWidth
            type="url"
            label={t("agentVtdEndpoint")}
            value={draft.vtdEndpoint}
            error={errors.vtdEndpoint != undefined}
            helperText={helperText(errors.vtdEndpoint)}
            onChange={(event) => {
              setDirty(true);
              setRevisionConflict(false);
              setDraft((current) => ({
                ...current,
                vtdEndpoint: event.target.value,
              }));
            }}
          />
          <TextField
            disabled={saving || !formReady}
            fullWidth
            type="password"
            autoComplete="off"
            label={t("agentVtdAuthToken")}
            value={draft.vtdAuthToken}
            error={errors.vtdAuthToken != undefined}
            helperText={helperText(errors.vtdAuthToken)}
            onChange={(event) => {
              setDirty(true);
              setRevisionConflict(false);
              setDraft((current) => ({
                ...current,
                vtdAuthToken: event.target.value,
              }));
            }}
          />
        </>
      )}
      {desktop && <DesktopVtdCliSettings />}
      <Button
        disabled={
          (!dirty && !snapshot.credentialResaveRequired) || saving || !formReady
        }
        onClick={() => void commit()}
        variant="contained"
      >
        {saving ? t("agentSaving") : t("agentSave")}
      </Button>
      <Divider />
      <AgentPromptSettings />
      <Divider />
      <AgentMemorySettings />
    </Stack>
  );
}

/**
 * Editing surface for the agent's instructions and skills.
 *
 * Edits are held locally and written on save so a half-typed skill body never reaches a live
 * conversation. Built-in skills are edited as overrides, so "Reset" always restores the shipped
 * text even after the built-in has been updated.
 */
type SkillView = "edit" | "preview";

const AUTOMATIC_REMOTE_SKILL_IDS = new Set([
  "lichtblick-layouts",
  "lichtblick-extensions",
]);

function formatRelativeSyncTime(syncedAt: string | undefined): string | undefined {
  if (syncedAt == undefined) {
    return undefined;
  }
  const timestamp = Date.parse(syncedAt);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (elapsedMs < 60_000) {
    return formatter.format(0, "second");
  }
  if (elapsedMs < 60 * 60_000) {
    return formatter.format(-Math.floor(elapsedMs / 60_000), "minute");
  }
  if (elapsedMs < 24 * 60 * 60_000) {
    return formatter.format(-Math.floor(elapsedMs / (60 * 60_000)), "hour");
  }
  return formatter.format(-Math.floor(elapsedMs / (24 * 60 * 60_000)), "day");
}

function AgentPromptSettings(): React.ReactElement {
  const { classes } = useStyles();
  const { t } = useTranslation("appSettings");
  const appConfiguration = useAppConfiguration();
  const [draft, setDraft] = useState<AgentPromptCustomization>(() =>
    readAgentPromptCustomization(appConfiguration),
  );
  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [skillView, setSkillView] = useState<SkillView>("edit");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const resolvedWorkspace = resolveWorkspace(appConfiguration);
  const workspace = resolveVizServerConfigured(resolvedWorkspace)
    ? resolvedWorkspace
    : undefined;
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [publishSucceeded, setPublishSucceeded] = useState(false);
  const [remoteBootstrap, setRemoteBootstrap] = useState<AgentBootstrap | undefined>(() =>
    workspace == undefined
      ? undefined
      : readCachedAgentBootstrap(workspace),
  );
  const [remoteSkillsFetching, setRemoteSkillsFetching] = useState(false);
  const [remoteSkillsFetchError, setRemoteSkillsFetchError] = useState<string>();
  const [remoteSkillsFetchSucceeded, setRemoteSkillsFetchSucceeded] = useState(false);
  const [expandedRemoteSkillId, setExpandedRemoteSkillId] = useState<string>();

  const skills = useMemo(() => resolveSkills(draft), [draft]);
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
  const isBuiltIn =
    selectedSkill != undefined && SKILL_REGISTRY.has(selectedSkill.id);
  const isOverridden =
    selectedSkill != undefined &&
    draft.skillOverrides[selectedSkill.id] != undefined;
  const remoteSkills = remoteBootstrap?.prompt?.customSkills ?? [];
  const remoteSkillOverrideIds = Object.keys(
    remoteBootstrap?.prompt?.skillOverrides ?? {},
  ).sort();
  const relativeSyncedAt = formatRelativeSyncTime(remoteBootstrap?.syncedAt);

  useEffect(() => {
    setRemoteBootstrap(
      workspace == undefined ? undefined : readCachedAgentBootstrap(workspace),
    );
    setRemoteSkillsFetchError(undefined);
    setRemoteSkillsFetchSucceeded(false);
    setExpandedRemoteSkillId(undefined);
  }, [workspace]);

  const update = (next: AgentPromptCustomization) => {
    setDraft(next);
    setSaved(false);
    setError(undefined);
  };

  const save = async () => {
    try {
      await writeAgentPromptCustomization(appConfiguration, draft);
      setError(undefined);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaved(false);
    }
  };

  const publish = async () => {
    if (workspace == undefined) {
      return;
    }
    setPublishing(true);
    setPublishError(undefined);
    setPublishSucceeded(false);
    try {
      const bootstrap = await publishCustomization(workspace, draft);
      setRemoteBootstrap(bootstrap);
      setPublishSucceeded(true);
    } catch (caught) {
      setPublishError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setPublishing(false);
    }
  };

  const refreshRemoteSkills = async () => {
    if (workspace == undefined) {
      return;
    }
    setRemoteSkillsFetching(true);
    setRemoteSkillsFetchError(undefined);
    setRemoteSkillsFetchSucceeded(false);
    try {
      const response = await fetchAgentBootstrap(workspace);
      setRemoteBootstrap(
        response.unchanged === true
          ? readCachedAgentBootstrap(workspace)
          : response,
      );
      setRemoteSkillsFetchSucceeded(true);
    } catch (caught) {
      setRemoteSkillsFetchError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRemoteSkillsFetching(false);
    }
  };

  return (
    <Stack gap={1.5}>
      <FormLabel>{t("agentPrompt")}:</FormLabel>
      <FormHelperText>{t("agentPromptHelp")}</FormHelperText>

      {workspace != undefined && (
        <Stack gap={1} data-testid="agent-remote-skills">
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <FormLabel>{t("agentRemoteSkills")}</FormLabel>
            <Button
              disabled={remoteSkillsFetching}
              onClick={() => void refreshRemoteSkills()}
              size="small"
              variant="outlined"
            >
              {remoteSkillsFetching
                ? t("agentRemoteSkillsFetching")
                : t("agentRemoteSkillsFetch")}
            </Button>
          </Stack>
          <FormHelperText>
            {t("agentRemoteSkillsVersion", {
              version: remoteBootstrap?.version.slice(0, 8) ?? "—",
            })}
            {" · "}
            {relativeSyncedAt == undefined
              ? t("agentRemoteSkillsNeverSynced")
              : t("agentRemoteSkillsLastSynced", { time: relativeSyncedAt })}
          </FormHelperText>
          <FormHelperText>{t("agentRemoteSkillsMergeHelp")}</FormHelperText>

          {remoteSkills.length === 0 ? (
            <FormHelperText>{t("agentRemoteSkillsEmpty")}</FormHelperText>
          ) : (
            <List disablePadding aria-label={t("agentRemoteSkills")}>
              {remoteSkills.map((skill) => {
                const expanded = expandedRemoteSkillId === skill.id;
                const automatic = AUTOMATIC_REMOTE_SKILL_IDS.has(skill.id);
                const bodyId = `agent-remote-skill-body-${skill.id}`;
                return (
                  <ListItem
                    className={classes.remoteSkillItem}
                    disableGutters
                    key={skill.id}
                  >
                    <Stack className={classes.remoteSkillItemContent} gap={0.5}>
                      <Button
                        aria-controls={expanded ? bodyId : undefined}
                        aria-expanded={expanded}
                        aria-label={t(
                          expanded
                            ? "agentRemoteSkillCollapse"
                            : "agentRemoteSkillExpand",
                          { name: skill.name },
                        )}
                        className={classes.remoteSkillButton}
                        onClick={() => {
                          setExpandedRemoteSkillId(expanded ? undefined : skill.id);
                        }}
                      >
                        <Stack className={classes.remoteSkillItemContent} gap={0.25}>
                          <Stack direction="row" alignItems="center" gap={1}>
                            <strong>{skill.name}</strong>
                            <code>{skill.id}</code>
                            <Chip
                              label={t(
                                automatic
                                  ? "agentRemoteSkillAutomatic"
                                  : "agentRemoteSkillOrganization",
                              )}
                              size="small"
                            />
                          </Stack>
                          <span
                            className={classes.remoteSkillWhenToUse}
                            title={skill.whenToUse}
                          >
                            {skill.whenToUse}
                          </span>
                        </Stack>
                      </Button>
                      {expanded && (
                        <div
                          className={classes.remoteSkillBody}
                          data-testid={`agent-remote-skill-body-${skill.id}`}
                          id={bodyId}
                        >
                          <AgentMarkdown>{skill.body}</AgentMarkdown>
                        </div>
                      )}
                    </Stack>
                  </ListItem>
                );
              })}
            </List>
          )}

          {remoteSkillOverrideIds.length > 0 && (
            <Stack gap={0.5}>
              <FormLabel>{t("agentRemoteSkillOverrides")}</FormLabel>
              <Stack direction="row" flexWrap="wrap" gap={0.5}>
                {remoteSkillOverrideIds.map((skillId) => (
                  <Chip key={skillId} label={skillId} size="small" />
                ))}
              </Stack>
            </Stack>
          )}

          {remoteSkillsFetchError != undefined && (
            <Alert severity="error">
              {t("agentRemoteSkillsFetchFailed", {
                error: remoteSkillsFetchError,
              })}
            </Alert>
          )}
          {remoteSkillsFetchSucceeded && (
            <Alert severity="success">
              {t("agentRemoteSkillsFetchSucceeded")}
            </Alert>
          )}
        </Stack>
      )}

      {workspace != undefined && <Divider />}

      <TextField
        fullWidth
        multiline
        minRows={3}
        label={t("agentInstructions")}
        placeholder={t("agentInstructionsPlaceholder")}
        value={draft.instructions}
        onChange={(event) => {
          update({ ...draft, instructions: event.target.value });
        }}
      />

      <FormControl fullWidth>
        <FormLabel id="agent-skill-label">{t("agentSkills")}:</FormLabel>
        <Select<string>
          displayEmpty
          inputProps={{ "aria-label": t("agentSkills") }}
          value={selectedSkillId}
          onChange={(event) => {
            setSelectedSkillId(event.target.value);
          }}
        >
          <MenuItem value="">{t("agentSkillSelect")}</MenuItem>
          {skills.map((skill) => (
            <MenuItem key={skill.id} value={skill.id}>
              {skill.id}
              {draft.skillOverrides[skill.id] != undefined
                ? ` ${t("agentSkillEdited")}`
                : ""}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {selectedSkill != undefined && (
        <>
          <FormHelperText>{selectedSkill.whenToUse}</FormHelperText>
          <ToggleButtonGroup
            color="primary"
            exclusive
            size="small"
            value={skillView}
            onChange={(_event, next?: SkillView) => {
              if (next != undefined) {
                setSkillView(next);
              }
            }}
          >
            <ToggleButton value="edit">{t("agentSkillEdit")}</ToggleButton>
            <ToggleButton value="preview">
              {t("agentSkillPreview")}
            </ToggleButton>
          </ToggleButtonGroup>
          {skillView === "preview" ? (
            // Skills are markdown and the agent consumes them as such; previewing the rendered form
            // is how you catch a broken table or an unclosed fence before the agent reads it.
            <div
              className={classes.skillPreview}
              data-testid="agent-skill-preview"
            >
              <AgentMarkdown>{selectedSkill.body}</AgentMarkdown>
            </div>
          ) : (
            <TextField
              fullWidth
              multiline
              minRows={8}
              maxRows={20}
              label={selectedSkill.name}
              value={selectedSkill.body}
              onChange={(event) => {
                const body = event.target.value;
                if (isBuiltIn) {
                  update({
                    ...draft,
                    skillOverrides: {
                      ...draft.skillOverrides,
                      [selectedSkill.id]: body,
                    },
                  });
                } else {
                  update({
                    ...draft,
                    customSkills: draft.customSkills.map((skill) =>
                      skill.id === selectedSkill.id
                        ? { ...skill, body }
                        : skill,
                    ),
                  });
                }
              }}
            />
          )}
          {isBuiltIn ? (
            <Button
              disabled={!isOverridden}
              onClick={() => {
                const { [selectedSkill.id]: _removed, ...rest } =
                  draft.skillOverrides;
                update({ ...draft, skillOverrides: rest });
              }}
            >
              {t("agentSkillReset")}
            </Button>
          ) : (
            <Button
              color="error"
              onClick={() => {
                update({
                  ...draft,
                  customSkills: draft.customSkills.filter(
                    (skill) => skill.id !== selectedSkill.id,
                  ),
                });
                setSelectedSkillId("");
              }}
            >
              {t("agentSkillDelete")}
            </Button>
          )}
        </>
      )}

      <Button
        onClick={() => {
          const index = draft.customSkills.length + 1;
          const id = `custom-skill-${String(index)}`;
          update({
            ...draft,
            customSkills: [
              ...draft.customSkills,
              {
                id,
                name: t("agentSkillNewName"),
                whenToUse: t("agentSkillNewWhenToUse"),
                body: t("agentSkillNewBody"),
              },
            ],
          });
          setSelectedSkillId(id);
        }}
      >
        {t("agentSkillAdd")}
      </Button>

      {error != undefined && <Alert severity="error">{error}</Alert>}
      {saved && <Alert severity="success">{t("agentPromptSaved")}</Alert>}
      {publishError != undefined && (
        <Alert severity="error">发布失败：{publishError}</Alert>
      )}
      {publishSucceeded && <Alert severity="success">发布成功</Alert>}

      <Button onClick={() => void save()} variant="contained">
        {t("agentPromptSave")}
      </Button>
      <Button
        disabled={workspace == undefined || publishing}
        onClick={() => void publish()}
        variant="outlined"
      >
        {publishing ? "正在发布…" : "发布到服务器"}
      </Button>
    </Stack>
  );
}

/**
 * Memory is written by the agent itself, so this exists to keep the user in control of what was
 * kept. Deletions apply immediately rather than through the credential draft/commit flow, because
 * memories are ordinary configuration, not secrets.
 */
function AgentMemorySettings(): React.ReactElement {
  const { t } = useTranslation("appSettings");
  const appConfiguration = useAppConfiguration();
  const [memories, setMemories] = useState<MemoryEntry[]>(() =>
    readAgentMemories(appConfiguration),
  );

  useEffect(() => {
    const listener = () => {
      setMemories(readAgentMemories(appConfiguration));
    };
    appConfiguration.addChangeListener(AppSetting.AGENT_MEMORY, listener);
    return () => {
      appConfiguration.removeChangeListener(AppSetting.AGENT_MEMORY, listener);
    };
  }, [appConfiguration]);

  return (
    <Stack gap={1}>
      <FormLabel>{t("agentMemory")}:</FormLabel>
      <FormHelperText>{t("agentMemoryHelp")}</FormHelperText>
      {memories.length === 0 ? (
        <FormHelperText>{t("agentMemoryEmpty")}</FormHelperText>
      ) : (
        <>
          <List dense disablePadding>
            {memories.map((memory) => (
              <ListItem
                key={memory.id}
                disableGutters
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label={t("agentMemoryForget", { text: memory.text })}
                    onClick={() =>
                      void removeAgentMemory(appConfiguration, memory.id)
                    }
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemText primary={memory.text} />
              </ListItem>
            ))}
          </List>
          <Button
            color="error"
            onClick={() => void clearAgentMemories(appConfiguration)}
            variant="outlined"
          >
            {t("agentMemoryClear")}
          </Button>
        </>
      )}
    </Stack>
  );
}

export function AgentSettings({
  isDesktop,
  onCommitHandlerChange,
}: {
  isDesktop: boolean;
  onCommitHandlerChange?: (
    handler: AgentSettingsCommitHandler | undefined,
  ) => void;
}): React.ReactElement {
  return (
    <AgentSettingsForm
      desktop={isDesktop}
      onCommitHandlerChange={onCommitHandlerChange}
    />
  );
}
