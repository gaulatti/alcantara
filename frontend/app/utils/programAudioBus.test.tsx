import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureProgramAudioBusTrack,
  getProgramAudioBusSnapshot,
  stopProgramAudioBus,
} from "./programAudioBus";

/** Just enough of an audio element for the bus: it "plays" as soon as play() is called. */
class FakeAudio {
  static created: FakeAudio[] = [];
  src: string;
  volume = 1;
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 180;
  crossOrigin: string | null = null;
  preload = "";
  onplaying: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src = "") {
    this.src = src;
    FakeAudio.created.push(this);
  }
  play() {
    this.paused = false;
    this.onplaying?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
  addEventListener() {}
  removeEventListener() {}
}

const track = (name: string) => ({
  token: `manual:${name}`,
  audioUrl: `https://audio.test/${name}.mp3`,
  artist: name,
  title: name,
});
const playing = () =>
  FakeAudio.created
    .filter((audio) => !audio.paused)
    .map((audio) => audio.src.split("/").pop());

describe("program audio bus: switching songs", () => {
  let programId = "";

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.created = [];
    vi.stubGlobal("Audio", FakeAudio);
    programId = `bus-test-${Math.random()}`;
  });

  afterEach(() => {
    stopProgramAudioBus(programId);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts a song at once when nothing is playing", () => {
    ensureProgramAudioBusTrack(programId, track("one"));
    expect(playing()).toEqual(["one.mp3"]);
    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe(
      "manual:one",
    );
  });

  it("switches to a second song while the first plays, even when asked again during the fade", async () => {
    ensureProgramAudioBusTrack(programId, track("one"));

    // The program page asks for the selected song on every state update. Ask every 100ms, which is
    // faster than the 420ms fade-out; this used to restart the fade each time and never switch.
    for (let elapsed = 0; elapsed < 1500; elapsed += 100) {
      ensureProgramAudioBusTrack(programId, track("two"));
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe(
      "manual:two",
    );
    expect(playing()).toEqual(["two.mp3"]);
    // One element per song: the repeated requests did not start the second song more than once.
    expect(
      FakeAudio.created.map((audio) => audio.src.split("/").pop()),
    ).toEqual(["one.mp3", "two.mp3"]);
  });

  it("follows a change of mind during the fade to the song asked for last", async () => {
    ensureProgramAudioBusTrack(programId, track("one"));
    ensureProgramAudioBusTrack(programId, track("two"));
    await vi.advanceTimersByTimeAsync(100);
    ensureProgramAudioBusTrack(programId, track("three"));
    await vi.advanceTimersByTimeAsync(1500);

    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe(
      "manual:three",
    );
    expect(playing()).toEqual(["three.mp3"]);
  });

  it("lets a stop during the fade win, and plays a song asked for afterwards", async () => {
    ensureProgramAudioBusTrack(programId, track("one"));
    ensureProgramAudioBusTrack(programId, track("two"));
    await vi.advanceTimersByTimeAsync(100);
    stopProgramAudioBus(programId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(playing()).toEqual([]);
    expect(getProgramAudioBusSnapshot(programId).track).toBeNull();

    ensureProgramAudioBusTrack(programId, track("two"));
    expect(playing()).toEqual(["two.mp3"]);
  });
});

// gaulatti/alcantara#184, group G6: the rest of the bus as the program page
// and the console's meters use it: snapshots and subscribers, the audio
// element's events, master volume, failed starts, and the level meter
// (analyser, media-element fallback, decoded envelope, or post-fader level).

import {
  getProgramAudioBusSignalLevel,
  getProgramAudioBusSignalSnapshot,
  setProgramAudioBusMasterVolume,
  subscribeProgramAudioBus,
} from "./programAudioBus";

/** An audio element with every handler the bus binds, driven by the test. */
class EventAudio {
  static created: EventAudio[] = [];
  static playResult: () => Promise<void> | undefined = () => Promise.resolve();
  src: string;
  // A real element reports null until crossOrigin is set; "anonymous" models a
  // source loaded in CORS mode, which Web Audio may read.
  static crossOriginMode: string | null = null;
  crossOrigin: string | null = EventAudio.crossOriginMode;
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  preload = "";
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src = "") {
    this.src = src;
    EventAudio.created.push(this);
  }
  play() {
    this.paused = false;
    this.onplay?.();
    return EventAudio.playResult();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
}

