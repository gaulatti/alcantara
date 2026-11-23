import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#195, groups 8 to 10 (what is left): the answers and events
// the on-air page has to tolerate without losing what is on air: an event with
// no program id, a scene clip answer that is not an object, a stinger list that
// is not a list, a scene update for the staged scene, and an answer that comes
// back after the page has gone.

const sse = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
}));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage: (data: unknown) => void }) => {
    sse.onMessage = options.onMessage;
    return { isConnected: false };
  },
}));

const bus = vi.hoisted(() => ({
  ensure: vi.fn(),
  stop: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("../utils/programAudioBus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/programAudioBus")>()),
  ensureProgramAudioBusTrack: bus.ensure,
  stopProgramAudioBus: bus.stop,
  getProgramAudioBusSnapshot: bus.snapshot,
}));

import ProgramRoute from "./program";

const scene = (id: number, text: string) => ({
  id,
  name: `Fictional scene ${id}`,
  layoutId: 1,
  metadata: JSON.stringify({ "full-screen": { text } }),
  layout: { id: 1, name: "Full screen", componentType: "full-screen" },
});
const programState = (
  activeScene: ReturnType<typeof scene> | null,
  extra: Record<string, unknown> = {},
) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: activeScene?.id ?? null,
  activeScene,
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
  ...extra,
});

// A minimal stand-in for the audio element: it records what was asked to play.
class PlayedAudio {
  static played: string[] = [];
  paused = true;
  ended = false;
  volume = 1;
  muted = false;
  loop = false;
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly src: string) {
    PlayedAudio.played.push(src);
  }
  addEventListener() {}
  removeEventListener() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

