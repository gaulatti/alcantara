import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";
import { faderToGain } from "../utils/audioTaper";

// gaulatti/alcantara#195, groups 4 and 5: what the on-air page plays and stops.
// Instants and scene instants (volume, mute, solo, fade-out, switching, leaving
// the scene), and what the page asks of the song bus. The audio elements, the
// audio context and the song bus are stand-ins; the assertions are what the
// listener would hear (volume, playing, stopped) and what is logged or sent.

const sse = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
}));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage: (data: unknown) => void }) => {
    sse.onMessage = options.onMessage;
    return { isConnected: false };
  },
}));

const bus = vi.hoisted(() => ({
  ensure: vi.fn(),
  stop: vi.fn(),
  setVolume: vi.fn(),
  snapshot: vi.fn(),
  listeners: [] as Array<(snapshot: Record<string, unknown>) => void>,
}));
vi.mock("../utils/programAudioBus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/programAudioBus")>()),
  ensureProgramAudioBusTrack: bus.ensure,
  stopProgramAudioBus: bus.stop,
  setProgramAudioBusMasterVolume: bus.setVolume,
  getProgramAudioBusSnapshot: bus.snapshot,
  subscribeProgramAudioBus: (
    _programId: string,
    listener: (snapshot: Record<string, unknown>) => void,
  ) => {
    bus.listeners.push(listener);
    return () => {
      bus.listeners = bus.listeners.filter((entry) => entry !== listener);
    };
  },
}));

import ProgramRoute from "./program";

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playResult: "ok" | "reject" | "none" = "ok";
  preload = "";
  loop = false;
  muted = false;
  volume = 1;
  paused = true;
  ended = false;
  pauses = 0;
  private time = 0;
  throwOnReset = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static stream: unknown = null;
  // A real element reports null until crossOrigin is set. "anonymous" models a
  // source loaded in CORS mode, which Web Audio may read.
  static crossOriginMode: string | null = null;
  crossOrigin: string | null = FakeAudio.crossOriginMode;
  static mozStream: unknown = null;
  constructor(public src: string) {
    FakeAudio.instances.push(this);
    if (FakeAudio.stream) {
      (this as unknown as { captureStream: () => unknown }).captureStream = () =>
        FakeAudio.stream;
    }
    if (FakeAudio.mozStream) {
      (this as unknown as { mozCaptureStream: () => unknown }).mozCaptureStream =
        () => FakeAudio.mozStream;
    }
  }
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    if (this.throwOnReset) throw new Error("unsupported media");
    this.time = value;
  }
  play() {
    this.paused = false;
    if (FakeAudio.playResult === "none") return undefined;
    return FakeAudio.playResult === "reject"
      ? Promise.reject(new Error("blocked"))
      : Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.pauses += 1;
  }
}

interface Node {
  connected: unknown[];
  disconnects: number;
  throwOnDisconnect: boolean;
}
const makeNode = (): Node & Record<string, unknown> => {
  const node = {
    connected: [] as unknown[],
    disconnects: 0,
    throwOnDisconnect: false,
    fftSize: 0,
    smoothingTimeConstant: 0,
    connect(target: unknown) {
      node.connected.push(target);
    },
    disconnect() {
      node.disconnects += 1;
      if (node.throwOnDisconnect) throw new Error("already disconnected");
    },
  };
  return node;
};

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: "running" | "suspended" = "running";
  static resumeRejects = false;
  static elementSourceThrows = false;
  static streamSourceThrows = false;
  state: "running" | "suspended" | "closed" = FakeAudioContext.initialState;
  destination = {};
  nodes: Array<Node & Record<string, unknown>> = [];
  closed = false;
  resumed = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    if (FakeAudioContext.streamSourceThrows) throw new Error("no stream");
    const node = makeNode();
    this.nodes.push(node);
    return node;
  }
  createMediaElementSource() {
    if (FakeAudioContext.elementSourceThrows) throw new Error("taken");
    const node = makeNode();
    this.nodes.push(node);
    return node;
  }
  createAnalyser() {
    const node = makeNode();
    this.nodes.push(node);
    return node;
  }
  resume() {
    this.resumed += 1;
    if (FakeAudioContext.resumeRejects) return Promise.reject(new Error("no"));
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

const sceneState = (activeSceneId: number | null) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId,
  activeScene: null,
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
});

