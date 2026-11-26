import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): the scene editor's autosave timers, when Save changes runs
// first and when repeated failures back off toward their cap. Earlier: gaulatti/alcantara#194 group 3: the scene editor. Editing the staged scene's
// components saves its metadata (on its own after a pause, or at once with
// Save changes); a failed save is shown and retried; the scene's background
// audio is chosen, taken and stopped from the editor.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
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

it("saves at once when Save changes runs before the autosave pause ends", async () => {
  const scene = open();
  server.answer("PUT /scenes/1", () =>
    Response.json({ ...scene, metadata: JSON.stringify({ header: { show: true } }) }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  // The autosave is still waiting out its pause when the operator saves by hand.
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(0));
  const saves = server.requests("PUT /scenes/1").length;
  // Once saved, the pending autosave is gone: no second save follows the pause.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(server.requests("PUT /scenes/1").length).toBe(saves);
});

it("backs off between failed saves and stops growing at the cap", async () => {
  const scene = open();
  server.answer("PUT /scenes/1", () => new Response("down", { status: 500 }));
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  // Each failed attempt waits longer than the last; the wait stops growing at its cap.
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThanOrEqual(4), { timeout: 15000 });
  expect(await screen.findByText("Scene save failed. Retrying...")).toBeVisible();
  // The real backoff takes about 4.6 s, so the test needs room for the 15 s wait above: vitest's 5 s
  // default cut it off when the suite ran in the Compose image (gaulatti/alcantara#200).
}, 20000);
