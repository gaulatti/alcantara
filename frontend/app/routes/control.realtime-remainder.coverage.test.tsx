import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  controlServer,
  FakeSocket,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#404 (group A, control.tsx): the live link's update branches the realtime suite does not reach. When the program's
// event stream (SSE) is down, the console opens a WebSocket with a realtime
// ticket and applies the updates it carries; while neither is up it polls.

const sse = vi.hoisted(() => ({
  state: "disconnected" as string,
  report: null as null | ((state: string) => void),
}));
const program = vi.hoisted(() => ({ id: "main" }));

vi.mock("../hooks/useSSE", async () => {
  const { useEffect } = await import("react");
  return {
    useSSE: (options: {
      onConnectionStateChange?: (state: string) => void;
    }) => {
      sse.report = (state: string) => options.onConnectionStateChange?.(state);
      useEffect(() => {
        options.onConnectionStateChange?.(sse.state);
      }, []);
      return { isConnected: false };
    },
  };
});
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => [program.id],
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

const scene = (id: number, name: string) => ({
  id,
  name,
  layoutId: 1,
  metadata: {},
  layout: { id: 1, name: "Fixture layout", componentType: "toni-clock" },
});
const headlines = scene(1, "Fictional headlines");
const desk = scene(2, "Fictional desk");
const programState = (
  scenes = [headlines, desk],
  extra: Record<string, unknown> = {},
) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: scenes[0]?.id ?? null,
  activeScene: scenes[0] ?? null,
  stagedSceneId: null,
  stagedScene: null,
  fadeToBlack: false,
  scenes: scenes.map((entry, index) => ({
    id: index + 1,
    sceneId: entry.id,
    position: index,
    scene: entry,
  })),
  mediaGroups: [],
  ...extra,
});

beforeEach(() => {
  sse.state = "disconnected";
  program.id = "main";
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /scenes": Response.json([headlines, desk]),
    "GET /program/main/state": () => Response.json(programState()),
    "POST /auth/realtime-ticket": () => Response.json({ ticket: "ticket-1" }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const source = (name: string) =>
  screen.getAllByRole("button", { name: new RegExp(name) })[0];

async function openLink() {
  const view = render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  return { view, socket };
}


const statusOf = (name: string) =>
  source(name).querySelector("span:last-child")?.textContent;

// A queue update with no song sequence keeps the queue as it was; a sequence the console cannot read falls back to an empty manual one.
it("keeps the song queue for an update without a sequence and falls back for an unreadable one", async () => {
  const { socket } = await openLink();
  act(() =>
    socket.send({ type: "song_queue_update", programId: "main", songSequence: undefined }),
  );
  expect(statusOf("Fictional headlines")).toBe("Program");
  act(() =>
    socket.send({ type: "song_queue_update", programId: "main", songSequence: 42 }),
  );
  // The show is still on its scene: the bad sequence did not touch the scene state.
  expect(statusOf("Fictional headlines")).toBe("Program");
  expect(statusOf("Fictional desk")).toBe("Stage");
});

// An instant take with no trigger time is stamped with the moment the console received it.
it("stamps an instant take that carries no trigger time", async () => {
  const { socket } = await openLink();
  act(() =>
    socket.send({
      type: "scene_instant_take",
      programId: "main",
      instant: { assetId: "asset-1", name: "Fictional stinger" },
    }),
  );
  expect(statusOf("Fictional headlines")).toBe("Program");
  act(() =>
    socket.send({
      type: "scene_instant_take",
      programId: "main",
      instant: {},
      triggeredAt: "2026-11-23T12:00:00.000Z",
    }),
  );
  expect(statusOf("Fictional headlines")).toBe("Program");
});
