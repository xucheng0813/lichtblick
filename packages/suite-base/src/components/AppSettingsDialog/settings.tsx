// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import Brightness5Icon from "@mui/icons-material/Brightness5";
import ComputerIcon from "@mui/icons-material/Computer";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import QuestionAnswerOutlinedIcon from "@mui/icons-material/QuestionAnswerOutlined";
import WebIcon from "@mui/icons-material/Web";
import {
  Alert,
  Autocomplete,
  Button,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  ToggleButtonGroupProps,
} from "@mui/material";
import moment from "moment-timezone";
import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import { filterMap } from "@lichtblick/den/collection";
import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import OsContextSingleton from "@lichtblick/suite-base/OsContextSingleton";
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
  AgentSettingsConflictError,
  AgentSettingsDraft,
  commitAgentSettings,
  createAgentSettingsDraft,
  selectAgentConfiguration,
  useAgentSettings,
  validateAgentConfiguration,
} from "@lichtblick/suite-base/services/agent/agentSettings";
import { LaunchPreferenceValue } from "@lichtblick/suite-base/types/LaunchPreferenceValue";
import { TimeDisplayMethod } from "@lichtblick/suite-base/types/panels";
import { formatTime } from "@lichtblick/suite-base/util/formatTime";
import { formatTimeRaw } from "@lichtblick/suite-base/util/time";

const MESSAGE_RATES = [1, 3, 5, 10, 15, 20, 30, 60];
const LANGUAGE_OPTIONS: { key: Language; value: string }[] = [{ key: "en", value: "English" }];

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
  const [colorScheme = "system", setColorScheme] = useAppConfigurationValue<string>(
    AppSetting.COLOR_SCHEME,
  );
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
  type Option = { key: string; label: string; data?: string; divider?: boolean };

  const { t } = useTranslation("appSettings");
  const [timezone, setTimezone] = useAppConfigurationValue<string>(AppSetting.TIMEZONE);
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

  const allItems = useMemo(() => [...fixedItems, ...timezoneItems], [fixedItems, timezoneItems]);

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
        onChange={(_, value?: TimeDisplayMethod) => value != undefined && void setTimeFormat(value)}
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
  const [preference, setPreference] = useAppConfigurationValue<string | undefined>(
    AppSetting.LAUNCH_PREFERENCE,
  );
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
        onChange={(_, value?: string) => value != undefined && void setPreference(value)}
      >
        <ToggleButton value={LaunchPreferenceValue.WEB} className={classes.toggleButton}>
          <WebIcon /> {t("webApp")}
        </ToggleButton>
        <ToggleButton value={LaunchPreferenceValue.DESKTOP} className={classes.toggleButton}>
          <ComputerIcon /> {t("desktopApp")}
        </ToggleButton>
        <ToggleButton value={LaunchPreferenceValue.ASK} className={classes.toggleButton}>
          <QuestionAnswerOutlinedIcon /> {t("askEachTime")}
        </ToggleButton>
      </ToggleButtonGroup>
    </Stack>
  );
}

export function MessageFramerate(): React.ReactElement {
  const { t } = useTranslation("appSettings");
  const [messageRate, setMessageRate] = useAppConfigurationValue<number>(AppSetting.MESSAGE_RATE);
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

  const [stepSize = defaultStepSize, setStepSize] = useAppConfigurationValue<number>(
    AppSetting.DEFAULT_STEP_SIZE,
  );

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
  const [updatesEnabled = false, setUpdatedEnabled] = useAppConfigurationValue<boolean>(
    AppSetting.UPDATES_ENABLED,
  );

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
  const [selectedLanguage = "en", setSelectedLanguage] = useAppConfigurationValue<Language>(
    AppSetting.LANGUAGE,
  );
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
      <Select<Language> value={selectedLanguage} fullWidth onChange={onChangeLanguage}>
        {options.map((option) => (
          <MenuItem key={option.key} value={option.key}>
            {option.text}
          </MenuItem>
        ))}
      </Select>
    </Stack>
  );
}

export type AgentSettingsCommitHandler = () => Promise<boolean>;

type AgentSettingsFormProps = {
  desktop: boolean;
  onCommitHandlerChange?: (handler: AgentSettingsCommitHandler | undefined) => void;
};

