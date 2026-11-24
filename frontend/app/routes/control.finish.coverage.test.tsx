import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx finish): an unsaved edit is saved when the page is hidden, even after the scene
// was cleared; a second edit inside the autosave pause restarts that pause. Earlier: the scene editor's autosave timers, when Save changes runs
// first and when repeated failures back off toward their cap. Earlier: gaulatti/alcantara#194 group 3: the scene editor. Editing the staged scene's
// components saves its metadata (on its own after a pause, or at once with
// Save changes); a failed save is shown and retried; the scene's background
// audio is chosen, taken and stopped from the editor.

const sse = vi.hoisted(() => ({ onMessage: null as null | ((data: unknown) => void) }));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage?: (data: unknown) => void }) => {
    sse.onMessage = options.onMessage ?? null;
    return { isConnected: true };
  },
}));
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

// The design system's Select is a native select here, as in the bracket
// editor's own tests, so a ballot can be cast with a change event.
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

const playerScene = (
  metadata: Record<string, unknown> = { header: { show: false } },
  componentType = "header",
) => ({
  id: 1,
  name: "Fictional player scene",
  layoutId: 1,
  metadata: JSON.stringify(metadata),
  layout: { id: 1, name: "Fixture layout", componentType },
});

function open(metadata?: Record<string, unknown>, componentType?: string, songs: unknown[] = []) {
  const scene = playerScene(metadata, componentType);
  server = controlServer({
    "GET /scenes": Response.json([scene]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: songs }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      activeSceneId: null,
      stagedSceneId: 1,
      stagedScene: scene,
      fadeToBlack: false,
      scenes: [{ id: 1, sceneId: 1, position: 0, scene }],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({
      data: [{ id: "a1", name: "Fictional rain", enabled: true }],
    }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  return scene;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("saves an unsaved edit when the page is hidden, after the scene was deselected", async () => {
  const scene = open();
  let succeed = false;
  server.answer("PUT /scenes/1", () => (succeed ? Response.json(scene) : new Response("down", { status: 500 })));
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThanOrEqual(1));
  // The program moves on with no scene staged: the editor lets go of the scene, and its save is still pending.
  act(() => sse.onMessage?.({
    type: "scene_change",
    programId: "main",
    state: {
      id: 1, programId: "main", type: "tv", activeSceneId: null, stagedSceneId: null, stagedScene: null,
      fadeToBlack: false, scenes: [{ id: 1, sceneId: 1, position: 0, scene }], mediaGroups: [],
    },
  }));
  const before = server.requests("PUT /scenes/1").length;
  succeed = true;
  // The window closes: the pending edit is saved with no scene selected.
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(before));
});

it("restarts the autosave pause when a second edit lands inside it", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  const before = server.requests("PUT /scenes/1").length;
  const field = (await screen.findAllByRole("textbox"))[0];
  fireEvent.change(field, { target: { value: "Fictional title" } });
  // Still inside the pause: nothing saved yet.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(server.requests("PUT /scenes/1").length).toBe(before);
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(before), { timeout: 3000 });
});
