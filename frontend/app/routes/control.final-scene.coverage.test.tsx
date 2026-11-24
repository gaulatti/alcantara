import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx final pass): a Save pressed while the edit's save is in flight sends nothing more,
// a refused save reports that it was not saved, and the workspace switch saves the preference.
// Earlier: gaulatti/alcantara#404 (group A, control.tsx): the scene editor's autosave timers, when Save changes runs
// first and when repeated failures back off toward their cap. Earlier: gaulatti/alcantara#194 group 3: the scene editor. Editing the staged scene's
// components saves its metadata (on its own after a pause, or at once with
// Save changes); a failed save is shown and retried; the scene's background
// audio is chosen, taken and stopped from the editor.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
const prefs = vi.hoisted(() => ({ updateProfile: vi.fn() }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: actual.defaultConsoleProfile("desktop"),
      updateProfile: prefs.updateProfile,
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

it("sends one save when Save changes is pressed while the edit's own save is still in flight", async () => {
  const scene = open();
  server.answer("PUT /scenes/1", () => new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json(scene)), 300)));
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(server.requests("PUT /scenes/1").length).toBe(1);
}, 15000);

it("reports a scene that was not saved when Save changes is pressed and the server refuses", async () => {
  open();
  server.answer("PUT /scenes/1", () => new Response("down", { status: 500 }));
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(0));
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Scene save failed. Please try again.", {}, { timeout: 4000 })).toBeVisible();
}, 15000);

it("saves the workspace preference when the operator switches to the remote workspace", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Remote" }));
  expect(prefs.updateProfile).toHaveBeenCalledWith({ workspace: "compact" });
}, 15000);
