import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { RadioPanel } from "./RadioPanel";
import { RadioMonitorProvider } from "./RadioMonitor";
import { dbToFader, faderToDb } from "../utils/audioTaper";
import * as flight from "../services/flight";
vi.mock("../services/flight", () => ({
  fetchFlightSequences: vi.fn(),
  updateFlightSequence: vi.fn(),
  activateFlightSequence: vi.fn(),
  startFlight: vi.fn(),
  stopFlight: vi.fn(),
  goFlight: vi.fn(),
}));

// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select, as RadioLogGenerator's test does.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Holds a hold-to-confirm control for longer than its hold time. */
async function hold(control: HTMLElement) {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
  try {
    fireEvent.pointerDown(control);
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.pointerUp(control);
  } finally {
    vi.useRealTimers();
  }
}

function props(): ComponentProps<typeof RadioPanel> {
  const now = new Date().toISOString();
  return {
    programId: "radio-demo",
    fixtureData: {
      monitorAudioUrl: "https://example.test/monitor.mp3",
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
  for (const name of ["Cartwall", "Mixer"]) {
    expect(screen.getAllByRole("heading", { name })).toHaveLength(1);
  }
  for (const label of ["Instant audio", "Program mix", "Playout"]) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
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
  expect(screen.getByText("Engine audio detected")).toBeVisible();
  expect(screen.getByRole("region", { name: "On-air rundown" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Cartwall" })).toBeVisible();
  expect(screen.getByRole("slider", { name: "Music level" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Stop rundown / Take Off Air" }),
  ).toBeVisible();
});

it("shows one complete on-air log without playlist tabs or playback modes", () => {
  mount();
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Playback mode" }),
  ).not.toBeInTheDocument();
  const log = screen.getByRole("list", { name: "On-air rundown" });
  expect(within(log).getAllByRole("listitem")).toHaveLength(6);
  expect(within(log).getByText("NOW")).toBeVisible();
  expect(within(log).getByText("NEXT")).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove event 1" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Prepare rundown" })).toHaveAttribute(
    "href",
    "/flight",
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
  fireEvent.click(screen.getByRole("button", { name: "Advance rundown" }));
  await waitFor(() =>
    expect(flight.goFlight).toHaveBeenCalledWith("radio-demo"),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Log command rejected",
  );
  expect(p.onSaveSongSequence).not.toHaveBeenCalled();
});

it("keeps cartwall triggering, disabled clips, search and mixer controls wired", async () => {
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
  await hold(screen.getByRole("button", { name: "Stop all sounders" }));
  expect(p.onStopAllInstants).toHaveBeenCalledOnce();
});

it("presents stale timing explicitly and never turns unavailable output into healthy confidence", () => {
  const p = props();
  p.programSongPlayback = { ...p.programSongPlayback!, telemetryStale: true };
  p.fixtureData!.output.state = "unavailable";
  p.fixtureData!.stream.running = false;
  p.fixtureData!.palazzo.connection = "unavailable";
  mount(p);
  // With the engine unavailable nothing can confirm the song (#609): not confirmed, no clock, in
  // the on-air strip and in the rundown's playback bar alike.
  expect(screen.getAllByText("Not confirmed").length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText("No engine confirmation").length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("—:—")).toBeVisible();
  expect(screen.queryByText("Remaining")).not.toBeInTheDocument();
  expect(screen.queryByText("On air")).not.toBeInTheDocument();
  expect(screen.getByText("Output unavailable")).toBeVisible();
  expect(screen.getByText("Stream offline")).toBeVisible();
  expect(screen.getByText("Engine unavailable")).toBeVisible();
  expect(screen.queryByText("Engine audio detected")).not.toBeInTheDocument();
});

// The airing walk's W5: with Palazzo answering and its playout down, a playing song is never On air, in the strip,
// the rotation rows or the rundown's playback bar, even with fresh output samples.
it("never shows On air or a running clock while playout is down", () => {
  const p = props();
  p.fixtureData!.palazzo = { ...p.fixtureData!.palazzo, playout: "down" };
  mount(p);
  const strip = screen.getByRole("region", { name: "On air" });
  expect(within(strip).getByText("Not confirmed")).toBeVisible();
  expect(within(strip).getByText("Playout down")).toBeVisible();
  expect(screen.queryByText("On air")).not.toBeInTheDocument();
  expect(screen.queryByText("Remaining")).not.toBeInTheDocument();
  expect(screen.getAllByText("No engine confirmation").length).toBeGreaterThanOrEqual(2);
});

it("calls a stale report from a connected engine delayed, with no frozen clock", () => {
  const p = props();
  p.programSongPlayback = { ...p.programSongPlayback!, telemetryStale: true };
  mount(p);
  expect(screen.getByText("Status delayed")).toBeVisible();
  expect(screen.getByText("No live clock")).toBeVisible();
});

it("shows explicit empty states without hiding transport or inventing a countdown", () => {
  const p = props();
  p.songSequence = { ...p.songSequence, items: [], activeItemId: null };
  p.instants = [];
  p.programSongPlayback = null;
  p.fixtureData!.logs = [];
  // Nothing airs: with audible output the strip would name the fallback playlist (D7).
  p.fixtureData!.output = { ...p.fixtureData!.output, state: "idle", outputRms: 0 };
  mount(p);
  expect(screen.getByText(/Nothing on air/)).toBeVisible();
  expect(screen.getByText("Off air")).toBeVisible();
  expect(screen.queryByText("—:—")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Start rundown" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Filler rotation is empty")).toBeVisible();
});

// D7, from the recovery walk: Palazzo's fallback playlist on air with no song commanded read "Off air". The desk is
// not told about live input or scene audio, so it cannot rule them out and never claims the fallback playlist
// (Wakko's #804 review).
it("says audio is on air, not from the rundown, when no song is commanded and the output is audible", () => {
  const p = props();
  p.programSongPlayback = null;
  p.fixtureData!.logs = [];
  mount(p);
  const strip = screen.getByRole("region", { name: "On air" });
  expect(strip).toHaveAttribute("data-state", "off-rundown");
  expect(within(strip).getByRole("status")).toHaveTextContent(
    "Audio on air · not from the rundown",
  );
  expect(within(strip).getByRole("status")).toHaveAttribute("data-tone", "live");
  expect(within(strip).queryByText("Fallback playlist on air")).toBeNull();
  expect(within(strip).queryByText("Off air")).toBeNull();
  expect(within(strip).queryByText(/Nothing on air/)).toBeNull();
});

it("counts an airing instant as another source, and an ended one as none", () => {
  const p = props();
  p.programSongPlayback = null;
  p.fixtureData!.logs = [];
  p.instantPlayback = {
    1: { startedAtMs: Date.now() - 1_000, endsAtMs: Date.now() + 5_000 },
    2: { startedAtMs: Date.now() - 9_000, endsAtMs: Date.now() - 1_000 },
    3: { startedAtMs: Date.now() - 1_000, endsAtMs: null },
  };
  mount(p);
  expect(screen.getByRole("region", { name: "On air" })).toHaveAttribute(
    "data-state",
    "off-rundown",
  );
});

it("never shows audible output in the live tone while playout is down", () => {
  const p = props();
  p.programSongPlayback = null;
  p.fixtureData!.logs = [];
  p.fixtureData!.palazzo = { ...p.fixtureData!.palazzo, playout: "down" };
  mount(p);
  const strip = screen.getByRole("region", { name: "On air" });
  expect(strip).toHaveAttribute("data-state", "audio-unconfirmed");
  expect(within(strip).getByRole("status")).toHaveAttribute("data-tone", "warn");
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

for (const futureBlock of [false, true]) {
  it(`shows the real continuous fillers and transport with ${futureBlock ? "a future block" : "no blocks"}, without sending playback commands on mount`, async () => {
    const p = props();
    p.fixtureData!.logs = futureBlock
      ? [
          {
            ...p.fixtureData!.logs[0],
            isRunning: false,
            lastStartedAt: null,
            scheduledAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ]
      : [];
    p.onTakeSelection = vi.fn();
    mount(p);
    expect(
      screen.getByRole("region", { name: "Continuous fillers" }),
    ).toBeVisible();
    expect(screen.getByText("24/7 rotation")).toBeVisible();
    expect(screen.getByRole("group", { name: "Playback mode" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Start rundown" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add fillers" }));
    expect(
      screen.getByPlaceholderText("Search catalog to add..."),
    ).toBeVisible();
    expect(p.onSaveSongSequence).not.toHaveBeenCalled();
    expect(p.onTakeSelection).not.toHaveBeenCalled();
    expect(flight.activateFlightSequence).not.toHaveBeenCalled();
    await hold(screen.getByRole("button", { name: "Stop the song on air" }));
    await waitFor(() => expect(p.onTakeOffAir).toHaveBeenCalledOnce());
    expect(flight.stopFlight).not.toHaveBeenCalled();
  });
}

it("keeps a playout failure visible beside the current rotation", () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.playoutError = "Continuous fillers could not resume";
  mount(p);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Continuous fillers could not resume",
  );
  expect(
    screen.getByRole("region", { name: "Continuous fillers" }),
  ).toBeVisible();
});

it("monitors listener audio inline without changing the on-air transport or mix", async () => {
  const p = props();
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const { container } = mount(p);
  const confidence = screen.getByLabelText("Output confidence");
  const monitor = within(confidence).getByLabelText("Listener audio monitor");
  expect(screen.queryByRole("link", { name: "Listen to Program" })).toBeNull();
  expect(play).not.toHaveBeenCalled();
  fireEvent.click(within(monitor).getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(within(monitor).getByRole("status")).toHaveTextContent(
      "Listening to broadcast",
    ),
  );
  fireEvent.change(
    within(monitor).getByRole("slider", { name: "Monitor volume" }),
    { target: { value: "0.2" } },
  );
  expect(container.querySelector("audio")!.volume).toBe(0.2);
  fireEvent.click(
    within(monitor).getByRole("button", { name: "Stop listening" }),
  );
  expect(container.querySelector("audio")).not.toHaveAttribute("src");
  for (const fn of [
    p.onSaveSongSequence,
    p.onTakeOffAir,
    p.onSongVolumeChange,
    p.onMainVolumeChange,
  ])
    expect(fn).not.toHaveBeenCalled();
  expect(
    within(screen.getByLabelText("On-air player")).getByText("City lights"),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// gaulatti/alcantara#184: the rest of the radio desk, through its props and
// the radio API it polls.

/** The running log of the default fixture. */
const onAirLog = (p: ReturnType<typeof props>) => p.fixtureData!.logs[0];

function liveProps(): ComponentProps<typeof RadioPanel> {
  const p = props();
  delete p.fixtureData;
  return p;
}

type Answer = Response | Error | undefined;
/** A fetch stub that answers the radio status endpoints by path. */
function radioApi(answers: Partial<Record<string, Answer | (() => Answer)>>) {
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(answers).find((path) => url.includes(path));
    const answer = key ? answers[key] : undefined;
    const value = typeof answer === "function" ? answer() : answer;
    if (value instanceof Error) throw value;
    return value ?? new Response("null", { status: 404 });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(transport as typeof fetch);
  return transport;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

it("polls the live radio API when no fixture is supplied", async () => {
  const now = new Date().toISOString();
  radioApi({
    "/status": json({ running: true, uptime: 3_725_000 }),
    "/palazzo-status": json({
      ...props().fixtureData!.palazzo,
      degraded: true,
      detail: "Reconnecting to engine",
    }),
    "/output-confidence": json({
      state: "silent",
      expectedAudio: true,
      outputRms: 0,
      lastSampleAt: now,
      quietForMs: 4000,
    }),
    "/recovery": json({
      preparedVersion: "v3",
      automation: null,
      connection: "connected",
    }),
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([
    { ...onAirLog(props()), isRunning: false, scheduledAt: null },
  ]);
  mount(liveProps());
  expect(await screen.findByText("Stream verified")).toBeVisible();
  expect(await screen.findByText("Engine degraded")).toBeVisible();
  expect(await screen.findByText("Expected audio is silent")).toBeVisible();
  expect(await screen.findByText("Prepared for next session")).toBeInTheDocument();
  expect(screen.getByText("Up 1h 2m")).toBeVisible();
  // An unscheduled rundown is not part of the air plan.
  expect(screen.getByRole("region", { name: "Continuous fillers" })).toBeVisible();
  // The live monitor asks the API for a grant instead of a fixture URL.
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) => String(url).includes("/monitor-ticket")),
  ).toBe(true);
});

it("treats every unreachable or refused status endpoint as unverified", async () => {
  radioApi({
    "/status": new Error("offline"),
    "/palazzo-status": new Error("offline"),
    "/output-confidence": new Error("offline"),
    "/recovery": new Error("offline"),
  });
  vi.mocked(flight.fetchFlightSequences).mockRejectedValue(
    new Error("Rundowns are being rebuilt"),
  );
  const view = mount(liveProps());
  expect(await screen.findByText("Rundowns are being rebuilt")).toHaveAttribute(
    "role",
    "alert",
  );
  expect(screen.getByText("Stream unverified")).toBeVisible();
  // The console cannot reach the server, so the engine is not what is unavailable.
  expect(await screen.findByText("Can\'t reach the Alcántara server")).toBeVisible();
  expect(screen.queryByText("Engine unavailable")).toBeNull();
  expect(screen.getByText("Output unverified")).toBeVisible();
  expect(screen.getByText("No level sample")).toBeVisible();
  // The recovery status never answered, so there is no last known state to show.
  expect(screen.getByText("Recovery status unavailable")).toBeInTheDocument();
  expect(screen.queryByText("No prepared recovery playlist")).toBeNull();
  view.unmount();

  radioApi({
    "/status": json({}, 503),
    "/palazzo-status": json({}, 503),
    "/output-confidence": json({}, 503),
    "/recovery": json({}, 503),
  });
  vi.mocked(flight.fetchFlightSequences).mockRejectedValue("busy");
  const refused = mount(liveProps());
  expect(await screen.findByText("Rundowns unavailable")).toHaveAttribute(
    "role",
    "alert",
  );
  expect(screen.getByText("Stream unverified")).toBeVisible();
  refused.unmount();

  // A Palazzo answer with no body is not a status either.
  radioApi({ "/palazzo-status": new Response("null", { status: 200 }) });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  mount(liveProps());
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("/palazzo-status")),
    ).toBe(true),
  );
  expect(await screen.findByText("Engine unavailable")).toBeVisible();
});

// The #734 walk: a page reload left the desk reading "Engine unavailable" for seconds while the engine was fine, only
// because its first engine status had not answered yet. Unknown reads as unknown until an answer, a failure included.
// Wakko's #738 review: on a program switch this instance gets the new programId before it unmounts. An engine status
// that answers late for the previous program must not set the new program's engine state.
it("drops an engine status that answers for the program before a switch", async () => {
  const pending: Record<string, (response: Response) => void> = {};
  radioApi({});
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = /\/radio\/([^/]+)\/palazzo-status/.exec(url);
    if (match)
      return new Promise<Response>((resolve) => {
        pending[match[1]] = resolve;
      });
    return new Response("null", { status: 404 });
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  const first = liveProps();
  const view = mount({ ...first, programId: "radio-old" });
  await waitFor(() => expect(pending["radio-old"]).toBeDefined());
  view.rerender(
    <MemoryRouter>
      <RadioPanel {...first} programId="radio-new" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(pending["radio-new"]).toBeDefined());

  // The old program answers late, as connected: it must not read as the new program's engine.
  pending["radio-old"](json({ ...props().fixtureData!.palazzo, connection: "connected" }));
  const strip = screen.getByRole("region", { name: "On air" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(within(strip).getByText("Checking engine")).toBeVisible();
  expect(within(strip).queryByText("Engine ready")).toBeNull();

  // The new program's own answer decides.
  pending["radio-new"](json({ ...props().fixtureData!.palazzo, connection: "unavailable" }));
  expect(await within(strip).findByText(/Engine unavailable/)).toBeVisible();
});

it("reads Checking engine, never Engine unavailable, until the first engine status answers", async () => {
  let answer: (response: Response) => void = () => undefined;
  radioApi({
    "/palazzo-status": () => undefined,
  });
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).includes("/palazzo-status"))
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    return new Response("null", { status: 404 });
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  mount(liveProps());
  const strip = screen.getByRole("region", { name: "On air" });
  const chip = await within(strip).findByText("Checking engine");
  expect(chip.closest("[data-tone]")).toHaveAttribute("data-tone", "idle");
  expect(within(strip).queryByText(/Engine unavailable/)).toBeNull();

  // The answer decides: here the engine really is unavailable.
  answer(json({ ...props().fixtureData!.palazzo, connection: "unavailable" }));
  expect(await within(strip).findByText(/Engine unavailable/)).toBeVisible();
  expect(within(strip).queryByText("Checking engine")).toBeNull();
});

// The #734 follow-up: Palazzo answering with its playout (Liquidsoap) down is its own engine state, never Ready.
it("shows Playout down on the strip and names the action, over the dead-air advice", async () => {
  radioApi({
    "/status": json({ running: false, uptime: null }),
    "/palazzo-status": json({ ...props().fixtureData!.palazzo, playout: "down" }),
    "/output-confidence": json({
      state: "silent",
      expectedAudio: true,
      outputRms: 0,
      lastSampleAt: new Date().toISOString(),
      quietForMs: 12_000,
    }),
    "/recovery": json({ preparedVersion: "v3", automation: null, connection: "connected" }),
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  mount(liveProps());
  const strip = screen.getByRole("region", { name: "On air" });
  const chip = await within(strip).findByText("Playout down");
  expect(chip.closest("[data-tone]")).toHaveAttribute("data-tone", "bad");
  expect(within(strip).queryByText("Engine ready")).toBeNull();
  expect(screen.getByRole("alert", { name: "Playout down" })).toHaveTextContent(
    "Restart playout on the Palazzo host or call engineering.",
  );
  // The dead-air advice (Start with fallback) cannot help while playout is down.
  expect(screen.queryByRole("alert", { name: "Dead air" })).toBeNull();
});

// Wakko's #740 review: while playout is down a take would be accepted and not air, so the desk refuses it on every
// take path, and Start with fallback (the recovery playlist cannot play either). Stop stays available.
it("refuses Take, Take now and Start with fallback while playout is down, and keeps Stop", async () => {
  const p = deskProps();
  p.fixtureData!.logs = [];
  p.fixtureData!.palazzo = { ...p.fixtureData!.palazzo, playout: "down" } as never;
  p.fixtureData!.recovery = {
    preparedVersion: "v3",
    automation: { actualState: "ready", filler: { activeVersion: null, ready: false } },
    connection: "connected",
  } as never;
  mount(p);
  expect(
    screen.getByText("Playout down: nothing can air. Take is unavailable until the engine is back."),
  ).toBeVisible();
  const fallback = screen.getByRole("button", { name: "Start with fallback" });
  expect(fallback).toBeDisabled();
  expect(
    screen.getByText(
      "Playout down: nothing can air, the recovery playlist included: Start with fallback is unavailable until playout is back.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stop the song on air" })).toBeEnabled();

  fireEvent.keyDown(window, { key: "/" });
  const dialog = await screen.findByRole("dialog", { name: "Play a song now" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Search the rotation and the library" }),
    { target: { value: "paper sat" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Take now Paper Satellites" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Paper Satellites" }));
  expect(
    await within(dialog).findByText("Playout down: nothing can air. Nothing was taken."),
  ).toBeVisible();
  expect(p.onTakeSelection).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Play a song now" })).toBeNull());

  // The airing walk's W4: a rotation row's Take on air refused nothing and the song was sent to Palazzo.
  const rows = screen.getAllByRole("button", { name: "Take on air" });
  fireEvent.click(rows[1]);
  expect(
    await screen.findByText("Playout down: nothing can air. Nothing was taken."),
  ).toBeVisible();
  expect(p.onTakeSelection).not.toHaveBeenCalled();
});

it("reads Engine ready when Palazzo reports its playout up", async () => {
  radioApi({
    "/palazzo-status": json({ ...props().fixtureData!.palazzo, playout: "up" }),
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  mount(liveProps());
  const strip = screen.getByRole("region", { name: "On air" });
  expect(await within(strip).findByText("Engine ready")).toBeVisible();
  expect(screen.queryByRole("alert", { name: "Playout down" })).toBeNull();
});

// gaulatti/alcantara#706: six seconds without a fresh output sample turn audible output into Output unverified and
// dim the on-air clock; a fresh sample restores both. Display only.
describe("output unverified after six seconds without a sample", () => {
  afterEach(() => vi.useRealTimers());

  it("moves from detected to unverified as time passes, and back with a fresh sample, on the same desk", async () => {
    const start = Date.parse("2026-11-26T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(start);
    let sampledAt = start - 5_000;
    radioApi({
      "/status": () => json({ running: true, uptime: 60_000 }),
      "/palazzo-status": () => json(props().fixtureData!.palazzo),
      "/output-confidence": () =>
        json({
          state: "audible",
          expectedAudio: true,
          outputRms: 0.2,
          lastSampleAt: new Date(sampledAt).toISOString(),
          quietForMs: null,
        }),
      "/recovery": () =>
        json({ preparedVersion: null, automation: null, connection: "connected" }),
    });
    vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
    const p = liveProps();
    mount(p);
    expect(await screen.findByText("Engine audio detected")).toBeVisible();
    const strip = screen.getByRole("region", { name: "On air" });
    expect(within(strip).getByText("On air")).toBeVisible();
    expect(within(strip).getByTestId("on-air-clock")).not.toHaveAttribute("data-dimmed");

    // The desk re-reads freshness every second: at 2 s the last sample is 7 s old (a poll at 2 s still answers
    // that old sample), so the output reads unverified with no fresh answer.
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    expect(screen.getByText("Output unverified")).toBeVisible();
    expect(screen.queryByText("Engine audio detected")).toBeNull();
    expect(within(strip).getByText("Unverified")).toBeVisible();
    expect(within(strip).getByTestId("on-air-clock")).toHaveAttribute("data-dimmed", "true");

    // The next air-plan poll brings a fresh sample.
    sampledAt = Date.now();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(await screen.findByText("Engine audio detected")).toBeVisible();
    expect(within(strip).getByText("On air")).toBeVisible();
    expect(within(strip).getByTestId("on-air-clock")).not.toHaveAttribute("data-dimmed");
  });
});

it("names every output confidence state", () => {
  const cases: [string, string][] = [
    ["idle", "Output idle"],
    ["checking", "Checking output"],
    ["unknown", "Output unverified"],
    ["silent", "Expected audio is silent"],
  ];
  for (const [state, label] of cases) {
    const p = props();
    p.fixtureData!.output.state = state as never;
    const view = mount(p);
    expect(screen.getByText(label)).toBeVisible();
    view.unmount();
  }
});

it("shows uptime in seconds, minutes and days", () => {
  for (const [uptime, label] of [
    [42_000, "Up 42s"],
    [5 * 60_000, "Up 5m"],
    [(2 * 24 + 3) * 3_600_000, "Up 2d 3h"],
  ] as const) {
    const p = props();
    p.fixtureData!.stream.uptime = uptime;
    const view = mount(p);
    expect(screen.getByText(label)).toBeVisible();
    view.unmount();
  }
  const p = props();
  p.fixtureData!.stream.uptime = null;
  mount(p);
  expect(screen.queryByText(/^Up /)).toBeNull();
});

it("describes each event of the on-air rundown and its timing", () => {
  const p = props();
  const log = onAirLog(p);
  log.scheduledAt = new Date(Date.now() - 60_000).toISOString();
  log.activeItemId = "cue-2";
  log.items = [
    { id: "cue-1", kind: "playSong", songId: 1, clockOffsetSeconds: 0 },
    { id: "cue-2", kind: "playSong", songId: 1, isFiller: true },
    { id: "cue-3", kind: "instant", instantId: 1, voiceTrackInstantId: 9 },
    { id: "cue-4", kind: "stopSong" },
    { id: "cue-5", kind: "playSong", songId: 404 },
    { id: "cue-6", kind: "instant", instantId: 404 },
  ];
  p.songCatalog = [
    {
      id: 1,
      artist: "Catalog artist",
      title: "Catalog song",
      audioUrl: "https://example.test/catalog.mp3",
      coverUrl: null,
      durationMs: 185_000,
      earoneSongId: null,
      earoneRank: null,
      earoneSpins: null,
      enabled: true,
    },
  ];
  mount(p);
  const rows = within(
    screen.getByRole("list", { name: "On-air rundown" }),
  ).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("PLAYED");
  expect(rows[0]).toHaveTextContent("03:05");
  expect(rows[1]).toHaveTextContent("NOW");
  expect(rows[1]).toHaveTextContent("Catalog artist · Filler");
  expect(rows[1]).toHaveTextContent("Follows");
  expect(rows[2]).toHaveTextContent("NEXT");
  expect(rows[2]).toHaveTextContent("News opener");
  expect(rows[2]).toHaveTextContent("Audio clip · Voice track");
  expect(rows[3]).toHaveTextContent("Stop audio");
  expect(rows[3]).toHaveTextContent("Transport command");
  expect(rows[3]).toHaveTextContent("04");
  expect(rows[4]).toHaveTextContent("Unavailable audio");
  expect(rows[5]).toHaveTextContent("Unavailable audio");
  expect(screen.getByText("6 events")).toBeVisible();
  expect(screen.getByText(/ON AIR · Revision 1/)).toBeVisible();
});

// gaulatti/alcantara#726: a cue the as-run logged as not aired shows as skipped, never played.
it("shows a not-aired cue as skipped with its reason, and keeps aired cues played", () => {
  const p = props();
  const log = onAirLog(p);
  log.scheduledAt = new Date(Date.now() - 120_000).toISOString();
  log.activeItemId = "cue-4";
  log.items = [
    { id: "cue-1", kind: "playSong", songId: 1, clockOffsetSeconds: 0 },
    { id: "cue-2", kind: "playSong", songId: 1, clockOffsetSeconds: 60 },
    { id: "cue-3", kind: "playSong", songId: 1 },
    { id: "cue-4", kind: "playSong", songId: 1 },
    { id: "cue-5", kind: "playSong", songId: 1 },
  ];
  log.cueOutcomes = [
    { cueId: "cue-2", state: "not-aired", reason: "engine_unavailable" },
    { cueId: "cue-3", state: "not-aired", reason: null },
  ];
  mount(p);
  const rows = within(
    screen.getByRole("list", { name: "On-air rundown" }),
  ).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("PLAYED");
  expect(rows[0]).toHaveAttribute("data-skipped", "false");
  expect(rows[1]).toHaveTextContent("SKIPPED");
  expect(rows[1]).not.toHaveTextContent("PLAYED");
  expect(rows[1]).toHaveAttribute("data-skipped", "true");
  expect(rows[1]).toHaveAttribute("data-played", "false");
  const reason = within(rows[1]).getByLabelText(
    "Skipped: not aired, the engine was unavailable",
  );
  expect(reason).toHaveAttribute(
    "title",
    "not aired, the engine was unavailable",
  );
  expect(within(rows[2]).getByLabelText("Skipped: not aired")).toHaveTextContent(
    "SKIPPED",
  );
  expect(rows[3]).toHaveTextContent("NOW");
  expect(rows[4]).toHaveTextContent("NEXT");
});

it("names an unknown not-aired reason as the as-run logged it", () => {
  const p = props();
  const log = onAirLog(p);
  log.scheduledAt = new Date(Date.now() - 60_000).toISOString();
  log.activeItemId = "cue-2";
  log.items = [
    { id: "cue-1", kind: "playSong", songId: 1, clockOffsetSeconds: 0 },
    { id: "cue-2", kind: "playSong", songId: 1 },
  ];
  log.cueOutcomes = [
    { cueId: "cue-1", state: "not-aired", reason: "audio_missing" },
  ];
  mount(p);
  expect(
    screen.getByLabelText("Skipped: not aired (audio_missing)"),
  ).toBeVisible();
});

it("names a cue a fixed start passed over as skipped, not played", () => {
  const p = props();
  const log = onAirLog(p);
  log.scheduledAt = new Date(Date.now() - 120_000).toISOString();
  log.activeItemId = "cue-3";
  log.items = [
    { id: "cue-1", kind: "playSong", songId: 1, clockOffsetSeconds: 0 },
    { id: "cue-2", kind: "playSong", songId: 1 },
    { id: "cue-3", kind: "playSong", songId: 1, clockOffsetSeconds: 60 },
  ];
  log.cueOutcomes = [
    { cueId: "cue-2", state: "not-aired", reason: "fixed_start" },
  ];
  mount(p);
  expect(
    screen.getByLabelText("Skipped: not aired, cut by a fixed start"),
  ).toBeVisible();
});

it("marks rows by position when the backend sends no cue outcomes", () => {
  const p = props();
  const log = onAirLog(p);
  log.scheduledAt = new Date(Date.now() - 60_000).toISOString();
  log.activeItemId = "cue-2";
  log.items = [
    { id: "cue-1", kind: "playSong", songId: 1, clockOffsetSeconds: 0 },
    { id: "cue-2", kind: "playSong", songId: 1 },
  ];
  delete log.cueOutcomes;
  mount(p);
  const rows = within(
    screen.getByRole("list", { name: "On-air rundown" }),
  ).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("PLAYED");
  expect(screen.queryByText("SKIPPED")).toBeNull();
});

it("reorders and removes events in the persisted log, and reloads it after a refused change", async () => {
  const p = props();
  const log = onAirLog(p);
  vi.mocked(flight.updateFlightSequence)
    .mockImplementationOnce(async (_program, _id, data) => ({
      ...log,
      items: data.items!,
      revision: 2,
    }))
    .mockRejectedValueOnce(new Error("Revision conflict"))
    .mockRejectedValueOnce("conflict");
  mount(p);
  expect(screen.getByRole("button", { name: "Move event 2 up" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move event 6 down" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Move event 4 up" }));
  await waitFor(() =>
    expect(flight.updateFlightSequence).toHaveBeenLastCalledWith(
      "radio-demo",
      1,
      {
        revision: 1,
        items: [log.items[0], log.items[1], log.items[3], log.items[2], ...log.items.slice(4)],
      },
    ),
  );
  expect(await screen.findByText(/Revision 2/)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Move event 4 down" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Revision conflict");
  fireEvent.click(screen.getByRole("button", { name: "Remove event 5" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The log was not changed",
  );
  // With fixture data the log is not reloaded from the API.
  expect(flight.fetchFlightSequences).not.toHaveBeenCalled();
});

it("reloads the log from the API after a command when it is live", async () => {
  const now = new Date(Date.now() - 1000).toISOString();
  const log = { ...onAirLog(props()), scheduledAt: now };
  radioApi({});
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([log]);
  vi.mocked(flight.updateFlightSequence).mockRejectedValue(new Error("Stale"));
  vi.mocked(flight.stopFlight).mockResolvedValue(undefined as never);
  mount(liveProps());
  fireEvent.click(await screen.findByRole("button", { name: "Remove event 3" }));
  expect(await screen.findByText("Stale")).toHaveAttribute("role", "alert");
  const loads = vi.mocked(flight.fetchFlightSequences).mock.calls.length;
  fireEvent.click(
    screen.getByRole("button", { name: "Stop rundown / Take Off Air" }),
  );
  await waitFor(() => expect(flight.stopFlight).toHaveBeenCalledWith("radio-demo"));
  await waitFor(() =>
    expect(vi.mocked(flight.fetchFlightSequences).mock.calls.length).toBeGreaterThan(
      loads,
    ),
  );
});

// Dot's recovery walk: while the console cannot reach the Alcántara server, the engine chip must not blame the
// engine. A server that answers that the engine is down still reads Engine unavailable.
it("says the console cannot reach the server, not the engine, when the server is unreachable", async () => {
  radioApi({
    "/status": json({ running: true, uptime: 60_000 }),
    "/palazzo-status": new Error("offline"),
    "/output-confidence": json(props().fixtureData!.output),
    "/recovery": json({ preparedVersion: null, automation: null, connection: "connected" }),
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  mount(liveProps());
  expect(await screen.findByText("Can\'t reach the Alcántara server")).toBeVisible();
  expect(screen.queryByText("Engine unavailable")).toBeNull();
});

it("keeps Engine unavailable when the server answers that the engine is down", async () => {
  radioApi({
    "/status": json({ running: true, uptime: 60_000 }),
    "/palazzo-status": json({ ...props().fixtureData!.palazzo, connection: "unavailable" }),
    "/output-confidence": json(props().fixtureData!.output),
    "/recovery": json({ preparedVersion: null, automation: null, connection: "connected" }),
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  mount(liveProps());
  expect(await screen.findByText("Engine unavailable")).toBeVisible();
  expect(screen.queryByText("Can\'t reach the Alcántara server")).toBeNull();
});

// Dot's recovery walk: a failed recovery status read used to replace the known state with "No prepared recovery
// playlist", although a playlist was prepared and airing. The last known state stays, and the panel says it is
// unavailable until a read answers again.
it("keeps the last known recovery state and says it is unavailable when the status read fails", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    let recoveryUp = true;
    radioApi({
      "/status": () => json({ running: true, uptime: 60_000 }),
      "/palazzo-status": () => json(props().fixtureData!.palazzo),
      "/output-confidence": () => json(props().fixtureData!.output),
      "/recovery": () =>
        recoveryUp
          ? json({ preparedVersion: "v7", automation: null, connection: "connected" })
          : new Error("offline"),
    });
    vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
    mount(liveProps());
    fireEvent.click(screen.getByText("Recovery & session"));
    expect(await screen.findByText("Prepared for next session")).toBeVisible();

    recoveryUp = false;
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(await screen.findByText("Recovery status unavailable")).toBeVisible();
    expect(screen.getByText("Last known: prepared for next session.")).toBeVisible();
    expect(screen.queryByText("No prepared recovery playlist")).toBeNull();

    // A read that answers again replaces the last known state and clears the notice.
    recoveryUp = true;
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    await waitFor(() =>
      expect(screen.queryByText("Recovery status unavailable")).toBeNull(),
    );
    expect(screen.getByText("Prepared for next session")).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

// gaulatti/alcantara#707: a command failure shows as the alert and enters the session log; when the engine
// reconnects the alert clears and the log keeps the entry.
it("clears a command failure when the engine reconnects, and keeps it in the session log", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    let connection = "unavailable";
    radioApi({
      "/status": () => json({ running: true, uptime: 60_000 }),
      "/palazzo-status": () => json({ ...props().fixtureData!.palazzo, connection }),
      "/output-confidence": () => json(props().fixtureData!.output),
      "/recovery": () => json({ preparedVersion: null, automation: null, connection: "connected" }),
    });
    vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
    const p = liveProps();
    // A rotation change the engine cannot take while it is away.
    p.onSaveSongSequence = vi.fn().mockRejectedValue(new Error("Fictional engine away"));
    mount(p);
    fireEvent.click(await screen.findByRole("button", { name: /^Loop playlist: / }));
    expect(
      await screen.findByText("Fictional engine away", { selector: '[role="alert"]' }),
    ).toBeVisible();
    const log = screen.getByLabelText("Session log");
    expect(within(log).getByText("Session log (1)")).toBeInTheDocument();
    expect(log).toHaveTextContent("Fictional engine away");

    // The next status poll finds the engine connected again.
    connection = "connected";
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Fictional engine away", { selector: '[role="alert"]' }),
      ).toBeNull(),
    );
    expect(screen.getByLabelText("Session log")).toHaveTextContent("Fictional engine away");
  } finally {
    vi.useRealTimers();
  }
});

// gaulatti/alcantara#713 review: the engine's first status answer is not a reconnect, so it clears nothing.
it("keeps a command failure from before the engine's first status answer", async () => {
  let answerStatus: (response: Response) => void = () => {};
  radioApi({
    "/status": () => json({ running: true, uptime: 60_000 }),
    "/palazzo-status": (() =>
      new Promise<Response>((resolve) => {
        answerStatus = resolve;
      })) as never,
    "/output-confidence": () => json(props().fixtureData!.output),
    "/recovery": () => json({ preparedVersion: null, automation: null, connection: "connected" }),
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  const p = liveProps();
  p.onSaveSongSequence = vi.fn().mockRejectedValue(new Error("Fictional early failure"));
  mount(p);
  fireEvent.click(await screen.findByRole("button", { name: /^Loop playlist: / }));
  expect(
    await screen.findByText("Fictional early failure", { selector: '[role="alert"]' }),
  ).toBeVisible();
  await act(async () => {
    answerStatus(json({ ...props().fixtureData!.palazzo, connection: "connected" }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(
    screen.getByText("Fictional early failure", { selector: '[role="alert"]' }),
  ).toBeVisible();
});

// gaulatti/alcantara#713 review: the same failure again is one line with a count.
it("collapses a repeated identical failure into one session-log line with a count", async () => {
  vi.mocked(flight.stopFlight).mockRejectedValue(new Error("Fictional same failure"));
  mount();
  const stop = screen.getByRole("button", { name: "Stop rundown / Take Off Air" });
  fireEvent.click(stop);
  await screen.findByText("Fictional same failure", { selector: '[role="alert"]' });
  fireEvent.click(stop);
  await waitFor(() =>
    expect(within(screen.getByLabelText("Session log")).getAllByRole("listitem")).toHaveLength(1),
  );
  const [entry] = within(screen.getByLabelText("Session log")).getAllByRole("listitem");
  await waitFor(() => expect(entry).toHaveTextContent("Fictional same failure (×2)"));
  expect(within(screen.getByLabelText("Session log")).getByText("Session log (1)")).toBeInTheDocument();
});

it("keeps only the latest twenty command failures in the session log, newest first", async () => {
  let attempt = 0;
  vi.mocked(flight.stopFlight).mockImplementation(async () => {
    attempt += 1;
    throw new Error(`Fictional failure ${attempt}`);
  });
  mount();
  const stop = screen.getByRole("button", { name: "Stop rundown / Take Off Air" });
  for (let index = 0; index < 22; index += 1) {
    fireEvent.click(stop);
    await screen.findByText(`Fictional failure ${index + 1}`, { selector: '[role="alert"]' });
  }
  const entries = within(screen.getByLabelText("Session log")).getAllByRole("listitem");
  expect(entries).toHaveLength(20);
  expect(entries[0]).toHaveTextContent("Fictional failure 22");
  expect(entries[19]).toHaveTextContent("Fictional failure 3");
});

it("reports an unnamed log command failure", async () => {
  vi.mocked(flight.stopFlight).mockRejectedValue("engine gone");
  mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Stop rundown / Take Off Air" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Log command failed");
});

it("adds a Library song next in the running rundown, as its first timed event when empty", async () => {
  const p = props();
  const log = onAirLog(p);
  log.items = [];
  log.activeItemId = null;
  p.songCatalog = [
    {
      id: 5,
      artist: "Enabled artist",
      title: "Enabled song",
      audioUrl: "https://example.test/5.mp3",
      coverUrl: null,
      durationMs: null,
      earoneSongId: null,
      earoneRank: null,
      earoneSpins: null,
      enabled: true,
    },
    {
      id: 6,
      artist: "Hidden artist",
      title: "Disabled song",
      audioUrl: "https://example.test/6.mp3",
      coverUrl: null,
      durationMs: null,
      earoneSongId: null,
      earoneRank: null,
      earoneSpins: null,
      enabled: false,
    },
  ];
  vi.mocked(flight.updateFlightSequence).mockImplementation(
    async (_program, _id, data) => ({ ...log, items: data.items!, revision: 2 }),
  );
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000001",
  );
  mount(p);
  const add = screen.getByRole("button", { name: "Add next" });
  expect(add).toBeDisabled();
  const picker = screen.getByRole("combobox", { name: "Song to add to log" });
  expect(within(picker).queryByRole("option", { name: /Disabled song/ })).toBeNull();
  fireEvent.change(picker, { target: { value: "5" } });
  fireEvent.click(add);
  await waitFor(() =>
    expect(flight.updateFlightSequence).toHaveBeenCalledWith("radio-demo", 1, {
      revision: 1,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "playSong",
          songId: 5,
          clockOffsetSeconds: 0,
        },
      ],
    }),
  );
  expect(screen.getByRole("link", { name: "Library & tags" })).toHaveAttribute(
    "href",
    "/media",
  );
});

it("inserts a Library song right after the current event", async () => {
  const p = props();
  const log = onAirLog(p);
  p.songCatalog = [
    {
      id: 5,
      artist: "A",
      title: "Five",
      audioUrl: "https://example.test/5.mp3",
      coverUrl: null,
      durationMs: null,
      earoneSongId: null,
      earoneRank: null,
      earoneSpins: null,
      enabled: true,
    },
  ];
  vi.mocked(flight.updateFlightSequence).mockImplementation(
    async (_program, _id, data) => ({ ...log, items: data.items!, revision: 2 }),
  );
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000002",
  );
  mount(p);
  fireEvent.change(screen.getByRole("combobox", { name: "Song to add to log" }), {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add next" }));
  await waitFor(() =>
    expect(
      vi.mocked(flight.updateFlightSequence).mock.calls[0][2].items!.map(
        (item) => item.id,
      ),
    ).toEqual([
      "cue-1",
      "00000000-0000-4000-8000-000000000002",
      "cue-2",
      "cue-3",
      "cue-4",
      "cue-5",
      "cue-6",
    ]),
  );
});

it("shows the filler rotation with its Play Next queue, shuffle note and next timed block", () => {
  const p = props();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const evenLater = new Date(Date.now() + 7_200_000).toISOString();
  p.fixtureData!.logs = [
    { ...onAirLog(p), id: 2, name: "Second block", isRunning: false, lastStartedAt: null, scheduledAt: evenLater },
    { ...onAirLog(p), id: 3, name: "First block", isRunning: false, lastStartedAt: null, scheduledAt: later },
    { ...onAirLog(p), id: 4, name: "Draft block", isRunning: false, lastStartedAt: null, publishedAt: null, scheduledAt: later },
  ];
  p.songSequence = { ...p.songSequence, mode: "shuffle", loop: true };
  p.songQueue = [{ id: "queue-1", itemId: "song-1", enqueuedAt: 1 }];
  p.programSongPlayback = { ...p.programSongPlayback!, queueEntryId: "queue-1" };
  mount(p);
  expect(
    screen.getByText(/Shuffle on; Manual plays your row order/),
  ).toBeVisible();
  expect(screen.getByText(/Next timed block: First block/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Shuffle playlist" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Loop playlist: on" })).toBeVisible();
  const queue = screen.getByRole("region", { name: "Play Next queue" });
  expect(within(queue).getByText("Playing")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add fillers" }));
  expect(screen.getByRole("button", { name: "Done adding" })).toBeVisible();
});

it("falls back to an empty rotation when the saved one is malformed", () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.songSequence = null;
  mount(p);
  expect(screen.getByText(/No hourly log required · 0 songs/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Manual" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Loop playlist: on" })).toBeVisible();
});

it("shows the last aired block when nothing runs and nothing is next", () => {
  const p = props();
  const log = onAirLog(p);
  p.fixtureData!.logs = [
    { ...log, id: 7, name: "Older", isRunning: false, scheduledAt: new Date(Date.now() - 7_200_000).toISOString() },
    { ...log, id: 8, name: "Newer", isRunning: false, scheduledAt: new Date(Date.now() - 3_600_000).toISOString() },
  ];
  mount(p);
  // A stopped block is not on air: the fillers carry the station.
  expect(screen.getByRole("region", { name: "Continuous fillers" })).toBeVisible();
  expect(screen.queryByText(/Next timed block/)).toBeNull();
});

it("keeps rotation and off-air failures visible", async () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.songSequence = { ...p.songSequence, loop: true };
  p.onSaveSongSequence = vi
    .fn()
    .mockRejectedValueOnce(new Error("Rotation locked"))
    .mockRejectedValueOnce("nope");
  p.onTakeOffAir = vi
    .fn()
    .mockRejectedValueOnce(new Error("Engine refused off air"))
    .mockRejectedValueOnce("refused");
  p.onTakeSelection = vi.fn().mockRejectedValueOnce(new Error("Take refused"));
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Rotation locked");
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Rotation was not changed",
  );
  await hold(screen.getByRole("button", { name: "Stop the song on air" }));
  expect(await screen.findByText("Engine refused off air")).toBeVisible();
  await hold(screen.getByRole("button", { name: "Stop the song on air" }));
  expect(await screen.findByText("The stop was refused")).toBeVisible();
});

it("shows the mixer's saving and error states, mute state and silent faders", () => {
  const p = props();
  p.mixer = {
    ...p.mixer,
    song: { volume: 0, peak: 2, muted: true },
    saving: true,
  };
  const view = mount(p);
  const music = screen.getByLabelText("Music mixer channel");
  expect(music).toHaveTextContent("-∞ dB");
  expect(within(music).getByRole("button", { name: "MUTED" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(music).getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
  expect(screen.getByText("Applying mix…")).toHaveAttribute("role", "status");
  expect(
    within(screen.getByLabelText("Output mixer channel")).getByText("Master"),
  ).toBeVisible();
  fireEvent.change(screen.getByRole("slider", { name: "Output level" }), {
    target: { value: "0.5" },
  });
  expect(p.onMainVolumeChange).toHaveBeenCalledWith(0.5);
  fireEvent.change(screen.getByRole("slider", { name: "Cartwall level" }), {
    target: { value: "0.3" },
  });
  expect(p.onInstantVolumeChange).toHaveBeenCalledWith(0.3);
  fireEvent.click(within(music).getByRole("button", { name: "MUTED" }));
  expect(p.onToggleSongMuted).toHaveBeenCalledOnce();
  view.unmount();

  const failed = props();
  failed.mixer = { ...failed.mixer, error: "Mixer rejected the level" };
  mount(failed);
  expect(screen.getByText("Mixer rejected the level")).toHaveAttribute(
    "role",
    "alert",
  );
});

it("starts and stops the recovery session through Palazzo", async () => {
  const p = props();
  p.fixtureData!.recovery = {
    preparedVersion: "v4",
    automation: null,
    connection: "connected",
  };
  const transport = radioApi({
    "/recovery/start": json({
      preparedVersion: "v4",
      automation: { actualState: "running", filler: { activeVersion: "v4", ready: true } },
      connection: "connected",
    }),
    "/recovery/stop": json({
      preparedVersion: "v4",
      automation: null,
      connection: "connected",
    }),
  });
  mount(p);
  const start = screen.getByRole("button", { name: "Start with fallback" });
  const stop = screen.getByRole("button", { name: "Stop session" });
  expect(stop).toBeDisabled();
  fireEvent.click(start);
  expect(await screen.findByText("Recovery playlist active")).toBeInTheDocument();
  expect(start).toBeDisabled();
  expect(transport).toHaveBeenCalledWith(
    expect.stringContaining("/radio/radio-demo/recovery/start"),
    { method: "POST" },
  );
  // Stopping clears program audio: a click only explains, a 0.6 s hold stops (gaulatti/alcantara#693).
  fireEvent.pointerDown(stop);
  fireEvent.pointerUp(stop);
  expect(
    screen.getByText("Hold to stop the session (0.6 s). Program audio stops."),
  ).toBeInTheDocument();
  expect(transport).not.toHaveBeenCalledWith(
    expect.stringContaining("/radio/radio-demo/recovery/stop"),
    expect.anything(),
  );
  await hold(stop);
  expect(await screen.findByText("Prepared for next session")).toBeInTheDocument();
  expect(
    transport.mock.calls.filter(([url]) =>
      String(url).includes("/radio/radio-demo/recovery/stop"),
    ),
  ).toHaveLength(1);
  const configure = screen.getByRole("link", { name: "Configure" });
  expect(configure).toHaveAttribute("href", "/radio-settings");
  // Keyboard focus uses the global :focus-visible ring (#688): no per-link style cancels its outline.
  expect(configure.className).not.toMatch(/outline-none|focus-visible:/);
});

// gaulatti/alcantara#693 review: one stop while one is on its way. A second hold sends nothing.
it("sends one recovery stop while one is on its way, however often Stop session is held", async () => {
  const p = props();
  p.fixtureData!.recovery = {
    preparedVersion: "v4",
    automation: { actualState: "running", filler: { activeVersion: "v4", ready: true } },
    connection: "connected",
  } as never;
  let answerStop: (response: Response) => void = () => {};
  const transport = radioApi({
    "/recovery/stop": (() =>
      new Promise<Response>((resolve) => {
        answerStop = resolve;
      })) as never,
  });
  mount(p);
  const stop = screen.getByRole("button", { name: "Stop session" });
  await hold(stop);
  await hold(stop);
  const stops = () =>
    transport.mock.calls.filter(([url]) =>
      String(url).includes("/radio/radio-demo/recovery/stop"),
    );
  expect(stops()).toHaveLength(1);
  await act(async () => {
    answerStop(json({ preparedVersion: "v4", automation: null, connection: "connected" }));
  });
  expect(await screen.findByText("Prepared for next session")).toBeInTheDocument();
  expect(stops()).toHaveLength(1);
});

it("reports recovery commands Palazzo refused or could not receive", async () => {
  const p = props();
  p.fixtureData!.recovery = {
    preparedVersion: "v4",
    automation: null,
    connection: "connected",
  };
  let attempt = 0;
  radioApi({
    "/recovery/start": () =>
      ++attempt === 1 ? json({}, 409) : (("lost" as unknown) as Error),
  });
  vi.mocked(fetch).mockImplementationOnce(async () => json({}, 409));
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Start with fallback" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Palazzo could not start recovery (409).",
  );
  vi.mocked(fetch).mockImplementationOnce(() => Promise.reject("lost"));
  fireEvent.click(screen.getByRole("button", { name: "Start with fallback" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recovery command failed.",
  );
});

it("only offers recovery when a playlist is prepared and the engine is reachable", () => {
  const p = props();
  p.fixtureData!.recovery = {
    preparedVersion: "v4",
    automation: null,
    connection: "unavailable",
  };
  mount(p);
  expect(screen.getByText("Engine unavailable", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start with fallback" })).toBeDisabled();
});

it("keeps a failed filler rotation edit visible", async () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.onSaveSongSequence = vi
    .fn()
    .mockRejectedValueOnce(new Error("Rotation is read-only"))
    .mockRejectedValueOnce("nope");
  mount(p);
  fireEvent.click(
    screen.getByRole("button", { name: "Add City lights to high rotation" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Rotation is read-only",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Add City lights to high rotation" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Rotation was not changed",
  );
});

it("updates only the edited rundown among the scheduled ones", async () => {
  const p = props();
  const log = onAirLog(p);
  const later = {
    ...log,
    id: 2,
    name: "Later block",
    isRunning: false,
    lastStartedAt: null,
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  p.fixtureData!.logs = [log, later];
  vi.mocked(flight.updateFlightSequence).mockImplementation(
    async (_program, _id, data) => ({ ...log, items: data.items!, revision: 5 }),
  );
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Remove event 6" }));
  expect(await screen.findByText(/Revision 5/)).toBeVisible();
  expect(
    within(screen.getByRole("list", { name: "On-air rundown" })).getAllByRole(
      "listitem",
    ),
  ).toHaveLength(5);
});

// gaulatti/alcantara#194: a refused Play Next add used to be dropped (the
// editor fires and forgets); it is shown like a refused rotation change.
it("shows why a song could not be added to Play Next", async () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.onQueueSong = vi
    .fn()
    .mockRejectedValueOnce(new Error("Play Next is full"))
    .mockRejectedValueOnce("refused");
  mount(p);
  const [playNext] = screen.getAllByRole("button", { name: /^Play .+ next$/ });
  fireEvent.click(playNext);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Play Next is full",
  );
  fireEvent.click(playNext);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Play Next was not changed",
    ),
  );
  expect(p.onQueueSong).toHaveBeenCalledTimes(2);
  // A later add that succeeds leaves no stale refusal on screen.
  fireEvent.click(playNext);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(p.onQueueSong).toHaveBeenCalledTimes(3);
});

// gaulatti/alcantara#253: the cartwall's refusal and load-error alerts share
// the search box's and pads' inset at every width. jsdom has no layout, so the
// contract is checked where it lives: the class on both alerts, and the
// stylesheet giving that class the search box's padding with no width-specific
// override of either.
it("lines the cartwall alerts up with the search box and pads", () => {
  mount({
    ...props(),
    instantError: "Could not play News opener: Fictional refusal",
    instantsLoadError: "Fictional library is offline",
  });
  const cartwall = screen.getByRole("region", { name: "Cartwall" });
  const alerts = within(cartwall).getAllByRole("alert");
  expect(alerts.map((alert) => alert.textContent)).toEqual([
    "Could not play News opener: Fictional refusal",
    "Cartwall did not load: Fictional library is offline",
  ]);
  for (const alert of alerts) {
    expect(alert.classList.contains("radio-cartwall-alert")).toBe(true);
    expect(alert.className).not.toMatch(/\b(p|px|pl|pr)-\d/);
  }

  // Tests run from frontend/ (vitest.config.ts); jsdom has no file: module URL.
  const css = readFileSync("app/components/BroadcastConsole.css", "utf8");
  const padding = (selector: string) =>
    [...css.matchAll(new RegExp(`(^|\\n)\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g"))].map(
      (match) => /padding:\s*([^;]+);/.exec(match[2])?.[1]?.trim() ?? null,
    );
  // One rule each, outside any media query, with the same padding.
  expect(padding(".radio-cartwall-alert")).toEqual(["10px 12px 0"]);
  expect(padding(".console-cart-search")).toEqual(["10px 12px 0"]);
  expect(padding(".console-cart-grid")[0]).toMatch(/^10px 12px/);
});

// gaulatti/alcantara#257: the backend says why there is no engine.
const unavailableStatus = (extra: Record<string, unknown>) => ({
  programId: "radio-demo",
  programType: "radio",
  palazzoUrl: "",
  instanceId: null,
  connection: "unavailable",
  lastEventAt: null,
  lastSnapshotAt: null,
  degraded: false,
  detail: "Radio is disabled in this program’s settings",
  ...extra,
});

async function mountLiveWith(palazzo: Answer) {
  radioApi({
    "/status": json({ running: true, uptime: 1000 }),
    "/palazzo-status": palazzo,
    "/output-confidence": json(null, 404),
    "/recovery": json(null, 404),
  });
  vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
  mount(liveProps());
  await screen.findByText("Stream verified");
}

it.each([
  ["not-configured", "Engine unavailable: not configured"],
  ["disabled", "Engine unavailable: disabled in settings"],
  ["url-rejected", "Engine unavailable: URL not allowed"],
  ["deploy-candidate", "Engine unavailable: deploy candidate"],
])("says why the engine is unavailable: %s", async (reason, text) => {
  await mountLiveWith(json(unavailableStatus({ reason })));
  expect(await screen.findByText(text)).toBeVisible();
  // The backend's sentence is the tooltip, as with every status detail.
  expect(screen.getByText(text)).toHaveAttribute(
    "title",
    "Radio is disabled in this program’s settings",
  );
});

it("keeps today's wording for an unavailable status without a reason, with an unknown reason and for a null body", async () => {
  await mountLiveWith(json(unavailableStatus({})));
  expect(await screen.findByText("Engine unavailable")).toBeVisible();
  cleanup();
  await mountLiveWith(json(unavailableStatus({ reason: "from-the-future" })));
  expect(await screen.findByText("Engine unavailable")).toBeVisible();
  cleanup();
  await mountLiveWith(json(null));
  expect(await screen.findByText("Engine unavailable")).toBeVisible();
});

it("renders an old backend's live status exactly as before (no reason field)", async () => {
  await mountLiveWith(json({ ...props().fixtureData!.palazzo }));
  expect(await screen.findByText("Engine ready")).toBeVisible();
});

// ---------------------------------------------------------------- the rebuilt desk (#298)

function deskProps() {
  const p = props();
  p.fixtureData!.logs = [];
  p.songSequence = {
    ...p.songSequence,
    mode: "autoplay",
    loop: true,
    activeItemId: "song-1",
    items: [
      ...p.songSequence.items,
      {
        id: "song-2",
        kind: "preset",
        title: "Copper Season",
        artist: "The Paper Hours",
        audioUrl: "https://example.test/two.mp3",
        coverUrl: "",
        durationMs: 241_000,
      },
      {
        id: "song-3",
        kind: "preset",
        title: "Paper Satellites",
        artist: "Low Tide Radio",
        audioUrl: "https://example.test/three.mp3",
        coverUrl: "",
        durationMs: 198_000,
      },
    ],
  };
  p.onTakeSelection = vi.fn(async () => undefined);
  p.onPlaySongNow = vi.fn(async () => undefined);
  p.songCatalog = [
    {
      id: 77,
      artist: "Library Artist",
      title: "Harbor Library Cut",
      audioUrl: "https://example.test/lib.mp3",
      coverUrl: null,
      durationMs: 200_000,
      earoneSongId: null,
      earoneRank: null,
      earoneSpins: null,
      enabled: true,
    },
  ];
  return p;
}

it("keeps the on-air strip above the scrolling workspace, with what plays, what is next and the health chips", () => {
  mount(deskProps());
  const strip = screen.getByRole("region", { name: "On air" });
  const scroll = document.querySelector(".radio-console-scroll")!;
  expect(strip.compareDocumentPosition(scroll)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(strip.contains(scroll)).toBe(false);
  expect(within(strip).getByText("On air")).toBeVisible();
  expect(within(strip).getByText("City lights")).toBeVisible();
  expect(within(strip).getByText("Next · Autoplay")).toBeVisible();
  expect(within(strip).getByText("Copper Season")).toBeVisible();
  expect(within(strip).getByText("Stream verified")).toBeVisible();
  expect(within(strip).getByText("Engine ready")).toBeVisible();
  expect(within(strip).getByText("Monitor unavailable")).toBeVisible();
});

it("marks the song on air and the next one in the rotation", () => {
  mount(deskProps());
  const rows = Array.from(document.querySelectorAll(".playlist-row"));
  expect(rows).toHaveLength(3);
  expect(within(rows[0] as HTMLElement).getByText("On air")).toBeVisible();
  expect(within(rows[1] as HTMLElement).getByText("Next")).toBeVisible();
  expect(within(rows[2] as HTMLElement).queryByText("Next")).toBeNull();
});

it("puts the mode above the rotation and saves it as the bottom bar used to", () => {
  const p = deskProps();
  mount(p);
  const mode = screen.getByRole("group", { name: "Playback mode" });
  const rotation = screen.getByRole("region", { name: "Continuous fillers" });
  expect(rotation.contains(mode)).toBe(true);
  fireEvent.click(within(mode).getByRole("button", { name: "Manual" }));
  expect(p.onSaveSongSequence).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "manual", activeItemId: "song-1" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  expect(p.onSaveSongSequence).toHaveBeenLastCalledWith(
    expect.objectContaining({ loop: false }),
  );
});

it("takes the next song with N then Space, and never on one key press", async () => {
  const p = deskProps();
  mount(p);
  fireEvent.keyDown(window, { key: " " });
  expect(p.onTakeSelection).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "n" });
  expect(screen.getByText("Cued")).toBeVisible();
  expect(p.onTakeSelection).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: " " });
  await waitFor(() => expect(p.onTakeSelection).toHaveBeenCalledTimes(1));
  expect(p.onTakeSelection).toHaveBeenCalledWith(
    expect.objectContaining({ activeItemId: "song-2", mode: "autoplay" }),
  );
});

it("opens the song search with / and cues a rotation song next, or takes a library song now after confirming", async () => {
  const p = deskProps();
  mount(p);
  fireEvent.keyDown(window, { key: "/" });
  const dialog = await screen.findByRole("dialog", { name: "Play a song now" });
  // The desk keys wait while the search owns the keyboard.
  fireEvent.keyDown(window, { key: "n" });
  expect(screen.queryByText("Cued")).toBeNull();

  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Search the rotation and the library" }),
    { target: { value: "copper" } },
  );
  fireEvent.keyDown(dialog, { key: "Enter" });
  await waitFor(() => expect(p.onQueueSong).toHaveBeenCalledWith("song-2"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.keyDown(window, { key: "/" });
  const again = await screen.findByRole("dialog", { name: "Play a song now" });
  fireEvent.change(
    within(again).getByRole("textbox", { name: "Search the rotation and the library" }),
    { target: { value: "harbor" } },
  );
  fireEvent.click(within(again).getByRole("button", { name: "Take now Harbor Library Cut" }));
  expect(p.onPlaySongNow).not.toHaveBeenCalled();
  fireEvent.click(within(again).getByRole("button", { name: "Confirm Harbor Library Cut" }));
  await waitFor(() =>
    expect(p.onPlaySongNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 77 }),
    ),
  );
  expect(p.onTakeSelection).not.toHaveBeenCalled();
});

it("takes a rotation song now through the rotation, and does not open the search while typing", async () => {
  const p = deskProps();
  mount(p);
  const search = screen.getByLabelText("Search cartwall");
  fireEvent.keyDown(search, { key: "/" });
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.keyDown(window, { key: "/" });
  const dialog = await screen.findByRole("dialog", { name: "Play a song now" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Search the rotation and the library" }),
    { target: { value: "paper sat" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Take now Paper Satellites" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Paper Satellites" }));
  await waitFor(() =>
    expect(p.onTakeSelection).toHaveBeenCalledWith(
      expect.objectContaining({ activeItemId: "song-3" }),
    ),
  );
});

it("says a library song cannot be played now when the page gives no way to", async () => {
  const p = deskProps();
  p.onPlaySongNow = undefined;
  mount(p);
  fireEvent.keyDown(window, { key: "/" });
  const dialog = await screen.findByRole("dialog", { name: "Play a song now" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Search the rotation and the library" }),
    { target: { value: "library" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Take now Harbor Library Cut" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Harbor Library Cut" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Playing a library song now is not available here.",
  );
});

it("moves a fader one decibel with the arrow keys", () => {
  const p = deskProps();
  mount(p);
  const fader = screen.getByLabelText("Music level");
  fireEvent.keyDown(fader, { key: "ArrowUp" });
  const call = (p.onSongVolumeChange as ReturnType<typeof vi.fn>).mock
    .calls[0][0] as number;
  expect(faderToDb(call) - faderToDb(0.7)).toBeCloseTo(1, 1);
  fireEvent.keyDown(fader, { key: "ArrowDown" });
  const down = (p.onSongVolumeChange as ReturnType<typeof vi.fn>).mock
    .calls[1][0] as number;
  expect(faderToDb(down) - faderToDb(0.7)).toBeCloseTo(-1, 1);
  fireEvent.keyDown(fader, { key: "ArrowLeft" });
  expect(p.onSongVolumeChange).toHaveBeenCalledTimes(2);
});

it("shows the live level, its peak and the held peak beside a fader when the program publishes them", () => {
  const p = deskProps();
  p.mixer = {
    ...p.mixer,
    song: { volume: 0.7, peak: 0.6, vu: 0.3, peakHold: 0.95 },
  };
  mount(p);
  const meter = screen.getByRole("meter", { name: "Music live peak" });
  expect(within(meter).getByTestId("meter-fill").style.width).toBe("30%");
  expect(within(meter).getByTestId("meter-peak")).toBeInTheDocument();
  expect(within(meter).getByTestId("meter-hold").className).toContain("bg-terracotta");
});

it("holds to stop all sounders from the cartwall, and a click only explains", async () => {
  const p = deskProps();
  mount(p);
  const stopAll = screen.getByRole("button", { name: "Stop all sounders" });
  fireEvent.pointerDown(stopAll);
  fireEvent.pointerUp(stopAll);
  expect(p.onStopAllInstants).not.toHaveBeenCalled();
  expect(screen.getByText("Hold to stop every sounder (0.6 s).")).toBeVisible();
  await hold(stopAll);
  expect(p.onStopAllInstants).toHaveBeenCalledOnce();
});

// gaulatti/alcantara#404 (group B): the panel's load-error retries, a take that falls back to the
// rotation save when the page gives no take handler, a refused take, and an armed rundown.

it("shows the song library's load error and retries it", () => {
  const p = props();
  p.songCatalogLoadError = "offline";
  p.onRetrySongCatalog = vi.fn();
  mount(p);
  expect(screen.getByText("Song library did not load: offline")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry song library" }));
  expect(p.onRetrySongCatalog).toHaveBeenCalledTimes(1);
});

it("shows the cartwall's load error and retries it", () => {
  const p = props();
  p.instantsLoadError = "offline";
  p.onRetryInstants = vi.fn();
  mount(p);
  expect(screen.getByText("Cartwall did not load: offline")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry cartwall" }));
  expect(p.onRetryInstants).toHaveBeenCalledTimes(1);
});

it("takes the next song through the rotation save when the page gives no take handler", async () => {
  const p = deskProps();
  p.onTakeSelection = undefined;
  p.onSaveSongSequence = vi.fn().mockResolvedValue(undefined);
  mount(p);
  fireEvent.keyDown(window, { key: "n" });
  fireEvent.keyDown(window, { key: " " });
  await waitFor(() =>
    expect(p.onSaveSongSequence).toHaveBeenCalledWith(
      expect.objectContaining({ activeItemId: "song-2" }),
    ),
  );
});

it("reports a take the page refuses", async () => {
  const p = deskProps();
  p.onTakeSelection = vi.fn().mockRejectedValue(new Error("Palazzo refused the take"));
  mount(p);
  fireEvent.keyDown(window, { key: "n" });
  fireEvent.keyDown(window, { key: " " });
  expect(await screen.findByRole("alert")).toHaveTextContent("Palazzo refused the take");
});

it("says a running rundown that has reached its scheduled start is on air", () => {
  const p = props();
  const earlier = new Date(Date.now() - 60_000).toISOString();
  p.fixtureData!.logs = [{ ...p.fixtureData!.logs[0], scheduledAt: earlier }];
  mount(p);
  expect(screen.getByText(/ON AIR/)).toBeInTheDocument();
  expect(screen.getByText("Rundown automation running")).toBeInTheDocument();
});

// gaulatti/alcantara#404 (RadioPanel pass): the rotation editor takes a song through the page, and the desk's M key
// starts and stops the listener monitor.
it("reports a rotation song the page refuses to take on air", async () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.onTakeSelection = vi.fn().mockRejectedValue(new Error("Palazzo refused the take"));
  mount(p);
  const [take] = screen.getAllByRole("button", { name: "Take on air" });
  fireEvent.click(take);
  expect(await screen.findByRole("alert")).toHaveTextContent("Palazzo refused the take");
  expect(p.onTakeSelection).toHaveBeenCalledTimes(1);
});

it("takes a rotation song on air through the page", async () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.onTakeSelection = vi.fn().mockResolvedValue(undefined);
  mount(p);
  const [take] = screen.getAllByRole("button", { name: "Take on air" });
  fireEvent.click(take);
  await waitFor(() => expect(p.onTakeSelection).toHaveBeenCalledTimes(1));
});

it("says a rotation take the page refuses without a reason was not taken", async () => {
  const p = props();
  p.fixtureData!.logs = [];
  p.onTakeSelection = vi.fn().mockRejectedValue("nope");
  mount(p);
  fireEvent.click(screen.getAllByRole("button", { name: "Take on air" })[0]);
  expect(await screen.findByRole("alert")).toHaveTextContent("Rotation command failed");
});

// gaulatti/alcantara#404 (RadioPanel stronger pass): the desk's M key starts and stops the console's shared listener
// monitor. The monitor plays only with a grant from the API, and asks for one only while a player is on screen: here the
// panel's own output player, with no fixture listener URL, attaches to the provider.
it("starts and stops the shared listener monitor from the desk's M key", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const grants = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).includes("/radio/radio-demo/monitor-ticket")
      ? new Response(
          JSON.stringify({
            streamPath: "/radio/radio-demo/monitor-audio?ticket=fixture-grant",
            expiresInMs: 600_000,
          }),
          { status: 201 },
        )
      : new Response("{}", { status: 404 }),
  );
  const p = props();
  // Rotation, not a timed log: the transport (with its M key) shows instead of the playback bar.
  p.fixtureData!.logs = [];
  delete p.fixtureData!.monitorAudioUrl;
  render(
    <MemoryRouter>
      <RadioMonitorProvider programId="radio-demo">
        <RadioPanel {...p} />
      </RadioMonitorProvider>
    </MemoryRouter>,
  );
  const desk = () => screen.getByRole("button", { name: /^Listen M$/ });
  await waitFor(() =>
    expect(
      grants.mock.calls.some(([url]) => String(url).includes("/monitor-ticket")),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  expect(desk()).toHaveAttribute("aria-pressed", "false");

  fireEvent.keyDown(window, { key: "m" });
  await waitFor(() => expect(desk()).toHaveAttribute("aria-pressed", "true"));
  expect(screen.getByRole("button", { name: "Stop listening" })).toBeInTheDocument();
  expect(document.querySelector("audio")?.getAttribute("src")).toContain(
    "/radio/radio-demo/monitor-audio?ticket=fixture-grant",
  );

  fireEvent.keyDown(window, { key: "M" });
  await waitFor(() => expect(desk()).toHaveAttribute("aria-pressed", "false"));
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Stop listening" })).not.toBeInTheDocument();
});

// gaulatti/alcantara#527 (RadioPanel, untriaged gaps): bad inputs the desk can receive. A silent fader still moves
// one decibel from silence; a rundown can be advanced without a take callback.
it("moves a silent fader one decibel up from silence with the arrow keys", () => {
  const p = props();
  p.mixer = { ...p.mixer, instants: { volume: 0, peak: 0 } };
  mount(p);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Cartwall level" }), { key: "ArrowUp" });
  expect(p.onInstantVolumeChange).toHaveBeenCalledWith(dbToFader(-79));
});

it("advances the rundown without a take callback supplied", async () => {
  const p = props();
  delete (p as { onTakeSelection?: unknown }).onTakeSelection;
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Advance rundown" }));
  await waitFor(() => expect(flight.goFlight).toHaveBeenCalledWith("radio-demo"));
});

it("passes the rundown's take callback to the playback bar when one is supplied", async () => {
  const p = props();
  p.onTakeSelection = vi.fn(async () => {});
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Advance rundown" }));
  await waitFor(() => expect(flight.goFlight).toHaveBeenCalledWith("radio-demo"));
});

it("says On air only for an engine-confirmed song, and refuses Take while the engine is off (#609)", () => {
  const ready = props();
  ready.fixtureData!.logs = [];
  const { unmount } = mount(ready);
  expect(screen.getAllByText("On air").length).toBeGreaterThan(0);
  expect(screen.queryByText(/Take is unavailable until the engine is back/)).not.toBeInTheDocument();
  unmount();
  const down = props();
  down.fixtureData!.logs = [];
  down.fixtureData!.palazzo.connection = "unavailable";
  mount(down);
  expect(screen.queryByText("On air")).not.toBeInTheDocument();
  expect(screen.getByText("Not confirmed")).toBeVisible();
  expect(screen.getByText(/Take is unavailable until the engine is back/)).toBeVisible();
});

// gaulatti/alcantara#694: dead air shows in the on-air strip, and the alarm names the action that cures it for
// the recovery state the desk knows.
// Advance answers on the rundown's feedback line when it goes through, and names the failure when it does not.
it("confirms an advanced rundown on screen, and shows the refusal when it fails", async () => {
  vi.mocked(flight.goFlight).mockResolvedValue({ ok: true } as never);
  const p = props();
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Advance rundown" }));
  expect(await screen.findByText("Advanced to the next cue.")).toBeVisible();
  vi.mocked(flight.goFlight).mockRejectedValueOnce(new Error("Cue refused"));
  fireEvent.click(screen.getByRole("button", { name: "Advance rundown" }));
  expect(await screen.findByText("Cue refused")).toBeVisible();
  expect(screen.queryByText("Advanced to the next cue.")).toBeNull();
}, 15_000);

// Advance pressed while the engine's feedback is stale says the command is only sent, not that it took.
it("says Sent and waits for the engine when Advance is pressed while its feedback is stale", async () => {
  vi.mocked(flight.goFlight).mockResolvedValue({ ok: true } as never);
  const p = props();
  p.programSongPlayback = { ...p.programSongPlayback!, telemetryStale: true };
  mount(p);
  fireEvent.click(screen.getByRole("button", { name: "Advance rundown" }));
  expect(await screen.findByText("Sent: waiting for the engine to confirm.")).toBeVisible();
  expect(screen.queryByText("Advanced to the next cue.")).toBeNull();
}, 15_000);

describe("dead air", () => {
  const deadAir = (
    recovery: NonNullable<ReturnType<typeof props>["fixtureData"]>["recovery"],
  ) => {
    const p = props();
    p.fixtureData!.output.state = "silent" as never;
    p.fixtureData!.recovery = recovery;
    return p;
  };

  it("leads the on-air strip with a dead-air chip", () => {
    mount(deadAir({ preparedVersion: null, automation: null, connection: "connected" }));
    expect(
      within(screen.getByRole("region", { name: "On air" })).getByText("Dead air"),
    ).toBeVisible();
  });

  it("leaves Dead air the only coloured chip on the strip: the good chips render neutral", () => {
    mount(deadAir({ preparedVersion: null, automation: null, connection: "connected" }));
    const strip = screen.getByRole("region", { name: "On air" });
    const tone = (label: string) =>
      within(strip).getByText(label).closest("[data-tone]")?.getAttribute("data-tone");
    expect(tone("Dead air")).toBe("bad");
    expect(tone("Stream verified")).toBe("idle");
    expect(tone("Engine ready")).toBe("idle");
  });

  // Walk part 4: muting the desk's Music channel while a song aired raised Dead air with "Hold Stop to take the silent
  // song off air", which would have left the silence for good.
  it("says the desk's own mute silenced the song, and unmutes it, instead of saying to stop it", () => {
    const p = deadAir({ preparedVersion: null, automation: null, connection: "connected" });
    p.mixer = { ...p.mixer, song: { ...p.mixer.song, muted: true } };
    mount(p);
    const alarm = screen.getByRole("alert", { name: "Dead air" });
    expect(alarm).toHaveTextContent(
      "Music is muted on this desk: the song plays, but nothing reaches the air. Unmute it.",
    );
    expect(alarm).not.toHaveTextContent(/Hold Stop/);
    fireEvent.click(within(alarm).getByRole("button", { name: "Unmute music" }));
    expect(p.onToggleSongMuted).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByRole("region", { name: "On air" })).getByText("Dead air"),
    ).toBeVisible();
  });

  it("says which desk fader is down when the music or the output is at zero", () => {
    for (const [channel, name] of [
      ["song", "Music"],
      ["main", "Output"],
    ] as const) {
      const p = deadAir({ preparedVersion: null, automation: null, connection: "connected" });
      p.mixer = { ...p.mixer, [channel]: { ...p.mixer[channel], volume: 0 } };
      mount(p);
      const alarm = screen.getByRole("alert", { name: "Dead air" });
      expect(alarm).toHaveTextContent(
        `The ${name} fader is down on this desk: raise it to put the song back on air.`,
      );
      expect(alarm).not.toHaveTextContent(/Hold Stop/);
      cleanup();
    }
  });

  // A zero fader is the desk's own cause even when a recovery playlist is prepared: the recovery advice must not
  // replace the fader, or the operator would start a playlist while the fader still silences the song.
  it("names a zero fader before the recovery advice, even when a recovery playlist is prepared", () => {
    const p = deadAir({ preparedVersion: "v9", automation: null, connection: "connected" });
    p.mixer = { ...p.mixer, song: { ...p.mixer.song, volume: 0, muted: false } };
    mount(p);
    const alarm = screen.getByRole("alert", { name: "Dead air" });
    expect(alarm).toHaveTextContent(
      "The Music fader is down on this desk: raise it to put the song back on air.",
    );
    expect(alarm).not.toHaveTextContent(/recovery playlist/i);
    expect(alarm).not.toHaveTextContent(/Hold Stop/);
  });

  it("says to take the silent song off air and prepare a playlist when none is prepared", () => {
    mount(deadAir({ preparedVersion: null, automation: null, connection: "connected" }));
    const alarm = screen.getByRole("alert", { name: "Dead air" });
    expect(alarm).toHaveTextContent(
      "Hold Stop to take the silent song off air. No recovery playlist is prepared.",
    );
    expect(within(alarm).getByRole("link", { name: "Prepare a recovery playlist" })).toHaveAttribute(
      "href",
      "/radio-settings",
    );
  });

  it("says to take the silent song off air, then start the prepared fallback, and opens recovery", () => {
    mount(deadAir({ preparedVersion: "v4", automation: null, connection: "connected" }));
    const alarm = screen.getByRole("alert", { name: "Dead air" });
    expect(alarm).toHaveTextContent(
      "Hold Stop to take the silent song off air, then Start with fallback.",
    );
    const controls = screen.getByLabelText("Recovery controls") as HTMLDetailsElement;
    // jsdom has no scrollIntoView; the button opens the controls and brings them into view.
    const scrolled = vi.fn();
    controls.scrollIntoView = scrolled;
    expect(controls.open).toBe(false);
    fireEvent.click(within(alarm).getByRole("button", { name: "Go to recovery" }));
    expect(controls.open).toBe(true);
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("says the bound playlist plays once the silent song is off air", () => {
    mount(
      deadAir({
        preparedVersion: "v4",
        automation: { actualState: "running", filler: { activeVersion: "v4", ready: true } },
        connection: "connected",
      } as never),
    );
    expect(screen.getByRole("alert", { name: "Dead air" })).toHaveTextContent(
      "Hold Stop to take the silent song off air. The recovery playlist is bound and plays once the queue runs dry.",
    );
  });

  it("claims nothing about a playlist while the recovery status is unknown or the engine unavailable", () => {
    for (const recovery of [
      null,
      { preparedVersion: "v4", automation: null, connection: "unavailable" },
      { preparedVersion: null, automation: null, connection: "unavailable" },
    ]) {
      const view = mount(deadAir(recovery as never));
      const alarm = screen.getByRole("alert", { name: "Dead air" });
      expect(alarm).toHaveTextContent(
        "Hold Stop to take the silent song off air. The recovery status is unavailable: check the engine before relying on the fallback.",
      );
      expect(alarm).not.toHaveTextContent(/prepared|Start with fallback/);
      expect(within(alarm).queryByRole("button", { name: "Go to recovery" })).toBeNull();
      expect(within(alarm).queryByRole("link")).toBeNull();
      view.unmount();
    }
  });

  it("clears the chip and the alarm on the same desk when audio returns", async () => {
    let state = "silent";
    radioApi({
      "/status": () => json({ running: true, uptime: 60_000 }),
      "/palazzo-status": () => json(props().fixtureData!.palazzo),
      "/output-confidence": () =>
        json({
          state,
          expectedAudio: true,
          outputRms: state === "silent" ? 0 : 0.2,
          lastSampleAt: new Date().toISOString(),
          quietForMs: state === "silent" ? 12_000 : null,
        }),
      "/recovery": () =>
        json({ preparedVersion: "v4", automation: null, connection: "connected" }),
    });
    vi.mocked(flight.fetchFlightSequences).mockResolvedValue([]);
    mount(liveProps());
    const strip = screen.getByRole("region", { name: "On air" });
    expect(await within(strip).findByText("Dead air")).toBeVisible();
    expect(screen.getByRole("alert", { name: "Dead air" })).toBeVisible();
    // The next air-plan poll reads audible output.
    state = "audible";
    await waitFor(() => expect(within(strip).queryByText("Dead air")).toBeNull(), {
      timeout: 4_000,
    });
    expect(screen.queryByRole("alert", { name: "Dead air" })).toBeNull();
    expect(screen.getByText("Engine audio detected")).toBeVisible();
  });

  it("shows no dead-air alarm while the output is audible", () => {
    mount(props());
    expect(screen.queryByRole("alert", { name: "Dead air" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "On air" })).queryByText("Dead air"),
    ).toBeNull();
  });
});

// A rotation that failed to load is an error with a Retry, never the empty rotation (the desk read a restarting backend as
// an empty filler rotation).
it("shows a rotation that failed to load as an error with Retry, not as an empty rotation", async () => {
  const onRetryRotation = vi.fn();
  const p = props();
  p.fixtureData!.logs = [];
  mount({ ...p, rotationLoadError: true, onRetryRotation });
  expect(screen.getByText("Couldn't load the rotation")).toBeVisible();
  expect(screen.queryByText(/is empty/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetryRotation).toHaveBeenCalledOnce();
});

it("says a truly empty rotation is empty, and offers no load error", () => {
  const p = props();
  p.fixtureData!.logs = [];
  mount({ ...p, songSequence: { mode: "manual", items: [], activeItemId: null, intervalMs: 0, loop: false, startedAt: 0 }, rotationLoadError: false });
  expect(screen.getByText("Filler rotation is empty")).toBeVisible();
  expect(screen.queryByText("Couldn't load the rotation")).toBeNull();
});

// The rotation-load error replaces the rotation editor only: taking the song off air stays available (an on-air control).
it("keeps Stop the song on air working while the rotation-load error is shown", async () => {
  const p = props();
  p.fixtureData!.logs = [];
  mount({ ...p, rotationLoadError: true, onRetryRotation: vi.fn() });
  expect(screen.getByText("Couldn't load the rotation")).toBeVisible();
  await hold(screen.getByRole("button", { name: "Stop the song on air" }));
  await waitFor(() => expect(p.onTakeOffAir).toHaveBeenCalledOnce());
});
