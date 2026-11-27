import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { ProgramSongPlaybackState } from "../../models/broadcast";
import { deriveOnAir, type OnAirInput } from "./onAir";
import { OnAirStrip } from "./OnAirStrip";
import { RadioTransport } from "./RadioTransport";

// gaulatti/alcantara#609: "On air" means the engine confirmed it. Without a connected engine the
// desk says "Not confirmed"; Take is refused while the engine is off; after a take the desk waits for
// the engine's confirmation before calling the song on air.

afterEach(cleanup);

const playback = (extra: Partial<ProgramSongPlaybackState> = {}): ProgramSongPlaybackState => ({
  token: "s1:1",
  audioUrl: "https://media.test/s1.mp3",
  title: "Harbor Lights",
  artist: "Marisol Vega",
  progress: 0.3,
  currentTimeMs: 72_000,
  durationMs: 214_000,
  isPlaying: true,
  updatedAt: "2026-11-26T12:00:00Z",
  ...extra,
});
const input = (connected: boolean, extra: Partial<ProgramSongPlaybackState> = {}): OnAirInput => ({
  playback: playback(extra),
  next: null,
  mode: "manual",
  streamRunning: true,
  engine: { connected, degraded: false, unavailableLabel: "Engine unavailable: disabled in settings" },
  monitor: "stopped",
});
const next = { itemId: "s2", via: "rotation" as const, title: "Copper Season", artist: "The Paper Hours", durationMs: 241_000 };
const label = "Engine unavailable: disabled in settings";

async function cueAndTake() {
  fireEvent.keyDown(window, { key: "n" });
  await act(async () => {
    fireEvent.keyDown(window, { key: " " });
  });
}

it("calls a song on air only when the engine is connected and its report is fresh", () => {
  expect(deriveOnAir(input(true))).toMatchObject({ state: "on-air", label: "On air", elapsedMs: 72_000 });
  expect(deriveOnAir(input(false))).toMatchObject({
    state: "unconfirmed",
    label: "Not confirmed",
    title: "Harbor Lights",
    elapsedMs: null,
    remainingMs: null,
  });
  // Without an engine, a stale report is still only "Not confirmed".
  expect(deriveOnAir(input(false, { telemetryStale: true }))).toMatchObject({ state: "unconfirmed" });
  expect(deriveOnAir(input(true, { telemetryStale: true }))).toMatchObject({ state: "delayed", label: "Status delayed" });
  expect(deriveOnAir({ ...input(false), playback: null })).toMatchObject({ state: "off-air", label: "Off air" });
});

it("shows an unconfirmed song with a warning and no clock", () => {
  // The engine chip links to the radio settings here, so the strip needs the app's router.
  render(
    <MemoryRouter>
      <OnAirStrip view={deriveOnAir(input(false))} programId="station" />
    </MemoryRouter>,
  );
  expect(screen.getByText("Not confirmed")).toBeVisible();
  expect(screen.getByText("No engine confirmation")).toBeVisible();
  expect(screen.queryByText("On air")).not.toBeInTheDocument();
  expect(screen.getByText("Harbor Lights")).toBeVisible();
});

it("refuses Take while the engine is off: nothing is sent and the desk says so", async () => {
  const onTake = vi.fn();
  render(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} engineUnavailable={label} />);
  expect(screen.getByText(`${label}. Take unavailable.`)).toBeVisible();
  await cueAndTake();
  expect(onTake).not.toHaveBeenCalled();
  expect(screen.getByText(`${label}. Not taken.`)).toBeVisible();
  expect(screen.queryByText(/awaiting engine/)).not.toBeInTheDocument();
});

it("after a take waits for the engine, then stops waiting once it confirms the song", async () => {
  const onTake = vi.fn(async () => undefined);
  const view = render(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} confirmedItemId={null} />);
  await cueAndTake();
  expect(onTake).toHaveBeenCalledWith(next);
  expect(screen.getByText("Taken")).toBeVisible();
  expect(screen.getByText("Copper Season · awaiting engine")).toBeVisible();
  // Another song confirmed is not this take.
  view.rerender(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} confirmedItemId="s1" />);
  expect(screen.getByText(/awaiting engine/)).toBeVisible();
  view.rerender(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} confirmedItemId="s2" />);
  expect(screen.queryByText(/awaiting engine/)).not.toBeInTheDocument();
});

it("stops waiting when the operator cues again", async () => {
  render(<RadioTransport next={next} onTake={vi.fn(async () => undefined)} onTakeOffAir={vi.fn()} />);
  await cueAndTake();
  expect(screen.getByText(/awaiting engine/)).toBeVisible();
  fireEvent.keyDown(window, { key: "n" });
  expect(screen.queryByText(/awaiting engine/)).not.toBeInTheDocument();
});

it("shows the backend's refusal when the take is refused there, and does not wait", async () => {
  const onTake = vi.fn(async () => {
    throw new Error("The radio engine is off (disabled in settings), so nothing was taken.");
  });
  render(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} />);
  await cueAndTake();
  expect(await screen.findByText("The radio engine is off (disabled in settings), so nothing was taken.")).toBeVisible();
  expect(screen.queryByText(/awaiting engine/)).not.toBeInTheDocument();
});
