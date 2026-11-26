import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProgramAudioBusTrack, getProgramAudioBusSnapshot, stopProgramAudioBus } from "./programAudioBus";

// gaulatti/alcantara#624: a fade that is overtaken. A stop during the fade-out, and a second request during it,
// must leave the bus on the last thing asked for, with no second song started by the old fade. Fictional names.

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

describe("program audio bus: a fade that is overtaken", () => {
  let programId = "";

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.created = [];
    vi.stubGlobal("Audio", FakeAudio);
    programId = `bus-superseded-${Math.random()}`;
  });

  afterEach(() => {
    stopProgramAudioBus(programId);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not start the faded-out song when the bus is stopped during the fade", async () => {
    ensureProgramAudioBusTrack(programId, track("one"));
    ensureProgramAudioBusTrack(programId, track("two"));
    stopProgramAudioBus(programId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeAudio.created.filter((audio) => !audio.paused)).toHaveLength(0);
    expect(getProgramAudioBusSnapshot(programId).track).toBeNull();
  });
});
