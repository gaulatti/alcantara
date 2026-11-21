import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#194 group 2: on-air actions. Fade to black on the TV deck,
// and instants on the radio cartwall: a click or its keyboard shortcut plays
// one, it shows as playing for the clip's length, and Stop all ends them.

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

import Control from "./control";

let server: ControlServer;

// Clip lengths by URL; an unknown URL fails to load, as a broken clip does.
const clipSeconds: Record<string, number> = {
  "https://media.example.test/bell.mp3": 2,
  "https://media.example.test/silent.mp3": 0,
};
class FakeAudio {
  preload = "";
  src = "";
  duration = Number.NaN;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  load() {
    const url = this.src;
    queueMicrotask(() => {
      if (url in clipSeconds) {
        this.duration = clipSeconds[url];
        this.onloadedmetadata?.();
      } else this.onerror?.();
    });
  }
}

const instants = [
  {
    id: 1,
    name: "Fictional bell",
    audioUrl: "https://media.example.test/bell.mp3",
    volume: 1,
    enabled: true,
    position: 0,
  },
  {
    id: 2,
    name: "Fictional sting",
    audioUrl: "https://media.example.test/broken.mp3",
    volume: 1,
    enabled: true,
    position: 1,
  },
  {
    id: 3,
    name: "Fictional silence",
    audioUrl: "https://media.example.test/silent.mp3",
    volume: 1,
    enabled: false,
    position: 2,
  },
];

function state(type: "radio" | "tv", fadeToBlack = false) {
  return {
    id: 1,
    programId: "main",
    type,
    activeSceneId: null,
    fadeToBlack,
    scenes: [],
    mediaGroups: [],
  };
}

function open(type: "radio" | "tv") {
  server = controlServer({
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json(instants),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json(state(type)),
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
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("fades the TV program to black after the operator confirms, and restores it", async () => {
  open("tv");
  server.answer(
    "PUT /program/main/fade-to-black",
    Response.json(state("tv", true)),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "ARM FADE TO BLACK" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "CONFIRM FADE TO BLACK" }),
  );
  expect(
    await screen.findByRole("button", { name: "RESTORE PROGRAM" }),
  ).toBeVisible();
  expect(server.requests("PUT /program/main/fade-to-black")).toEqual([
    { active: true },
  ]);

  server.answer(
    "PUT /program/main/fade-to-black",
    Response.json(state("tv", false)),
  );
  fireEvent.click(screen.getByRole("button", { name: "RESTORE PROGRAM" }));
  expect(
    await screen.findByRole("button", { name: "ARM FADE TO BLACK" }),
  ).toBeVisible();
  expect(server.requests("PUT /program/main/fade-to-black")).toEqual([
    { active: true },
    { active: false },
  ]);
});

it("keeps the program as it was when fade to black is refused or answered with nothing usable", async () => {
  open("tv");
  server.answer(
    "PUT /program/main/fade-to-black",
    new Response("no", { status: 503 }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "ARM FADE TO BLACK" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "CONFIRM FADE TO BLACK" }),
  );
  await waitFor(() =>
    expect(server.requests("PUT /program/main/fade-to-black")).toHaveLength(1),
  );
  server.answer("PUT /program/main/fade-to-black", Response.json(null));
  fireEvent.click(
    await screen.findByRole("button", { name: "ARM FADE TO BLACK" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "CONFIRM FADE TO BLACK" }),
  );
  await waitFor(() =>
    expect(server.requests("PUT /program/main/fade-to-black")).toHaveLength(2),
  );
  expect(
    screen.queryByRole("button", { name: "RESTORE PROGRAM" }),
  ).toBeNull();
});

it("plays an instant from the cartwall, shows it playing for the clip's length, and plays it again", async () => {
  open("radio");
  server.answer(
    "POST /instants/1/play?programId=main",
    Response.json({}),
  );
  const bell = await screen.findByRole("button", { name: "Fictional bell" });
  // Wait until the clip's length is known.
  await act(async () => {
    await Promise.resolve();
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.click(bell);
  expect(
    await screen.findByRole("button", { name: "Fictional bell · playing" }),
  ).toBeVisible();
  // Played again while playing: one playing state, restarted.
  fireEvent.click(
    screen.getByRole("button", { name: "Fictional bell · playing" }),
  );
  await waitFor(() =>
    expect(
      server.requests("POST /instants/1/play?programId=main"),
    ).toHaveLength(2),
  );
  await act(async () => {
    vi.advanceTimersByTime(2100);
  });
  expect(
    await screen.findByRole("button", { name: "Fictional bell" }),
  ).toBeVisible();
});

it("plays an instant of unknown length until Stop all, and plays one from its keyboard shortcut", async () => {
  open("radio");
  server.answer("POST /instants/2/play?programId=main", Response.json({}));
  server.answer("POST /instants/1/play?programId=main", Response.json({}));
  server.answer("POST /instants/stop-all?programId=main", Response.json({}));
  fireEvent.click(await screen.findByRole("button", { name: "Fictional sting" }));
  expect(
    await screen.findByRole("button", { name: "Fictional sting · playing" }),
  ).toBeVisible();
  // Ctrl+Q plays the first instant.
  fireEvent.keyDown(window, { key: "q", code: "KeyQ", ctrlKey: true });
  await waitFor(() =>
    expect(
      server.requests("POST /instants/1/play?programId=main"),
    ).toHaveLength(1),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /· playing$/ }),
    ).toBeNull(),
  );
  expect(
    server.requests("POST /instants/stop-all?programId=main"),
  ).toHaveLength(1);
});

