import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  FakeSocket,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";
import { MemoryRouter } from "react-router";
import { dbToFader } from "../utils/audioTaper";

// gaulatti/alcantara#194 group 3: the TV audio desk. The mixer's faders,
// mutes, solos and A/B presets save through the program's audio bus, and the
// realtime link keeps the bus, meters, song playback and scene audio current.

const sse = vi.hoisted(() => ({ state: "disconnected" as string }));
const prefs = vi.hoisted(() => ({ workspace: "audio" as string }));

vi.mock("../hooks/useSSE", async () => {
  const { useEffect } = await import("react");
  return {
    useSSE: (options: {
      onConnectionStateChange?: (state: string) => void;
    }) => {
      useEffect(() => {
        options.onConnectionStateChange?.(sse.state);
      }, []);
      return { isConnected: false };
    },
  };
});
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["main"],
}));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual =
    await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: {
        ...actual.defaultConsoleProfile("desktop"),
        workspace: prefs.workspace,
      },
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

let server: ControlServer;

const scene = (id: number, name: string, componentType = "toni-clock") => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType },
});
const headlines = scene(1, "Fictional headlines");
const programState = (type = "tv", scenes = [headlines]) => ({
  id: 1,
  programId: "main",
  type,
  activeSceneId: scenes[0].id,
  activeScene: scenes[0],
  stagedSceneId: null,
  stagedScene: null,
  fadeToBlack: false,
  scenes: scenes.map((entry, index) => ({
    id: index + 1,
    sceneId: entry.id,
    position: index,
    scene: entry,
  })),
  mediaGroups: [],
});
const song = (id: string, title: string) => ({
  id,
  kind: "preset",
  highRotation: false,
  artist: "Fictional band",
  title,
  coverUrl: "",
  audioUrl: `https://cdn.example.test/${id}.mp3`,
  durationMs: 180000,
});
const audioBus = (extra: Record<string, unknown> = {}) => ({
  mixerSettings: { mainMasterVolume: 0.8, songMasterVolume: 0.6 },
  songSequence: {
    mode: "manual",
    items: [
      song("s1", "First fictional song"),
      song("s2", "Second fictional song"),
    ],
    activeItemId: "s2",
    intervalMs: 4000,
    loop: true,
    startedAt: 1,
  },
  songQueue: [],
  ...extra,
});

