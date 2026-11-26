import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#819: while a channel fades to a take preset, that channel's preset buttons are disabled, so a
// second take cannot supersede the running fade from the console.

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

const FADE_MS = 2200;
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const button = (side: "A" | "B") => screen.getByRole("button", { name: `Take Music preset ${side}` });

it("keeps the channel busy through its fade, ignores a second take, and frees it when the fade lands", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  open();
  fireEvent.change(await screen.findByLabelText("Preset fade in milliseconds"), { target: { value: String(FADE_MS) } });
  fireEvent.click(await screen.findByRole("button", { name: "Take Music preset A" }));
  expect(button("A")).toBeDisabled();
  expect(button("B")).toBeDisabled();

  // A second take on the same channel while the first fades does nothing: it keeps heading for preset A.
  await advance(FADE_MS / 4);
  fireEvent.click(button("B"));
  expect(button("B")).toBeDisabled();
  await advance(FADE_MS / 4);
  expect(button("A")).toBeDisabled();

  await advance(FADE_MS);
  expect(level()).toBe("-15.0");
  expect(button("A")).toBeEnabled();
  expect(button("B")).toBeEnabled();
});