it("ignores shortcuts for a disabled or missing instant, and keeps playing states when Stop all is refused", async () => {
  open("radio");
  server.answer("POST /instants/2/play?programId=main", Response.json({}));
  server.answer(
    "POST /instants/stop-all?programId=main",
    new Response("no", { status: 500 }),
  );
  server.answer(
    "POST /instants/1/play?programId=main",
    new Response("no", { status: 500 }),
  );
  await screen.findByRole("button", { name: "Fictional sting" });
  // Ctrl+E is the third (disabled) instant, Ctrl+R names none, Ctrl+1 is
  // not armed, a plain Q is not a shortcut, Ctrl+Shift+Q and Ctrl+5 are not
  // instant keys, and nothing typed in a field is a shortcut.
  fireEvent.keyDown(window, { key: "e", code: "KeyE", ctrlKey: true });
  fireEvent.keyDown(window, { key: "r", code: "KeyR", ctrlKey: true });
  fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true });
  fireEvent.keyDown(window, { key: "q", code: "KeyQ" });
  fireEvent.keyDown(window, {
    key: "Q",
    code: "KeyQ",
    ctrlKey: true,
    shiftKey: true,
  });
  fireEvent.keyDown(window, { key: "5", code: "Digit5", ctrlKey: true });
  // Armed, but this console has no scene 1 to prepare.
  fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
  fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Search cartwall" }), {
    key: "q",
    code: "KeyQ",
    ctrlKey: true,
  });
  // A refused play shows nothing as playing.
  fireEvent.click(screen.getByRole("button", { name: "Fictional bell" }));
  await waitFor(() =>
    expect(
      server.requests("POST /instants/1/play?programId=main"),
    ).toHaveLength(1),
  );
  expect(
    screen.queryByRole("button", { name: "Fictional bell · playing" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fictional sting" }));
  await screen.findByRole("button", { name: "Fictional sting · playing" });
  fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
  await waitFor(() =>
    expect(
      server.requests("POST /instants/stop-all?programId=main"),
    ).toHaveLength(1),
  );
  expect(
    screen.getByRole("button", { name: "Fictional sting · playing" }),
  ).toBeVisible();
  expect(
    server.calls.filter((call) => /instants\/3\/play/.test(call.path)),
  ).toEqual([]);
  expect(server.requests("POST /program/main/stage")).toEqual([]);
});

it("prepares a scene from Ctrl+S then its number, and only while armed", async () => {
  const scene = (id: number, name: string) => ({
    id,
    name,
    layoutId: 1,
    metadata: {},
    layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
  });
  const first = scene(1, "Fictional headlines");
  const tenth = scene(10, "Fictional tenth");
  const assigned = Array.from({ length: 10 }, (_, index) => {
    const entry = index === 0 ? first : index === 9 ? tenth : scene(index + 1, `Fictional ${index + 1}`);
    return { id: index + 1, sceneId: entry.id, position: index, scene: entry };
  });
  server = controlServer({
    "GET /scenes": Response.json(assigned.map((entry) => entry.scene)),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json({ ...state("tv"), scenes: assigned }),
    "GET /program/main/media-groups": Response.json([]),
    "POST /program/main/stage": Response.json({ stagedSceneId: 1, stagedScene: first }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  await screen.findAllByRole("button", { name: /Fictional headlines/ });
  fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
  fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true });
  await waitFor(() =>
    expect(server.requests("POST /program/main/stage")).toHaveLength(1),
  );
  // 0 is the tenth scene.
  server.answer("POST /program/main/stage", Response.json({ stagedSceneId: 10, stagedScene: tenth }));
  fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
  fireEvent.keyDown(window, { key: "0", code: "Digit0", ctrlKey: true });
  await waitFor(() =>
    expect(server.requests("POST /program/main/stage")).toHaveLength(2),
  );
  expect(server.requests("POST /program/main/stage")).toEqual([
    { sceneId: 1 },
    { sceneId: 10 },
  ]);
  // Used once: a second number without Ctrl+S prepares nothing.
  fireEvent.keyDown(window, { key: "2", code: "Digit2", ctrlKey: true });
  await act(async () => {
    await Promise.resolve();
  });
  expect(server.requests("POST /program/main/stage")).toHaveLength(2);
});
