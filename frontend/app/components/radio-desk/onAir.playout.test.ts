import { describe, expect, it } from "vitest";
import { deriveOnAir, type OnAirInput } from "./onAir";

// Playout down (the #734 follow-up): Palazzo answers, but its playout (Liquidsoap) is down. The engine chip says so,
// in the bad tone, whatever the connection reads; a Palazzo that is not connected keeps its own unavailable state.

const base = {
  playback: null,
  next: null,
  mode: "manual",
  streamRunning: true,
  engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
  monitor: "stopped",
} as unknown as OnAirInput;

describe("deriveOnAir and playout down", () => {
  it("shows Playout down, in the bad tone, when Palazzo answers but its playout is down", () => {
    for (const degraded of [false, true]) {
      const view = deriveOnAir({
        ...base,
        engine: { ...base.engine, degraded },
        playoutDown: true,
      });
      expect(view.chips.find((chip) => chip.id === "engine")).toMatchObject({
        tone: "bad",
        label: "Playout down",
      });
    }
  });

  it("keeps the engine's own unavailable state when Palazzo itself is not connected", () => {
    const view = deriveOnAir({
      ...base,
      engine: { ...base.engine, connected: false },
      playoutDown: true,
    });
    expect(view.chips.find((chip) => chip.id === "engine")?.label).toBe("Engine unavailable");
  });

  // The airing walk's W5: about 45 s into playout down, a fresh sample turned the pill back to On air with a clock.
  it("never says On air, and shows no clock, while a song plays with playout down, whatever the samples say", () => {
    const playback = {
      isPlaying: true,
      title: "Fictional song",
      artist: "Fictional artist",
      currentTimeMs: 85_000,
      durationMs: 240_000,
      telemetryStale: false,
    } as unknown as OnAirInput["playback"];
    for (const outputUnverified of [false, true]) {
      const view = deriveOnAir({ ...base, playback, outputUnverified, playoutDown: true });
      expect(view.state).toBe("unconfirmed");
      expect(view.label).toBe("Not confirmed");
      expect(view.elapsedMs).toBeNull();
      expect(view.remainingMs).toBeNull();
    }
    // Playout back: the same song is On air again with its clock.
    const back = deriveOnAir({ ...base, playback, playoutDown: false });
    expect(back.state).toBe("on-air");
    expect(back.remainingMs).toBe(155_000);
  });
});
