import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#404 (stronger pass, lines 142/143): a stored rotation whose active song is no longer in its
// playlist (the song was removed) starts again from the playlist's first song, and that is what the desk saves;
// a rotation with no active song keeps none.

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
function open(activeItemId: string | null, items: unknown[] = [first, second]) {
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
        songSequence: rotation("manual", activeItemId),
        songQueue: [],
      }),
    "PUT /program/main/audio-bus": () =>
      Response.json({
        songSequence: rotation("autoplay", "s1"),
        songQueue: [],
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

const saved = () =>
  server.requests("PUT /program/main/audio-bus") as Array<{
    songSequence: { activeItemId: string | null; mode: string };
  }>;

it("starts a rotation whose active song was removed from its first song, and saves that", async () => {
  open("gone");
  fireEvent.click(await screen.findByRole("button", { name: "Autoplay" }));
  await waitFor(() => expect(saved()).toHaveLength(1));
  expect(saved()[0].songSequence).toMatchObject({
    mode: "autoplay",
    activeItemId: "s1",
  });
});

it("keeps no active song for a rotation that has none", async () => {
  open(null);
  fireEvent.click(await screen.findByRole("button", { name: "Autoplay" }));
  await waitFor(() => expect(saved()).toHaveLength(1));
  expect(saved()[0].songSequence).toMatchObject({
    mode: "autoplay",
    activeItemId: null,
  });
});

it("starts a rotation whose active item is a nested playlist from that playlist's first song", async () => {
  open("g1", [
    {
      id: "g1",
      kind: "sequence",
      sequence: { mode: "manual", items: [first, second] },
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Autoplay" }));
  await waitFor(() => expect(saved()).toHaveLength(1));
  expect(saved()[0].songSequence).toMatchObject({
    mode: "autoplay",
    activeItemId: "s1",
  });
});
