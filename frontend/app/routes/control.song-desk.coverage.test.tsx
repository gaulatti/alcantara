import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { holdControl } from "../../test/routeKit";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#194 group 1: the radio song desk. Saving the filler
// rotation, taking a song on air, and the Play Next queue (add, move, remove)
// go to the program's audio bus and song queue; what the server answers is
// what the desk shows, and a refused request is shown and reloaded.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["main"],
}));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual =
    await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: actual.defaultConsoleProfile("desktop"),
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

let server: ControlServer;

const song = (id: string, title: string, songId: number) => ({
  id,
  kind: "preset",
  songId,
  artist: "Fictional artist",
  title,
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 180_000,
});
const first = song("s1", "Fictional opener", 11);
const second = song("s2", "Fictional closer", 12);

const rotation = (mode: string, activeItemId: string | null = "s1") => ({
  mode,
  items: [first, second],
  activeItemId,
  intervalMs: 4000,
  loop: true,
  startedAt: Date.parse("2026-11-21T10:00:00Z"),
});
const queue = [
  { id: "q1", itemId: "s1", enqueuedAt: Date.parse("2026-11-21T10:00:00Z") },
  { id: "q2", itemId: "s2", enqueuedAt: Date.parse("2026-11-21T10:01:00Z") },
];

function open(
  mode = "manual",
  songQueue: unknown[] = queue,
  items: unknown[] = [first, second],
) {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "radio",
      activeSceneId: null,
      fadeToBlack: false,
      scenes: [],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": () =>
      Response.json({
        version: 5,
        songSequence: { ...rotation(mode), items },
        songQueue,
      }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("takes a song on air in manual rotation: saves the rotation, then sends the song to the radio", async () => {
  open("manual");
  server.answer(
    "PUT /program/main/audio-bus",
    Response.json({
      songSequence: rotation("manual", "s2"),
      songQueue: [queue[1]],
      mixerSettings: { songMasterVolume: 0.5 },
    }),
  );
  server.answer("POST /radio/main/song", Response.json({}));
  const takes = await screen.findAllByRole("button", { name: "Take on air" });
  fireEvent.click(takes[1]);
  await waitFor(() =>
    expect(server.requests("POST /radio/main/song")).toEqual([
      {
        audioUrl: second.audioUrl,
        title: second.title,
        artist: second.artist,
        coverUrl: second.coverUrl,
        durationMs: second.durationMs,
        songId: second.songId,
      },
    ]),
  );
  const [saved] = server.requests("PUT /program/main/audio-bus") as Array<{
    songSequence: { activeItemId: string; items: unknown[] };
  }>;
  expect(saved.songSequence.activeItemId).toBe("s2");
  expect(saved.songSequence.items).toHaveLength(2);
  // The queue the server answered replaces the shown one.
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "Remove Fictional opener from Play Next",
      }),
    ).toBeNull(),
  );
});

it("starts an idle automatic rotation by saving it alone, without a second manual take", async () => {
  open("autoplay");
  server.answer(
    "PUT /program/main/audio-bus",
    Response.json({ songSequence: rotation("autoplay", "s2") }),
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Take on air" }))[1],
  );
  await waitFor(() =>
    expect(server.requests("PUT /program/main/audio-bus")).toHaveLength(1),
  );
  expect(server.requests("POST /radio/main/song")).toEqual([]);
});

it("shows a refused take and reloads the rotation from the server", async () => {
  open("manual");
  server.answer(
    "PUT /program/main/audio-bus",
    new Response("down", { status: 500 }),
  );
  const busReads = () =>
    server.calls.filter(
      (call) =>
        call.method === "GET" && call.path === "/program/main/audio-bus",
    ).length;
  const takes = await screen.findAllByRole("button", { name: "Take on air" });
  await waitFor(() => expect(busReads()).toBeGreaterThan(0));
  const before = busReads();
  fireEvent.click(takes[1]);
  expect(await screen.findByText("HTTP 500")).toBeVisible();
  // The rotation the server holds is read again.
  await waitFor(() => expect(busReads()).toBe(before + 1));
  expect(server.requests("POST /radio/main/song")).toEqual([]);
});

it("shows a song the radio refused after the rotation was saved", async () => {
  open("manual");
  server.answer(
    "PUT /program/main/audio-bus",
    Response.json({ songSequence: rotation("manual", "s2") }),
  );
  server.answer("POST /radio/main/song", new Response("no", { status: 502 }));
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Take on air" }))[1],
  );
  expect(await screen.findByText("HTTP 502")).toBeVisible();
});

