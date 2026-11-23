import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): the control route's lifecycle paths. A cartwall clip that
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

it("lets a clip with a known length go quiet once it has played through", async () => {
  open();
  server.answer("POST /instants/1/play?programId=main", Response.json({}));
  fireEvent.click(await screen.findByRole("button", { name: "Fictional clip 1" }));
  await waitFor(() => expect(server.requests("POST /instants/1/play?programId=main")).toHaveLength(1));
  // The clip's length is a quarter of a second; once it has run out, the pad is no longer playing.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(server.requests("POST /instants/1/play?programId=main")).toHaveLength(1);
});

it("drops a playing clip's state when the program's instant list no longer holds it", async () => {
  KnownLengthAudio.seconds = 3;
  const view = open();
  await screen.findByRole("button", { name: "Fictional clip 1" });
  await waitFor(() => expect(KnownLengthAudio.prototype).toBeDefined());
  // Switching program reloads the instant list, which now lacks clip 1.
  server.answer("GET /instants", Response.json([clips[1]]));
  activeProgram = "alt";
  view.rerender(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  await waitFor(() => expect(server.requests("GET /instants").length).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Fictional clip 1" })).toBeNull());
  expect(await screen.findByRole("button", { name: "Fictional clip 2" })).toBeInTheDocument();
});

it("does not open a realtime socket when the ticket response carries no ticket", async () => {
  open(clips, { "POST /auth/realtime-ticket": Response.json({}) });
  await waitFor(() => expect(server.requests("POST /auth/realtime-ticket").length).toBeGreaterThan(0));
});

it("releases a pending scene save's timers when the page is left", async () => {
  server = controlServer({
    "GET /scenes": Response.json([scene]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json({
      ...programState("main"),
      type: "tv",
      stagedSceneId: 1,
      stagedScene: scene,
      scenes: [{ id: 1, sceneId: 1, position: 0, scene }],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({ data: [] }),
    "PUT /scenes/1": new Response("down", { status: 500 }),
  });
  const view = render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  // The failed save leaves a retry scheduled; leaving the page must cancel it.
  await waitFor(() => expect(server.requests("PUT /scenes/1").length).toBeGreaterThan(0));
  view.unmount();
  const saves = server.requests("PUT /scenes/1").length;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(server.requests("PUT /scenes/1").length).toBe(saves);
});

it("cancels a scene edit that is still waiting to be flushed when the page is left at once", async () => {
  server = controlServer({
    "GET /scenes": Response.json([scene]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
    "GET /program/main/state": Response.json({
      ...programState("main"),
      type: "tv",
      stagedSceneId: 1,
      stagedScene: scene,
      scenes: [{ id: 1, sceneId: 1, position: 0, scene }],
    }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /media-assets?mediaType=AUDIO&capability=BACKGROUND&limit=200": Response.json({ data: [] }),
    "PUT /scenes/1": Response.json(scene),
  });
  const view = render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Show component" }));
  // Leave straight after the edit: whatever was sent before leaving is all that is sent.
  view.unmount();
  const sent = server.requests("PUT /scenes/1").length;
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(server.requests("PUT /scenes/1")).toHaveLength(sent);
});