beforeEach(() => {
  sse.state = "disconnected";
  prefs.workspace = "audio";
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([headlines]),
    "GET /program/main/state": () => Response.json(programState()),
    "GET /program/main/audio-bus": () => Response.json(audioBus()),
    "POST /auth/realtime-ticket": () => Response.json({ ticket: "ticket-1" }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const faderControl = (label: string) =>
  screen.getByRole("slider", { name: `${label} fader` });
/** The channel's stored fader position (0..1), read back from the Fader's dB value through the console taper. */
const fader = (label: string) => {
  const db = Number(faderControl(label).getAttribute("aria-valuenow"));
  return { value: String(Number(dbToFader(db).toFixed(6))) };
};
const press = (label: string, key: string, times = 1) => {
  for (let index = 0; index < times; index += 1)
    fireEvent.keyDown(faderControl(label), { key });
};
/** Where a key press leaves a fader that sits at `position`, as the stored position. */
const positionAfter = (db: number) => Number(dbToFader(db).toFixed(6));
const meter = (label: string) =>
  Number(
    screen
      .getByRole("meter", { name: `${label} live level` })
      .getAttribute("aria-valuenow"),
  );
const activeRow = () =>
  document.querySelector('.playlist-row[data-active="true"]')?.textContent ??
  null;
const rows = () =>
  [...document.querySelectorAll(".playlist-row")].map((row) => row.textContent);
const puts = () =>
  server.requests("PUT /program/main/audio-bus") as {
    mixerSettings: {
      mainMasterVolume: number;
      mixerChannels: {
        id: string;
        volume: number;
        muted: boolean;
        solo: boolean;
      }[];
    };
  }[];
const channelIn = (body: ReturnType<typeof puts>[number], id: string) =>
  body.mixerSettings.mixerChannels.find((channel) => channel.id === id)!;

async function openDesk() {
  const view = render(<Control />);
  await screen.findByRole("region", { name: "Audio mixer" });
  await waitFor(() => expect(fader("Music").value).toBe("0.6"));
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  return { view, socket };
}

it("loads the program's mixer and playlist into the audio desk", async () => {
  await openDesk();
  expect(fader("Main mix").value).toBe("0.8");
  expect(fader("Cartwall").value).toBe("1");
  expect(
    screen.getByRole("status", { name: "" }).textContent ?? "",
  ).toBeDefined();
  expect(rows()).toHaveLength(2);
  expect(activeRow()).toContain("Second fictional song");
  // Stream only has a strip while a video stream is on Program or Preview.
  expect(
    screen.queryByRole("slider", { name: "Stream fader" }),
  ).not.toBeInTheDocument();
});

it.each([
  [
    "nested sequences flatten into one playlist and an unknown selection falls back to the first song",
    {
      mode: "manual",
      items: [
        song("s1", "First fictional song"),
        {
          id: "nest",
          kind: "sequence",
          label: "Nested",
          sequence: {
            mode: "manual",
            items: [song("s3", "Nested fictional song")],
            activeItemId: null,
          },
        },
      ],
      activeItemId: "gone",
    },
    ["First fictional song", "Nested fictional song"],
    "First fictional song",
  ],
  [
    "a cleared selection stays cleared",
    {
      mode: "manual",
      items: [song("s1", "First fictional song")],
      activeItemId: null,
    },
    ["First fictional song"],
    null,
  ],
  [
    "an empty playlist has no selection",
    { mode: "manual", items: [], activeItemId: "gone" },
    [],
    null,
  ],
])(
  "normalizes the playlist: %s",
  async (_name, songSequence, titles, active) => {
    server.answer("GET /program/main/audio-bus", () =>
      Response.json(audioBus({ songSequence })),
    );
    await openDesk();
    expect(
      rows().map((row) => titles.find((title) => row!.includes(title))),
    ).toEqual(titles);
    if (active === null) expect(activeRow()).toBeNull();
    else expect(activeRow()).toContain(active);
  },
);

it("falls back to an empty manual playlist and unity levels when the bus cannot be read", async () => {
  server.answer(
    "GET /program/main/audio-bus",
    () => new Response("down", { status: 500 }),
  );
  render(<Control />);
  await screen.findByRole("region", { name: "Audio mixer" });
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch program audio bus settings:",
      expect.any(Error),
    ),
  );
  expect(fader("Music").value).toBe("1");
  expect(fader("Main mix").value).toBe("1");
  expect(rows()).toEqual([]);
  expect(screen.getByRole("button", { name: "Manual" })).toBeInTheDocument();
});

it("reads a bus without a playlist as an empty manual playlist", async () => {
  server.answer("GET /program/main/audio-bus", () =>
    Response.json({ mixerSettings: { songMasterVolume: 0.6 } }),
  );
  await openDesk();
  expect(rows()).toEqual([]);
});

it("saves a fader move once, after the debounce, and applies the acknowledged mix", async () => {
  server.answer("PUT /program/main/audio-bus", () =>
    Response.json({
      version: 3,
      mixerSettings: { mainMasterVolume: 0.8, songMasterVolume: 0.4 },
    }),
  );
  await openDesk();
  // Music sits at 0.6 (about −11.8 dB): two presses down land on −12.0 and −12.5 dB.
  press("Music", "ArrowDown", 2);
  expect(fader("Music").value).toBe(String(positionAfter(-12.5)));
  expect(puts()).toHaveLength(0);
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0].mixerSettings.mainMasterVolume).toBe(0.8);
  expect(channelIn(puts()[0], "song").volume).toBeCloseTo(dbToFader(-12.5), 6);
  await waitFor(() => expect(fader("Music").value).toBe("0.4"));
  expect(screen.getByText("Levels in dB")).toBeInTheDocument();

  // An acknowledgement older than the one already applied is ignored.
  server.answer("PUT /program/main/audio-bus", () =>
    Response.json({ version: 2, mixerSettings: { mainMasterVolume: 0.1 } }),
  );
  press("Main mix", "End");
  await waitFor(() => expect(puts()).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByText("Levels in dB")).toBeInTheDocument(),
  );
  expect(fader("Main mix").value).toBe("1");

  // An acknowledgement without a mix keeps the levels that were sent.
  server.answer("PUT /program/main/audio-bus", () => Response.json(null));
  press("Cartwall", "Home");
  await waitFor(() => expect(puts()).toHaveLength(3));
  await waitFor(() =>
    expect(screen.getByText("Levels in dB")).toBeInTheDocument(),
  );
  expect(fader("Cartwall").value).toBe("0");
});

