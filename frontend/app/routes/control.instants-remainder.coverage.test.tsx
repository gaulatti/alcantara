import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): the route's metadata, a cartwall clip the program
// refuses, and a clip whose length is already known from another clip on the same audio file.

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

import Control, { meta } from "./control";

let server: ControlServer;

const clips = [
  { id: 1, name: "Fictional clip 1", audioUrl: "https://media.example.test/shared.mp3", volume: 1, enabled: true, position: 0 },
  { id: 2, name: "Fictional clip 2", audioUrl: "https://media.example.test/shared.mp3", volume: 1, enabled: true, position: 1 },
];

// Clips report a fixed length as soon as their source is set, so the duration is known for the second clip.
class LoadingAudio {
  static sources: string[] = [];
  preload = "";
  duration = 3;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    LoadingAudio.sources.push(value);
    queueMicrotask(() => this.onloadedmetadata?.());
  }
  load() {}
}

function open() {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json(clips),
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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  LoadingAudio.sources = [];
  vi.stubGlobal("Audio", LoadingAudio);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("gives the route's document title and description", () => {
  expect(meta({} as never)).toEqual([
    { title: "Control Panel - TV Broadcast" },
    { name: "description", content: "Control panel for TV broadcast overlay system" },
  ]);
});

it("names the clip and the reason when the program refuses it", async () => {
  open();
  server.answer("POST /instants/1/play?programId=main", Response.json({ message: "Palazzo is busy" }, { status: 409 }));
  await screen.findByRole("button", { name: "Fictional clip 1" });
  fireEvent.keyDown(document, { key: "q", code: "KeyQ", ctrlKey: true });
  await waitFor(() =>
    expect(screen.getByText(/Could not play Fictional clip 1/)).toBeInTheDocument(),
  );
});

it("reads a clip's length once and reuses it for another clip on the same file", async () => {
  open();
  server.answer("POST /instants/1/play?programId=main", Response.json({}));
  await screen.findByRole("button", { name: "Fictional clip 1" });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.keyDown(document, { key: "q", code: "KeyQ", ctrlKey: true });
  await waitFor(() => expect(server.requests("POST /instants/1/play?programId=main")).toHaveLength(1));
  // The shared file is measured for the first clip; the second clip reads the cached length.
  expect(LoadingAudio.sources.filter((src) => src.endsWith("shared.mp3")).length).toBeLessThanOrEqual(2);
});
