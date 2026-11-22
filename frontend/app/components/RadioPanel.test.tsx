import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
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
  expect(screen.queryByText("Engine audio detected")).not.toBeInTheDocument();
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
  expect(
    screen.queryByRole("button", { name: "Start rundown" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Filler rotation is empty")).toBeVisible();
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
    fireEvent.click(
      screen.getByRole("button", { name: "Stop / Take Off Air" }),
    );
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
  expect(await screen.findByText("Stream connected")).toBeVisible();
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
  expect(screen.getByText("Engine unavailable")).toBeVisible();
  expect(screen.getByText("Output unverified")).toBeVisible();
  expect(screen.getByText("No level sample")).toBeVisible();
  expect(screen.getByText("No prepared recovery playlist")).toBeInTheDocument();
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
  expect(screen.getByText("Engine unavailable")).toBeVisible();
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
    screen.getByText(/Shuffle pool; row order is not the next-song order/),
  ).toBeVisible();
  expect(screen.getByText(/Next timed block: First block/)).toBeVisible();
  expect(screen.getByText("shuffle · Loop on")).toBeVisible();
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
  expect(screen.getByText("manual · Loop on")).toBeVisible();
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
  fireEvent.click(screen.getByRole("button", { name: "Stop / Take Off Air" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Engine refused off air",
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop / Take Off Air" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Rotation command failed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Advance" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Take refused");
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
  fireEvent.click(stop);
  expect(await screen.findByText("Prepared for next session")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Configure" })).toHaveAttribute(
    "href",
    "/radio-settings",
  );
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
  await screen.findByText("Stream connected");
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
  expect(await screen.findByText("Engine connected")).toBeVisible();
});
