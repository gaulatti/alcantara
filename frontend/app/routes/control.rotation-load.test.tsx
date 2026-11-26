import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#624 (control.tsx:2067): a take that answers after the operator switched programs must not put the
// answering program's scene on the program now on screen. The harness is the scene editor's, with a second program.

const program = vi.hoisted(() => ({ id: "main" }));
vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => [program.id] }));
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
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

import Control from "./control";

let server: ControlServer;

const scene = (id: number, name: string) => ({
  id,
  name,
  layoutId: 1,
  metadata: JSON.stringify({ header: { show: false } }),
  layout: { id: 1, name: "Fixture layout", componentType: "header" },
});
const stagedScene = scene(1, "Fictional stage scene");
const mainOnlyScene = scene(2, "Main-only scene");

const stateFor = (programId: string, scenes: Array<ReturnType<typeof scene>>, stagedSceneId: number | null, activeSceneId: number | null) => ({
  id: programId === "main" ? 1 : 2,
  programId,
  type: programId === "main" ? "radio" : "tv",
  activeSceneId,
  stagedSceneId,
  stagedScene: scenes.find((entry) => entry.id === stagedSceneId) ?? null,
  fadeToBlack: false,
  scenes: scenes.map((entry, position) => ({ id: entry.id, sceneId: entry.id, position, scene: entry })),
  mediaGroups: [],
});

beforeEach(() => {
  program.id = "main";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([stagedScene]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json(stateFor("main", [stagedScene], 1, null)),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": Response.json({ songSequence: null, songQueue: [] }),
    "GET /program/other/state": Response.json(stateFor("other", [], null, null)),
    "GET /program/other/media-groups": Response.json([]),
    "GET /program/other/audio-bus": Response.json({ songSequence: null, songQueue: [] }),
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

// gaulatti/alcantara#624 (control.tsx:2067): a take that answers after the operator switched programs must not put the
// answering program's scene on the program now on screen.
// gaulatti/alcantara#624-adjacent: a rotation whose load fails is an error with Retry, and it loads once the backend answers.
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

it("shows a failed rotation load as an error, then the rotation once the backend answers again", async () => {
  server.answer("GET /program/main/audio-bus", () => new Response("down", { status: 500 }));
  render(view());
  expect(await screen.findByText("Couldn't load the rotation", {}, { timeout: 5000 })).toBeVisible();
  expect(screen.queryByText(/is empty/)).toBeNull();

  server.answer("GET /program/main/audio-bus", () =>
    Response.json({
      songSequence: { mode: "manual", items: [song("s1", "Fictional opener", 11)], activeItemId: "s1", intervalMs: 4000, loop: true, startedAt: 0 },
      songQueue: [],
    }),
  );
  expect((await screen.findAllByText("Fictional opener", {}, { timeout: 8000 })).length).toBeGreaterThan(0);
  expect(screen.queryByText("Couldn't load the rotation")).toBeNull();
}, 15000);
