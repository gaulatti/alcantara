import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx remainder, audio-bus fallback): a stored audio bus with no song sequence
// starts from an empty manual rotation, and a catalog song added to it is saved from that base.
// gaulatti/alcantara#194: the TV console's audio workspace. Its music list,
// playback bar, playlist sheet and cartwall reach the same audio bus, radio,
// off-air and instant requests as the radio console.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: { ...actual.defaultConsoleProfile("desktop"), workspace: "audio" },
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
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([
      { id: 1, name: "Fictional bell", audioUrl: "https://media.example.test/bell.mp3", volume: 1, enabled: true, position: 0 },
    ]),
    "GET /songs?limit=0": Response.json({
      data: [{ id: 9, enabled: true, title: "Fictional catalog song", artist: "Fictional artist", audioUrl: "https://media.example.test/c9.mp3", durationMs: 120000 }],
    }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      activeSceneId: null,
      fadeToBlack: false,
      scenes: [],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": Response.json({ songSequence: null, songQueue: [] }),
    "PUT /program/main/audio-bus": () => {
      const sent = server.calls.filter((call) => call.method === "PUT").at(-1)?.body as { songSequence: unknown };
      return Response.json({ songSequence: sent.songSequence });
    },
    "POST /radio/main/song": Response.json({}),
    "POST /program/main/song/off-air": Response.json({}),
    "POST /instants/1/play?programId=main": Response.json({}),
    "POST /instants/stop-all?programId=main": Response.json({}),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("starts from an empty rotation when the stored audio bus has no song sequence, and saves a catalog song into it", async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Add songs" }));
  const sheet = await screen.findByRole("dialog");
  const saves = server.requests("PUT /program/main/audio-bus").length;
  fireEvent.click(within(sheet).getAllByRole("button", { name: "Add to queue" })[0]);
  await waitFor(() => expect(server.requests("PUT /program/main/audio-bus").length).toBe(saves + 1));
  const sent = server.requests("PUT /program/main/audio-bus").at(-1) as { songSequence: { items: Array<{ title: string }>; mode: string } };
  expect(sent.songSequence.mode).toBe("manual");
  expect(sent.songSequence.items.map((item) => item.title)).toEqual(["Fictional catalog song"]);
});