/** A Web Audio context whose analyser reports `samples`. */
function audioContextClass(options: {
  state?: string;
  samples?: number[];
  resume?: () => Promise<void>;
  decode?: (buffer: ArrayBuffer) => Promise<unknown>;
  disconnectThrows?: boolean;
  elementSourceThrows?: boolean;
}) {
  const made: any[] = [];
  class Context {
    state = options.state ?? "running";
    destination = { kind: "destination" };
    sources: any[] = [];
    resume = vi.fn(options.resume ?? (() => Promise.resolve()));
    decodeAudioData = vi.fn(
      options.decode ?? (() => Promise.reject(new Error("no decoder"))),
    );
    constructor() {
      made.push(this);
    }
    node(kind: string) {
      const node = {
        kind,
        connect: vi.fn(),
        disconnect: vi.fn(() => {
          if (options.disconnectThrows) throw new Error("already gone");
        }),
      };
      this.sources.push(node);
      return node;
    }
    createMediaStreamSource() {
      return this.node("stream");
    }
    createMediaElementSource() {
      if (options.elementSourceThrows) throw new Error("already attached");
      return this.node("element");
    }
    createAnalyser() {
      return {
        ...this.node("analyser"),
        fftSize: 0,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData(buffer: Float32Array) {
          const samples = options.samples ?? [];
          for (let index = 0; index < buffer.length; index += 1)
            buffer[index] = samples[index % Math.max(1, samples.length)] ?? 0;
        },
      };
    }
  }
  return { Context, made };
}

const busTrack = (name: string, extra: Record<string, unknown> = {}) => ({
  token: `bus:${name}`,
  audioUrl: `https://audio.test/${name}-${Math.random()}.mp3`,
  ...extra,
});