let server: ControlServer;
beforeEach(() => {
  PlayedAudio.played = [];
  bus.ensure.mockReset();
  bus.stop.mockReset();
  bus.snapshot.mockReset().mockReturnValue({ track: null, isPlaying: false });
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  stubConsoleBrowser();
  vi.stubGlobal("Audio", PlayedAudio);
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      addEventListener() {}
      close() {}
      send() {}
    },
  );
  server = controlServer({
    "GET /program/main/audio-bus": () =>
      Response.json({ songSequence: null, songQueue: [] }),
    "GET /program/main/state": () => Response.json(programState(null)),
    "GET /program/broadcast-settings": () => Response.json({}),
    "GET /program/main/scene-instant": () => Response.json({ isPlaying: false }),
    "GET /program/main/stingers": () => Response.json([]),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let view: ReturnType<typeof render>;
const open = (search = "") => {
  view = render(
    <MemoryRouter initialEntries={[`/program/main${search}`]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
};
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const emit = (data: unknown) => act(() => sse.onMessage?.(data));
const snapshot = (
  activeScene: ReturnType<typeof scene> | null,
  extra: Record<string, unknown> = {},
) => ({
  type: "program_state_snapshot",
  state: programState(activeScene, extra),
});
const loggedLines = () =>
  vi.mocked(console.error).mock.calls.map((call) => call.join(" "));
const stingerVideos = () =>
  [...document.body.querySelectorAll("video")].map((video) =>
    video.getAttribute("src"),
  );

describe("events the page must not choke on", () => {
  it("ignores a list where an event is expected", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    await emit([snapshot(scene(8, "Beta"))]);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("keeps showing no scene when a scene is cleared before any state arrived", async () => {
    server.answer("GET /program/main/state", new Response("", { status: 503 }));
    open();
    await advance(10);
    await emit({ type: "scene_cleared" });
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();
  });

  it("applies a scene update to the staged scene too, and none when nothing is staged", async () => {
    open("?confidence=preview");
    await advance(10);
    await emit(snapshot(scene(7, "Alpha"), { stagedScene: scene(8, "Staged") }));
    expect(screen.getByText("Staged")).toBeInTheDocument();
    await emit({ type: "scene_update", scene: scene(8, "Staged, edited") });
    expect(screen.getByText("Staged, edited")).toBeInTheDocument();

    await emit(snapshot(scene(7, "Alpha"), { stagedScene: null }));
    await emit({ type: "scene_update", scene: scene(8, "Nobody's scene") });
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();
  });

  it("stops what is playing for a stop event that names no program", async () => {
    open();
    await advance(10);
    await emit({ type: "instant_stop_all" });
    await emit({ type: "scene_instant_stop" });
    await emit({ type: "scene_instant_state" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("plays an instant or a scene clip that names no program, and ignores a clip without a sound", async () => {
    open();
    await advance(10);
    await emit({
      type: "instant_play",
      instant: { id: 1, name: "Fictional jingle", audioUrl: "/jingle.mp3" },
    });
    expect(PlayedAudio.played).toContain("/jingle.mp3");
    await emit({
      type: "scene_instant_take",
      sceneId: 7,
      instant: { id: 2, name: "Fictional clip", audioUrl: "/clip.mp3" },
      triggeredAt: "2030-01-01T00:00:00Z",
    });
    expect(PlayedAudio.played).toContain("/clip.mp3");

    PlayedAudio.played = [];
    await emit({
      type: "scene_instant_take",
      programId: "main",
      sceneId: 7,
      instant: { id: 3, name: "Fictional silent clip" },
      triggeredAt: "2030-01-01T00:00:01Z",
    });
    expect(PlayedAudio.played).toEqual([]);
  });
});

describe("answers the page must not take as truth", () => {
  it("takes a scene clip answer that is not an object as nothing playing", async () => {
    server.answer("GET /program/main/scene-instant", () => Response.json(null));
    open();
    await advance(10);
    expect(server.requests("GET /program/main/scene-instant")).toHaveLength(1);
    server.answer("GET /program/main/scene-instant", () =>
      Response.json([{ isPlaying: true }]),
    );
    await advance(5000);
    expect(
      server.requests("GET /program/main/scene-instant").length,
    ).toBeGreaterThan(1);
    expect(PlayedAudio.played).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps the stingers it has when the answer is not a list", async () => {
    server.answer("GET /program/main/stingers", () => Response.json({ no: "list" }));
    open();
    await advance(1000);
    expect(
      loggedLines().some(
        (line) =>
          line.includes("[program]") && line.includes("keeping the last good value"),
      ),
    ).toBe(true);
    expect(stingerVideos()).toEqual([]);
  });

  it("preloads a stinger that arrives without its details as an empty one", async () => {
    open();
    await advance(10);
    await emit({
      type: "program_stingers_changed",
      programId: "main",
      state: {
        stingers: [
          { stingerId: 1 },
          {
            stingerId: 2,
            stinger: { name: "Fictional", videoUrl: "/s.mp4", cutPointMs: 500 },
          },
        ],
      },
    });
    expect(stingerVideos().sort()).toEqual(["", "/s.mp4"].sort());
  });

  it("drops a slideshow answer that comes back after the page has gone", async () => {
    let answerGroup!: (value: Response) => void;
    let answerLabel!: (value: Response) => void;
    server.answer(
      "GET /media-groups/4",
      () => new Promise<Response>((resolve) => (answerGroup = resolve)) as never,
    );
    server.answer(
      "GET /media-labels/label-a/images",
      () => new Promise<Response>((resolve) => (answerLabel = resolve)) as never,
    );
    const slideshow = { mediaGroupId: 4, labelId: "label-a" };
    open();
    await advance(10);
    await emit({
      type: "program_state_snapshot",
      state: programState({
        ...scene(7, "x"),
        metadata: JSON.stringify({ slideshow }),
        layout: { id: 1, name: "Photos", componentType: "slideshow" },
      }),
    });
    await advance(10);
    expect(server.requests("GET /media-groups/4").length).toBeGreaterThan(0);
    expect(
      server.requests("GET /media-labels/label-a/images").length,
    ).toBeGreaterThan(0);

    view.unmount();
    await act(async () => {
      answerGroup(Response.json({ id: 4, items: [] }));
      answerLabel(Response.json({ id: "label-a", images: [] }));
    });
    await advance(10);
    expect(console.error).not.toHaveBeenCalled();
  });
});
