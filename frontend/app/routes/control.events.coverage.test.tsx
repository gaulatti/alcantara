import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#194 group 4: the program's server-sent events. Each event
// the control room receives changes what it shows: radio failures and playback,
// the song queue and rotation, the TV program and staged scene, fade to black,
// and scene background audio. Events for another program, stale ones and
// non-objects change nothing.

const sse = vi.hoisted(() => ({ send: (_: unknown) => {} }));
const prefs = vi.hoisted(() => ({ workspace: "director" as string }));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage: (data: unknown) => void }) => {
    sse.send = options.onMessage;
    return { isConnected: true };
  },
}));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: { ...actual.defaultConsoleProfile("desktop"), workspace: prefs.workspace },
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

let server: ControlServer;

const song = (id: string, title: string) => ({
  id,
  kind: "preset",
  songId: Number(id.slice(1)),
  artist: "Fictional artist",
  title,
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 180_000,
});
const rotation = { mode: "manual", items: [song("s1", "Fictional opener"), song("s2", "Fictional closer")], activeItemId: "s1", loop: true };

const scene = (id: number, name: string) => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
});
const headlines = scene(1, "Fictional headlines");
const desk = scene(2, "Fictional desk");
const tvState = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: 1,
  activeScene: headlines,
  fadeToBlack: false,
  scenes: [
    { id: 1, sceneId: 1, position: 0, scene: headlines },
    { id: 2, sceneId: 2, position: 1, scene: desk },
  ],
  mediaGroups: [],
  ...overrides,
});

async function send(data: unknown) {
  await act(async () => {
    sse.send(data);
    await Promise.resolve();
  });
}