describe("program audio bus: snapshots, events and volume", () => {
  let programId = "";
  beforeEach(() => {
    vi.useFakeTimers();
    EventAudio.created = [];
    EventAudio.playResult = () => Promise.resolve();
    vi.stubGlobal("Audio", EventAudio);
    vi.stubGlobal("AudioContext", undefined);
    programId = `bus-events-${Math.random()}`;
  });
  afterEach(() => {
    stopProgramAudioBus(programId);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const empty = {
    track: null,
    progress: 0,
    currentTimeMs: 0,
    durationMs: null,
    endedToken: "",
    isPlaying: false,
  };

  it("reads an empty bus for an unknown or blank program and ignores blank requests", () => {
    expect(getProgramAudioBusSnapshot("never-used")).toEqual(empty);
    expect(getProgramAudioBusSnapshot("  ")).toEqual(empty);
    const listener = vi.fn();
    const unsubscribe = subscribeProgramAudioBus(" ", listener);
    expect(listener).toHaveBeenCalledWith(empty);
    unsubscribe();
    ensureProgramAudioBusTrack("", busTrack("one"));
    ensureProgramAudioBusTrack(programId, {
      token: " ",
      audioUrl: "https://audio.test/x.mp3",
    });
    ensureProgramAudioBusTrack(programId, { token: "bus:x", audioUrl: "  " });
    setProgramAudioBusMasterVolume("", 0.5);
    stopProgramAudioBus("never-used");
    expect(EventAudio.created).toHaveLength(0);
    expect(getProgramAudioBusSignalLevel("never-used")).toBe(0);
    expect(getProgramAudioBusSignalSnapshot("never-used")).toEqual({
      rms: 0,
      peak: 0,
    });
  });

  it("tells subscribers what the audio element does until they unsubscribe", () => {
    const seen: any[] = [];
    const unsubscribe = subscribeProgramAudioBus(programId, (snapshot) =>
      seen.push(snapshot),
    );
    expect(seen.at(-1)).toEqual(empty);

    ensureProgramAudioBusTrack(
      programId,
      busTrack("one", { durationMs: 200_400.6 }),
    );
    const audio = EventAudio.created[0];
    expect(audio.preload).toBe("auto");
    // Before metadata, the track's own duration stands in.
    expect(seen.at(-1)).toMatchObject({
      isPlaying: true,
      durationMs: 200_401,
      currentTimeMs: 0,
    });

    audio.duration = 100;
    audio.currentTime = 25;
    audio.onloadedmetadata?.();
    expect(seen.at(-1)).toMatchObject({
      progress: 0.25,
      durationMs: 100_000,
      currentTimeMs: 25_000,
    });
    audio.currentTime = 150;
    audio.ontimeupdate?.();
    expect(seen.at(-1)).toMatchObject({ progress: 1, currentTimeMs: 100_000 });
    audio.currentTime = -1;
    audio.duration = 0;
    audio.ontimeupdate?.();
    expect(seen.at(-1)).toMatchObject({
      progress: 0,
      currentTimeMs: 0,
      durationMs: 200_401,
    });

    audio.pause();
    expect(seen.at(-1)).toMatchObject({ isPlaying: false });
    audio.play();
    audio.ended = true;
    audio.onpause?.();
    expect(seen.at(-1)).toMatchObject({ isPlaying: true });
    audio.onended?.();
    expect(seen.at(-1)).toMatchObject({
      isPlaying: false,
      progress: 1,
      endedToken: audio.src && seen.at(-1).track.token,
    });
    audio.onerror?.();
    expect(seen.at(-1)).toMatchObject({ isPlaying: false });

    const count = seen.length;
    unsubscribe();
    audio.onplay?.();
    expect(seen).toHaveLength(count);
  });

  it("reads no progress from a position the element cannot report", () => {
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    const audio = EventAudio.created[0];
    audio.duration = 100;
    audio.currentTime = Number.NaN;
    audio.ontimeupdate?.();
    expect(getProgramAudioBusSnapshot(programId)).toMatchObject({
      progress: 0,
      currentTimeMs: 0,
    });
  });

  it("replaces a paused track at once, even when its element will not rewind", () => {
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    const one = EventAudio.created[0];
    one.pause();
    Object.defineProperty(one, "currentTime", {
      get: () => 12,
      set: () => {
        throw new Error("InvalidStateError");
      },
    });
    ensureProgramAudioBusTrack(programId, busTrack("two"));
    expect(one.onplay).toBeNull();
    expect(getProgramAudioBusSnapshot(programId)).toMatchObject({
      isPlaying: true,
      track: { token: "bus:two" },
    });
  });

  it("reports no duration for a track that gives none", () => {
    ensureProgramAudioBusTrack(programId, busTrack("one", { durationMs: -1 }));
    expect(getProgramAudioBusSnapshot(programId)).toMatchObject({
      durationMs: null,
      currentTimeMs: 0,
    });
    stopProgramAudioBus(programId);
    ensureProgramAudioBusTrack(
      programId,
      busTrack("two", { durationMs: Number.NaN }),
    );
    EventAudio.created[1].currentTime = 12.3456;
    expect(getProgramAudioBusSnapshot(programId)).toMatchObject({
      durationMs: null,
      currentTimeMs: 12_346,
    });
  });

  it("restarts the same track after it ended, resumes it when paused, and leaves it when playing", () => {
    const one = busTrack("one");
    ensureProgramAudioBusTrack(programId, one);
    const audio = EventAudio.created[0];
    audio.currentTime = 30;
    audio.ended = true;
    audio.paused = true;
    audio.onended?.();
    const play = vi.spyOn(audio, "play");
    ensureProgramAudioBusTrack(programId, { ...one, token: ` ${one.token} ` });
    expect(audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    expect(getProgramAudioBusSnapshot(programId)).toMatchObject({
      endedToken: "",
      progress: 0,
    });

    audio.ended = false;
    ensureProgramAudioBusTrack(programId, one);
    expect(play).toHaveBeenCalledTimes(1);

    // A refused resume (an autoplay rule) keeps the track as it is.
    audio.paused = true;
    EventAudio.playResult = () => Promise.reject(new Error("NotAllowedError"));
    ensureProgramAudioBusTrack(programId, one);
    // An old element whose play() returns nothing.
    audio.paused = true;
    EventAudio.playResult = () => undefined;
    ensureProgramAudioBusTrack(programId, one);
    expect(play).toHaveBeenCalledTimes(3);
    expect(EventAudio.created).toHaveLength(1);
  });

  it("reports a track the browser refuses to start", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = new Error("NotAllowedError");
    EventAudio.playResult = () => Promise.reject(refusal);
    const one = busTrack("one");
    ensureProgramAudioBusTrack(programId, one);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenCalledWith(
      `Failed to start audio bus track "${one.audioUrl}"`,
      refusal,
    );
    expect(getProgramAudioBusSnapshot(programId).isPlaying).toBe(false);

    // An old element whose play() returns nothing is taken as started.
    stopProgramAudioBus(programId);
    EventAudio.playResult = () => undefined;
    ensureProgramAudioBusTrack(programId, busTrack("two"));
    expect(getProgramAudioBusSnapshot(programId).isPlaying).toBe(true);
  });

  it("fades between tracks, and handles an incoming track that will not start", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    const refusal = new Error("NotAllowedError");
    EventAudio.playResult = () => Promise.reject(refusal);
    const two = busTrack("two");
    ensureProgramAudioBusTrack(programId, two);
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toHaveBeenCalledWith(
      `Failed to start audio bus track "${two.audioUrl}"`,
      refusal,
    );
    expect(getProgramAudioBusSnapshot(programId)).toMatchObject({
      isPlaying: false,
      track: { token: "bus:two" },
    });

    // The incoming element started (play() returning nothing): it fades in to the master volume.
    EventAudio.playResult = () => undefined;
    stopProgramAudioBus(programId);
    ensureProgramAudioBusTrack(programId, busTrack("three"));
    setProgramAudioBusMasterVolume(programId, 0.5);
    ensureProgramAudioBusTrack(programId, busTrack("four"));
    await vi.advanceTimersByTimeAsync(1000);
    const four = EventAudio.created.at(-1)!;
    expect(four.volume).toBe(0.5);
  });

  it("switches at once from a track that already ended, and from silence to silence", async () => {
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    const one = EventAudio.created[0];
    // Still "playing" to the bus, but the element has ended: no fade-out.
    one.ended = false;
    one.volume = 0;
    setProgramAudioBusMasterVolume(programId, 0);
    ensureProgramAudioBusTrack(programId, busTrack("two"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe("bus:two");
    expect(EventAudio.created[1].volume).toBe(0);
  });

  it("drops a fade-in when another song is asked for during it", async () => {
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    ensureProgramAudioBusTrack(programId, busTrack("two"));
    await vi.advanceTimersByTimeAsync(460);
    // The fade-out finished and two started fading in; three takes over.
    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe("bus:two");
    ensureProgramAudioBusTrack(programId, busTrack("three"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe(
      "bus:three",
    );
    expect(EventAudio.created[1].volume).toBeLessThan(1);
  });

  it("drops a switch whose incoming track starts only after another switch began", async () => {
    let start: () => void = () => {};
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    EventAudio.playResult = () =>
      new Promise<void>((resolve) => (start = resolve));
    ensureProgramAudioBusTrack(programId, busTrack("two"));
    await vi.advanceTimersByTimeAsync(460);
    const two = EventAudio.created[1];
    EventAudio.playResult = () => Promise.resolve();
    stopProgramAudioBus(programId);
    start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(two.volume).toBe(0);
  });

  it("applies the master volume to the playing track, a missing volume reading as full", () => {
    setProgramAudioBusMasterVolume(programId, 0.4);
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    const audio = EventAudio.created[0];
    expect(audio.volume).toBe(0.4);
    setProgramAudioBusMasterVolume(programId, 2);
    expect(audio.volume).toBe(1);
    setProgramAudioBusMasterVolume(programId, Number.NaN);
    expect(audio.volume).toBe(1);
    setProgramAudioBusMasterVolume(programId, -1);
    expect(audio.volume).toBe(0);
  });
});

describe("program audio bus: level meter", () => {
  let programId = "";
  beforeEach(() => {
    vi.useFakeTimers();
    EventAudio.created = [];
    EventAudio.crossOriginMode = null;
    EventAudio.playResult = () => Promise.resolve();
    vi.stubGlobal("Audio", EventAudio);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    programId = `bus-meter-${Math.random()}`;
  });
  afterEach(() => {
    stopProgramAudioBus(programId);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the post-fader level when the browser has no Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    setProgramAudioBusMasterVolume(programId, 0.6);
    expect(getProgramAudioBusSignalSnapshot(programId)).toEqual({
      rms: 0.6,
      peak: 0.6,
    });
    // Attack toward the level, then release when it pauses.
    expect(getProgramAudioBusSignalLevel(programId)).toBeCloseTo(0.27, 10);
    expect(getProgramAudioBusSignalLevel(programId)).toBeCloseTo(0.4185, 10);
    setProgramAudioBusMasterVolume(programId, 0.1);
    expect(getProgramAudioBusSignalLevel(programId)).toBeCloseTo(
      0.4185 + (0.1 - 0.4185) * 0.2,
      10,
    );
    EventAudio.created[0].pause();
    expect(getProgramAudioBusSignalLevel(programId)).toBe(0);
    EventAudio.created[0].play();
    EventAudio.created[0].ended = true;
    expect(getProgramAudioBusSignalSnapshot(programId)).toEqual({
      rms: 0,
      peak: 0,
    });
  });

  it("measures the captured stream with an analyser and resumes a suspended context", () => {
    const { Context, made } = audioContextClass({
      state: "suspended",
      samples: [0.5, -0.5, 0.5, -1],
    });
    vi.stubGlobal("AudioContext", Context);
    (EventAudio.prototype as any).captureStream = () => ({ stream: true });
    try {
      ensureProgramAudioBusTrack(programId, busTrack("one"));
    } finally {
      delete (EventAudio.prototype as any).captureStream;
    }
    expect(made).toHaveLength(1);
    expect(made[0].resume).toHaveBeenCalled();
    const signal = getProgramAudioBusSignalSnapshot(programId);
    expect(signal.peak).toBe(1);
    expect(signal.rms).toBeCloseTo(Math.sqrt((0.25 * 3 + 1) / 4), 10);
    // Release while the level falls.
    getProgramAudioBusSignalLevel(programId);
    const level = getProgramAudioBusSignalLevel(programId);
    expect(level).toBeGreaterThan(0);
    // The context is reused for the next track.
    ensureProgramAudioBusTrack(programId, busTrack("two"));
    expect(made).toHaveLength(1);
  });

  it("falls back to Firefox stream capture, and survives a refused resume", async () => {
    const { Context, made } = audioContextClass({
      state: "suspended",
      resume: () => Promise.reject(new Error("gesture")),
      samples: [0.2],
    });
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", Context);
    (EventAudio.prototype as any).mozCaptureStream = () => ({ stream: true });
    try {
      ensureProgramAudioBusTrack(programId, busTrack("one"));
      await vi.advanceTimersByTimeAsync(0);
      expect(made[0].resume).toHaveBeenCalled();
      expect(getProgramAudioBusSignalSnapshot(programId).rms).toBeCloseTo(
        0.2,
        6,
      );
    } finally {
      delete (EventAudio.prototype as any).mozCaptureStream;
    }
  });

  it("routes the element through the meter when the stream cannot be captured, and unmutes it after", () => {
    EventAudio.crossOriginMode = "anonymous";
    const { Context, made } = audioContextClass({
      state: "running",
      samples: [0.3],
    });
    vi.stubGlobal("AudioContext", Context);
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    const audio = EventAudio.created[0];
    expect(audio.muted).toBe(true);
    const source = made[0].sources.find((node: any) => node.kind === "element");
    expect(source.connect).toHaveBeenCalledWith(made[0].destination);
    expect(getProgramAudioBusSignalSnapshot(programId).rms).toBeCloseTo(0.3, 6);
    stopProgramAudioBus(programId);
    expect(audio.muted).toBe(false);
  });

  it("attaches the element once a suspended context resumes, unless the track moved on", async () => {
    EventAudio.crossOriginMode = "anonymous";
    const { Context, made } = audioContextClass({
      state: "suspended",
      samples: [0.4],
    });
    vi.stubGlobal("AudioContext", Context);
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    made[0].state = "running";
    await vi.advanceTimersByTimeAsync(0);
    expect(EventAudio.created[0].muted).toBe(true);
    expect(getProgramAudioBusSignalSnapshot(programId).rms).toBeCloseTo(0.4, 6);

    // A resume that lands after the track was replaced, or after a meter
    // attached, does nothing.
    made[0].state = "suspended";
    stopProgramAudioBus(programId);
    ensureProgramAudioBusTrack(programId, busTrack("two"));
    stopProgramAudioBus(programId);
    made[0].state = "running";
    await vi.advanceTimersByTimeAsync(0);
    expect(EventAudio.created[1].muted).toBe(false);
  });

  it("plays a song from another origin without CORS on its own, never muted through the meter", async () => {
    // The production song store sends no CORS headers. Web Audio outputs
    // silence for such a source, so routing it would play the song silent.
    const { Context, made } = audioContextClass({
      state: "running",
      samples: [0.3],
    });
    vi.stubGlobal("AudioContext", Context);
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    const audio = EventAudio.created[0];
    expect(audio.crossOrigin).toBeNull();
    expect(audio.muted).toBe(false);
    expect(made[0].sources.some((node: any) => node.kind === "element")).toBe(
      false,
    );

    stopProgramAudioBus(programId);

    // Nor once a suspended context resumes.
    const resumingProgram = `${programId}-resume`;
    const suspended = audioContextClass({ state: "suspended", samples: [0.3] });
    vi.stubGlobal("AudioContext", suspended.Context);
    ensureProgramAudioBusTrack(resumingProgram, busTrack("two"));
    suspended.made[0].state = "running";
    await vi.advanceTimersByTimeAsync(0);
    expect(EventAudio.created[1].muted).toBe(false);
    expect(
      suspended.made[0].sources.some((node: any) => node.kind === "element"),
    ).toBe(false);
    stopProgramAudioBus(resumingProgram);
  });

  it("keeps the bus playing when the meter cannot attach", async () => {
    const throwing = audioContextClass({
      state: "suspended",
      elementSourceThrows: true,
    });
    vi.stubGlobal("AudioContext", throwing.Context);
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    throwing.made[0].state = "running";
    await vi.advanceTimersByTimeAsync(0);
    expect(getProgramAudioBusSnapshot(programId).isPlaying).toBe(true);
    stopProgramAudioBus(programId);

    const refused = audioContextClass({
      state: "suspended",
      resume: () => Promise.reject(new Error("gesture")),
    });
    vi.stubGlobal("AudioContext", refused.Context);
    const other = `${programId}-refused`;
    ensureProgramAudioBusTrack(other, busTrack("one"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getProgramAudioBusSnapshot(other).isPlaying).toBe(true);
    stopProgramAudioBus(other);
  });

  it("plays without a meter when the analyser cannot be built", () => {
    const { Context } = audioContextClass({ state: "running" });
    (Context.prototype as any).createMediaStreamSource = () => {
      throw new Error("stream ended");
    };
    vi.stubGlobal("AudioContext", Context);
    (EventAudio.prototype as any).captureStream = () => ({ stream: true });
    try {
      ensureProgramAudioBusTrack(programId, busTrack("one"));
    } finally {
      delete (EventAudio.prototype as any).captureStream;
    }
    expect(getProgramAudioBusSnapshot(programId).isPlaying).toBe(true);
    expect(getProgramAudioBusSignalSnapshot(programId).rms).toBe(1);
  });

  it("ignores meter nodes that are already disconnected", () => {
    const { Context } = audioContextClass({
      state: "running",
      disconnectThrows: true,
    });
    vi.stubGlobal("AudioContext", Context);
    ensureProgramAudioBusTrack(programId, busTrack("one"));
    expect(() => stopProgramAudioBus(programId)).not.toThrow();
  });

  it("follows a decoded loudness envelope when no analyser can attach", async () => {
    // 2 channels x 1024 samples at 10 kHz: frames of 256 samples (24 ms
    // rounds up to the 256-sample minimum), each frame at its own level.
    const levels = [0.1, 0.8, 0.2, 0.6];
    const channel = (scale: number) =>
      Float32Array.from(
        { length: 1024 },
        (_, index) => levels[Math.floor(index / 256)] * scale,
      );
    const decoded = {
      numberOfChannels: 2,
      length: 1024,
      sampleRate: 10_000,
      getChannelData: (index: number) => channel(index === 0 ? 1 : 0.5),
    };
    const { Context } = audioContextClass({
      state: "closed",
      decode: async () => decoded,
    });
    vi.stubGlobal("AudioContext", Context);
    const fetch = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(8)));
    vi.stubGlobal("fetch", fetch);
    const sameOrigin = `${window.location.origin}/media/song-${Math.random()}.mp3`;
    ensureProgramAudioBusTrack(programId, {
      token: "bus:envelope",
      audioUrl: sameOrigin,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledWith(sameOrigin);
    const audio = EventAudio.created[0];
    audio.volume = 0.5;
    const levelAt = (seconds: number) => {
      audio.currentTime = seconds;
      return getProgramAudioBusSignalSnapshot(programId).rms;
    };
    // Frame 2 (0.8) is the loudest and frame 1 (0.1) the quietest.
    expect(levelAt(0)).toBe(0);
    expect(levelAt(0.03)).toBeCloseTo(0.5, 6);
    expect(levelAt(9)).toBeGreaterThan(0);
    audio.currentTime = Number.NaN;
    expect(getProgramAudioBusSignalSnapshot(programId).rms).toBe(0.5);
  });

  it("fetches a remote envelope through the audio proxy, once per URL, and ignores one that fails", async () => {
    const { Context } = audioContextClass({ state: "closed" });
    vi.stubGlobal("AudioContext", Context);
    const fetch = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(8)));
    vi.stubGlobal("fetch", fetch);
    const remote = `https://cdn.test/song-${Math.random()}.mp3`;
    ensureProgramAudioBusTrack(programId, {
      token: "bus:remote",
      audioUrl: remote,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        `/program/audio-proxy?url=${encodeURIComponent(remote)}`,
      ),
    );
    // The decoder refused it: the meter shows the post-fader level.
    expect(getProgramAudioBusSignalSnapshot(programId).rms).toBe(1);
    stopProgramAudioBus(programId);
    ensureProgramAudioBusTrack(programId, {
      token: "bus:again",
      audioUrl: remote,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // A URL that cannot be parsed still goes through the proxy; a refused
    // download leaves no envelope.
    fetch.mockResolvedValue(new Response(null, { status: 404 }));
    const broken = `http://[bad-${Math.random()}`;
    stopProgramAudioBus(programId);
    ensureProgramAudioBusTrack(programId, {
      token: "bus:broken",
      audioUrl: broken,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining(
        `/program/audio-proxy?url=${encodeURIComponent(broken)}`,
      ),
    );
    expect(getProgramAudioBusSignalSnapshot(programId).rms).toBe(1);
  });

  it("drops an envelope that arrives after the track changed, and one with no audio", async () => {
    const empty = {
      numberOfChannels: 0,
      length: 0,
      sampleRate: 44_100,
      getChannelData: () => new Float32Array(),
    };
    let decode: (value: unknown) => void = () => {};
    const { Context } = audioContextClass({
      state: "closed",
      decode: () => new Promise((resolve) => (decode = resolve)),
    });
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ArrayBuffer(8))),
    );
    ensureProgramAudioBusTrack(programId, busTrack("first"));
    await vi.advanceTimersByTimeAsync(0);
    const first = decode;
    stopProgramAudioBus(programId);
    ensureProgramAudioBusTrack(programId, busTrack("second"));
    await vi.advanceTimersByTimeAsync(0);
    first({
      numberOfChannels: 1,
      length: 512,
      sampleRate: 44_100,
      getChannelData: () => new Float32Array(512).fill(0.9),
    });
    await vi.advanceTimersByTimeAsync(0);
    decode(empty);
    await vi.advanceTimersByTimeAsync(500);
    expect(getProgramAudioBusSignalSnapshot(programId).rms).toBe(1);
    for (const bad of [
      { numberOfChannels: 1, length: 0, sampleRate: 44_100 },
      { numberOfChannels: 1, length: 10, sampleRate: Number.NaN },
      { numberOfChannels: 1, length: 10, sampleRate: 0 },
    ]) {
      stopProgramAudioBus(programId);
      ensureProgramAudioBusTrack(programId, busTrack("bad"));
      await vi.advanceTimersByTimeAsync(0);
      decode({ ...bad, getChannelData: () => new Float32Array(10) });
      await vi.advanceTimersByTimeAsync(0);
      expect(getProgramAudioBusSignalSnapshot(programId).rms).toBe(1);
    }
  });
});