it("explains a mix the server did not apply", async () => {
  server.answer(
    "PUT /program/main/audio-bus",
    () => new Response("no", { status: 502 }),
  );
  await openDesk();
  press("Scene audio", "ArrowDown");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Mixer change was not applied to Palazzo. Try again.",
  );
  expect(console.error).toHaveBeenCalledWith(
    "Failed to save mixer levels:",
    expect.any(Error),
  );
});

it("mutes, solos and types levels on every channel strip", async () => {
  server.answer("GET /program/main/state", () =>
    Response.json(
      programState("tv", [scene(1, "Fictional live feed", "video-stream")]),
    ),
  );
  server.answer("PUT /program/main/audio-bus", () => Response.json({}));
  await openDesk();
  for (const [label, id] of [
    ["Music", "song"],
    ["Stream", "stream"],
    ["Cartwall", "instants"],
    ["Scene audio", "sceneInstant"],
  ] as const) {
    const before = puts().length;
    fireEvent.click(screen.getByRole("button", { name: `Mute ${label}` }));
    fireEvent.click(screen.getByRole("button", { name: `Solo ${label}` }));
    expect(
      screen.getByRole("button", { name: `Mute ${label}` }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: `Solo ${label}` }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(puts().length).toBe(before + 1));
    expect(channelIn(puts().at(-1)!, id)).toMatchObject({
      muted: true,
      solo: true,
    });

    const level = screen.getByRole("textbox", { name: `${label} level in dB` });
    fireEvent.blur(level, { target: { value: "-6" } });
    expect(Number(fader(label).value)).toBeCloseTo(dbToFader(-6), 3);
  }
  fireEvent.blur(
    screen.getByRole("textbox", { name: "Main mix level in dB" }),
    { target: { value: "-inf" } },
  );
  expect(fader("Main mix").value).toBe("0");
  await waitFor(() =>
    expect(puts().at(-1)!.mixerSettings.mainMasterVolume).toBe(0),
  );
});

it("keeps typed A/B presets within range and takes them at once without a fade", async () => {
  server.answer("PUT /program/main/audio-bus", () => Response.json({}));
  await openDesk();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Preset fade in milliseconds" }),
    { target: { value: "0" } },
  );
  const presetA = screen.getByRole("textbox", { name: "Music preset A in dB" });
  fireEvent.blur(presetA, { target: { value: "-10" } });
  fireEvent.blur(
    screen.getByRole("textbox", { name: "Music preset B in dB" }),
    { target: { value: "loud" } },
  );
  fireEvent.blur(
    screen.getByRole("textbox", { name: "Cartwall preset B in dB" }),
    { target: { value: "99" } },
  );

  fireEvent.click(screen.getByRole("button", { name: "Take Music preset A" }));
  expect(Number(fader("Music").value)).toBeCloseTo(dbToFader(-10), 3);
  fireEvent.click(
    screen.getByRole("button", { name: "Take Cartwall preset B" }),
  );
  expect(Number(fader("Cartwall").value)).toBeCloseTo(dbToFader(12), 3);
  fireEvent.click(
    screen.getByRole("button", { name: "Take Scene audio preset A" }),
  );
  expect(Number(fader("Scene audio").value)).toBeCloseTo(dbToFader(-15), 3);
  // An unreadable preset keeps the one it had.
  fireEvent.click(screen.getByRole("button", { name: "Take Music preset B" }));
  expect(Number(fader("Music").value)).toBeCloseTo(dbToFader(-30), 3);
  // Taking the level the channel already has changes nothing.
  fireEvent.click(
    screen.getByRole("button", { name: "Take Scene audio preset A" }),
  );
  expect(Number(fader("Scene audio").value)).toBeCloseTo(dbToFader(-15), 3);
  await waitFor(() =>
    expect(channelIn(puts().at(-1)!, "sceneInstant").volume).toBeCloseTo(
      dbToFader(-15),
      3,
    ),
  );
});

