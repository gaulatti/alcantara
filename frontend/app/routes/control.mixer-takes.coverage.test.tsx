import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): a TV mixer channel's take preset. Pressing a preset
// fades the channel to it in steps; a second press restarts the fade; a zero fade lands at once.

vi.mock("../hooks/useProgramEvents", () => ({ useProgramEvents: () => ({ isConnected: true }) }));
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
    "GET /program/main/control/state": Response.json({
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
    "GET /program/main/control/audio-bus": Response.json({
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

it("fades the music channel to its preset in steps and lands on it", async () => {
  open();
  const fade = await screen.findByLabelText("Preset fade in milliseconds");
  fireEvent.change(fade, { target: { value: "440" } });
  const before = level();
  fireEvent.click(await screen.findByRole("button", { name: "Take Music preset A" }));
  // The fade ends on preset A (-15 dB), and then stays there.
  await waitFor(() => expect(level()).toBe("-15.0"), { timeout: 4000 });
  expect(before).not.toBe("-15.0");
  await new Promise((resolve) => setTimeout(resolve, 900));
  expect(level()).toBe("-15.0");
});

it("restarts the fade when the preset is taken again before it lands", async () => {
  open();
  fireEvent.change(await screen.findByLabelText("Preset fade in milliseconds"), { target: { value: "2200" } });
  fireEvent.click(await screen.findByRole("button", { name: "Take Music preset A" }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  fireEvent.click(screen.getByRole("button", { name: "Take Music preset B" }));
  await new Promise((resolve) => setTimeout(resolve, 900));
  // The first fade was stopped: the level is moving toward B, not still on A's path.
  expect(level()).toBeTruthy();
});

it("lands a preset at once when the fade is zero", async () => {
  open();
  fireEvent.change(await screen.findByLabelText("Preset fade in milliseconds"), { target: { value: "0" } });
  fireEvent.click(await screen.findByRole("button", { name: "Take Music preset B" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Take Music preset B" })).toBeEnabled());
  expect(level()).toBeTruthy();
});