it("moves and removes Play Next songs through the song queue and shows the queue the server answers", async () => {
  open("manual");
  server.answer(
    "PUT /program/main/song-queue",
    Response.json({ songQueue: [queue[1], queue[0]] }),
  );
  server.answer(
    "DELETE /program/main/song-queue/q2",
    Response.json({ songQueue: [queue[0]] }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Move Fictional closer earlier" }),
  );
  await waitFor(() =>
    expect(server.requests("PUT /program/main/song-queue")).toEqual([
      { entryIds: ["q2", "q1"] },
    ]),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove Fictional closer from Play Next",
    }),
  );
  await waitFor(() =>
    expect(
      server.calls.filter(
        (call) => call.method === "DELETE",
      ).map((call) => call.path),
    ).toEqual(["/program/main/song-queue/q2"]),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "Remove Fictional closer from Play Next",
      }),
    ).toBeNull(),
  );
});

it("adds a song to Play Next through the song queue", async () => {
  open("manual", []);
  server.answer(
    "POST /program/main/song-queue",
    Response.json({ songQueue: [queue[1]] }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Play Fictional closer next" }),
  );
  await waitFor(() =>
    expect(server.requests("POST /program/main/song-queue")).toEqual([
      { itemId: "s2" },
    ]),
  );
  expect(
    await screen.findByRole("button", {
      name: "Remove Fictional closer from Play Next",
    }),
  ).toBeVisible();
});

it("ignores an answer older than what the desk already shows, and keeps its own rotation when the answer has none", async () => {
  open("manual");
  // An older audio bus answer (version 4 after 5) changes nothing shown.
  server.answer(
    "PUT /program/main/audio-bus",
    Response.json({ version: 4, songQueue: [] }),
  );
  server.answer("POST /radio/main/song", Response.json({}));
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Take on air" }))[1],
  );
  await waitFor(() =>
    expect(server.requests("POST /radio/main/song")).toHaveLength(1),
  );
  expect(
    screen.getByRole("button", { name: "Remove Fictional opener from Play Next" }),
  ).toBeVisible();

  // A newer answer without a rotation keeps the rotation the desk saved.
  server.answer("PUT /program/main/audio-bus", Response.json({ version: 6 }));
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Take on air" }))[0],
  );
  await waitFor(() =>
    expect(server.requests("POST /radio/main/song")).toHaveLength(2),
  );
  expect(server.requests("POST /radio/main/song")[1]).toMatchObject({
    title: first.title,
  });
});

it("saves a take of a song without audio but sends nothing to the radio", async () => {
  const silent = { ...second, audioUrl: undefined };
  open("manual", queue, [first, silent]);
  server.answer(
    "PUT /program/main/audio-bus",
    Response.json({ version: 6 }),
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Take on air" }))[1],
  );
  await waitFor(() =>
    expect(server.requests("PUT /program/main/audio-bus")).toHaveLength(1),
  );
  expect(server.requests("POST /radio/main/song")).toEqual([]);
});

it("shows a refused Play Next change and ignores a queue answer that is empty or older", async () => {
  open("manual");
  server.answer(
    "PUT /program/main/song-queue",
    new Response("busy", { status: 409 }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Move Fictional closer earlier" }),
  );
  expect(
    await screen.findByText("The Play Next queue was not changed. Try again."),
  ).toBeVisible();

  server.answer(
    "DELETE /program/main/song-queue/q2",
    Response.json({ version: 4, songQueue: [] }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Fictional closer from Play Next" }),
  );
  await waitFor(() =>
    expect(server.calls.some((call) => call.method === "DELETE")).toBe(true),
  );
  server.answer("DELETE /program/main/song-queue/q1", Response.json(null));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Fictional opener from Play Next" }),
  );
  await waitFor(() =>
    expect(
      server.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(2),
  );
  // Neither answer replaced the queue.
  expect(
    screen.getByRole("button", { name: "Remove Fictional opener from Play Next" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Remove Fictional closer from Play Next" }),
  ).toBeVisible();
});

it("shows a refused removal", async () => {
  open("manual");
  server.answer(
    "DELETE /program/main/song-queue/q1",
    new Response("gone", { status: 410 }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove Fictional opener from Play Next",
    }),
  );
  expect(
    await screen.findByText("The Play Next queue was not changed. Try again."),
  ).toBeVisible();
});

it("takes the song off air, and shows it when the radio refuses", async () => {
  open("manual");
  server.answer("POST /program/main/song/off-air", Response.json({}));
  await holdControl(
    await screen.findByRole("button", { name: "Stop the song on air" }),
  );
  await waitFor(() =>
    expect(server.requests("POST /program/main/song/off-air")).toHaveLength(1),
  );
  server.answer(
    "POST /program/main/song/off-air",
    new Response("no", { status: 503 }),
  );
  await holdControl(screen.getByRole("button", { name: "Stop the song on air" }));
  expect(await screen.findByText("HTTP 503")).toBeVisible();
});

it("treats a Play Next entry that is already gone (404) as removed, with no error shown", async () => {
  open("manual");
  server.answer("DELETE /program/main/song-queue/q2", new Response("gone", { status: 404 }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove Fictional closer from Play Next",
    }),
  );
  await waitFor(() =>
    expect(
      server.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    ).toEqual(["/program/main/song-queue/q2"]),
  );
  expect(screen.queryByText(/HTTP 404|will play again/)).toBeNull();
});

