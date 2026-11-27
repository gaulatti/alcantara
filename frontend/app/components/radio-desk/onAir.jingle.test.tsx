import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { deriveOnAir, type OnAirInput } from "./onAir";
import { OnAirStrip } from "./OnAirStrip";
import { normalizeProgramSongPlayback } from "../../utils/broadcast";

// gaulatti/alcantara radio walk: a jingle plays about every second song, and the desk named the song after it as on
// air, with its clock running, for as long as the jingle lasted.
const playback = (patch: Record<string, unknown> = {}) =>
  normalizeProgramSongPlayback({
    token: "t",
    audioUrl: "/a.mp3",
    title: "Quore",
    artist: "Prozac+",
    isPlaying: true,
    currentTimeMs: 2000,
    durationMs: 200_000,
    updatedAt: "2026-11-27T10:00:00.000Z",
    ...patch,
  });
const input = (patch: Record<string, unknown> = {}): OnAirInput => ({
  playback: playback(patch),
  next: { title: "In fuga", artist: "Punkreas", durationMs: 180_000 } as OnAirInput["next"],
  mode: "shuffle",
  streamRunning: true,
  engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
  monitor: "stopped",
});
afterEach(cleanup);

it("names the jingle that is on, then the song, with no song clock", () => {
  const view = deriveOnAir(input({ jingle: { name: "CUÑA 2" } }));
  expect(view).toMatchObject({ state: "on-air", title: "Jingle · CUÑA 2", artist: "Then Quore · Prozac+", elapsedMs: null, remainingMs: null, intro: null });
  render(
    <MemoryRouter>
      <OnAirStrip view={view} programId="modoitaliano.fm" />
    </MemoryRouter>,
  );
  expect(screen.getByText("Jingle · CUÑA 2")).toBeVisible();
  expect(screen.getByText("No song clock")).toBeVisible();
  expect(screen.queryByTestId("on-air-clock")).toBeNull();
});

it("says a jingle comes before the next song", () => {
  const view = deriveOnAir(input({ jingleNext: { name: "CUÑA 3" } }));
  expect(view.title).toBe("Quore");
  expect(view.next!.detail.startsWith("after jingle CUÑA 3 · Punkreas")).toBe(true);
});

it("is unchanged without a jingle, and reads only a named one", () => {
  const view = deriveOnAir(input());
  expect(view).toMatchObject({ title: "Quore", jingle: false });
  expect(view.next!.detail).not.toContain("jingle");
  expect(playback({ jingle: { name: 7 }, jingleNext: "x" })).not.toHaveProperty("jingle");
  expect(playback({ jingle: { name: "  " } }).jingle).toEqual({ name: "Jingle" });
});

it("does not claim a jingle the engine cannot confirm", () => {
  const view = deriveOnAir({ ...input({ jingle: { name: "CUÑA 2" } }), engine: { connected: false, degraded: false, unavailableLabel: "Engine unavailable" } });
  expect(view).toMatchObject({ state: "unconfirmed", title: "Quore", jingle: false });
});

it("shows a commanded jingle, which has no song under it, as a jingle and not as off air", () => {
  const view = deriveOnAir({ ...input({ isPlaying: false, title: undefined, artist: undefined, jingle: { name: "CUÑA 4" } }), outputAudible: true, otherAudio: "none" });
  expect(view).toMatchObject({ state: "on-air", label: "On air", jingle: true, title: "Jingle · CUÑA 4", artist: "Then the next song", elapsedMs: null });
  const lost = deriveOnAir({ ...input({ isPlaying: false, jingle: { name: "CUÑA 4" } }), engine: { connected: false, degraded: false, unavailableLabel: "Engine unavailable" } });
  expect(lost).toMatchObject({ state: "off-air", jingle: false });
});

it("calls an untitled song behind a jingle the next song, with no artist to add", () => {
  expect(deriveOnAir(input({ jingle: { name: "CUÑA 2" }, title: "", artist: "" })).artist).toBe("Then the next song");
});