it("fades a take over the preset fade and locks the channel until it lands", async () => {
  server.answer("GET /program/main/state", () =>
    Response.json(
      programState("tv", [scene(1, "Fictional live feed", "video-stream")]),
    ),
  );
  server.answer("PUT /program/main/audio-bus", () => Response.json({}));
  await openDesk();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Preset fade in milliseconds" }),
    { target: { value: "660" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Take Stream preset B" }));
  const take = () =>
    within(
      screen.getByRole("region", { name: "Stream mixer channel" }),
    ).getAllByRole("button", { name: /Take Stream preset/ });
  expect(take()[0]).toHaveTextContent("…");
  expect(take()[0]).toBeDisabled();
  const first = Number(fader("Stream").value);
  expect(first).toBeLessThan(1);
  expect(first).toBeGreaterThan(dbToFader(-30));
  await waitFor(
    () => expect(Number(fader("Stream").value)).toBeCloseTo(dbToFader(-30), 3),
    { timeout: 3000 },
  );
  await waitFor(() => expect(take()[0]).toHaveTextContent("TAKE A"));

  // While one take fades, the channel's take buttons stay locked, so a second
  // take cannot start on the same channel.
  fireEvent.click(screen.getByRole("button", { name: "Take Stream preset A" }));
  expect(take()[0]).toBeDisabled();
  expect(take()[1]).toBeDisabled();
  await waitFor(() => expect(take()[1]).toBeEnabled(), { timeout: 3000 });
});

it("shows the program's meters and follows meter updates for this program only", async () => {
  server.answer("GET /program/main/audio-meter", () =>
    Response.json({
      song: 0.5,
      instants: { vu: 0.2, peak: 0.4 },
      main: { level: 0.3 },
    }),
  );
  const { socket } = await openDesk();
  await waitFor(() =>
    expect(meter("Music")).toBeCloseTo(Math.pow(0.5, 0.6) * 100, 3),
  );
  expect(meter("Main mix")).toBeCloseTo(Math.pow(0.3, 0.6) * 100, 3);
  act(() =>
    socket.send({
      type: "audio_meter_update",
      programId: "other",
      levels: { song: 0.9 },
    }),
  );
  expect(meter("Music")).toBeCloseTo(Math.pow(0.5, 0.6) * 100, 3);
  // A change smaller than the display can show keeps the current meters.
  act(() =>
    socket.send({
      type: "audio_meter_update",
      programId: "main",
      levels: {
        song: 0.501,
        instants: { vu: 0.2, peak: 0.4 },
        main: { level: 0.3 },
      },
    }),
  );
  expect(meter("Music")).toBeCloseTo(Math.pow(0.5, 0.6) * 100, 3);
  act(() =>
    socket.send({
      type: "audio_meter_update",
      programId: "main",
      levels: { song: 0.8 },
    }),
  );
  expect(meter("Music")).toBeCloseTo(Math.pow(0.8, 0.6) * 100, 3);
  expect(meter("Main mix")).toBe(0);
});

it("empties the meters when they cannot be read", async () => {
  server.answer(
    "GET /program/main/audio-meter",
    () => new Response("down", { status: 503 }),
  );
  await openDesk();
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch program audio meter levels:",
      expect.any(Error),
    ),
  );
  expect(meter("Music")).toBe(0);
});

it("marks the song on air from playback, its updates and Off Air", async () => {
  server.answer("GET /program/main/song-playback", () =>
    Response.json({
      token: "s1:take-1",
      audioUrl: "https://cdn.example.test/s1.mp3",
      isPlaying: true,
      currentTimeMs: 1000,
      durationMs: 180000,
    }),
  );
  const { socket } = await openDesk();
  await waitFor(() => expect(activeRow()).toContain("First fictional song"));
  act(() =>
    socket.send({
      type: "song_playback_update",
      programId: "other",
      playback: { token: "s2:x", isPlaying: true },
    }),
  );
  expect(activeRow()).toContain("First fictional song");
  act(() =>
    socket.send({
      type: "song_playback_update",
      programId: "main",
      playback: {
        token: "s2:take-2",
        audioUrl: "https://cdn.example.test/s2.mp3",
        isPlaying: true,
      },
    }),
  );
  expect(activeRow()).toContain("Second fictional song");
  act(() =>
    socket.send({
      type: "song_playback_update",
      programId: "main",
      playback: {
        token: "s1:take-3",
        audioUrl: "https://cdn.example.test/s1.mp3",
        isPlaying: true,
      },
    }),
  );
  expect(activeRow()).toContain("First fictional song");
  // Off Air without a playback keeps the last song but stops it, so the
  // playlist's own selection shows again.
  act(() => socket.send({ type: "song_off_air", programId: "other" }));
  expect(activeRow()).toContain("First fictional song");
  act(() =>
    socket.send({
      type: "song_off_air",
      programId: "main",
      triggeredAt: "2026-11-17T20:00:00.000Z",
    }),
  );
  expect(activeRow()).toContain("Second fictional song");
  act(() =>
    socket.send({
      type: "song_playback_update",
      programId: "main",
      playback: {
        token: "s1:take-4",
        audioUrl: "https://cdn.example.test/s1.mp3",
        isPlaying: true,
      },
    }),
  );
  act(() =>
    socket.send({
      type: "song_off_air",
      programId: "main",
      playback: { token: "s1:take-4", isPlaying: false },
    }),
  );
  expect(activeRow()).toContain("Second fictional song");
  act(() => socket.send({ type: "song_off_air", programId: "main" }));
  expect(activeRow()).toContain("Second fictional song");
});

