import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RadioPanel } from "./RadioPanel";
import * as songs from "./radio-desk/songs";

// The desk folds every status (stream, engine, monitor, output) into one dot; its detail list is where each one is
// named. A fault is also named beside the dot, so it is looked up in the detail list.
const statusDetail = () => screen.getByRole("group", { name: "Status detail" });

// The once-a-second freshness tick (gaulatti/alcantara#706) renders the strip and the output reading, not the desk.
// rotationLeaves is called once per render of the panel, so its calls count those renders.
vi.mock("./radio-desk/songs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./radio-desk/songs")>();
  return { ...actual, rotationLeaves: vi.fn(actual.rotationLeaves) };
});

beforeEach(() => {
  // jsdom implements none of the monitor player's media calls.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function props(sampledAt: string): ComponentProps<typeof RadioPanel> {
  return {
    programId: "radio-demo",
    fixtureData: {
      monitorAudioUrl: "https://example.test/monitor.mp3",
      logs: [],
      stream: { running: true, uptime: 60_000 },
      palazzo: {
        programId: "radio-demo",
        programType: "radio",
        palazzoUrl: "http://example.test",
        instanceId: "fixture",
        connection: "connected",
        lastEventAt: sampledAt,
        lastSnapshotAt: sampledAt,
        degraded: false,
        detail: null,
      },
      output: { state: "audible", expectedAudio: true, outputRms: 0.08, lastSampleAt: sampledAt, quietForMs: null },
      recovery: { preparedVersion: null, automation: null, connection: "connected" },
    },
    songSequence: { mode: "manual", loop: false, activeItemId: null, startedAt: 0, items: [] },
    songQueue: [],
    songCatalog: [],
    programSongPlayback: {
      isPlaying: true,
      title: "City lights",
      artist: "Fictional artist",
      audioUrl: "https://example.test/a.mp3",
      token: "a:1",
      durationMs: 198_000,
      currentTimeMs: 60_000,
      progress: 0.3,
      updatedAt: sampledAt,
      telemetryStale: false,
    },
    instants: [],
    instantSearch: "",
    instantPlayback: {},
    mixer: {
      song: { volume: 0.7, peak: 0 },
      instants: { volume: 0.8, peak: 0 },
      main: { volume: 0.9, peak: 0 },
      saving: false,
      error: null,
    },
    onSaveSongSequence: vi.fn(),
    onInstantSearchChange: vi.fn(),
    onTriggerInstant: vi.fn(),
    onStopAllInstants: vi.fn(),
    onSongVolumeChange: vi.fn(),
    onInstantVolumeChange: vi.fn(),
    onMainVolumeChange: vi.fn(),
    onToggleSongMuted: vi.fn(),
    onToggleInstantMuted: vi.fn(),
  } as unknown as ComponentProps<typeof RadioPanel>;
}

it("updates the strip and the output reading each second without rendering the panel again", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const start = Date.parse("2026-11-26T12:00:00Z");
  vi.setSystemTime(start);
  render(
    <MemoryRouter>
      <RadioPanel {...props(new Date(start).toISOString())} />
    </MemoryRouter>,
  );
  const strip = screen.getByRole("region", { name: "On air" });
  expect(within(statusDetail()).getByText("Engine audio detected")).toBeInTheDocument();
  expect(within(strip).getByText("On air")).toBeInTheDocument();
  const renders = vi.mocked(songs.rotationLeaves).mock.calls.length;
  expect(renders).toBeGreaterThan(0);

  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });

  // The tick did its work: ten seconds without a sample reads unverified in both places.
  expect(within(statusDetail()).getByText("Output unverified")).toBeInTheDocument();
  expect(within(strip).getByText("Unverified")).toBeInTheDocument();
  expect(vi.mocked(songs.rotationLeaves).mock.calls.length).toBe(renders);
});
