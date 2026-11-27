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

  it("shows an engine whose first status has not answered as Checking engine, neutral, not unavailable", () => {
    const view = deriveOnAir({
      ...base,
      engine: { ...base.engine, connected: false, unknown: true },
    });
    expect(view.chips.find((chip) => chip.id === "engine")).toEqual({
      id: "engine",
      tone: "idle",
      label: "Checking engine",
      title: "Waiting for the engine's first status.",
    });
  });

  it("lets an answered status win over the unknown flag", () => {
    const view = deriveOnAir({
      ...base,
      engine: { ...base.engine, connected: true, unknown: true },
    });
    expect(view.chips.find((chip) => chip.id === "engine")?.label).toBe("Engine ready");
  });
});

// Walk part 5: with a song in Play Next, the strip still labelled Next by the rotation's mode.
describe("deriveOnAir names where the next song comes from", () => {
  const next = { title: "Copper Season", artist: "The Paper Hours", durationMs: null };
  it("labels a queued next as Play Next, whatever the mode", () => {
    expect(deriveOnAir({ ...base, mode: "shuffle", next: { ...next, via: "queue" } }).modeLabel).toBe("Play Next");
  });
  it("labels a next from the rotation by the mode", () => {
    expect(deriveOnAir({ ...base, mode: "shuffle", next: { ...next, via: "rotation" } }).modeLabel).toBe("Shuffle");
    expect(deriveOnAir({ ...base, mode: "autoplay", next }).modeLabel).toBe("Autoplay");
  });
});
