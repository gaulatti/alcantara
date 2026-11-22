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

// gaulatti/alcantara#297: Ctrl+K belongs to the command palette, so on the radio
// console it must not play a cartwall instant. Route-level: the real keydown
// handler in control.tsx runs against an eighteen-instant cartwall, where the old
// map put k on slot 18.

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

const instants = Array.from({ length: 18 }, (_, index) => ({
  id: index + 1,
  name: `Fictional clip ${index + 1}`,
  audioUrl: `https://media.example.test/clip-${index + 1}.mp3`,
  volume: 1,
  enabled: true,
  position: index,
}));

// Clips never load, so no playback timer runs; the test only watches requests.
class SilentAudio {
  preload = "";
  src = "";
  duration = Number.NaN;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  load() {}
}

function open() {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json(instants),
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
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
}

function playRequests() {
  return server.calls.filter(
    (call) => call.method === "POST" && /^\/instants\/\d+\/play/.test(call.path),
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  vi.stubGlobal("Audio", SilentAudio);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("plays nothing for Ctrl+K, which the command palette owns", async () => {
  open();
  await screen.findByRole("button", { name: "Fictional clip 18" });
  await act(async () => {
    await Promise.resolve();
  });

  fireEvent.keyDown(document, { key: "k", code: "KeyK", ctrlKey: true });
  // Give a triggered play time to reach the fetch stub before asserting none.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  expect(playRequests()).toEqual([]);
  expect(
    screen.queryByRole("button", { name: "Fictional clip 18 · playing" }),
  ).toBeNull();
});

it("still plays the cartwall instant for a mapped chord, so the handler is live", async () => {
  open();
  server.answer("POST /instants/1/play?programId=main", Response.json({}));
  await screen.findByRole("button", { name: "Fictional clip 1" });

  fireEvent.keyDown(document, { key: "q", code: "KeyQ", ctrlKey: true });

  await waitFor(() =>
    expect(
      server.requests("POST /instants/1/play?programId=main"),
    ).toHaveLength(1),
  );
});
