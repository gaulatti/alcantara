import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProgramAudioBusTrack, getProgramAudioBusSnapshot, stopProgramAudioBus } from "./programAudioBus";

// gaulatti/alcantara#624: the transition's branches that a fade-out does not reach: a first track with nothing to fade
// out of, and an outgoing clip that has already ended. Tests only; no source change. Fictional names.

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

describe("program audio bus: transitions with nothing to fade out", () => {
  let programId = "";

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.created = [];
    vi.stubGlobal("Audio", FakeAudio);
    programId = `bus-transition-${Math.random()}`;
  });

  afterEach(() => {
    stopProgramAudioBus(programId);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts the first track on an empty bus, with nothing to fade out", async () => {
    ensureProgramAudioBusTrack(programId, track("one"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe("manual:one");
    expect(FakeAudio.created.filter((audio) => !audio.paused)).toHaveLength(1);
  });

  it("swaps to the next track without a fade when the outgoing clip has already ended", async () => {
    ensureProgramAudioBusTrack(programId, track("one"));
    await vi.advanceTimersByTimeAsync(1_000);
    FakeAudio.created[0].ended = true;
    ensureProgramAudioBusTrack(programId, track("two"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getProgramAudioBusSnapshot(programId).track?.token).toBe("manual:two");
    expect(FakeAudio.created[0].paused).toBe(true);
    expect(FakeAudio.created.at(-1)!.paused).toBe(false);
  });
});
