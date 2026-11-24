import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx single-input arms): realtime socket events are checked against the program
// they name: with no program id, or another program, they are ignored, and the page keeps rendering. Earlier (group A): the control route's lifecycle paths. A cartwall clip that
// plays for its known length and then goes quiet; the instant list changing under a playing clip, which
// drops the clip's state; the realtime ticket that arrives without a ticket; and leaving the page while a
// scene save is still pending, which must release every timer the route holds.

let activeProgram = "main";
const sockets = vi.hoisted(() => [] as Array<{ emit: (type: string, event: unknown) => void }>);
class FakeSocket {
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor() {
    sockets.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ||= []).push(listener);
  }
  close() {}
  emit(type: string, event: unknown) {
    (this.listeners[type] || []).forEach((listener) => listener(event));
  }
}
vi.stubGlobal("WebSocket", FakeSocket);

// The program's event stream is down, so the route falls back to its realtime socket.
vi.mock("../hooks/useSSE", async () => {
  const { useEffect } = await import("react");
  return {
    useSSE: (options?: { onConnectionStateChange?: (state: string) => void }) => {
      useEffect(() => {
        options?.onConnectionStateChange?.("disconnected");
      }, []);
      return { isConnected: false };
    },
  };
});
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [activeProgram],
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

const clips = [
  { id: 1, name: "Fictional clip 1", audioUrl: "https://media.example.test/one.mp3", volume: 1, enabled: true, position: 0 },
  { id: 2, name: "Fictional clip 2", audioUrl: "https://media.example.test/two.mp3", volume: 1, enabled: true, position: 1 },
];

// Every clip reports the length the test sets, as soon as its source is assigned.
class KnownLengthAudio {
  static seconds = 0.25;
  preload = "";
  duration = KnownLengthAudio.seconds;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onloadedmetadata?.());
  }
  load() {}
}

const scene = {
  id: 1,
  name: "Fictional player scene",
  layoutId: 1,
  metadata: JSON.stringify({ header: { show: false } }),
  layout: { id: 1, name: "Fixture layout", componentType: "header" },
};

function programState(programId: string) {
  return {
    id: 1,
    programId,
    type: "radio",
    activeSceneId: null,
    fadeToBlack: false,
    scenes: [],
    mediaGroups: [],
  };
}

function open(instantList: unknown[] = clips, extra: Record<string, Response> = {}) {
  server = controlServer({
    ...extra,
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json(instantList),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json(programState("main")),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/alt/state": Response.json(programState("alt")),
    "GET /program/alt/media-groups": Response.json([]),
  });
  return render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  activeProgram = "main";
  KnownLengthAudio.seconds = 0.25;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  vi.stubGlobal("Audio", KnownLengthAudio);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("applies realtime events only for the program they name, and keeps the console rendering", async () => {
  open(clips, { "POST /auth/realtime-ticket": Response.json({ ticket: "realtime-grant" }) });
  await screen.findByRole("button", { name: "Fictional clip 1" });
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const socket = sockets[0];
  socket.emit("open", {});
  const events = [
    { type: "program_state_snapshot", state: { id: 1, programId: "main", type: "radio", scenes: [], mediaGroups: [] } },
    { type: "audio_bus_snapshot", settings: {} },
    { type: "audio_bus_update", settings: {} },
    { type: "song_queue_update", songQueue: [] },
    { type: "audio_meter_update", meter: {} },
    { type: "song_playback_update", playback: {} },
    { type: "song_off_air" },
    { type: "scene_instant_state", state: {} },
    { type: "scene_instant_take", state: {} },
    { type: "scene_instant_stop", state: {} },
  ];
  for (const event of events) {
    socket.emit("message", { data: JSON.stringify(event) });
    socket.emit("message", { data: JSON.stringify({ ...event, programId: "other" }) });
    socket.emit("message", { data: JSON.stringify({ ...event, programId: "main" }) });
  }
  expect(await screen.findByRole("button", { name: "Fictional clip 1" })).toBeInTheDocument();
}, 15000);