it("treats unreadable song playback as nothing on air", async () => {
  server.answer(
    "GET /program/main/song-playback",
    () => new Response("down", { status: 500 }),
  );
  await openDesk();
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch program song playback:",
      expect.any(Error),
    ),
  );
  expect(activeRow()).toContain("Second fictional song");
});

it("applies audio bus snapshots and updates for this program", async () => {
  const { socket } = await openDesk();
  act(() =>
    socket.send({
      type: "audio_bus_snapshot",
      programId: "other",
      settings: audioBus({ mixerSettings: { songMasterVolume: 0.1 } }),
    }),
  );
  expect(fader("Music").value).toBe("0.6");
  act(() =>
    socket.send({
      type: "audio_bus_snapshot",
      programId: "main",
      settings: audioBus({
        mixerSettings: { songMasterVolume: 0.25 },
        songSequence: {
          mode: "manual",
          items: [song("s9", "Snapshot fictional song")],
          activeItemId: "s9",
        },
      }),
    }),
  );
  expect(fader("Music").value).toBe("0.25");
  expect(activeRow()).toContain("Snapshot fictional song");
  // A snapshot without a mix or a playlist keeps the mix and empties the playlist.
  act(() =>
    socket.send({
      type: "audio_bus_snapshot",
      programId: "main",
      settings: "unreadable",
    }),
  );
  expect(fader("Music").value).toBe("0.25");
  expect(rows()).toEqual([]);

  act(() =>
    socket.send({
      type: "audio_bus_update",
      programId: "other",
      settings: { mixerSettings: { songMasterVolume: 0.9 } },
    }),
  );
  expect(fader("Music").value).toBe("0.25");
  act(() =>
    socket.send({
      type: "audio_bus_update",
      programId: "main",
      settings: {
        mixerSettings: { songMasterVolume: 0.35, mainMasterVolume: 0.5 },
        songSequence: {
          mode: "manual",
          items: [song("s8", "Updated fictional song")],
          activeItemId: "s8",
        },
      },
    }),
  );
  expect(fader("Music").value).toBe("0.35");
  expect(fader("Main mix").value).toBe("0.5");
  expect(activeRow()).toContain("Updated fictional song");
  act(() => socket.send({ type: "audio_bus_update", programId: "main" }));
  expect(fader("Music").value).toBe("0.35");
  expect(rows()).toEqual([]);
});

describe_radio();

