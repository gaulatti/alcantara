import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx remainder, mixer takes): a fade shorter than one step lands in one step,
// with no timer left running.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: true }) }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
const prefs = vi.hoisted(() => ({ workspace: "audio" as string }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
  return {
    ...actual,
    useConsolePreferences: () => ({
      profile: { ...actual.defaultConsoleProfile("desktop"), workspace: prefs.workspace },
      updateProfile: vi.fn(),
    }),
  };
});

import Control from "./control";

let server: ControlServer;

function open() {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json({ data: [] }),
    "GET /program/main/state": Response.json({
      id: 1,
      programId: "main",
      type: "tv",
      activeSceneId: null,
      stagedSceneId: null,
      stagedScene: null,
      fadeToBlack: false,
      scenes: [],
      mediaGroups: [],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": Response.json({
      mixerSettings: { mainMasterVolume: 0.8, songMasterVolume: 0.6 },
      songSequence: { mode: "manual", items: [], activeItemId: null, intervalMs: 4000, loop: true, startedAt: 1 },
      songQueue: [],
    }),
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const level = () => (screen.getByLabelText("Music level in dB") as HTMLInputElement).value;

it("lands a preset in a single step when the fade is shorter than one step", async () => {
  open();
  fireEvent.change(await screen.findByLabelText("Preset fade in milliseconds"), { target: { value: "100" } });
  fireEvent.click(await screen.findByRole("button", { name: "Take Music preset A" }));
  await waitFor(() => expect(level()).toBe("-15.0"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(level()).toBe("-15.0");
});
