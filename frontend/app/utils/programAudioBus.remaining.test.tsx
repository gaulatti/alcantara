import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureProgramAudioBusTrack,
  getProgramAudioBusSignalSnapshot,
  getProgramAudioBusSnapshot,
  stopProgramAudioBus,
} from "./programAudioBus";

// gaulatti/alcantara#404 (group C): the level meter's failure paths and the page-less case, with the
// Web Audio objects a browser would hand the bus failing in each way.

class Audio_ {
  static created: Audio_[] = [];
  src: string;
  volume = 1;
  muted = false;
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  crossOrigin: string | null = "anonymous";
  preload = "";
  captureStream?: () => unknown;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src = "") {
    this.src = src;
    Audio_.created.push(this);
  }
  play() {
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
}

const track = (name: string) => ({
  token: `rem:${name}`,
  audioUrl: `https://audio.test/${name}-${Math.random()}.mp3`,
});

let programId = "";
beforeEach(() => {
  vi.useFakeTimers();
  Audio_.created = [];
  vi.stubGlobal("Audio", Audio_);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  programId = `bus-rem-${Math.random()}`;
});
afterEach(() => {
  stopProgramAudioBus(programId);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const node = (disconnects: () => void) => ({ connect: vi.fn(), disconnect: vi.fn(disconnects) });

it("stops cleanly when the browser refuses to disconnect the meter's nodes", () => {
  const disconnect = () => {
    throw new Error("already disconnected");
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      resume = () => Promise.resolve();
      createMediaStreamSource = () => node(disconnect);
      createAnalyser = () => ({ ...node(disconnect), fftSize: 0, smoothingTimeConstant: 0, getFloatTimeDomainData() {} });
      decodeAudioData = () => Promise.reject(new Error("no decoder"));
    },
  );
  class StreamAudio extends Audio_ {
    captureStream = () => ({});
  }
  vi.stubGlobal("Audio", StreamAudio);
  ensureProgramAudioBusTrack(programId, track("one"));
  expect(() => stopProgramAudioBus(programId)).not.toThrow();
  expect(getProgramAudioBusSnapshot(programId).isPlaying).toBe(false);
  // A second song builds a new meter, releasing nothing that is left.
  expect(() => ensureProgramAudioBusTrack(programId, track("two"))).not.toThrow();
});

it("keeps playing without a meter when routing the element fails after the context resumes", async () => {
  let resolveResume!: () => void;
  const context = {
    state: "suspended",
    destination: {},
    resume: () => new Promise<void>((resolve) => (resolveResume = resolve)),
    createMediaElementSource: () => {
      throw new Error("already attached");
    },
    createAnalyser: () => ({ ...node(() => {}), fftSize: 0, smoothingTimeConstant: 0 }),
    decodeAudioData: () => Promise.reject(new Error("no decoder")),
  };
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  ensureProgramAudioBusTrack(programId, track("one"));
  context.state = "running";
  resolveResume();
  await vi.advanceTimersByTimeAsync(10);
  expect(getProgramAudioBusSnapshot(programId).isPlaying).toBe(true);
  expect(getProgramAudioBusSignalSnapshot(programId)).toEqual({ rms: 1, peak: 1 });
});

it("plays without a meter when there is no page to ask for an AudioContext", () => {
  vi.stubGlobal("window", undefined);
  expect(() => ensureProgramAudioBusTrack(programId, track("one"))).not.toThrow();
  expect(Audio_.created.map((audio) => audio.paused)).toEqual([false]);
});

it("builds the envelope's context itself when the meter could not, and plays on if that fails too", async () => {
  let constructed = 0;
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      constructor() {
        constructed += 1;
        // The first request (the meter's) is refused; the envelope's second one is allowed.
        if (constructed === 1) throw new DOMException("No audio output", "NotSupportedError");
      }
      decodeAudioData() {
        return Promise.reject(new Error("no decoder"));
      }
    },
  );
  ensureProgramAudioBusTrack(programId, track("one"));
  await vi.advanceTimersByTimeAsync(10);
  expect(constructed).toBe(2);
  expect(getProgramAudioBusSnapshot(programId).isPlaying).toBe(true);
});

it("treats a program id that is not a string as no program", () => {
  expect(getProgramAudioBusSnapshot(undefined as never)).toMatchObject({ track: null, isPlaying: false });
  expect(getProgramAudioBusSignalSnapshot(7 as never)).toEqual({ rms: 0, peak: 0 });
});

// gaulatti/alcantara#438: the guards on the on-air audio path stay, and each is fed the bad input it
// guards against, asserting the safe result.

it("plays a padded URL trimmed, and refuses a blank one without a song or a meter", () => {
  ensureProgramAudioBusTrack(programId, { token: "rem:pad", audioUrl: "  https://audio.test/padded.mp3  " });
  expect(Audio_.created.map((audio) => audio.src)).toEqual(["https://audio.test/padded.mp3"]);
  stopProgramAudioBus(programId);
  Audio_.created = [];
  ensureProgramAudioBusTrack(programId, { token: "rem:blank", audioUrl: "   " });
  ensureProgramAudioBusTrack(programId, { token: "   ", audioUrl: "https://audio.test/x.mp3" });
  expect(Audio_.created).toHaveLength(0);
});

it("resolves an envelope URL that is blank, padded, relative, foreign or malformed to a safe address", async () => {
  const { resolveEnvelopeFetchUrl } = await import("./programAudioBus");
  expect(resolveEnvelopeFetchUrl("")).toBe("");
  expect(resolveEnvelopeFetchUrl("   ")).toBe("");
  expect(resolveEnvelopeFetchUrl(`  ${window.location.origin}/a.mp3  `)).toBe(`${window.location.origin}/a.mp3`);
  expect(resolveEnvelopeFetchUrl("/relative.mp3")).toBe(`${window.location.origin}/relative.mp3`);
  expect(resolveEnvelopeFetchUrl("https://elsewhere.test/a.mp3")).toContain(
    `audio-proxy?url=${encodeURIComponent("https://elsewhere.test/a.mp3")}`,
  );
  expect(resolveEnvelopeFetchUrl("http://[bad")).toContain("audio-proxy?url=");
});

it("sets up no envelope for a URL that is blank or not a string", async () => {
  const { setupAudioMeterEnvelope } = await import("./programAudioBus");
  const state = { meterEnvelopeUrl: "keep", meterEnvelope: { values: new Float32Array(1), stepMs: 1 } } as never;
  setupAudioMeterEnvelope(state, "   ");
  expect(state).toMatchObject({ meterEnvelopeUrl: "", meterEnvelope: null });
  setupAudioMeterEnvelope(state, undefined as never);
  expect(state).toMatchObject({ meterEnvelopeUrl: "", meterEnvelope: null });
});

it("reports the post-fader level when the decoded track is empty", async () => {
  const bus = await import("./programAudioBus");
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "suspended";
      resume = () => new Promise<void>(() => {});
      decodeAudioData = () => Promise.resolve({ numberOfChannels: 2, length: 0, sampleRate: 44100, getChannelData: () => new Float32Array(0) });
    },
  );
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(new ArrayBuffer(8)))));
  bus.ensureProgramAudioBusTrack(programId, track("empty"));
  await vi.advanceTimersByTimeAsync(50);
  expect(bus.getProgramAudioBusSignalSnapshot(programId)).toEqual({ rms: 1, peak: 1 });
});