function describe_radio() {
  const rotation = {
    mode: "manual",
    items: [
      song("s1", "First fictional song"),
      song("s2", "Second fictional song"),
    ],
    activeItemId: "s1",
  };
  const queueTitles = () => {
    const region = screen.queryByRole("region", { name: "Play Next queue" });
    return region
      ? [
          "First fictional song",
          "Second fictional song",
          "Third fictional song",
        ].filter((title) => region.textContent?.includes(title))
      : [];
  };
  async function openRadio() {
    server.answer("GET /program/main/state", () =>
      Response.json(programState("radio")),
    );
    server.answer("GET /program/main/audio-bus", () =>
      Response.json({ songSequence: rotation, songQueue: [] }),
    );
    render(
      <MemoryRouter>
        <Control />
      </MemoryRouter>,
    );
    await screen.findAllByText("First fictional song");
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    return socket;
  }

  it("follows the radio's Play Next queue from queue and bus updates", async () => {
    const socket = await openRadio();
    expect(queueTitles()).toEqual([]);
    act(() =>
      socket.send({
        type: "song_queue_update",
        programId: "other",
        songQueue: [{ id: "q1", itemId: "s2", enqueuedAt: 1 }],
      }),
    );
    expect(queueTitles()).toEqual([]);
    act(() =>
      socket.send({
        type: "song_queue_update",
        programId: "main",
        songQueue: [{ id: "q1", itemId: "s2", enqueuedAt: 1 }],
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Play Next queue" }),
    ).toBeInTheDocument();
    expect(queueTitles()).toEqual(["Second fictional song"]);
    act(() =>
      socket.send({
        type: "song_queue_update",
        programId: "main",
        songQueue: [{ id: "q2", itemId: "s3", enqueuedAt: 2 }],
        songSequence: {
          ...rotation,
          items: [...rotation.items, song("s3", "Third fictional song")],
        },
      }),
    );
    expect(queueTitles()).toEqual(["Third fictional song"]);
    // A bus update without a queue keeps the queue; one with a queue replaces it.
    act(() =>
      socket.send({
        type: "audio_bus_update",
        programId: "main",
        settings: {
          songSequence: {
            ...rotation,
            items: [...rotation.items, song("s3", "Third fictional song")],
          },
        },
      }),
    );
    expect(queueTitles()).toEqual(["Third fictional song"]);
    act(() =>
      socket.send({
        type: "audio_bus_update",
        programId: "main",
        settings: { songSequence: rotation, songQueue: [] },
      }),
    );
    expect(
      screen.queryByRole("region", { name: "Play Next queue" }),
    ).not.toBeInTheDocument();
    act(() =>
      socket.send({
        type: "audio_bus_snapshot",
        programId: "main",
        settings: {
          songSequence: rotation,
          songQueue: [{ id: "q3", itemId: "s1", enqueuedAt: 3 }],
        },
      }),
    );
    expect(queueTitles()).toEqual(["First fictional song"]);
  });
}

it("shows the scene audio playing on Program from its state, takes and stops", async () => {
  prefs.workspace = "desktop";
  server.answer("GET /program/main/scene-instant", () =>
    Response.json({
      sceneId: 1,
      isPlaying: true,
      instant: { id: 4, name: "Fictional thunder", assetId: "a1" },
    }),
  );
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  act(() =>
    socket.send({
      type: "scene_staged",
      programId: "main",
      stagedSceneId: 1,
      scene: headlines,
    }),
  );
  fireEvent.click(await screen.findByRole("tab", { name: "Background audio" }));
  expect(
    await screen.findByText("Playing: Fictional thunder"),
  ).toBeInTheDocument();
  act(() =>
    socket.send({
      type: "scene_instant_stop",
      programId: "main",
      triggeredAt: "2026-11-17T20:00:00.000Z",
    }),
  );
  expect(screen.queryByText(/^Playing:/)).not.toBeInTheDocument();
  act(() =>
    socket.send({
      type: "scene_instant_take",
      programId: "other",
      sceneId: 1,
      instant: { id: 5, name: "Other" },
    }),
  );
  expect(screen.queryByText(/^Playing:/)).not.toBeInTheDocument();
  act(() =>
    socket.send({
      type: "scene_instant_take",
      programId: "main",
      sceneId: 1,
      instant: { id: 5, name: "Fictional rain", assetId: " a2 " },
    }),
  );
  expect(screen.getByText("Playing: Fictional rain")).toBeInTheDocument();
  act(() =>
    socket.send({
      type: "scene_instant_take",
      programId: "main",
      sceneId: 1,
      instant: {},
    }),
  );
  expect(screen.getByText("Playing: Scene instant")).toBeInTheDocument();
  act(() => socket.send({ type: "scene_instant_stop", programId: "other" }));
  expect(screen.getByText("Playing: Scene instant")).toBeInTheDocument();
  act(() => socket.send({ type: "scene_instant_stop", programId: "main" }));
  expect(screen.queryByText(/^Playing:/)).not.toBeInTheDocument();
  act(() =>
    socket.send({
      type: "scene_instant_state",
      programId: "main",
      playback: { isPlaying: true, instant: { name: "Fictional wind" } },
    }),
  );
  expect(screen.getByText("Playing: Fictional wind")).toBeInTheDocument();
  act(() =>
    socket.send({
      type: "scene_instant_state",
      programId: "other",
      playback: null,
    }),
  );
  expect(screen.getByText("Playing: Fictional wind")).toBeInTheDocument();
  act(() =>
    socket.send({
      type: "scene_instant_state",
      programId: "main",
      playback: null,
    }),
  );
  expect(screen.queryByText(/^Playing:/)).not.toBeInTheDocument();
});
