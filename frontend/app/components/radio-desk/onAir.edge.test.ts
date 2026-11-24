import { describe, expect, it } from "vitest";
import type { ProgramSongPlaybackState } from "../../models/broadcast";
import { deriveOnAir, type OnAirInput } from "./onAir";

// gaulatti/alcantara#527 (radio desk on-air view, untriaged gaps): a degraded intro with no reason, an engine
// degraded with no detail, and a next song with no length. The on-air strip must still say what it knows.

const playback = (extra: Partial<ProgramSongPlaybackState> = {}): ProgramSongPlaybackState => ({
  token: "s1:1",
  audioUrl: "https://media.test/s1.mp3",
  title: "Harbor Lights",
  artist: "Marisol Vega",
  progress: 0.3,
  currentTimeMs: 72_000,
  durationMs: 214_000,
  isPlaying: true,
  updatedAt: "2026-11-22T12:00:00Z",
  ...extra,
});

const base: OnAirInput = {
  playback: playback(),
  next: { title: "Copper Season", artist: "The Paper Hours", durationMs: 241_000 },
  mode: "autoplay",
  streamRunning: true,
  engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
  monitor: "stopped",
} as unknown as OnAirInput;

describe("deriveOnAir with missing details", () => {
  it("names a degraded intro without a reason as unavailable, with no colon", () => {
    const view = deriveOnAir({ ...base, playback: playback({ introStatus: "degraded", introFailureReason: null } as Partial<ProgramSongPlaybackState>) });
    expect(view.intro).toEqual({ label: "Intro unavailable", tone: "warn" });
  });

  it("shows an engine degradation without a title when the engine gives no detail", () => {
    const view = deriveOnAir({ ...base, engine: { connected: true, degraded: true, unavailableLabel: "x", detail: null } } as unknown as OnAirInput);
    const engine = view.chips.find((chip) => chip.id === "engine");
    expect(engine).toMatchObject({ tone: "warn", label: "Engine degraded" });
    expect(engine?.title).toBeUndefined();
  });

  it("gives the next song without a length a detail of its artist alone", () => {
    const view = deriveOnAir({ ...base, next: { title: "Copper Season", artist: "The Paper Hours", durationMs: null } });
    expect(view.next).toMatchObject({ title: "Copper Season", detail: "The Paper Hours" });
  });
});
