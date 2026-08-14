/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { RawAudio } from "@foxglove/schemas";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TFunction } from "i18next";

import { MessageEvent, PanelExtensionContext, RenderState, SettingsTreeAction } from "@lichtblick/suite";
import { sharedI18nObject } from "@lichtblick/suite-base/i18n";
import { getBuiltin } from "@lichtblick/suite-base/panels";

import { AudioPanel } from "./AudioPanel";
import { JITTER_BUFFER_SEC } from "./audioPlayback";

type MockGainNode = { gain: { value: number }; connect: jest.Mock };
type MockBufferSource = {
  buffer: unknown;
  connect: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
  onended: (() => void) | undefined;
};

class MockAudioContext {
  public static instances: MockAudioContext[] = [];

  public currentTime = 0;
  public state: AudioContextState = "running";
  public destination = {};
  public onstatechange: (() => void) | undefined = undefined;
  public resume = jest.fn(async () => {
    this.state = "running";
    this.onstatechange?.();
  });
  public close = jest.fn(async () => {});
  public createGain = jest.fn((): MockGainNode => ({ gain: { value: 1 }, connect: jest.fn() }));
  public createBuffer = jest.fn((_channels: number, length: number, sampleRate: number) => ({
    length,
    sampleRate,
    getChannelData: jest.fn(() => new Float32Array(length)),
  }));
  public createBufferSource = jest.fn((): MockBufferSource => ({
    buffer: undefined,
    connect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    onended: undefined,
  }));

  public constructor() {
    MockAudioContext.instances.push(this);
  }
}

let settingsActionHandler: ((action: SettingsTreeAction) => void) | undefined;

// The panel receives a PanelExtensionContext; tests type the mock as a plain object so the
// mocked methods stay plain function properties (no unbound-method/deprecation noise).
type MockContext = {
  panelElement: HTMLDivElement;
  initialState: unknown;
  watch: jest.Mock;
  subscribe: jest.Mock;
  unsubscribeAll: jest.Mock;
  saveState: jest.Mock;
  updatePanelSettingsEditor: jest.Mock;
  onRender: ((renderState: Partial<RenderState>, done: () => void) => void) | undefined;
};

const makeContext = (overrides: Partial<MockContext> = {}): MockContext => {
  const context: MockContext = {
    panelElement: document.createElement("div"),
    initialState: undefined,
    watch: jest.fn(),
    subscribe: jest.fn(),
    unsubscribeAll: jest.fn(),
    saveState: jest.fn(),
    updatePanelSettingsEditor: jest.fn(
      (settings: { actionHandler: (action: SettingsTreeAction) => void }) => {
        settingsActionHandler = settings.actionHandler;
      },
    ),
    onRender: undefined,
    ...overrides,
  };
  return context;
};

const rawAudioMessage = (
  overrides: Partial<RawAudio> & { topic?: string; schemaName?: string } = {},
): MessageEvent => {
  const { topic, schemaName, ...messageOverrides } = overrides;
  return {
    topic: topic ?? "/audio",
    schemaName: schemaName ?? "foxglove.RawAudio",
    receiveTime: { sec: 0, nsec: 0 },
    sizeInBytes: 0,
    message: {
      timestamp: { sec: 0, nsec: 0 },
      data: new Uint8Array(800),
      format: "pcm-s16",
      sample_rate: 1000,
      number_of_channels: 1,
      ...messageOverrides,
    },
  };
};

const renderPanel = (context: MockContext) => {
  return render(<AudioPanel context={context as unknown as PanelExtensionContext} />);
};

const renderFrame = (
  context: MockContext,
  renderState: Partial<RenderState>,
  done: () => void = jest.fn(),
) => {
  act(() => {
    context.onRender!(renderState, done);
  });
};

