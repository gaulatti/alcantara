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
});
