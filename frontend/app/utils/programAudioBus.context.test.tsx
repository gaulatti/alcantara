import { afterEach, expect, it, vi } from "vitest";
import {
  ensureProgramAudioBusTrack,
  getProgramAudioBusSignalSnapshot,
  getProgramAudioBusSnapshot,
  stopProgramAudioBus,
} from "./programAudioBus";

// A browser can refuse to create an AudioContext (NotSupportedError, for
// example when no audio output is available). The level meter is optional;
// the song must still start.

class PlayingAudio {
  static created: PlayingAudio[] = [];
  volume = 1;
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
  constructor(public src = "") {
    PlayingAudio.created.push(this);
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

const programId = `bus-no-context-${Math.random()}`;

afterEach(() => {
  stopProgramAudioBus(programId);
  vi.unstubAllGlobals();
});

it("starts the song without a meter when the AudioContext cannot be created", () => {
  vi.stubGlobal("Audio", PlayingAudio);
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        throw new DOMException("No audio output", "NotSupportedError");
      }
    },
  );
  expect(() =>
    ensureProgramAudioBusTrack(programId, {
      token: "manual:one",
      audioUrl: "https://audio.test/one.mp3",
    }),
  ).not.toThrow();
  expect(PlayingAudio.created.map((audio) => audio.paused)).toEqual([false]);
  expect(getProgramAudioBusSnapshot(programId)).toMatchObject({
    isPlaying: true,
    track: { token: "manual:one" },
  });
  // Without a meter the bus reports the post-fader level.
  expect(getProgramAudioBusSignalSnapshot(programId)).toEqual({
    rms: 1,
    peak: 1,
  });
});

// gaulatti/alcantara#202: the skipped loudness envelope is logged once per
// page, with a fixed message and no track URL. A fresh module stands for a
// fresh page.
it("logs the skipped level envelope once, without the track's URL", async () => {
  vi.resetModules();
  const bus = await import("./programAudioBus");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("Audio", PlayingAudio);
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        throw new DOMException("No audio output", "NotSupportedError");
      }
    },
  );
  const page = `bus-page-${Math.random()}`;
  for (const name of ["two", "three"]) {
    bus.stopProgramAudioBus(page);
    bus.ensureProgramAudioBusTrack(page, {
      token: `manual:${name}`,
      audioUrl: `https://audio.test/private-${name}.mp3`,
    });
  }
  bus.stopProgramAudioBus(page);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    "Program audio level envelope skipped: the browser refused an AudioContext.",
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain("audio.test");
  warn.mockRestore();
});
