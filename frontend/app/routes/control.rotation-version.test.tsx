import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// A save of the rotation replaces all of it, so the console sends the version it loaded and shows a refusal.

const program = vi.hoisted(() => ({ id: "main" }));
const ui = vi.hoisted(() => ({ workspace: "desktop" as string, programType: "radio" as string }));
vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => [program.id] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: { ...actual.defaultConsoleProfile("desktop"), workspace: ui.workspace } as never,
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

const stateFor = (programId: string, scenes: Array<ReturnType<typeof scene>>, stagedSceneId: number | null, activeSceneId: number | null) => ({
  id: programId === "main" ? 1 : 2,
  programId,
  type: programId === "main" ? ui.programType : "tv",
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

const refusal = "The rotation changed or didn't load: reload before saving";
const stored = {
  songSequence: { mode: "manual", items: [], activeItemId: null, intervalMs: 4000, loop: true, startedAt: 0 },
  songQueue: [],
  sequenceVersion: "v1",
};

it("saves with the version it loaded, then with the one the save answered, and shows a refusal", async () => {
  ui.workspace = "audio";
  ui.programType = "tv";
  server.answer("GET /program/main/state", () => Response.json({ ...stateFor("main", [], null, null), type: "tv" }));
  server.answer("GET /program/main/audio-bus", () => Response.json(stored));
  server.answer("PUT /program/main/audio-bus", () => Response.json({ ...stored, sequenceVersion: "v2" }));
  server.answer("GET /songs?limit=0", () =>
    Response.json({ data: [{ id: 11, artist: "Fictional artist", title: "Fictional opener", enabled: true, audioUrl: "https://media.example.test/a.mp3", coverUrl: null, durationMs: 180_000 }] }),
  );
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Add songs" }, { timeout: 5000 }));
  fireEvent.click(await screen.findByRole("button", { name: "Add to queue" }, { timeout: 5000 }));
  await waitFor(() => expect(server.requests("PUT /program/main/audio-bus")).toHaveLength(1), { timeout: 5000 });

  server.answer("PUT /program/main/audio-bus", () => Response.json({ message: refusal }, { status: 409 }));
  // The refused save reloads the stored rotation, which has no song, so the song can be added again.
  fireEvent.click(await screen.findByRole("button", { name: "Add to queue" }, { timeout: 5000 }));
  expect(await screen.findByText(refusal, {}, { timeout: 5000 })).toHaveAttribute("role", "alert");
  expect(
    server.requests("PUT /program/main/audio-bus").map((body) => (body as { sequenceVersion?: unknown }).sequenceVersion),
  ).toEqual(["v1", "v2"]);
  ui.workspace = "desktop";
  ui.programType = "radio";
}, 20000);