function open(type: "radio" | "tv") {
  server = controlServer({
    "GET /scenes": Response.json([headlines, desk]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json(
      type === "radio" ? { ...tvState(), type: "radio", scenes: [], activeSceneId: null } : tvState(),
    ),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": Response.json({ version: 1, songSequence: rotation, songQueue: [] }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  prefs.workspace = "director";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows radio playout failures, and clears them when a song plays", async () => {
  open("radio");
  await screen.findByRole("region", { name: "Continuous fillers" });
  await send({ type: "song_request_failed", programId: "main", title: "Fictional closer", reason: "timeout" });
  expect(await screen.findByText(/“Fictional closer” did not play: it took too long to load\./)).toBeVisible();
  await send({ type: "radio_rotation_resume_failed" });
  expect(await screen.findByText(/continuous fillers could not resume/)).toBeVisible();
  await send({ type: "radio_log_cue_failed" });
  expect(await screen.findByText(/The timed block could not play\./)).toBeVisible();
  await send({ type: "song_playback_update", playback: { token: "t", audioUrl: "u", isPlaying: true } });
  await waitFor(() => expect(screen.queryByText(/The timed block could not play\./)).toBeNull());
  await send({ type: "radio_log_start_failed" });
  expect(await screen.findByText(/The timed block could not play\./)).toBeVisible();
  // A song that plays clears the playout error.
  await send({ type: "song_playback_update", playback: { token: "t2", audioUrl: "u", isPlaying: true, title: "Fictional opener" } });
  await waitFor(() => expect(screen.queryByText(/The timed block could not play\./)).toBeNull());
});

it("ignores events for another program, events that are not objects, and stale updates", async () => {
  open("radio");
  await screen.findByRole("region", { name: "Continuous fillers" });
  await send(null);
  await send("song_request_failed");
  await send({ type: "song_request_failed", programId: "other", title: "Elsewhere" });
  expect(screen.queryByText(/did not play/)).toBeNull();
  // Version 5, then an older version 4: the older queue is not shown.
  await send({ type: "song_queue_update", version: 5, songQueue: [{ id: "q1", itemId: "s2", enqueuedAt: 1 }] });
  expect(await screen.findByRole("button", { name: "Remove Fictional closer from Play Next" })).toBeVisible();
  await send({ type: "song_queue_update", version: 4, songQueue: [] });
  expect(screen.getByRole("button", { name: "Remove Fictional closer from Play Next" })).toBeVisible();
});

it("applies the rotation, queue and mixer the audio bus sends", async () => {
  open("radio");
  await screen.findByRole("region", { name: "Continuous fillers" });
  await send({
    type: "audio_bus_update",
    settings: {
      songSequence: { ...rotation, items: [song("s3", "Fictional bridge")], activeItemId: "s3" },
      songQueue: [{ id: "q3", itemId: "s3", enqueuedAt: 1 }],
    },
  });
  expect(await screen.findByRole("button", { name: "Remove Fictional bridge from Play Next" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Take on air" })).toHaveLength(1);
  // Without a queue or mixer, the shown queue stays; an unreadable rotation empties it.
  await send({ type: "audio_bus_update", settings: { songSequence: "corrupt" } });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Take on air" })).toBeNull());
  await send({ type: "audio_bus_update" });
  expect(screen.queryByRole("button", { name: "Take on air" })).toBeNull();
  // A queue update that carries a rotation replaces both; one without keeps the rotation.
  await send({
    type: "song_queue_update",
    songQueue: [],
    songSequence: { ...rotation, items: [song("s4", "Fictional coda")], activeItemId: "s4" },
  });
  expect((await screen.findAllByText("Fictional coda"))[0]).toBeVisible();
  await send({ type: "song_queue_update", songQueue: [], songSequence: "corrupt" });
  await waitFor(() => expect(screen.queryAllByText("Fictional coda")).toHaveLength(0));
  // A queue entry the rotation does not hold is shown as unavailable.
  await send({ type: "song_queue_update", songQueue: [{ id: "q9", itemId: "s9", enqueuedAt: 1 }] });
  expect(await screen.findByText("Unavailable playlist item")).toBeVisible();
});

it("shows what is playing, and takes it off air", async () => {
  open("radio");
  await screen.findByRole("region", { name: "Continuous fillers" });
  await send({
    type: "song_playback_update",
    playback: { token: "t1", audioUrl: "https://media.example.test/s2.mp3", isPlaying: true, title: "Fictional closer", artist: "Fictional artist", currentTimeMs: 1000, durationMs: 180000 },
  });
  const player = screen.getByRole("region", { name: "On air" });
  expect(await within(player).findByText("Fictional closer")).toBeVisible();
  await send({ type: "song_off_air", playback: { token: "t1" }, triggeredAt: new Date().toISOString() });
  expect(await within(player).findByText(/^Nothing on air/)).toBeVisible();
});

it("follows the TV program: snapshots, staging, scene updates, clearing, fade to black and media groups", async () => {
  open("tv");
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  await send({ type: "scene_staged", stagedSceneId: 2, scene: desk });
  expect(await screen.findByText("Ready: Fictional desk")).toBeVisible();
  await send({ type: "scene_update", scene: { ...desk, name: "Fictional desk, renamed" } });
  expect(await screen.findByText("Ready: Fictional desk, renamed")).toBeVisible();
  await send({ type: "scene_update", scene: "corrupt" });
  await send({ type: "scene_staged", stagedSceneId: "2", scene: null });
  await send({ type: "fade_to_black", state: tvState({ fadeToBlack: true }) });
  expect(await screen.findByRole("button", { name: "RESTORE PROGRAM" })).toBeVisible();
  await send({ type: "program_state_snapshot", state: tvState({ fadeToBlack: false }) });
  expect(await screen.findByRole("button", { name: "ARM FADE TO BLACK" })).toBeVisible();
  const onProgram = (name: RegExp) =>
    screen.getAllByRole("button", { name }).some((button) => /Program$/.test(button.textContent ?? ""));
  expect(onProgram(/Fictional headlines/)).toBe(true);
  await send({ type: "scene_change", state: tvState({ activeSceneId: 2, activeScene: desk }) });
  await waitFor(() => expect(onProgram(/Fictional desk/)).toBe(true));
  expect(onProgram(/Fictional headlines/)).toBe(false);
  // Staging the scene on Program warns that saved edits appear live; once
  // Program is cleared, the staged scene is no longer on air.
  await send({ type: "scene_staged", stagedSceneId: 2, scene: desk });
  expect(await screen.findByText("This scene is on Program. Saved changes appear live.")).toBeVisible();
  await send({ type: "scene_cleared" });
  await waitFor(() =>
    expect(screen.queryByText("This scene is on Program. Saved changes appear live.")).toBeNull(),
  );
  // The switcher agrees: no source is tagged Program once Program is cleared (#251).
  expect(onProgram(/Fictional desk/)).toBe(false);
  expect(onProgram(/Fictional headlines/)).toBe(false);
  const groupReads = () => server.calls.filter((call) => call.path === "/program/main/media-groups").length;
  const before = groupReads();
  await send({ type: "program_media_groups_changed", state: tvState() });
  await waitFor(() => expect(groupReads()).toBe(before + 1));
  await send({
    type: "program_scenes_changed",
    state: tvState({ scenes: [{ id: 1, sceneId: 1, position: 0, scene: headlines }] }),
  });
  await waitFor(() => expect(screen.queryAllByRole("button", { name: /Fictional desk/ })).toHaveLength(0));
});

it("shows the staged scene's background audio as taken, reported and stopped", async () => {
  const bedScene = {
    ...scene(3, "Fictional bed scene"),
    metadata: JSON.stringify({ player: { show: true }, sceneInstant: { assetId: "a1", instantId: null, volume: 0.5 } }),
    layout: { id: 2, name: "Player layout", componentType: "player" },
  };
  server = controlServer({
    "GET /scenes": Response.json([bedScene]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json(
      tvState({ activeSceneId: null, stagedSceneId: 3, stagedScene: bedScene, scenes: [{ id: 3, sceneId: 3, position: 0, scene: bedScene }] }),
    ),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({ data: [{ id: "a1", name: "Fictional rain", enabled: true }] }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: "TAKE BG" });
  await send({ type: "scene_instant_take", sceneId: 3, instant: { id: 7, assetId: " a1 ", name: "Fictional rain" }, triggeredAt: "2026-11-21T10:00:00Z" });
  expect(await screen.findByText("Playing: Fictional rain")).toBeVisible();
  await send({ type: "scene_instant_take", sceneId: 3, instant: {} });
  expect(await screen.findByText("Playing: Scene instant")).toBeVisible();
  await send({ type: "scene_instant_stop", triggeredAt: "2026-11-21T10:01:00Z" });
  await waitFor(() => expect(screen.queryByText(/^Playing:/)).toBeNull());
  await send({ type: "scene_instant_state", playback: { sceneId: 3, instantId: 7, isPlaying: true, instant: { name: "Fictional rain" } } });
  expect(await screen.findByText("Playing: Fictional rain")).toBeVisible();
  await send({ type: "scene_instant_stop" });
  await waitFor(() => expect(screen.queryByText(/^Playing:/)).toBeNull());
  // An event type the console does not know changes nothing.
  await send({ type: "something_new" });
  expect(screen.queryByText(/^Playing:/)).toBeNull();
});


it("keeps a scene staged or cleared before the program has loaded from creating a program", async () => {
  open("tv");
  // Sent before the first state read has answered.
  act(() => {
    sse.send({ type: "scene_cleared" });
    sse.send({ type: "scene_staged", stagedSceneId: 2, scene: desk });
  });
  // The program then opens as the server holds it: nothing is staged and its
  // own scene is on Program.
  const rows = await screen.findAllByRole("button", { name: /Fictional headlines/ });
  await waitFor(() => expect(rows.some((row) => /Program$/.test(row.textContent ?? ""))).toBe(true));
  expect(screen.queryByText("Ready: Fictional desk")).toBeNull();
});

it("moves the TV audio desk's faders and meters with the audio bus and meter events", async () => {
  prefs.workspace = "audio";
  open("tv");
  const fader = () => screen.getByRole("slider", { name: "Music fader" }) as HTMLInputElement;
  const meter = () => Number(screen.getByRole("meter", { name: "Music live level" }).getAttribute("aria-valuenow"));
  await screen.findByRole("slider", { name: "Music fader" });
  const before = fader().value;
  await send({ type: "audio_bus_update", settings: { mixerSettings: { songMasterVolume: 0.1 }, songSequence: rotation } });
  await waitFor(() => expect(fader().value).not.toBe(before));
  await send({ type: "audio_meter_update", levels: { song: 0.5, instants: { vu: 0, peak: 0 }, main: { level: 0 } } });
  await waitFor(() => expect(meter()).toBeCloseTo(Math.pow(0.5, 0.6) * 100, 3));
});
