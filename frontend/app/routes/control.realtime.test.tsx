import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  controlServer,
  FakeSocket,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#194 group 2: the live program link. When the program's
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

it("opens the WebSocket with a realtime ticket while the event stream is down", async () => {
  const { socket } = await openLink();
  expect(server.requests("POST /auth/realtime-ticket")).toEqual([
    { programId: "main" },
  ]);
  expect(socket.url).toContain("programId=main");
  expect(socket.url).toContain("role=control");
  expect(socket.url).toContain("ticket=ticket-1");
  expect(screen.getByTitle("Live updates connected")).toBeInTheDocument();
});

it("leaves the WebSocket alone while the event stream is up", async () => {
  sse.state = "connected";
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  expect(server.requests("POST /auth/realtime-ticket")).toEqual([]);
  expect(FakeSocket.instances).toHaveLength(0);
  expect(screen.getByTitle("Live updates disconnected")).toBeInTheDocument();
});

const statusOf = (name: string) =>
  source(name).querySelector("span:last-child")?.textContent;

it("follows the show's scenes from state snapshots and scene changes", async () => {
  const { socket } = await openLink();
  const guest = scene(3, "Fictional guest");
  act(() =>
    socket.send({
      type: "program_state_snapshot",
      programId: "main",
      state: programState([headlines, guest]),
    }),
  );
  expect(
    await screen.findByRole("button", { name: /Fictional guest/ }),
  ).toBeInTheDocument();
  for (const type of ["scene_change", "program_scenes_changed"]) {
    act(() =>
      socket.send({
        type,
        programId: "main",
        state: programState([desk, headlines]),
      }),
    );
    await waitFor(() => expect(statusOf("Fictional desk")).toBe("Program"));
  }
});

it("reloads the show's media groups when they change", async () => {
  const { socket } = await openLink();
  const before = server.requests("GET /program/main/media-groups").length;
  act(() =>
    socket.send({
      type: "program_media_groups_changed",
      programId: "main",
      state: programState(),
    }),
  );
  await waitFor(() =>
    expect(server.requests("GET /program/main/media-groups").length).toBe(
      before + 1,
    ),
  );
});

it("shows a scene staged elsewhere, and a cleared Preview", async () => {
  const { socket } = await openLink();
  act(() =>
    socket.send({
      type: "scene_staged",
      programId: "main",
      stagedSceneId: 2,
      scene: desk,
    }),
  );
  await waitFor(() =>
    expect(source("Fictional desk")).toHaveAttribute("aria-pressed", "true"),
  );
  act(() =>
    socket.send({
      type: "scene_staged",
      programId: "main",
      stagedSceneId: "none",
    }),
  );
  await waitFor(() =>
    expect(source("Fictional desk")).toHaveAttribute("aria-pressed", "false"),
  );
});

