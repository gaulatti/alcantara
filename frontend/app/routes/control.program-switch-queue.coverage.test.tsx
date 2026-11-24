import {
  act,
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

// gaulatti/alcantara#404 (control.tsx stronger pass): a Play Next answer that arrives after the operator switched to
// another program is not applied to the program now on screen.

const program = vi.hoisted(() => ({ id: "main" }));
vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [program.id],
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

const programFixture = (programId: string) => ({
  [`GET /program/${programId}/state`]: Response.json({
    id: programId === "main" ? 1 : 2,
    programId,
    type: "radio",
    activeSceneId: null,
    fadeToBlack: false,
    scenes: [],
    mediaGroups: [],
  }),
  [`GET /program/${programId}/media-groups`]: Response.json([]),
  [`GET /program/${programId}/audio-bus`]: () =>
    Response.json({
      songSequence: {
        mode: "manual",
        items: [first, second],
        activeItemId: "s1",
        intervalMs: 4000,
        loop: true,
        startedAt: Date.parse("2026-11-21T10:00:00Z"),
      },
      songQueue: [],
    }),
});

beforeEach(() => {
  program.id = "main";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    ...programFixture("main"),
    ...programFixture("other"),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const view = () => (
  <MemoryRouter>
    <Control />
  </MemoryRouter>
);

it("does not show one program's Play Next answer on the program the operator switched to", async () => {
  let answer: (response: Response) => void = () => {};
  server.answer(
    "POST /program/main/song-queue",
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  const { rerender } = render(view());
  fireEvent.click(
    await screen.findByRole("button", { name: "Play Fictional closer next" }),
  );
  await waitFor(() =>
    expect(server.requests("POST /program/main/song-queue")).toHaveLength(1),
  );

  program.id = "other";
  rerender(view());
  await waitFor(() =>
    expect(
      server.requests("GET /program/other/audio-bus").length,
    ).toBeGreaterThan(0),
  );
  await screen.findByRole("button", { name: "Play Fictional closer next" });

  await act(async () => {
    answer(
      Response.json({
        songQueue: [
          {
            id: "q2",
            itemId: "s2",
            enqueuedAt: Date.parse("2026-11-21T10:01:00Z"),
          },
        ],
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(
    screen.queryByRole("button", {
      name: "Remove Fictional closer from Play Next",
    }),
  ).toBeNull();
});
