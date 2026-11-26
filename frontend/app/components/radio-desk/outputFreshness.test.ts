import { describe, expect, it } from "vitest";
import type { ProgramSongPlaybackState } from "../../models/broadcast";
import { deriveOnAir, type OnAirInput } from "./onAir";
import { isOutputSampleUnverified, OUTPUT_SAMPLE_UNVERIFIED_MS } from "./outputFreshness";

// gaulatti/alcantara#706: audible output whose last level sample is older than 6 s is unverified, and the strip
// shows Unverified with its clock kept; Not confirmed and Status delayed still win.

const at = Date.parse("2026-11-26T12:00:00Z");
const audible = (ageMs: number) => ({
  state: "audible",
  lastSampleAt: new Date(at - ageMs).toISOString(),
});

describe("isOutputSampleUnverified", () => {
  it("holds audible output verified up to the limit, and unverified past it", () => {
    expect(OUTPUT_SAMPLE_UNVERIFIED_MS).toBe(6_000);
    expect(isOutputSampleUnverified(audible(5_900), at)).toBe(false);
    expect(isOutputSampleUnverified(audible(6_000), at)).toBe(false);
    expect(isOutputSampleUnverified(audible(6_100), at)).toBe(true);
  });

  it("treats audible output with no sample time as unverified, and leaves other states alone", () => {
    expect(isOutputSampleUnverified({ state: "audible", lastSampleAt: null }, at)).toBe(true);
    expect(isOutputSampleUnverified({ state: "audible", lastSampleAt: "garbled" }, at)).toBe(true);
    for (const state of ["silent", "idle", "unavailable", "checking", "unknown"])
      expect(isOutputSampleUnverified({ state, lastSampleAt: null }, at)).toBe(false);
    expect(isOutputSampleUnverified(null, at)).toBe(false);
  });
});

describe("deriveOnAir with unverified output", () => {
  const base = {
    playback: {
      token: "s1:1",
      audioUrl: "https://media.test/s1.mp3",
      title: "Harbor Lights",
      artist: "Marisol Vega",
      progress: 0.3,
      currentTimeMs: 72_000,
      durationMs: 214_000,
      isPlaying: true,
      updatedAt: "2026-11-22T12:00:00Z",
    } as ProgramSongPlaybackState,
    next: null,
    mode: "manual",
    streamRunning: true,
    engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
    monitor: "stopped",
  } as OnAirInput;

  it("shows Unverified and keeps the clock while the output is unverified", () => {
    const view = deriveOnAir({ ...base, outputUnverified: true });
    expect(view.state).toBe("unverified");
    expect(view.label).toBe("Unverified");
    expect(view.elapsedMs).toBe(72_000);
    expect(view.remainingMs).toBe(142_000);
  });

  it("lets Not confirmed and Status delayed win, and stays Off air with nothing playing", () => {
    expect(
      deriveOnAir({ ...base, outputUnverified: true, engine: { ...base.engine, connected: false } }).label,
    ).toBe("Not confirmed");
    expect(
      deriveOnAir({
        ...base,
        outputUnverified: true,
        playback: { ...base.playback!, telemetryStale: true } as ProgramSongPlaybackState,
      }).label,
    ).toBe("Status delayed");
    expect(
      deriveOnAir({
        ...base,
        outputUnverified: true,
        playback: { ...base.playback!, isPlaying: false },
      }).label,
    ).toBe("Off air");
    expect(deriveOnAir(base).label).toBe("On air");
  });
});
