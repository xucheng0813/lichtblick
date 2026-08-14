// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { RawAudio } from "@foxglove/schemas";
import { Typography } from "@mui/material";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import { SettingsTreeAction, Topic } from "@lichtblick/suite";
import EmptyState from "@lichtblick/suite-base/components/EmptyState";

import {
  AudioPlaybackScheduler,
  AudioPlaybackSource,
  createAudioPlaybackScheduler,
} from "./audioPlayback";
import { RAW_AUDIO_SCHEMA_NAME, audioSettingsActionReducer, useAudioSettingsTree } from "./settings";
import { DEFAULT_CONFIG, AudioConfig, AudioPanelProps } from "./types";
import { envelopeToCanvasPoints, WaveformBuffer } from "./waveform";

const useStyles = makeStyles()((theme) => ({
  root: {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  canvas: {
    width: "100%",
    height: "100%",
    display: "block",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
  },
  error: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    padding: theme.spacing(1),
    color: theme.palette.error.main,
    zIndex: 1,
  },
  suspendedOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    cursor: "pointer",
    zIndex: 2,
  },
}));

function getAudioContextClass(): typeof AudioContext | undefined {
  return typeof AudioContext === "undefined" ? undefined : AudioContext;
}

export function AudioPanel({ context }: AudioPanelProps): React.JSX.Element {
  const { classes } = useStyles();
  const { t } = useTranslation("audio");

  const [config, setConfig] = useState<AudioConfig>(() => ({
    ...DEFAULT_CONFIG,
    ...(context.initialState as Partial<AudioConfig>),
  }));
  const [renderDone, setRenderDone] = useState<() => void>(() => () => {});
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [waveformTick, setWaveformTick] = useState(0);
  // Probed once: environments without AudioContext (e.g. jsdom) show a hint instead of crashing.
  const [audioUnsupported] = useState<boolean>(() => getAudioContextClass() == undefined);
  const [isSuspended, setIsSuspended] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformRef = useRef<WaveformBuffer | undefined>(undefined);
  waveformRef.current ??= new WaveformBuffer();
  const audioRef = useRef<
    | {
        ctx: AudioContext;
        gain: GainNode;
        scheduler: AudioPlaybackScheduler;
      }
    | undefined
  >(undefined);

  // Create the AudioContext, gain node, and scheduler once. The scheduler receives only the
  // minimal audio surface it needs.
  useEffect(() => {
    if (audioUnsupported) {
      return;
    }
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const scheduler = createAudioPlaybackScheduler(
      {
        getCurrentTime: () => ctx.currentTime,
        destination: gain,
        createBuffer: (channels, length, sampleRate) =>
          ctx.createBuffer(channels, length, sampleRate),
        createBufferSource: () =>
          ctx.createBufferSource() as unknown as AudioPlaybackSource,
      },
      {
        onError: (message) => {
          setError(message);
          waveformRef.current?.reset();
          setWaveformTick((tick) => tick + 1);
        },
        onScheduled: (samples, sampleRate) => {
          waveformRef.current?.push(samples, sampleRate);
          setWaveformTick((tick) => tick + 1);
        },
      },
    );
    audioRef.current = { ctx, gain, scheduler };
    const handleStateChange = () => {
      setIsSuspended(ctx.state === "suspended");
    };
    ctx.onstatechange = handleStateChange;
    setIsSuspended(ctx.state === "suspended");

    return () => {
      ctx.onstatechange = null;
      scheduler.dispose();
      void ctx.close().catch(() => {});
      audioRef.current = undefined;
    };
  }, [audioUnsupported]);

  // Apply volume/muted to the gain node.
  useEffect(() => {
    const gain = audioRef.current?.gain;
    if (gain != undefined) {
      gain.gain.value = config.muted ? 0 : config.volume;
    }
  }, [config.muted, config.volume]);

  // Subscribe to the selected topic with preload:false — only messages for the current frame
  // are delivered, so audio never triggers a full-file preload.
  useEffect(() => {
    if (config.topicPath === "") {
      return;
    }
    context.subscribe([{ topic: config.topicPath, preload: false }]);
    return () => {
      context.unsubscribeAll();
    };
  }, [config.topicPath, context]);

  // Any topic change (including clearing the selection) stops scheduled audio and resets the
  // waveform, anchors, and error state.
  useEffect(() => {
    audioRef.current?.scheduler.flush();
    waveformRef.current?.reset();
    setError(undefined);
    setWaveformTick((tick) => tick + 1);
  }, [config.topicPath]);

  // Wire the render callback: watch the fields we consume, filter frames by the current
  // topicPath + schemaName, and hand chunks to the scheduler.
  useLayoutEffect(() => {
    context.watch("topics");
    context.watch("currentFrame");
    context.watch("didSeek");

    context.onRender = (renderState, done) => {
      setRenderDone(() => done);

      if (renderState.didSeek === true) {
        audioRef.current?.scheduler.flush();
        waveformRef.current?.reset();
        setError(undefined);
        setWaveformTick((tick) => tick + 1);
      }

      const frame = renderState.currentFrame;
      if (frame != undefined) {
        for (const message of frame) {
          // Ignore leftover frames from a previous subscription: after switching topics the
          // frame may still contain messages from the old topic/schema.
          if (message.topic !== config.topicPath || message.schemaName !== RAW_AUDIO_SCHEMA_NAME) {
            continue;
          }
          const rawAudio = message.message as Partial<RawAudio>;
          if (rawAudio.timestamp == undefined) {
            continue;
          }
          audioRef.current?.scheduler.schedule({
            timestamp: rawAudio.timestamp,
            data: rawAudio.data!,
            format: rawAudio.format ?? "",
            sampleRate: rawAudio.sample_rate ?? Number.NaN,
            numberOfChannels: rawAudio.number_of_channels ?? Number.NaN,
          });
        }
      }

      if (renderState.topics != undefined) {
        setTopics(renderState.topics);
      }
    };

    return () => {
      context.onRender = undefined;
    };
  }, [config.topicPath, context]);

  // Settings tree: topic dropdown (RawAudio only), volume, muted.
  const settingsActionHandler = useCallback((action: SettingsTreeAction) => {
    setConfig((prevConfig) => audioSettingsActionReducer(prevConfig, action));
  }, []);

  const settingsTree = useAudioSettingsTree({ config, topics, error });
  useEffect(() => {
    context.updatePanelSettingsEditor({
      actionHandler: settingsActionHandler,
      nodes: settingsTree,
    });
  }, [context, settingsActionHandler, settingsTree]);

  // Persist config changes.
  useEffect(() => {
    context.saveState(config);
  }, [config, context]);

  // Auto-select the only RawAudio topic when none is chosen yet.
  useEffect(() => {
    const candidates = topics.filter((topic) => topic.schemaName === RAW_AUDIO_SCHEMA_NAME);
    if (config.topicPath === "" && candidates.length === 1) {
      setConfig((prevConfig) => ({ ...prevConfig, topicPath: candidates[0]!.name }));
    }
  }, [config.topicPath, topics]);

  // Draw the waveform envelope on the canvas.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas == undefined) {
      return;
    }
    const dpr = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx2d = canvas.getContext("2d");
    if (ctx2d == undefined) {
      return;
    }
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    const buckets = waveformRef.current?.getBuckets() ?? [];
    if (buckets.length > 0) {
      ctx2d.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (const point of envelopeToCanvasPoints(buckets, canvas.width, canvas.height)) {
        ctx2d.moveTo(point.x, point.topY);
        ctx2d.lineTo(point.x, point.bottomY);
      }
      ctx2d.stroke();
    }
  }, [renderDone, waveformTick]);

  // Notify the message pipeline that rendering is complete — exactly once per onRender call.
  useEffect(() => {
    renderDone();
  }, [renderDone]);

  const resumeAudio = useCallback(() => {
    void audioRef.current?.ctx.resume().catch(() => {});
  }, []);

  const hasWaveform = !waveformRef.current.isEmpty();

  return (
    <div className={classes.root}>
      {audioUnsupported ? (
        <div className={classes.overlay}>
          <EmptyState>{t("audioUnsupported")}</EmptyState>
        </div>
      ) : (
        <>
          <canvas ref={canvasRef} className={classes.canvas} />
          {error != undefined && <div className={classes.error}>{error}</div>}
          {config.topicPath === "" && (
            <div className={classes.overlay}>
              <EmptyState>{t("emptyState")}</EmptyState>
            </div>
          )}
          {config.topicPath !== "" && !hasWaveform && error == undefined && (
            <div className={classes.overlay}>
              <EmptyState>{t("noAudioData")}</EmptyState>
            </div>
          )}
          {isSuspended && (
            <div
              className={classes.suspendedOverlay}
              role="button"
              tabIndex={0}
              onClick={resumeAudio}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  resumeAudio();
                }
              }}
            >
              <Typography variant="body2">{t("clickToEnableSound")}</Typography>
            </div>
          )}
        </>
      )}
    </div>
  );
}