let server: ControlServer;
function startFetchStub() {
  server = controlServer({
    "GET /program/main/state": () => Response.json(sceneState(7)),
    "GET /program/main/audio-bus": () =>
      Response.json({ songSequence: null, songQueue: [] }),
    "GET /program/broadcast-settings": () => Response.json({}),
    "GET /program/main/scene-instant": () => Response.json({ isPlaying: false }),
    "GET /program/main/stingers": () => Response.json([]),
  });
}

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.playResult = "ok";
  FakeAudio.stream = null;
  FakeAudio.crossOriginMode = null;
  FakeAudio.mozStream = null;
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  FakeAudioContext.resumeRejects = false;
  FakeAudioContext.elementSourceThrows = false;
  FakeAudioContext.streamSourceThrows = false;
  bus.ensure.mockReset();
  bus.stop.mockReset();
  bus.setVolume.mockReset();
  bus.snapshot.mockReset().mockReturnValue({ track: null, isPlaying: false });
  bus.listeners = [];
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      addEventListener() {}
      close() {}
      send() {}
    },
  );
  Object.defineProperty(window, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
  startFetchStub();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "AudioContext");
});

const open = (search = "") =>
  render(
    <MemoryRouter initialEntries={[`/program/main${search}`]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
const openWithoutProgram = () =>
  render(
    <MemoryRouter initialEntries={["/program"]}>
      <Routes>
        <Route path="/program" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const emit = (data: unknown) => act(() => sse.onMessage?.(data));
const flush = () => advance(10);

const instant = (overrides: Record<string, unknown> = {}) => ({
  id: 3,
  name: "Fictional stinger",
  audioUrl: "https://media.example.test/instant.mp3",
  volume: 0.8,
  ...overrides,
});
const playInstant = (overrides: Record<string, unknown> = {}) =>
  emit({
    type: "instant_play",
    programId: "main",
    instant: instant(overrides),
  });
const mixer = (settings: Record<string, unknown>) =>
  emit({
    type: "audio_bus_update",
    programId: "main",
    settings: { mixerSettings: settings },
  });
const sceneTake = (
  extra: Record<string, unknown> = {},
  instantOverrides: Record<string, unknown> = {},
) =>
  emit({
    type: "scene_instant_take",
    programId: "main",
    sceneId: 7,
    triggeredAt: "2026-11-22T10:00:00.000Z",
    instant: instant({
      id: 5,
      name: "Fictional bed",
      audioUrl: "https://media.example.test/bed.mp3",
      volume: 0.5,
      ...instantOverrides,
    }),
    ...extra,
  });

describe("instants", () => {
  it("is the main program's page when the address names no program", async () => {
    openWithoutProgram();
    await flush();
    playInstant();
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("plays an instant at its own volume scaled by the instant channel", async () => {
    open();
    await flush();
    playInstant();
    expect(FakeAudio.instances).toHaveLength(1);
    const audio = FakeAudio.instances[0];
    expect(audio.src).toBe("https://media.example.test/instant.mp3");
    expect(audio.preload).toBe("auto");
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBeCloseTo(0.8, 5);

    mixer({ instantMasterVolume: 0.5 });
    expect(audio.volume).toBeCloseTo(0.8 * faderToGain(0.5), 5);
    mixer({ instantMasterVolume: 0.5, instantMuted: true });
    expect(audio.volume).toBe(0);
    mixer({ instantMasterVolume: 1, songSolo: true });
    expect(audio.volume).toBe(0);
    mixer({ instantMasterVolume: 1, instantSolo: true, songSolo: true });
    expect(audio.volume).toBeCloseTo(0.8, 5);
  });

  it("does not play for another program or on a confidence monitor", async () => {
    open("?confidence=preview");
    await flush();
    playInstant();
    expect(FakeAudio.instances).toHaveLength(0);
    cleanup();

    open();
    await flush();
    emit({
      type: "instant_play",
      programId: "other",
      instant: instant(),
    });
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("stops every instant when told to, and ignores another program's stop", async () => {
    open();
    await flush();
    playInstant();
    playInstant({ audioUrl: "https://media.example.test/second.mp3" });
    const [first, second] = FakeAudio.instances;
    first.throwOnReset = true;

    emit({ type: "instant_stop_all", programId: "other" });
    expect(first.paused).toBe(false);

    emit({ type: "instant_stop_all", programId: "main" });
    expect(first.paused).toBe(true);
    expect(second.paused).toBe(true);
    expect(second.currentTime).toBe(0);
    expect(first.onended).toBeNull();
    expect(first.onerror).toBeNull();
  });

  it("forgets an instant that ended, and logs one that failed or could not start", async () => {
    open();
    await flush();
    playInstant();
    const [ended] = FakeAudio.instances;
    act(() => ended.onended?.());
    emit({ type: "instant_stop_all", programId: "main" });
    expect(ended.pauses).toBe(0);

    playInstant({ name: "Broken one" });
    const failing = FakeAudio.instances[1];
    act(() => failing.onerror?.());
    expect(console.error).toHaveBeenCalledWith(
      'Instant playback error for "Broken one" (https://media.example.test/instant.mp3)',
    );

    FakeAudio.playResult = "reject";
    playInstant({ name: "Blocked one" });
    await flush();
    expect(console.error).toHaveBeenCalledWith(
      'Failed to play instant "Blocked one":',
      expect.any(Error),
    );

    FakeAudio.playResult = "none";
    playInstant({ name: "No promise" });
    expect(FakeAudio.instances[3].paused).toBe(false);
  });

  it("stops the instants when the page is closed", async () => {
    const view = open();
    await flush();
    playInstant();
    const audio = FakeAudio.instances[0];
    view.unmount();
    expect(audio.paused).toBe(true);
  });
});

describe("the level meter attached to an instant", () => {
  const attach = async () => {
    // These cases meter a source Web Audio can read; the unreadable one is below.
    FakeAudio.crossOriginMode = "anonymous";
    open();
    await flush();
  };

  it("reads the level from the captured stream", async () => {
    await attach();
    FakeAudio.stream = {};
    FakeAudioContext.initialState = "suspended";
    playInstant();
    const context = FakeAudioContext.instances[0];
    expect(context.nodes).toHaveLength(2);
    expect(context.resumed).toBe(1);
    expect(FakeAudio.instances[0].muted).toBe(false);
    emit({ type: "instant_stop_all", programId: "main" });
    expect(context.nodes.every((node) => node.disconnects === 1)).toBe(true);
  });

  it("reads the level from Firefox's captured stream", async () => {
    await attach();
    FakeAudio.mozStream = {};
    playInstant();
    expect(FakeAudioContext.instances[0].nodes).toHaveLength(2);
    expect(FakeAudio.instances[0].muted).toBe(false);
  });

  it("goes without a meter when the stream's resume is refused", async () => {
    await attach();
    FakeAudio.stream = {};
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.resumeRejects = true;
    playInstant();
    await flush();
    expect(FakeAudio.instances[0].paused).toBe(false);
  });

  it("falls back to the media element when no stream can be captured", async () => {
    await attach();
    playInstant();
    const audio = FakeAudio.instances[0];
    const context = FakeAudioContext.instances[0];
    expect(audio.muted).toBe(true);
    expect(context.nodes).toHaveLength(2);
    emit({ type: "instant_stop_all", programId: "main" });
    expect(audio.muted).toBe(false);
  });

  it("attaches once a suspended context resumes", async () => {
    await attach();
    FakeAudioContext.initialState = "suspended";
    playInstant();
    const context = FakeAudioContext.instances[0];
    expect(context.nodes).toHaveLength(0);
    await flush();
    expect(context.resumed).toBe(1);
    expect(context.nodes).toHaveLength(2);
    expect(FakeAudio.instances[0].muted).toBe(true);
  });

  it("does not attach after the instant was stopped while the context resumed", async () => {
    await attach();
    FakeAudioContext.initialState = "suspended";
    playInstant();
    emit({ type: "instant_stop_all", programId: "main" });
    await flush();
    expect(FakeAudioContext.instances[0].nodes).toHaveLength(0);
  });

  it("plays unmetered when the context cannot resume or the source cannot be made", async () => {
    await attach();
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.resumeRejects = true;
    playInstant();
    await flush();
    expect(FakeAudio.instances[0].paused).toBe(false);
    expect(FakeAudioContext.instances[0].nodes).toHaveLength(0);

    emit({ type: "instant_stop_all", programId: "main" });
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = "running";
    FakeAudioContext.elementSourceThrows = true;
    playInstant();
    expect(FakeAudio.instances[1].paused).toBe(false);
    expect(FakeAudio.instances[1].muted).toBe(false);
  });

  it("plays unmetered when the stream cannot be turned into a source", async () => {
    await attach();
    FakeAudio.stream = {};
    FakeAudioContext.streamSourceThrows = true;
    playInstant();
    expect(FakeAudio.instances[0].paused).toBe(false);
    expect(FakeAudio.instances[0].muted).toBe(false);
  });

  it("plays unmetered when the source cannot be made after the context resumed", async () => {
    await attach();
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.elementSourceThrows = true;
    playInstant();
    await flush();
    expect(FakeAudioContext.instances[0].resumed).toBe(1);
    expect(FakeAudio.instances[0].paused).toBe(false);
    expect(FakeAudio.instances[0].muted).toBe(false);
  });

  it("gives the element its sound back when an instant ends or fails, whatever the meter nodes do", async () => {
    await attach();
    playInstant();
    playInstant({ name: "Second" });
    const [ended, failed] = FakeAudio.instances;
    FakeAudioContext.instances[0].nodes.forEach((node) => {
      node.throwOnDisconnect = true;
    });
    expect(ended.muted).toBe(true);
    act(() => ended.onended?.());
    expect(ended.muted).toBe(false);
    act(() => failed.onerror?.());
    expect(failed.muted).toBe(false);
    expect(
      FakeAudioContext.instances[0].nodes.every((node) => node.disconnects >= 1),
    ).toBe(true);
  });

  it("plays unmetered when the browser has no audio context", async () => {
    await attach();
    Reflect.deleteProperty(window, "AudioContext");
    playInstant();
    expect(FakeAudio.instances[0].paused).toBe(false);
    expect(FakeAudio.instances[0].muted).toBe(false);
  });

  it("makes a new context when the first one was closed, and closes it with the page", async () => {
    const view = open();
    await flush();
    playInstant();
    FakeAudioContext.instances[0].state = "closed";
    emit({ type: "instant_stop_all", programId: "main" });
    playInstant();
    expect(FakeAudioContext.instances).toHaveLength(2);
    const context = FakeAudioContext.instances[1];
    context.nodes.forEach((node) => {
      node.throwOnDisconnect = true;
    });
    emit({ type: "instant_stop_all", programId: "main" });
    view.unmount();
    expect(context.closed).toBe(true);
  });
});

describe("scene instants", () => {
  it("plays a scene instant on a loop at its volume scaled by the scene instant channel", async () => {
    open();
    await flush();
    sceneTake();
    expect(FakeAudio.instances).toHaveLength(1);
    const audio = FakeAudio.instances[0];
    expect(audio.src).toBe("https://media.example.test/bed.mp3");
    expect(audio.loop).toBe(true);
    expect(audio.volume).toBeCloseTo(0.5, 5);

    mixer({ sceneInstantMasterVolume: 0.5 });
    expect(audio.volume).toBeCloseTo(0.5 * faderToGain(0.5), 5);
    mixer({ sceneInstantMasterVolume: 1, sceneInstantMuted: true });
    expect(audio.volume).toBe(0);
  });

  it("follows solo and mute across the other channels", async () => {
    open();
    await flush();
    sceneTake();
    playInstant();
    const [bed, short] = [FakeAudio.instances[0], FakeAudio.instances[1]];
    mixer({ streamSolo: true });
    expect(bed.volume).toBe(0);
    expect(short.volume).toBe(0);
    mixer({ sceneInstantSolo: true });
    expect(bed.volume).toBeCloseTo(0.5, 5);
    expect(short.volume).toBe(0);
    mixer({ streamMuted: true, streamMasterVolume: 0.2 });
    expect(bed.volume).toBeCloseTo(0.5, 5);
    expect(short.volume).toBeCloseTo(0.8, 5);
  });

  it("plays once when the take asks not to loop", async () => {
    open();
    await flush();
    sceneTake({ loop: false });
    expect(FakeAudio.instances[0].loop).toBe(false);
  });

  it("ignores a take with no instant: no audio, a logged line, and no throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    open();
    await flush();
    expect(() =>
      emit({ type: "scene_instant_take", programId: "main", sceneId: 7, triggeredAt: "2026-11-22T10:00:00.000Z" }),
    ).not.toThrow();
    expect(FakeAudio.instances).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no instant on scene 7"));
    warn.mockRestore();
  });

  it("ignores a take for another program or on a confidence monitor", async () => {
    open("?confidence=program");
    await flush();
    sceneTake();
    expect(FakeAudio.instances).toHaveLength(0);
    cleanup();
    open();
    await flush();
    sceneTake({ programId: "other" });
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("does not restart the same take while it is still playing", async () => {
    open();
    await flush();
    sceneTake();
    sceneTake();
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("fades the playing scene instant out and starts the next one when another is taken", async () => {
    open();
    await flush();
    sceneTake();
    const first = FakeAudio.instances[0];
    sceneTake(
      { triggeredAt: "2026-11-22T10:05:00.000Z" },
      { audioUrl: "https://media.example.test/next.mp3" },
    );
    expect(FakeAudio.instances).toHaveLength(1);
    await advance(750);
    expect(first.volume).toBeGreaterThan(0);
    expect(first.volume).toBeLessThan(0.5);
    await advance(800);
    expect(first.volume).toBe(0);
    expect(first.paused).toBe(true);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].src).toBe("https://media.example.test/next.mp3");
    expect(FakeAudio.instances[1].paused).toBe(false);
  });

  it("starts nothing when a newer take replaced the one waiting for the fade", async () => {
    open();
    await flush();
    sceneTake();
    sceneTake(
      { triggeredAt: "2026-11-22T10:05:00.000Z" },
      { audioUrl: "https://media.example.test/second.mp3" },
    );
    sceneTake(
      { triggeredAt: "2026-11-22T10:06:00.000Z" },
      { audioUrl: "https://media.example.test/third.mp3" },
    );
    await advance(3200);
    const sources = FakeAudio.instances.map((audio) => audio.src);
    expect(sources).toContain("https://media.example.test/third.mp3");
    expect(sources).not.toContain("https://media.example.test/second.mp3");
  });

  it("stops at once, or fades out for the length the stop asks for", async () => {
    open();
    await flush();
    sceneTake();
    const audio = FakeAudio.instances[0];
    emit({ type: "scene_instant_stop", programId: "other" });
    expect(audio.paused).toBe(false);

    emit({ type: "scene_instant_stop", programId: "main", fadeMs: 1000 });
    await advance(500);
    expect(audio.volume).toBeLessThan(0.5);
    expect(audio.paused).toBe(false);
    audio.throwOnReset = true;
    await advance(600);
    expect(audio.paused).toBe(true);
    expect(audio.volume).toBe(0);

    sceneTake({ triggeredAt: "2026-11-22T10:10:00.000Z" });
    const again = FakeAudio.instances[1];
    emit({ type: "scene_instant_stop", programId: "main" });
    expect(again.paused).toBe(true);
    expect(again.currentTime).toBe(0);
  });

  it("disconnects the meter when a scene instant stops, even if the nodes refuse", async () => {
    FakeAudio.crossOriginMode = "anonymous";
    open();
    await flush();
    sceneTake();
    const context = FakeAudioContext.instances[0];
    context.nodes.forEach((node) => {
      node.throwOnDisconnect = true;
    });
    const audio = FakeAudio.instances[0];
    expect(audio.muted).toBe(true);
    emit({ type: "scene_instant_stop", programId: "main" });
    expect(audio.muted).toBe(false);
    expect(context.nodes.every((node) => node.disconnects === 1)).toBe(true);

    sceneTake({ triggeredAt: "2026-11-22T10:11:00.000Z" });
    context.nodes.forEach((node) => {
      node.throwOnDisconnect = true;
    });
    emit({ type: "scene_instant_stop", programId: "main", fadeMs: 200 });
    await advance(300);
    expect(FakeAudio.instances[1].paused).toBe(true);
    expect(
      context.nodes.slice(2).every((node) => node.disconnects === 1),
    ).toBe(true);
  });

  it("gives the element its sound back when a scene instant ends or fails, whatever the meter nodes do", async () => {
    FakeAudio.crossOriginMode = "anonymous";
    open();
    await flush();
    sceneTake();
    const ended = FakeAudio.instances[0];
    FakeAudioContext.instances[0].nodes.forEach((node) => {
      node.throwOnDisconnect = true;
    });
    expect(ended.muted).toBe(true);
    act(() => ended.onended?.());
    expect(ended.muted).toBe(false);

    sceneTake({ triggeredAt: "2026-11-22T11:00:00.000Z" });
    const failed = FakeAudio.instances[1];
    FakeAudioContext.instances[0].nodes.slice(2).forEach((node) => {
      node.throwOnDisconnect = true;
    });
    act(() => failed.onerror?.());
    expect(failed.muted).toBe(false);
  });

  it("stops a scene instant whose media cannot rewind", async () => {
    open();
    await flush();
    sceneTake();
    const audio = FakeAudio.instances[0];
    audio.throwOnReset = true;
    emit({ type: "scene_instant_stop", programId: "main" });
    expect(audio.paused).toBe(true);
  });

  it("forgets a scene instant that ended, and logs one that failed or could not start", async () => {
    open();
    await flush();
    sceneTake();
    act(() => FakeAudio.instances[0].onended?.());
    sceneTake();
    expect(FakeAudio.instances).toHaveLength(2);

    act(() => FakeAudio.instances[1].onerror?.());
    expect(console.error).toHaveBeenCalledWith(
      'Scene instant playback error for "Fictional bed" (https://media.example.test/bed.mp3)',
    );

    FakeAudio.playResult = "reject";
    sceneTake({ triggeredAt: "2026-11-22T10:20:00.000Z" });
    await flush();
    expect(console.error).toHaveBeenCalledWith(
      'Failed to play scene instant "Fictional bed":',
      expect.any(Error),
    );

    FakeAudio.playResult = "none";
    sceneTake({ triggeredAt: "2026-11-22T10:21:00.000Z" });
    expect(FakeAudio.instances.at(-1)?.paused).toBe(false);
  });

  it("takes the scene instant the state says is playing, once", async () => {
    open();
    await flush();
    const playing = {
      type: "scene_instant_state",
      programId: "main",
      playback: {
        isPlaying: true,
        sceneId: 7,
        mediaAssetId: "asset-9",
        startedAt: "2026-11-22T10:30:00.000Z",
        instant: instant({ id: 9, audioUrl: "https://media.example.test/state.mp3" }),
      },
    };
    emit(playing);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe("https://media.example.test/state.mp3");
    expect(FakeAudio.instances[0].loop).toBe(true);
    emit({ ...playing });
    expect(FakeAudio.instances).toHaveLength(1);

    emit({
      ...playing,
      playback: { ...playing.playback, startedAt: undefined, updatedAt: undefined },
    });
    await advance(1600);
    expect(FakeAudio.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("stops the scene instant when the state says nothing is playing", async () => {
    open();
    await flush();
    sceneTake();
    const audio = FakeAudio.instances[0];
    emit({
      type: "scene_instant_state",
      programId: "main",
      playback: { isPlaying: false },
    });
    expect(audio.paused).toBe(true);

    sceneTake({ triggeredAt: "2026-11-22T10:40:00.000Z" });
    const next = FakeAudio.instances[1];
    emit({
      type: "scene_instant_state",
      programId: "main",
      playback: {
        isPlaying: true,
        instant: instant({ audioUrl: "   " }),
      },
    });
    expect(next.paused).toBe(true);
  });

  it("ignores a scene instant state for another program or on a confidence monitor", async () => {
    open();
    await flush();
    emit({
      type: "scene_instant_state",
      programId: "other",
      playback: { isPlaying: true, instant: instant() },
    });
    expect(FakeAudio.instances).toHaveLength(0);
    cleanup();
    open("?confidence=preview");
    await flush();
    emit({
      type: "scene_instant_state",
      programId: "main",
      playback: { isPlaying: true, instant: instant() },
    });
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("fades the scene instant out when the scene it belongs to leaves the air", async () => {
    open();
    await flush();
    sceneTake();
    const audio = FakeAudio.instances[0];
    await advance(10);
    emit({
      type: "scene_change",
      state: { ...sceneState(8), activeScene: null },
    });
    await advance(800);
    expect(audio.volume).toBeLessThan(0.5);
    await advance(800);
    expect(audio.paused).toBe(true);
  });

  it("keeps a scene instant playing while its scene stays on air", async () => {
    open();
    await flush();
    sceneTake();
    const audio = FakeAudio.instances[0];
    // The page also reads the scene instant on a timer; the backend still says
    // this one is playing.
    server.answer(
      "GET /program/main/scene-instant",
      Response.json({
        isPlaying: true,
        sceneId: 7,
        startedAt: "2026-11-22T10:00:00.000Z",
        instant: instant({
          id: 5,
          audioUrl: "https://media.example.test/bed.mp3",
        }),
      }),
    );
    emit({ type: "scene_change", state: sceneState(7) });
    await advance(6000);
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBeCloseTo(0.5, 5);
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("stops the scene instant when the page is closed", async () => {
    const view = open();
    await flush();
    sceneTake();
    const audio = FakeAudio.instances[0];
    view.unmount();
    expect(audio.paused).toBe(true);
  });
});

describe("the song bus", () => {
  const song = (overrides: Record<string, unknown> = {}) => ({
    type: "song_playback_update",
    playback: {
      isPlaying: true,
      audioUrl: " https://media.example.test/song.mp3 ",
      token: "song-1",
      durationMs: 180000,
      artist: "Fictional artist",
      title: "Fictional song",
      ...overrides,
    },
  });

  it("asks the bus to play the song the update names, once, with what the update says", async () => {
    open();
    await flush();
    emit(song());
    expect(bus.ensure).toHaveBeenCalledWith("main", {
      token: "song-1",
      audioUrl: "https://media.example.test/song.mp3",
      durationMs: 180000,
      artist: "Fictional artist",
      title: "Fictional song",
    });

    bus.snapshot.mockReturnValue({ track: { token: "song-1" }, isPlaying: true });
    emit(song());
    expect(bus.ensure).toHaveBeenCalledTimes(1);

    bus.snapshot.mockReturnValue({ track: { token: "song-1" }, isPlaying: false });
    emit(song({ token: "song-1" }));
    expect(bus.ensure).toHaveBeenCalledTimes(2);
  });

  it("makes its own token when the update has none, and drops fields of the wrong type", async () => {
    open();
    await flush();
    emit(song({ token: undefined, durationMs: "long", artist: 4, title: null }));
    const [, track] = bus.ensure.mock.calls[0];
    expect(track.token).toMatch(/^\d+:https:\/\/media\.example\.test\/song\.mp3$/);
    expect(track.durationMs).toBeUndefined();
    expect(track.artist).toBeUndefined();
    expect(track.title).toBeUndefined();
  });

  it("does not start a song whose address is blank, and stops the bus when the update says it is not playing", async () => {
    open();
    await flush();
    emit(song({ audioUrl: "   " }));
    expect(bus.ensure).not.toHaveBeenCalled();
    emit(song({ isPlaying: false }));
    expect(bus.stop).toHaveBeenCalledWith("main");
  });

  it("does not play the song on a confidence monitor", async () => {
    open("?confidence=preview");
    await flush();
    emit(song());
    expect(bus.ensure).not.toHaveBeenCalled();
  });

  it("stops the bus when this program's song goes off air, and not for another program", async () => {
    open();
    await flush();
    emit({ type: "song_off_air", programId: "other" });
    expect(bus.stop).not.toHaveBeenCalled();
    emit({ type: "song_off_air", programId: "main" });
    expect(bus.stop).toHaveBeenCalledWith("main");
  });

  it("follows the song channel and the main fader, and silences a confidence monitor", async () => {
    open();
    await flush();
    expect(bus.setVolume).toHaveBeenLastCalledWith("main", 1);
    mixer({ songMasterVolume: 0.5 });
    expect(bus.setVolume).toHaveBeenLastCalledWith("main", faderToGain(0.5));
    mixer({ songMasterVolume: 1, songMuted: true });
    expect(bus.setVolume).toHaveBeenLastCalledWith("main", 0);
    mixer({ songMasterVolume: 1, instantSolo: true });
    expect(bus.setVolume).toHaveBeenLastCalledWith("main", 0);
    cleanup();

    bus.setVolume.mockClear();
    open("?confidence=program");
    await flush();
    expect(bus.setVolume).toHaveBeenLastCalledWith("main", 0);
  });

  it("tells the program the song ended, once, only over an open connection", async () => {
    const sent: string[] = [];
    let socket: { readyState: number; listeners: Record<string, () => void> };
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        readyState = 0;
        listeners: Record<string, () => void> = {};
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          socket = this;
        }
        addEventListener(type: string, listener: () => void) {
          this.listeners[type] = listener;
        }
        close() {}
        send(message: string) {
          sent.push(message);
        }
      },
    );
    open();
    await flush();
    const ended = { track: { token: "song-1" }, endedToken: "song-1" };

    bus.listeners.forEach((listener) => listener({ track: null, endedToken: "" }));
    bus.listeners.forEach((listener) => listener(ended));
    expect(sent).toHaveLength(0);

    act(() => {
      socket.readyState = 1;
      socket.listeners.open?.();
    });
    bus.listeners.forEach((listener) =>
      listener({ track: { token: "song-2" }, endedToken: "song-2" }),
    );
    bus.listeners.forEach((listener) =>
      listener({ track: { token: "song-2" }, endedToken: "song-2" }),
    );
    expect(sent).toEqual([JSON.stringify({ type: "song_ended", programId: "main" })]);
  });

  it("carries on when the connection drops just as the song ends", async () => {
    let socket: { readyState: number; listeners: Record<string, () => void> };
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        readyState = 0;
        listeners: Record<string, () => void> = {};
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          socket = this;
        }
        addEventListener(type: string, listener: () => void) {
          this.listeners[type] = listener;
        }
        close() {}
        send() {
          throw new Error("closed");
        }
      },
    );
    open();
    await flush();
    act(() => {
      socket.readyState = 1;
      socket.listeners.open?.();
    });
    expect(() =>
      bus.listeners.forEach((listener) =>
        listener({ track: { token: "song-3" }, endedToken: "song-3" }),
      ),
    ).not.toThrow();
  });

  it("does not listen for the end of a song on a confidence monitor", async () => {
    open("?confidence=preview");
    await flush();
    expect(bus.listeners).toHaveLength(0);
  });

  it("plays the song a manual sequence names, and stops the bus when it names none", async () => {
    open();
    await flush();
    const manual = (songs: unknown[]) =>
      emit({
        type: "audio_bus_snapshot",
        settings: {
          songSequence: {
            mode: "manual",
            items: songs,
          },
        },
      });
    manual([
      {
        id: "song-11",
        title: "Fictional manual song",
        artist: "Fictional artist",
        audioUrl: "https://media.example.test/manual.mp3",
        durationMs: 120000,
      },
    ]);
    expect(bus.ensure).toHaveBeenCalled();
    const [, track] = bus.ensure.mock.calls.at(-1) ?? [];
    expect(track.token).toBe("manual:song-11:https://media.example.test/manual.mp3");
    expect(track.title).toBe("Fictional manual song");

    bus.ensure.mockClear();
    bus.snapshot.mockReturnValue({ track: { token: track.token }, isPlaying: true });
    emit({
      type: "audio_bus_update",
      programId: "main",
      settings: {
        songSequence: {
          mode: "manual",
          items: [
            {
              id: "song-11",
              title: "Fictional manual song",
              artist: "Fictional artist",
              audioUrl: "https://media.example.test/manual.mp3",
              durationMs: 120000,
            },
          ],
        },
        mixerSettings: { songMasterVolume: 0.9 },
      },
    });
    expect(bus.ensure).not.toHaveBeenCalled();

    bus.snapshot.mockReturnValue({ track: { token: "x" }, isPlaying: true });
    manual([]);
    expect(bus.stop).toHaveBeenCalledWith("main");
  });
});

describe("fade to black", () => {
  it("brings the instant volume down over a second and back up", async () => {
    open();
    await flush();
    playInstant();
    const audio = FakeAudio.instances[0];
    expect(audio.volume).toBeCloseTo(0.8, 5);

    emit({ type: "program_state_snapshot", state: sceneState(7) });
    emit({
      type: "fade_to_black",
      state: { ...sceneState(7), fadeToBlack: true },
    });
    await advance(500);
    expect(audio.volume).toBeLessThan(0.8);
    expect(audio.volume).toBeGreaterThan(0);
    await advance(700);
    expect(audio.volume).toBe(0);

    emit({
      type: "fade_to_black",
      state: { ...sceneState(7), fadeToBlack: false },
    });
    await advance(1100);
    expect(audio.volume).toBeCloseTo(0.8, 2);
  });
});

describe("an instant from another origin without CORS", () => {
  it("keeps its own sound instead of going silent through the meter", async () => {
    // Web Audio outputs silence for a cross-origin source loaded without CORS,
    // and the meter mutes the element it routes: the instant must not be routed.
    open();
    await flush();
    playInstant();
    const audio = FakeAudio.instances[0];
    expect(audio.crossOrigin).toBeNull();
    expect(audio.muted).toBe(false);
    expect(FakeAudioContext.instances[0]?.nodes ?? []).toHaveLength(0);
  });

  it("is not routed when a suspended context resumes either", async () => {
    open();
    await flush();
    FakeAudioContext.initialState = "suspended";
    playInstant();
    await flush();
    expect(FakeAudio.instances[0].muted).toBe(false);
    expect(FakeAudioContext.instances[0]?.nodes ?? []).toHaveLength(0);
  });
});