it("marks fade to black from the link", async () => {
  const { socket } = await openLink();
  expect(
    screen.getByRole("button", { name: "Fade to black" }),
  ).toBeInTheDocument();
  act(() =>
    socket.send({
      type: "fade_to_black",
      state: programState(undefined, { fadeToBlack: true }),
    }),
  );
  expect(
    await screen.findByRole("button", { name: "RESTORE PROGRAM" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("renames a scene everywhere it is shown when it is updated", async () => {
  const { socket } = await openLink();
  act(() =>
    socket.send({
      type: "scene_update",
      programId: "main",
      scene: { ...headlines, name: "Fictional headlines, late" },
    }),
  );
  expect(
    (await screen.findAllByText("Fictional headlines, late")).length,
  ).toBeGreaterThan(0);
  // A scene the show does not hold is added to the catalog only.
  act(() =>
    socket.send({
      type: "scene_update",
      programId: "main",
      scene: scene(9, "Fictional archive"),
    }),
  );
  act(() =>
    socket.send({
      type: "scene_update",
      programId: "main",
      scene: { id: "bad" },
    }),
  );
  act(() => socket.send({ type: "scene_update", programId: "main" }));
  expect(
    screen.queryByRole("button", { name: /Fictional archive/ }),
  ).not.toBeInTheDocument();
});

it("clears Program when the show says so", async () => {
  const { socket } = await openLink();
  expect(statusOf("Fictional headlines")).toBe("Program");
  act(() => socket.send({ type: "scene_cleared", programId: "main" }));
  // Clearing Program leaves no source tagged Program (#251).
  expect(statusOf("Fictional headlines")).toBe("Stage");
});

it("ignores updates for another show, unreadable messages and stale versions", async () => {
  const { socket } = await openLink();
  for (const type of [
    "program_state_snapshot",
    "audio_bus_snapshot",
    "scene_staged",
    "scene_change",
    "scene_update",
    "scene_cleared",
    "audio_bus_update",
    "song_queue_update",
    "audio_meter_update",
    "song_playback_update",
    "song_off_air",
    "scene_instant_state",
    "scene_instant_take",
    "scene_instant_stop",
  ]) {
    act(() =>
      socket.send({
        type,
        programId: "other",
        stagedSceneId: 2,
        scene: desk,
        state: programState([desk]),
      }),
    );
  }
  act(() => socket.send("{not json"));
  act(() => socket.send("null"));
  act(() => socket.send({ type: "unknown_update" }));
  expect(statusOf("Fictional headlines")).toBe("Program");
  expect(source("Fictional desk")).toHaveAttribute("aria-pressed", "false");

  act(() =>
    socket.send({
      type: "program_state_snapshot",
      programId: "main",
      version: 5,
      state: programState([desk, headlines]),
    }),
  );
  await waitFor(() => expect(statusOf("Fictional desk")).toBe("Program"));
  // An older version of the same topic is dropped.
  act(() =>
    socket.send({
      type: "program_state_snapshot",
      programId: "main",
      version: 4,
      state: programState(),
    }),
  );
  expect(statusOf("Fictional desk")).toBe("Program");
});

it("retries the ticket after a refusal, a failure or a missing ticket", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  let answers = [
    () => new Response("down", { status: 503 }),
    () => Promise.reject(new TypeError("offline")),
  ];
  server.answer("POST /auth/realtime-ticket", () => {
    const next = answers.shift();
    return next ? next() : Response.json({ ticket: "ticket-2" });
  });
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() =>
    expect(server.requests("POST /auth/realtime-ticket")).toHaveLength(1),
  );
  await act(() => vi.advanceTimersByTimeAsync(1500));
  await waitFor(() =>
    expect(server.requests("POST /auth/realtime-ticket")).toHaveLength(2),
  );
  await act(() => vi.advanceTimersByTimeAsync(1500));
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  expect(FakeSocket.instances[0].url).toContain("ticket=ticket-2");
  answers = [];
});

it("does not connect when the ticket answer carries no ticket", async () => {
  server.answer("POST /auth/realtime-ticket", () =>
    Response.json({ ticket: "" }),
  );
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() =>
    expect(server.requests("POST /auth/realtime-ticket")).toHaveLength(1),
  );
  expect(FakeSocket.instances).toHaveLength(0);
});

it("reconnects after the link closes, and closes it on an error", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  const { socket } = await openLink();
  act(() => socket.emit("error"));
  expect(socket.closed).toBe(true);
  act(() => socket.emit("close"));
  expect(screen.getByTitle("Live updates disconnected")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1500));
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
  act(() => FakeSocket.instances[1].open());
  expect(screen.getByTitle("Live updates connected")).toBeInTheDocument();
});

it("closes the link when the console leaves, and ignores what it still delivers", async () => {
  const { view, socket } = await openLink();
  view.unmount();
  expect(socket.closed).toBe(true);
  socket.send({ type: "scene_cleared", programId: "main" });
});

it("leaves a link that is still connecting when the console leaves", async () => {
  render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  cleanup();
  expect(FakeSocket.instances[0].closed).toBe(false);
});

