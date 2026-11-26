import { describe, expect, it } from "vitest";
import type { ProgramSongPlaybackState } from "../../models/broadcast";
import { deriveOnAir, type OnAirInput } from "./onAir";

// gaulatti/alcantara#694: while output confidence reads silent, the on-air strip leads with a dead-air
// chip, so it never reads all good while the listener hears nothing.

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
  it("leads with a dead-air chip while the output is silent", () => {
    const view = deriveOnAir({ ...base, outputSilent: true });
    expect(view.chips[0]).toEqual({
      id: "output",
      tone: "bad",
      label: "Dead air",
      title:
        "Expected audio is silent: a song is playing but the output is quiet.",
    });
    // The other chips still say what they know.
    expect(view.chips.map((chip) => chip.label)).toEqual([
      "Dead air",
      "Stream verified",
      "Engine ready",
      "Monitor off",
    ]);
  });

  it("shows no output chip while the output is not silent", () => {
    for (const outputSilent of [false, undefined]) {
      const view = deriveOnAir({ ...base, outputSilent });
      expect(view.chips.some((chip) => chip.id === "output")).toBe(false);
    }
  });
});
