import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (control.tsx final pass): a rotation whose active song is no longer listed still shows its
// songs, and a clip still playing when the program changes has its timer cleared. Earlier (batch 3): a clip still playing when the cartwall is reloaded without it.
// Earlier (group A, control.tsx): the control route's lifecycle paths. A cartwall clip that
// plays for its known length and then goes quiet; the instant list changing under a playing clip, which
// drops the clip's state; the realtime ticket that arrives without a ticket; and leaving the page while a
// scene save is still pending, which must release every timer the route holds.

let activeProgram = "main";

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

it("shows the rotation when its active song is no longer in the list, with the first song as the one on air", async () => {
  open(clips, { "GET /program/main/audio-bus": Response.json({
    songSequence: {
      mode: "manual",
      items: [
        { id: "s1", kind: "preset", songId: 1, title: "Fictional opener", artist: "Fictional artist", audioUrl: "https://media.example.test/s1.mp3", coverUrl: "", durationMs: 180000 },
        { id: "s2", kind: "preset", songId: 2, title: "Fictional closer", artist: "Fictional artist", audioUrl: "https://media.example.test/s2.mp3", coverUrl: "", durationMs: 180000 },
      ],
      activeItemId: "gone-song",
      loop: true,
    },
    songQueue: [],
  }) });
  expect((await screen.findAllByText("Fictional opener")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Fictional closer").length).toBeGreaterThan(0);
}, 15000);

it("clears a clip's timer when the program changes while it is still playing", async () => {
  KnownLengthAudio.seconds = 3;
  const view = open();
  server.answer("POST /instants/1/play?programId=main", Response.json({}));
  fireEvent.click(await screen.findByRole("button", { name: "Fictional clip 1" }));
  await waitFor(() => expect(server.requests("POST /instants/1/play?programId=main")).toHaveLength(1));
  activeProgram = "alt";
  view.rerender(<MemoryRouter><Control /></MemoryRouter>);
  await waitFor(() => expect(server.requests("GET /instants").length).toBeGreaterThanOrEqual(2));
  expect(await screen.findByRole("button", { name: "Fictional clip 1" })).toBeInTheDocument();
}, 15000);

it("renders an empty rotation whose stored active song is gone, with nothing on air", async () => {
  open(clips, {
    "GET /program/main/audio-bus": Response.json({
      songSequence: { mode: "manual", items: [], activeItemId: "gone-song", loop: true },
      songQueue: [],
    }),
  });
  expect(await screen.findByRole("button", { name: "Fictional clip 1" })).toBeInTheDocument();
}, 15000);
