import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OnAirStrip } from "./OnAirStrip";
import { deriveOnAir, type OnAirInput } from "./onAir";

// D7, from the recovery walk: while Palazzo aired its fallback playlist the strip said "Off air · Nothing on air" and
// output confidence said "Engine audio detected". Palazzo airs that playlist by itself after 15 s with nothing on the
// air and names no track for it (gaulatti/palazzo src/stream/liquidsoap-script.ts, filler_on_air). With no song
// commanded and fresh audible output the strip never says Off air; it names the fallback playlist only with the same
// engine checks as On air and when the desk knows nothing else is on the air (Wakko's #804 review).

afterEach(cleanup);

const base = {
  playback: null,
  next: null,
  mode: "manual",
  streamRunning: true,
  engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
  monitor: "stopped",
  outputAudible: true,
} as unknown as OnAirInput;
const GENERIC = "Audio on air · not from the rundown";

describe("deriveOnAir with no song commanded and audible output", () => {
  it("names the fallback playlist only when the engine airs and the desk knows nothing else is on the air", () => {
    const view = deriveOnAir({ ...base, otherAudio: "none" });
    expect(view.state).toBe("fallback");
    expect(view.label).toBe("Fallback playlist on air");
    expect(view.elapsedMs).toBeNull();
  });

  it("is generic when another source is on the air or the desk cannot tell", () => {
    for (const otherAudio of ["active", "unknown", undefined] as const) {
      const view = deriveOnAir({ ...base, otherAudio });
      expect(view.state).toBe("off-rundown");
      expect(view.label).toBe(GENERIC);
    }
  });

  it("is generic and unconfirmed, never the fallback, while the engine is not connected or its playout is down", () => {
    for (const patch of [
      { engine: { ...base.engine, connected: false } },
      { playoutDown: true },
    ]) {
      const view = deriveOnAir({ ...base, ...patch, otherAudio: "none" });
      expect(view.state).toBe("audio-unconfirmed");
      expect(view.label).toBe(GENERIC);
    }
  });

  it("stays Off air when the output is quiet, unknown, or its audible sample is stale", () => {
    for (const patch of [
      { outputAudible: undefined },
      { outputAudible: false },
      { outputUnverified: true },
    ])
      expect(
        deriveOnAir({ ...base, otherAudio: "none", ...patch }).state,
      ).toBe("off-air");
  });

  it("keeps a commanded song On air with its clock, audible or not", () => {
    const playback = {
      isPlaying: true,
      title: "Fictional song",
      artist: "Fictional artist",
      currentTimeMs: 10_000,
      durationMs: 200_000,
      telemetryStale: false,
    } as unknown as OnAirInput["playback"];
    const view = deriveOnAir({ ...base, playback, otherAudio: "none" });
    expect(view.state).toBe("on-air");
    expect(view.remainingMs).toBe(190_000);
  });
});

describe("the strip with no song commanded and audible output", () => {
  const strip = (input: Partial<OnAirInput>) => {
    render(
      <OnAirStrip programId="radio-main" view={deriveOnAir({ ...base, ...input })} />,
    );
    return {
      region: screen.getByRole("region", { name: "On air" }),
      pill: screen.getByRole("status"),
    };
  };

  it("shows the fallback playlist live, with no song clock", () => {
    const { region, pill } = strip({ otherAudio: "none" });
    expect(region).toHaveAttribute("data-state", "fallback");
    expect(pill).toHaveTextContent(/^Fallback playlist on air$/);
    expect(pill).toHaveAttribute("data-tone", "live");
    expect(screen.getByText("Fallback playlist")).toBeVisible();
    expect(screen.getByText("No song clock")).toBeVisible();
    expect(screen.queryByText(/Nothing on air/)).toBeNull();
    expect(screen.queryByTestId("on-air-clock")).toBeNull();
  });

  it("shows generic audio live when the desk cannot tell its source", () => {
    const { region, pill } = strip({ otherAudio: "unknown" });
    expect(region).toHaveAttribute("data-state", "off-rundown");
    expect(pill).toHaveTextContent(GENERIC);
    expect(pill).toHaveAttribute("data-tone", "live");
    expect(screen.getByText("Audio not from the rundown")).toBeVisible();
    expect(screen.getByText("No song clock")).toBeVisible();
    expect(screen.queryByText("Fallback playlist")).toBeNull();
    expect(screen.queryByText(/Off air|Nothing on air/)).toBeNull();
  });

  it("never shows the live tone while playout is down", () => {
    const { region, pill } = strip({ otherAudio: "none", playoutDown: true });
    expect(region).toHaveAttribute("data-state", "audio-unconfirmed");
    expect(pill).toHaveTextContent(GENERIC);
    expect(pill).toHaveAttribute("data-tone", "warn");
    expect(screen.getByText("No engine confirmation")).toBeVisible();
    expect(screen.queryByText("No song clock")).toBeNull();
  });
});
