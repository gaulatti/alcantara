import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser } from "../../test/controlKit";

// gaulatti/alcantara#194 fix-forward: on the radio console, a song the song
// queue refuses to add to Play Next shows why, instead of nothing.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: actual.defaultConsoleProfile("desktop"),
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

const song = {
  id: "s1",
  kind: "preset",
  songId: 11,
  artist: "Fictional artist",
  title: "Fictional closer",
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: "https://media.example.test/s1.mp3",
  durationMs: 180_000,
};

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

it("shows why the song queue refused a Play Next add", async () => {
  const server = controlServer({
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
    "GET /program/main/audio-bus": Response.json({
      songSequence: { mode: "manual", items: [song], activeItemId: "s1", loop: true },
      songQueue: [],
    }),
    "POST /program/main/song-queue": new Response("full", { status: 422 }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Play Fictional closer next" }),
  );
  expect(await screen.findByText("HTTP 422")).toBeVisible();
  await waitFor(() =>
    expect(server.requests("POST /program/main/song-queue")).toEqual([{ itemId: "s1" }]),
  );
});