describe("AudioPanel", () => {
  beforeEach(() => {
    MockAudioContext.instances = [];
    settingsActionHandler = undefined;
    (globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext;
  });

  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
  });

  it("watches the fields it consumes and subscribes with preload:false", () => {
    const context = makeContext({ initialState: { topicPath: "/audio", volume: 1, muted: false } });
    renderPanel(context);

    expect(context.watch).toHaveBeenCalledWith("topics");
    expect(context.watch).toHaveBeenCalledWith("currentFrame");
    expect(context.watch).toHaveBeenCalledWith("didSeek");
    expect(context.subscribe).toHaveBeenCalledWith([{ topic: "/audio", preload: false }]);
  });

  it("does not subscribe when no topic is selected", () => {
    const context = makeContext();
    renderPanel(context);
    expect(context.subscribe).not.toHaveBeenCalled();
  });

  it("calls the render done callback exactly once per render", () => {
    const context = makeContext();
    renderPanel(context);

    const done = jest.fn();
    renderFrame(context, { topics: [] }, done);
    expect(done).toHaveBeenCalledTimes(1);

    const done2 = jest.fn();
    renderFrame(context, { topics: [] }, done2);
    expect(done2).toHaveBeenCalledTimes(1);
  });

  it("calls done exactly once even when scheduling fails", () => {
    const context = makeContext({ initialState: { topicPath: "/audio" } });
    renderPanel(context);

    const done = jest.fn();
    renderFrame(context, { currentFrame: [rawAudioMessage({ format: "pcm-u8" })] }, done);

    expect(done).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Unsupported audio format/)).toBeDefined();
  });

  it("calls done exactly once when the audio context throws while scheduling", () => {
    const context = makeContext({ initialState: { topicPath: "/audio" } });
    renderPanel(context);
    // Make the next buffer creation fail inside the scheduler.
    const ctx = MockAudioContext.instances[0]!;
    ctx.createBuffer = jest.fn((_channels: number, _length: number, _sampleRate: number) => {
      throw new Error("buffer boom");
    });

    const done = jest.fn();
    renderFrame(context, { currentFrame: [rawAudioMessage({})] }, done);

    expect(done).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/buffer boom/)).toBeDefined();
  });

  it("schedules audio from matching frames and ignores mismatched topic/schema leftovers", () => {
    const context = makeContext({ initialState: { topicPath: "/audio" } });
    renderPanel(context);

    renderFrame(context, {
      currentFrame: [
        rawAudioMessage({ topic: "/other" }), // wrong topic
        rawAudioMessage({ schemaName: "some.OtherSchema" }), // wrong schema
        rawAudioMessage({}), // matches
      ],
    });

    const ctx = MockAudioContext.instances[0]!;
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    const source = ctx.createBufferSource.mock.results[0]!.value as MockBufferSource;
    expect(source.start).toHaveBeenCalledWith(JITTER_BUFFER_SEC, 0, 0.4);
  });

  it("stops scheduled audio and resets the waveform when the topic changes", () => {
    const context = makeContext({ initialState: { topicPath: "/audio" } });
    renderPanel(context);
    renderFrame(context, { currentFrame: [rawAudioMessage({})] });

    const ctx = MockAudioContext.instances[0]!;
    const source = ctx.createBufferSource.mock.results[0]!.value as MockBufferSource;
    expect(source.start).toHaveBeenCalled();

    act(() => {
      settingsActionHandler!({
        action: "update",
        payload: { path: ["general", "topic"], input: "select", value: "/other" },
      });
    });

    expect(source.stop).toHaveBeenCalledTimes(1);
    // The waveform was reset: the panel shows the no-data state again.
    expect(screen.getByText("No audio data received yet")).toBeDefined();
    expect(context.subscribe).toHaveBeenLastCalledWith([{ topic: "/other", preload: false }]);
  });

  it("stops tracking sources that ended, so they are not stopped again on topic switch", () => {
    const context = makeContext({ initialState: { topicPath: "/audio" } });
    renderPanel(context);
    renderFrame(context, {
      currentFrame: [
        rawAudioMessage({ timestamp: { sec: 0, nsec: 0 } }),
        rawAudioMessage({ timestamp: { sec: 0, nsec: 500000000 } }),
      ],
    });

    const ctx = MockAudioContext.instances[0]!;
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(2);
    const [source1, source2] = ctx.createBufferSource.mock.results.map(
      (result) => result.value as MockBufferSource,
    );

    source1!.onended?.(); // first source ends naturally

    act(() => {
      settingsActionHandler!({
        action: "update",
        payload: { path: ["general", "topic"], input: "select", value: "/other" },
      });
    });

    expect(source1!.stop).not.toHaveBeenCalled();
    expect(source2!.stop).toHaveBeenCalledTimes(1);
  });

  it("flushes scheduled audio, the waveform, and errors on seek", () => {
    const context = makeContext({ initialState: { topicPath: "/audio" } });
    renderPanel(context);
    renderFrame(context, { currentFrame: [rawAudioMessage({ format: "pcm-u8" })] });
    expect(screen.getByText(/Unsupported audio format/)).toBeDefined();

    // A valid chunk after the error schedules audio.
    renderFrame(context, { currentFrame: [rawAudioMessage({})] });
    const ctx = MockAudioContext.instances[0]!;
    const source = ctx.createBufferSource.mock.results[0]!.value as MockBufferSource;
    expect(source.start).toHaveBeenCalled();
    expect(screen.queryByText(/Unsupported audio format/)).toBeNull();

    renderFrame(context, { didSeek: true });
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No audio data received yet")).toBeDefined();
  });

  it("shows a click-to-enable overlay while the AudioContext is suspended and resumes on click", async () => {
    const context = makeContext({ initialState: { topicPath: "/audio" } });
    renderPanel(context);
    const ctx = MockAudioContext.instances[0]!;

    act(() => {
      ctx.state = "suspended";
      ctx.onstatechange?.();
    });
    expect(screen.getByText("Click to enable sound")).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText("Click to enable sound"));
    });
    expect(ctx.resume).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText("Click to enable sound")).toBeNull();
    });
  });

  it("applies volume and muted to the gain node", () => {
    const context = makeContext({
      initialState: { topicPath: "/audio", volume: 0.5, muted: false },
    });
    renderPanel(context);

    const ctx = MockAudioContext.instances[0]!;
    const gain = ctx.createGain.mock.results[0]!.value as MockGainNode;
    expect(gain.gain.value).toBe(0.5);

    act(() => {
      settingsActionHandler!({
        action: "update",
        payload: { path: ["general", "muted"], input: "boolean", value: true },
      });
    });
    expect(gain.gain.value).toBe(0);

    act(() => {
      settingsActionHandler!({
        action: "update",
        payload: { path: ["general", "volume"], input: "number", value: 0.25 },
      });
    });
    // Muted still wins over the volume change.
    expect(gain.gain.value).toBe(0);

    act(() => {
      settingsActionHandler!({
        action: "update",
        payload: { path: ["general", "muted"], input: "boolean", value: false },
      });
    });
    expect(gain.gain.value).toBe(0.25);
  });

  it("shows an unsupported hint without crashing when AudioContext is unavailable", () => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    const context = makeContext();
    renderPanel(context);

    expect(screen.getByText("Audio playback is not supported in this browser.")).toBeDefined();
    expect(MockAudioContext.instances).toHaveLength(0);
  });

  it("auto-selects the only RawAudio topic", () => {
    const context = makeContext();
    renderPanel(context);

    renderFrame(context, {
      topics: [
        { name: "/audio", schemaName: "foxglove.RawAudio" },
        { name: "/image", schemaName: "sensor_msgs/Image" },
      ],
    });

    expect(context.subscribe).toHaveBeenCalledWith([{ topic: "/audio", preload: false }]);
    expect(context.saveState).toHaveBeenCalledWith(
      expect.objectContaining({ topicPath: "/audio" }),
    );
  });
});

describe("Audio panel registration", () => {
  it("registers the Audio panel in the builtin catalog and loads its module", async () => {
    const t = ((key: string) => key) as unknown as TFunction<"panels">;
    const builtin = getBuiltin(t);

    const audioPanel = builtin.find((panel) => panel.type === "Audio");
    expect(audioPanel).toBeDefined();
    expect(audioPanel!.title).toBe("audio");
    expect(audioPanel!.description).toBe("audioDescription");
    expect(audioPanel!.thumbnail).toBeDefined();

    const module = await audioPanel!.module();
    expect(module.default).toBeDefined();
  });

  it("provides the audio namespace and panel catalog translations", () => {
    const panelsT = sharedI18nObject.getFixedT("en", "panels");
    expect(panelsT("audio")).toBe("Audio");
    expect(panelsT("audioDescription")).toContain("audio");

    const audioT = sharedI18nObject.getFixedT("en", "audio");
    expect(audioT("clickToEnableSound")).toBe("Click to enable sound");
    expect(audioT("settings.topic.label")).toBe("Topic");
  });
});
