import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { ComponentProps } from "react";
import { RadioPanel } from "./RadioPanel";
import * as flight from "../services/flight";
vi.mock("../services/flight", () => ({
  fetchFlightSequences: vi.fn(),
  updateFlightSequence: vi.fn(),
  activateFlightSequence: vi.fn(),
  startFlight: vi.fn(),
  stopFlight: vi.fn(),
  goFlight: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function props(): ComponentProps<typeof RadioPanel> {
  const now = new Date().toISOString();
  return {
    programId: "radio-demo",
    fixtureData: {
      stream: { running: true, uptime: 60_000 },
      palazzo: {
        programId: "radio-demo",
        programType: "radio",
        palazzoUrl: "http://example.test",
        instanceId: "fixture",
        connection: "connected",
        lastEventAt: now,
        lastSnapshotAt: now,
        degraded: false,
        detail: null,
      },
      output: {
        state: "audible",
        expectedAudio: true,
        outputRms: 0.08,
        lastSampleAt: now,
        quietForMs: null,
      },
      recovery: {
        preparedVersion: null,
        automation: null,
        connection: "connected",
      },
      logs: [
        {
          id: 1,
          name: "Morning hour",
          scheduledAt: now,
          publishedAt: now,
          lastStartedAt: now,
          revision: 1,
          loop: false,
          isRunning: true,
          activeItemId: "cue-1",
          items: Array.from({ length: 6 }, (_, i) => ({
            id: `cue-${i + 1}`,
            kind: "playSong" as const,
            songId: i + 1,
            ...(i === 0 ? { clockOffsetSeconds: 0 } : {}),
          })),
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    songSequence: {
      mode: "manual",
      loop: false,
      activeItemId: "song-1",
      startedAt: 0,
      items: [
        {
          id: "song-1",
          kind: "preset",
          title: "City lights",
          artist: "Test signals",
          audioUrl: "https://example.test/one.mp3",
          coverUrl: "",
          durationMs: 180_000,
        },
      ],
    },
    songQueue: [],
    songCatalog: [],
    programSongPlayback: {
      isPlaying: true,
      title: "City lights",
      artist: "Test signals",
      audioUrl: "https://example.test/one.mp3",
      token: "song-1:playback",
      durationMs: 180_000,
      currentTimeMs: 42_000,
      progress: 42_000 / 180_000,
      updatedAt: now,
      telemetryStale: false,
    },
    instants: [
      {
        id: 1,
        name: "News opener",
        audioUrl: "https://example.test/news.mp3",
        volume: 1,
        enabled: true,
        position: 0,
      },
      {
        id: 2,
        name: "Disabled sting",
        audioUrl: "https://example.test/sting.mp3",
        volume: 1,
        enabled: false,
        position: 1,
      },
    ],
    instantSearch: "",
    instantPlayback: {},
    mixer: {
      song: { volume: 0.7, peak: 0.4 },
      instants: { volume: 0.8, peak: 0 },
      main: { volume: 0.9, peak: 0.5 },
      saving: false,
      error: null,
    },
    onSaveSongSequence: vi.fn(),
    onQueueSong: vi.fn(),
    onRemoveQueuedSong: vi.fn(),
    onReorderSongQueue: vi.fn(),
    onTakeOffAir: vi.fn(async () => {}),
    onInstantSearchChange: vi.fn(),
    onTriggerInstant: vi.fn(),
    onStopAllInstants: vi.fn(),
    onSongVolumeChange: vi.fn(),
    onInstantVolumeChange: vi.fn(),
    onMainVolumeChange: vi.fn(),
    onToggleSongMuted: vi.fn(),
    onToggleInstantMuted: vi.fn(),
  };
}
function mount(p = props()) {
  return render(
    <MemoryRouter>
      <RadioPanel {...p} />
    </MemoryRouter>,
  );
}

it("keeps one on-air player in the transport dock with timing, confidence and the full workspace", () => {
  mount();
  expect(
    within(screen.getByLabelText("On-air player")).getByText("02:18"),
  ).toBeVisible();
  expect(screen.getAllByLabelText("On-air player")).toHaveLength(1);
  expect(
    screen.getByLabelText("On-air player").closest(".playback-dock"),
  ).not.toBeNull();
  expect(
    within(screen.getByLabelText("On-air player")).getByText("City lights"),
  ).toBeVisible();
  expect(
    screen.getByRole("progressbar", { name: "Track progress" }),
  ).toHaveAttribute("aria-valuenow", "23");
  expect(screen.getByText("Audio detected")).toBeVisible();
  expect(screen.getByRole("region", { name: "On-air log" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Cartwall" })).toBeVisible();
  expect(screen.getByRole("slider", { name: "Music level" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Stop log / Take Off Air" }),
  ).toBeVisible();
});

it("shows one complete on-air log without playlist tabs or playback modes", () => {
  mount();
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Playback mode" }),
  ).not.toBeInTheDocument();
  const log = screen.getByRole("list", { name: "On-air log" });
  expect(within(log).getAllByRole("listitem")).toHaveLength(6);
  expect(within(log).getByText("NOW")).toBeVisible();
  expect(within(log).getByText("NEXT")).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove event 1" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Prepare hours" })).toHaveAttribute(
    "href",
    "/radio-log",
  );
});

it("moves Play Next inside the persisted log instead of a second queue", async () => {
  const p = props();
  const original = p.fixtureData!.logs[0];
  vi.mocked(flight.updateFlightSequence).mockImplementation(
    async (_program, _id, data) => ({
      ...original,
      items: data.items!,
      revision: 2,
    }),
  );
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Play event 4 next" }));
  await waitFor(() =>
    expect(flight.updateFlightSequence).toHaveBeenCalledWith("radio-demo", 1, {
      revision: 1,
      items: [
        original.items[0],
        original.items[3],
        original.items[1],
        original.items[2],
        ...original.items.slice(4),
      ],
    }),
  );
  expect(p.onQueueSong).not.toHaveBeenCalled();
  expect(p.onSaveSongSequence).not.toHaveBeenCalled();
});

it("routes transport to log execution and presents request failures", async () => {
  vi.mocked(flight.goFlight).mockRejectedValue(
    new Error("Log command rejected"),
  );
  const p = props();
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Advance log" }));
  await waitFor(() =>
    expect(flight.goFlight).toHaveBeenCalledWith("radio-demo"),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Log command rejected",
  );
  expect(p.onSaveSongSequence).not.toHaveBeenCalled();
});

it("keeps cartwall triggering, disabled clips, search and mixer controls wired", () => {
  const p = props();
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "News opener" }));
  expect(p.onTriggerInstant).toHaveBeenCalledWith(1);
  expect(screen.getByRole("button", { name: "Disabled sting" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Search cartwall" }), {
    target: { value: "news" },
  });
  expect(p.onInstantSearchChange).toHaveBeenCalledWith("news");
  fireEvent.change(screen.getByRole("slider", { name: "Music level" }), {
    target: { value: "0.45" },
  });
  expect(p.onSongVolumeChange).toHaveBeenCalledWith(0.45);
  fireEvent.click(
    within(screen.getByLabelText("Cartwall mixer channel")).getByRole(
      "button",
      { name: "MUTE" },
    ),
  );
  expect(p.onToggleInstantMuted).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
  expect(p.onStopAllInstants).toHaveBeenCalledOnce();
});

it("presents stale timing explicitly and never turns unavailable output into healthy confidence", () => {
  const p = props();
  p.programSongPlayback = { ...p.programSongPlayback!, telemetryStale: true };
  p.fixtureData!.output.state = "unavailable";
  p.fixtureData!.stream.running = false;
  p.fixtureData!.palazzo.connection = "unavailable";
  mount(p);
  expect(screen.getByText("Last reported remaining")).toBeVisible();
  expect(screen.getByText("Feedback stale")).toBeVisible();
  expect(screen.getByText("Output unavailable")).toBeVisible();
  expect(screen.getByText("Stream offline")).toBeVisible();
  expect(screen.getByText("Engine unavailable")).toBeVisible();
  expect(screen.queryByText("Audio detected")).not.toBeInTheDocument();
});

it("shows explicit empty states without hiding transport or inventing a countdown", () => {
  const p = props();
  p.songSequence = { ...p.songSequence, items: [], activeItemId: null };
  p.instants = [];
  p.programSongPlayback = null;
  p.fixtureData!.logs = [];
  mount(p);
  expect(screen.getByText("Nothing on air")).toBeVisible();
  expect(screen.queryByText("—:—")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start log" })).toBeDisabled();
  expect(screen.getByText("No published hour is queued.")).toBeVisible();
});

it("renders reported metadata when the playing track is absent from the playlist", () => {
  const p = props();
  p.programSongPlayback = {
    ...p.programSongPlayback!,
    token: "external:playback",
    audioUrl: "https://example.test/external.mp3",
    title: "External live track",
    artist: "External artist",
    coverUrl: "https://example.test/external-cover.png",
    introStatus: "degraded",
    introFailureReason: "Source unavailable",
  };
  mount(p);
  const player = screen.getByLabelText("On-air player");
  expect(within(player).getByText("External live track")).toBeVisible();
  expect(within(player).getByText("External artist")).toBeVisible();
  expect(player.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/external-cover.png",
  );
  expect(within(player).queryByText("City lights")).not.toBeInTheDocument();
  expect(within(player).getByText("02:18")).toBeVisible();
  expect(
    within(player).getByText("Intro unavailable: Source unavailable"),
  ).toBeVisible();
});

it("does not use playlist duration when playback duration is unavailable", () => {
  const p = props();
  p.programSongPlayback = { ...p.programSongPlayback!, durationMs: null };
  mount(p);
  const player = screen.getByLabelText("On-air player");
  expect(within(player).getByText("—:—")).toBeVisible();
  expect(within(player).getByText("00:42 elapsed")).toBeVisible();
  expect(
    screen.queryByRole("progressbar", { name: "Track progress" }),
  ).not.toBeInTheDocument();
});
