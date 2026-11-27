import { describe, expect, it } from "vitest";
import type { ProgramSongPlaybackState } from "../../models/broadcast";
import { deriveOnAir, type OnAirInput } from "./onAir";

// gaulatti/alcantara#694 and #879: while output confidence reads silent the strip says Dead air, so it never reads all
// good while the listener hears nothing.

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
  engine: {
    connected: true,
    degraded: false,
    unavailableLabel: "Engine unavailable",
  },
  monitor: "stopped",
} as OnAirInput;

describe("deriveOnAir and dead air", () => {
  // gaulatti/alcantara#879 reverses #694: the main pill itself says Dead air.
  it("says Dead air as the strip's own state while the output is silent", () => {
    const view = deriveOnAir({ ...base, outputSilent: true });
    expect(view).toMatchObject({ deadAir: true, label: "Dead air", title: "Harbor Lights" });
    expect(view.chips.some((chip) => chip.label === "Dead air")).toBe(false);
  });

  it("renders the good chips neutral while dead air shows, so only Dead air is coloured", () => {
    const view = deriveOnAir({ ...base, outputSilent: true });
    expect(view.chips.map((chip) => [chip.label, chip.tone])).toEqual([
      ["Stream verified", "idle"],
      ["Engine ready", "idle"],
      ["Monitor off", "idle"],
    ]);
    // Without dead air the same chips are green again.
    const healthy = deriveOnAir({ ...base, outputSilent: false });
    expect(healthy.chips.map((chip) => [chip.label, chip.tone])).toEqual([
      ["Stream verified", "ok"],
      ["Engine ready", "ok"],
      ["Monitor off", "idle"],
    ]);
  });

  it("keeps a warning chip's colour during dead air: it is a second problem, not a good state", () => {
    const view = deriveOnAir({
      ...base,
      outputSilent: true,
      streamRunning: null,
      engine: { ...base.engine, degraded: true, detail: "Telemetry late" },
    });
    expect(view.chips.map((chip) => [chip.label, chip.tone])).toEqual([
      ["Stream unverified", "warn"],
      ["Engine degraded", "warn"],
      ["Monitor off", "idle"],
    ]);
  });

  it("says nothing of dead air while the output is not silent, or when playout down says it", () => {
    for (const outputSilent of [false, undefined]) {
      const view = deriveOnAir({ ...base, outputSilent });
      expect(view.deadAir).toBeUndefined();
      expect(view.label).toBe("On air");
    }
    expect(deriveOnAir({ ...base, outputSilent: true, playoutDown: true }).deadAir).toBeUndefined();
  });
});
