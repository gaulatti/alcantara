import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OnAirStrip } from "./OnAirStrip";
import { deriveOnAir, type OnAirInput } from "./onAir";

// D7, from the recovery walk: while Palazzo aired its fallback playlist the strip said "Off air · Nothing on air" and
// output confidence said "Engine audio detected". Palazzo airs that playlist by itself after 15 s with nothing on the
// air and names no track for it (gaulatti/palazzo src/stream/liquidsoap-script.ts, filler_on_air), so with no song
// commanded, fresh audible output is the fallback playlist on air, whatever the recovery session is.

afterEach(cleanup);

const base = {
  playback: null,
  next: null,
  mode: "manual",
  streamRunning: true,
  engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
  monitor: "stopped",
} as unknown as OnAirInput;

describe("deriveOnAir and the fallback playlist", () => {
  it("says the fallback playlist is on air when no song is commanded and the output is freshly audible", () => {
    const view = deriveOnAir({ ...base, outputAudible: true });
    expect(view.state).toBe("fallback");
    expect(view.label).toBe("Fallback playlist on air");
    expect(view.elapsedMs).toBeNull();
  });

  it("stays Off air when the output is quiet, unknown, or its audible sample is stale", () => {
    for (const patch of [
      {},
      { outputAudible: false },
      { outputAudible: true, outputUnverified: true },
    ])
      expect(deriveOnAir({ ...base, ...patch }).state).toBe("off-air");
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
    const view = deriveOnAir({ ...base, playback, outputAudible: true });
    expect(view.state).toBe("on-air");
    expect(view.remainingMs).toBe(190_000);
  });
});

it("shows the fallback playlist in the strip, live, with no song clock", () => {
  render(
    <OnAirStrip
      programId="radio-main"
      view={deriveOnAir({ ...base, outputAudible: true })}
    />,
  );
  const strip = screen.getByRole("region", { name: "On air" });
  expect(strip).toHaveAttribute("data-state", "fallback");
  expect(screen.getByRole("status")).toHaveTextContent(/^Fallback playlist on air$/);
  expect(screen.getByText("Fallback playlist")).toBeVisible();
  expect(screen.getByText("No song clock")).toBeVisible();
  expect(screen.queryByText(/Nothing on air/)).toBeNull();
  expect(screen.queryByTestId("on-air-clock")).toBeNull();
});