it("closes the link once the event stream is back", async () => {
  const { socket } = await openLink();
  act(() => sse.report!("connected"));
  expect(socket.closed).toBe(true);
  expect(screen.getByTitle("Live updates disconnected")).toBeInTheDocument();
});

it("tolerates a link that cannot be closed, and an old link closing late", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  const view = render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const first = FakeSocket.instances[0];
  first.close = () => {
    throw new Error("already closing");
  };
  act(() => first.emit("error"));
  act(() => first.emit("close"));
  await act(() => vi.advanceTimersByTimeAsync(1500));
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
  // The first link reports closing again after it was replaced.
  act(() => first.emit("close"));
  view.unmount();
  act(() => first.open());
});

it("closes a link that opens after the console left", async () => {
  const view = render(<Control />);
  await screen.findAllByText("Fictional headlines");
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0];
  view.unmount();
  act(() => socket.open());
  expect(socket.closed).toBe(true);
});

describe("while neither the event stream nor the link is up", () => {
  const stateReads = () => server.requests("GET /program/main/state").length;

  it("reads the show after a moment and then polls it, but not while the page is hidden", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      shouldAdvanceTime: true,
    });
    // No ticket, so no link ever opens.
    server.answer("POST /auth/realtime-ticket", () => Response.json({}));
    render(<Control />);
    await screen.findAllByText("Fictional headlines");
    const opening = stateReads();
    await act(() => vi.advanceTimersByTimeAsync(900));
    await waitFor(() => expect(stateReads()).toBe(opening + 1));
    expect(
      server.requests("GET /program/main/audio-bus").length,
    ).toBeGreaterThan(1);

    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(stateReads()).toBe(opening + 2));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(stateReads()).toBe(opening + 2);
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
    }
  });

  it("skips the first read when the link is already open", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      shouldAdvanceTime: true,
    });
    render(<Control />);
    await screen.findAllByText("Fictional headlines");
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    // Open on the wire, but its open event has not been handled yet.
    FakeSocket.instances[0].readyState = FakeSocket.OPEN;
    const opening = stateReads();
    await act(() => vi.advanceTimersByTimeAsync(900));
    expect(stateReads()).toBe(opening);
  });
});

it("applies updates that arrive while the show's state is still loading", async () => {
  server.answer(
    "GET /program/main/state",
    new Response("down", { status: 500 }),
  );
  render(<Control />);
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  for (const payload of [
    { type: "scene_update", programId: "main", scene: headlines },
    { type: "scene_staged", programId: "main", stagedSceneId: 1 },
    { type: "scene_cleared", programId: "main" },
  ])
    act(() => socket.send(payload));
  expect(screen.getByText("Loading main control surface…")).toBeVisible();
});

it("updates a staged scene the show does not list, and reads updates without a show id as another show's", async () => {
  const guest = scene(9, "Fictional guest");
  server.answer("GET /program/main/state", () =>
    Response.json(
      programState(undefined, { stagedSceneId: 9, stagedScene: guest }),
    ),
  );
  const { socket } = await openLink();
  act(() =>
    socket.send({
      type: "scene_update",
      programId: "main",
      scene: { ...guest, name: "Fictional guest, late" },
    }),
  );
  act(() =>
    socket.send({
      type: "scene_update",
      programId: "main",
      scene: { ...desk, name: "Fictional desk, late" },
    }),
  );
  expect(
    (await screen.findAllByText("Fictional desk, late")).length,
  ).toBeGreaterThan(0);

  for (const type of [
    "program_state_snapshot",
    "scene_staged",
    "scene_change",
    "scene_update",
    "scene_cleared",
  ])
    act(() =>
      socket.send({ type, stagedSceneId: 2, state: programState([desk]) }),
    );
  // A JSON array is read as an update without a topic, and ignored.
  act(() => socket.send("[1, 2]"));
  expect(statusOf("Fictional headlines")).toBe("Program");
});

it("leaves without error when an open link refuses to close", async () => {
  const { view, socket } = await openLink();
  socket.close = () => {
    throw new Error("already closing");
  };
  expect(() => view.unmount()).not.toThrow();
});
