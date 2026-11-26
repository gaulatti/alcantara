import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeProgramSongSequence } from "../../utils/programSequence";
import { OnAirStrip } from "./OnAirStrip";
import { deriveOnAir, type OnAirInput } from "./onAir";

// Walk part 4: a rotation that does not loop ran out and the desk said a silent "Off air · Nothing on air". The
// engine now leaves it manual with endedAt, and the strip says "Rotation ended" as a warning until a start.

afterEach(cleanup);

const base = {
  playback: null,
  next: null,
  mode: "manual",
  streamRunning: true,
  engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
  monitor: "stopped",
} as unknown as OnAirInput;

describe("deriveOnAir when the rotation ran out", () => {
  it("says Rotation ended with nothing on air", () => {
    const view = deriveOnAir({ ...base, rotationEnded: true });
    expect(view.state).toBe("rotation-ended");
    expect(view.label).toBe("Rotation ended");
  });

  it("stays Off air without an end, and yields to a song or audible output", () => {
    expect(deriveOnAir(base).state).toBe("off-air");
    const playback = {
      isPlaying: true,
      title: "Fictional song",
      artist: "Fictional artist",
      currentTimeMs: 1_000,
      durationMs: 60_000,
      telemetryStale: false,
    } as unknown as OnAirInput["playback"];
    expect(deriveOnAir({ ...base, rotationEnded: true, playback }).state).toBe("on-air");
    expect(deriveOnAir({ ...base, rotationEnded: true, outputAudible: true }).state).toBe("off-rundown");
  });
});

it("shows the end in the strip as a warning, with nothing scheduled", () => {
  render(<OnAirStrip programId="radio-main" view={deriveOnAir({ ...base, rotationEnded: true })} />);
  const pill = screen.getByRole("status");
  expect(screen.getByRole("region", { name: "On air" })).toHaveAttribute("data-state", "rotation-ended");
  expect(pill).toHaveTextContent(/^Rotation ended$/);
  expect(pill).toHaveAttribute("data-tone", "warn");
  expect(screen.getByText("Nothing is scheduled")).toBeVisible();
  expect(screen.getByText(/The rotation does not loop and is manual now/)).toBeVisible();
  expect(screen.queryByText(/Nothing on air/)).toBeNull();
  expect(screen.queryByTestId("on-air-clock")).toBeNull();
});

it("keeps endedAt through normalising, so a Loop toggle saves it, and drops a malformed one", () => {
  const stored = { mode: "manual", loop: false, items: [], activeItemId: null, startedAt: 1 };
  expect(normalizeProgramSongSequence({ ...stored, endedAt: 4_102_444_800_000 })?.endedAt).toBe(4_102_444_800_000);
  for (const bad of [undefined, "soon", Number.NaN, 0])
    expect(normalizeProgramSongSequence({ ...stored, endedAt: bad })).not.toHaveProperty("endedAt");
});
