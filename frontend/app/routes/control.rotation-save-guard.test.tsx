import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#624 (control.tsx:2067): a take that answers after the operator switched programs must not put the
// answering program's scene on the program now on screen. The harness is the scene editor's, with a second program.

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
const mainOnlyScene = scene(2, "Main-only scene");

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

// gaulatti/alcantara#624 (control.tsx:2067): a take that answers after the operator switched programs must not put the
// answering program's scene on the program now on screen.
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

const notLoaded = "The rotation didn't load. Nothing can be changed until it does.";

// Surfaces: the playlist sheet and the music panel (both opened by Add songs) and the playback bar. While the rotation has
// not loaded, an add is refused with a visible notice, and no audio-bus write is sent.
it("sends no audio-bus write from the playlist when the rotation has not loaded, and says why", async () => {
  ui.workspace = "audio";
  ui.programType = "tv";
  server.answer("GET /program/main/state", () => Response.json({ ...stateFor("main", [], null, null), type: "tv" }));
  server.answer("GET /program/main/audio-bus", () => new Response("down", { status: 500 }));
  server.answer("GET /songs?limit=0", () =>
    Response.json({ data: [{ id: 11, artist: "Fictional artist", title: "Fictional opener", enabled: true, audioUrl: "https://media.example.test/a.mp3", coverUrl: null, durationMs: 180_000 }] }),
  );
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Add songs" }, { timeout: 5000 }));
  expect((await screen.findAllByText(notLoaded, {}, { timeout: 5000 })).length).toBeGreaterThan(0);
  fireEvent.click(await screen.findByRole("button", { name: "Add to queue" }, { timeout: 5000 }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(server.requests("PUT /program/main/audio-bus")).toHaveLength(0);
  ui.workspace = "desktop";
  ui.programType = "radio";
}, 15000);

it("keeps Stop working while the rotation has not loaded: taking the song off air is never blocked", async () => {
  ui.workspace = "audio";
  ui.programType = "tv";
  server.answer("GET /program/main/state", () => Response.json({ ...stateFor("main", [], null, null), type: "tv" }));
  server.answer("GET /program/main/audio-bus", () => new Response("down", { status: 500 }));
  server.answer("POST /program/main/song/off-air", () => Response.json({ songPlayback: null }));
  render(view());
  await screen.findAllByText(notLoaded, {}, { timeout: 5000 });
  fireEvent.click(await screen.findByRole("button", { name: "Stop / Take Off Air" }, { timeout: 5000 }));
  await waitFor(() => expect(server.requests("POST /program/main/song/off-air").length).toBeGreaterThan(0), { timeout: 5000 });
  ui.workspace = "desktop";
  ui.programType = "radio";
}, 15000);

it("keeps the transport's controls enabled while the rotation has not loaded", async () => {
  ui.workspace = "audio";
  ui.programType = "tv";
  server.answer("GET /program/main/state", () => Response.json({ ...stateFor("main", [], null, null), type: "tv" }));
  server.answer("GET /program/main/audio-bus", () => new Response("down", { status: 500 }));
  render(view());
  await screen.findAllByText(notLoaded, {}, { timeout: 5000 });
  expect(document.querySelector(".tv-audio-transport")).not.toHaveAttribute("inert");
  ui.workspace = "desktop";
  ui.programType = "radio";
}, 15000);

it("re-enables the surfaces once a retry loads the rotation", async () => {
  ui.workspace = "audio";
  ui.programType = "tv";
  server.answer("GET /program/main/state", () => Response.json({ ...stateFor("main", [], null, null), type: "tv" }));
  server.answer("GET /program/main/audio-bus", () => new Response("down", { status: 500 }));
  render(view());
  await screen.findAllByText(notLoaded, {}, { timeout: 5000 });
  server.answer("GET /program/main/audio-bus", () =>
    Response.json({ songSequence: { mode: "manual", items: [song("s1", "Fictional opener", 11)], activeItemId: "s1", intervalMs: 4000, loop: true, startedAt: 0 }, songQueue: [] }),
  );
  fireEvent.click((await screen.findAllByRole("button", { name: "Retry" }, { timeout: 5000 }))[0]);
  await waitFor(() => expect(screen.queryByText(notLoaded)).toBeNull(), { timeout: 8000 });
  ui.workspace = "desktop";
  ui.programType = "radio";
}, 20000);