function AgentSettingsForm({
  desktop,
  onCommitHandlerChange,
}: AgentSettingsFormProps): React.ReactElement {
  const { t } = useTranslation("appSettings");
  const appConfiguration = useAppConfiguration();
  const {
    credentialBackendUnavailable,
    migrationError,
    migrationReady,
    snapshot,
  } = useAgentSettings(appConfiguration, { desktop });
  const [draft, setDraft] = useState<AgentSettingsDraft>(() => createAgentSettingsDraft(snapshot));
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
    if (draft.revision !== snapshot.revision && commitInFlightRef.current == undefined) {
      if (dirty) {
        setRevisionConflict(true);
      }
      setDirty(false);
      setDraft(createAgentSettingsDraft(snapshot));
    } else if (!dirty) {
      setDraft(createAgentSettingsDraft(snapshot));
    }
  }, [dirty, draft.revision, migrationReady, snapshot]);

  const formReady = migrationReady && draft.revision === snapshot.revision;

  const providerSettings =
    draft.provider === "anthropic" ? draft.anthropic : draft.openAiCompatible;
  const selectedConfiguration = selectAgentConfiguration(
    {
      ...draft,
      credentialResaveRequired: snapshot.credentialResaveRequired,
      credentialStorage: snapshot.credentialStorage,
      revision: snapshot.revision,
      storageError: snapshot.storageError,
    },
    { desktop },
  );
  const errors = validateAgentConfiguration(selectedConfiguration);

  const updateProviderSettings = useCallback((update: Partial<AgentSettingsDraft["anthropic"]>) => {
    setDirty(true);
    setRevisionConflict(false);
    setDraft((current) => {
      const key = current.provider === "anthropic" ? "anthropic" : "openAiCompatible";
      return {
        ...current,
        [key]: { ...current[key], ...update },
      };
    });
  }, []);

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
        } else if (
          error instanceof AgentCredentialsBackendUnavailableError
        ) {
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
  }, [appConfiguration, desktop, dirty, draft, formReady, snapshot.credentialResaveRequired]);

  useEffect(() => {
    onCommitHandlerChange?.(commit);
    return () => {
      onCommitHandlerChange?.(undefined);
    };
  }, [commit, onCommitHandlerChange]);

  const helperText = (error: AgentConfigurationErrors[keyof AgentConfigurationErrors]) => {
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
      <Alert severity={Object.keys(errors).length === 0 ? "success" : "info"}>
        {Object.keys(errors).length === 0 ? t("agentConfigured") : t("agentNotConfigured")}
      </Alert>
      {(credentialBackendUnavailable ||
        migrationError instanceof AgentCredentialsBackendUnavailableError) && (
        <Alert severity="warning">{t("agentCredentialBackendUnavailable")}</Alert>
      )}
      {(snapshot.storageError ||
        (migrationError != undefined &&
          !(migrationError instanceof AgentCredentialsBackendUnavailableError)) ||
        saveFailed) && <Alert severity="error">{t("agentSettingsStorageError")}</Alert>}
      {!migrationReady && migrationError == undefined && (
        <Alert severity="info">{t("agentSettingsLoading")}</Alert>
      )}
      {revisionConflict && <Alert severity="warning">{t("agentSettingsRevisionConflict")}</Alert>}
      {plaintextLockUnavailable && (
        <Alert severity="warning">{t("agentPlaintextLockUnavailable")}</Alert>
      )}
      <FormControl fullWidth>
        <FormLabel id="agent-llm-provider-label">{t("agentLlmProvider")}:</FormLabel>
        <Select<AgentLlmProvider>
          disabled={saving || !formReady}
          inputProps={{ "aria-label": t("agentLlmProvider") }}
          value={draft.provider}
          onChange={(event) => {
            setDirty(true);
            setRevisionConflict(false);
            setSaveFailed(false);
            setDraft((current) => ({ ...current, provider: event.target.value }));
          }}
        >
          <MenuItem value="anthropic">{t("agentProviderAnthropic")}</MenuItem>
          <MenuItem value="openai-compatible">{t("agentProviderOpenAICompatible")}</MenuItem>
        </Select>
      </FormControl>
      <TextField
        disabled={saving || !formReady}
        fullWidth
        label={t("agentLlmModel")}
        value={providerSettings.model}
        error={errors.model != undefined}
        helperText={helperText(errors.model)}
        onChange={(event) => {
          updateProviderSettings({ model: event.target.value });
        }}
      />
      <TextField
        disabled={saving || !formReady}
        fullWidth
        type="password"
        autoComplete="off"
        label={t("agentLlmApiKey")}
        value={providerSettings.apiKey}
        error={errors.apiKey != undefined}
        helperText={helperText(errors.apiKey)}
        onChange={(event) => {
          updateProviderSettings({ apiKey: event.target.value });
        }}
      />
      <Alert severity={desktop && snapshot.credentialStorage === "secure" ? "info" : "warning"}>
        {desktop && snapshot.credentialStorage === "secure"
          ? t("agentDesktopCredentialStorageInfo")
          : desktop && snapshot.credentialResaveRequired
            ? t("agentDesktopLegacyPlaintextCredentialStorageWarning")
            : desktop
              ? t("agentDesktopPlaintextCredentialStorageWarning")
              : t("agentWebCredentialStorageWarning")}
      </Alert>
      <TextField
        disabled={saving || !formReady}
        fullWidth
        type="url"
        label={t("agentLlmBaseUrl")}
        value={providerSettings.baseUrl}
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
              setDraft((current) => ({ ...current, vtdEndpoint: event.target.value }));
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
      <Button
        disabled={(!dirty && !snapshot.credentialResaveRequired) || saving || !formReady}
        onClick={() => void commit()}
        variant="contained"
      >
        {saving ? t("agentSaving") : t("agentSave")}
      </Button>
    </Stack>
  );
}

export function AgentSettings({
  isDesktop,
  onCommitHandlerChange,
}: {
  isDesktop: boolean;
  onCommitHandlerChange?: (handler: AgentSettingsCommitHandler | undefined) => void;
}): React.ReactElement {
  return <AgentSettingsForm desktop={isDesktop} onCommitHandlerChange={onCommitHandlerChange} />;
}
