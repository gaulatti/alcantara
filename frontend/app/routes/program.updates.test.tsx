import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";
import { SCENE_TRANSITIONS } from "../utils/sceneTransitions";

// gaulatti/alcantara#195, groups 6 and 7: which updates the on-air page applies
// and which it ignores (older versions, another program, a malformed event),
// how a scene change reaches the picture (cut, animated, stinger), what a
// reload does, and how the program's stingers are kept. The assertions are what
// the viewer sees (the scene text, the fade overlay) and what is asked of the
// song bus, the stinger videos and the backend.

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
const snapshot = (
  activeScene: ReturnType<typeof scene> | null,
  extra: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) => ({
  type: "program_state_snapshot",
  state: programState(activeScene, state),
  ...extra,
});

let server: ControlServer;
beforeEach(() => {
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

const open = (search = "") =>
  render(
    <MemoryRouter initialEntries={[`/program/main${search}`]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const emit = (data: unknown) => act(() => sse.onMessage?.(data));
const fadeOverlay = (container: HTMLElement) =>
  container.querySelector("[data-fade-to-black]")?.getAttribute(
    "data-fade-to-black",
  );
const loggedLines = (spy: "error" | "warn") =>
  vi.mocked(console[spy]).mock.calls.map((call) => call.join(" "));
const stingerVideos = () =>
  [...document.body.querySelectorAll("video")].map((video) =>
    video.getAttribute("src"),
  );

describe("which updates are applied", () => {
  it("shows the scene of a state snapshot and ignores a snapshot without a state", async () => {
    open();
    await advance(10);
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();

    await emit({ type: "program_state_snapshot", state: "not a state" });
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();

    await emit(snapshot(scene(7, "Alpha")));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("ignores anything that is not an object, and an event type it does not know", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    for (const noise of [null, undefined, "text", 5]) await emit(noise);
    await emit({ type: "something_from_the_future", version: 99 });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("ignores a state that is not newer than the last one applied, and applies one that is", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha"), { version: 5 }));
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await emit(snapshot(scene(8, "Beta"), { version: 5 }));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await emit(snapshot(scene(8, "Beta"), { version: 4 }));
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await emit(snapshot(scene(8, "Beta"), { version: 6 }));
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("reads the version from the state itself, and applies an update that carries none", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha"), {}, { version: 3 }));
    await emit(snapshot(scene(8, "Beta"), {}, { version: 3 }));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await emit(snapshot(scene(8, "Beta")));
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("does not let a later poll answer replace a newer state with an older one", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha"), { version: 5 }));
    server.answer("GET /program/main/state", () =>
      Response.json(programState(scene(8, "Beta"), { version: 4 })),
    );
    await advance(5000);
    expect(server.requests("GET /program/main/state").length).toBeGreaterThan(0);
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    server.answer("GET /program/main/state", () =>
      Response.json(programState(scene(8, "Beta"), { version: 9 })),
    );
    await advance(5000);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("shows the state the backend answers on the first reads when no event has come", async () => {
    server.answer("GET /program/main/state", () =>
      Response.json(programState(scene(7, "Fictional first read"))),
    );
    open();
    await advance(1000);
    expect(screen.getByText("Fictional first read")).toBeInTheDocument();
  });

  it("fades to black and back from the state an event carries", async () => {
    const view = open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    expect(fadeOverlay(view.container)).toBe("inactive");
    await emit({
      type: "fade_to_black",
      state: programState(scene(7, "Alpha"), { fadeToBlack: true }),
    });
    expect(fadeOverlay(view.container)).toBe("active");
    await emit({ type: "fade_to_black", state: null });
    expect(fadeOverlay(view.container)).toBe("active");
    await emit({
      type: "fade_to_black",
      state: programState(scene(7, "Alpha"), { fadeToBlack: false }),
    });
    expect(fadeOverlay(view.container)).toBe("inactive");
  });

  it("replaces the scene on air only when the updated scene is the one on air", async () => {
    open();
    await advance(10);
    await emit({ type: "scene_update", scene: scene(7, "Before any state") });
    await emit(snapshot(scene(7, "Alpha")));

    await emit({ type: "scene_update", scene: scene(7, "Alpha, edited") });
    expect(screen.getByText("Alpha, edited")).toBeInTheDocument();
    await emit({ type: "scene_update", scene: scene(9, "Another scene") });
    expect(screen.getByText("Alpha, edited")).toBeInTheDocument();
    await emit({ type: "scene_update" });
    expect(screen.getByText("Alpha, edited")).toBeInTheDocument();
  });

  it("clears the scene on air, even in the middle of a transition", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    await emit({ type: "scene_cleared" });
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();
    await emit({ type: "scene_cleared" });
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();
  });

  it("keeps the staged scene for the preview monitor, for this program only", async () => {
    open("?confidence=preview");
    await advance(10);
    await emit({
      type: "scene_staged",
      stagedSceneId: 8,
      scene: scene(8, "Beta, before any state"),
    });
    await emit(snapshot(scene(7, "Alpha")));
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();

    await emit({
      type: "scene_staged",
      programId: "other",
      stagedSceneId: 9,
      scene: scene(9, "Gamma, for another program"),
    });
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();

    await emit({
      type: "scene_staged",
      programId: "main",
      stagedSceneId: 8,
      scene: scene(8, "Beta, staged"),
    });
    expect(screen.getByText("Beta, staged")).toBeInTheDocument();

    await emit({ type: "scene_staged", stagedSceneId: "x", scene: null });
    expect(screen.getByText("No Active Scene")).toBeInTheDocument();
  });

  it("shows the program monitor's fade to black from the state", async () => {
    const view = open("?confidence=program");
    await advance(10);
    await emit(
      snapshot(scene(7, "Alpha"), {}, { fadeToBlack: true }),
    );
    expect(
      view.container
        .querySelector("[data-confidence-fade-to-black]")
        ?.getAttribute("data-confidence-fade-to-black"),
    ).toBe("active");
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });
});

describe("scene changes", () => {
  const sceneChange = (
    to: ReturnType<typeof scene>,
    transitionId?: string,
  ) => ({
    type: "scene_change",
    transitionId,
    state: programState(to),
  });
  const transition = (id: string) => {
    const preset = SCENE_TRANSITIONS.find((entry) => entry.id === id);
    if (!preset) throw new Error(`no transition ${id}`);
    return preset;
  };

  it("cuts straight to the new scene when no transition is named", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    await emit(sceneChange(scene(8, "Beta")));
    expect(screen.getByText("Beta")).toBeInTheDocument();
    await emit(sceneChange(scene(9, "Gamma"), "no-such-transition"));
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("holds the old scene until the transition's cut point, then shows the new one", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    const preset = transition("crescendo-prism");
    await emit(sceneChange(scene(8, "Beta"), preset.id));
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await advance(preset.cutPointMs - 1);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await advance(1);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    await advance(preset.durationMs);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("does not animate to the scene that is already on air, or to a first scene", async () => {
    open();
    await advance(10);
    const preset = transition("crescendo-prism");
    await emit(sceneChange(scene(7, "Alpha"), preset.id));
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await emit(sceneChange(scene(7, "Alpha, again"), preset.id));
    expect(screen.getByText("Alpha, again")).toBeInTheDocument();
  });

  it("lets a newer scene change take over from one still in transition", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    const preset = transition("crescendo-prism");
    await emit(sceneChange(scene(8, "Beta"), preset.id));
    await advance(preset.cutPointMs / 2);
    await emit(sceneChange(scene(9, "Gamma"), "cut"));
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    await advance(preset.durationMs);
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("cuts at the first stinger's cut point when the transition is a stinger", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    await emit({
      type: "program_stingers_changed",
      state: {
        stingers: [
          {
            stingerId: 1,
            stinger: {
              name: "Fictional wipe",
              videoUrl: "https://media.example.test/wipe.webm",
              cutPointMs: 300,
            },
          },
        ],
      },
    });
    await emit(sceneChange(scene(8, "Beta"), "webm-stinger"));
    await advance(299);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await advance(1);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("falls back to the stinger preset's own timing when the program has no stinger", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    const preset = transition("webm-stinger");
    await emit(sceneChange(scene(8, "Beta"), "webm-stinger"));
    await advance(preset.cutPointMs - 1);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await advance(1);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("uses a stinger that has no cut point at one second", async () => {
    open();
    await advance(10);
    await emit(snapshot(scene(7, "Alpha")));
    server.answer("GET /program/main/stingers", () =>
      Response.json([
        { id: 1, name: "Fictional wipe", videoUrl: "https://media.example.test/w.webm" },
      ]),
    );
    await advance(5000);
    await emit(sceneChange(scene(8, "Beta"), "webm-stinger"));
    await advance(999);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await advance(1);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });
});

describe("stingers", () => {
  const stingerEvent = (
    stingers: Array<{ id: number; name?: string; url?: string; cut?: number }>,
    extra: Record<string, unknown> = {},
  ) => ({
    type: "program_stingers_changed",
    state: {
      stingers: stingers.map((entry) => ({
        stingerId: entry.id,
        stinger: {
          name: entry.name,
          videoUrl: entry.url,
          cutPointMs: entry.cut,
        },
      })),
    },
    ...extra,
  });

  it("preloads each stinger's video once, and drops the ones the program no longer has", async () => {
    open();
    await advance(10);
    await emit(
      stingerEvent([
        { id: 1, name: "One", url: "https://media.example.test/one.webm" },
        { id: 2, name: "Two", url: "https://media.example.test/two.webm" },
      ]),
    );
    expect(stingerVideos()).toEqual([
      "https://media.example.test/one.webm",
      "https://media.example.test/two.webm",
    ]);

    await emit(
      stingerEvent([
        { id: 1, name: "One", url: "https://media.example.test/one.webm" },
      ]),
    );
    expect(stingerVideos()).toEqual(["https://media.example.test/one.webm"]);
  });

  it("removes the preloaded videos when the page is left", async () => {
    const view = open();
    await advance(10);
    await emit(
      stingerEvent([
        { id: 1, name: "One", url: "https://media.example.test/one.webm" },
      ]),
    );
    expect(stingerVideos()).toHaveLength(1);
    view.unmount();
    expect(stingerVideos()).toEqual([]);
  });

  it("ignores a stinger change for another program", async () => {
    open();
    await advance(10);
    await emit(
      stingerEvent(
        [{ id: 1, name: "One", url: "https://media.example.test/one.webm" }],
        { programId: "other" },
      ),
    );
    expect(stingerVideos()).toEqual([]);
  });

  it("reads the program's stingers again when the change carries none", async () => {
    open();
    await advance(10);
    const before = server.requests("GET /program/main/stingers").length;
    server.answer("GET /program/main/stingers", () =>
      Response.json([
        { id: 4, name: "Four", videoUrl: "https://media.example.test/four.webm" },
      ]),
    );
    await emit({ type: "program_stingers_changed", programId: "main" });
    await advance(10);
    expect(server.requests("GET /program/main/stingers").length).toBe(
      before + 1,
    );
    expect(stingerVideos()).toEqual(["https://media.example.test/four.webm"]);
  });

  it("keeps the last good stingers, and logs one fixed line, when the reload is refused or is not a list", async () => {
    open();
    await advance(10);
    await emit(
      stingerEvent([
        { id: 1, name: "One", url: "https://media.example.test/one.webm" },
      ]),
    );
    server.answer("GET /program/main/stingers", () =>
      Response.json({ message: "Fictional backend stack trace" }, { status: 500 }),
    );
    await emit({ type: "program_stingers_changed" });
    await advance(10);
    server.answer("GET /program/main/stingers", () => Response.json({}));
    await emit({ type: "program_stingers_changed" });
    await advance(10);

    expect(stingerVideos()).toEqual(["https://media.example.test/one.webm"]);
    const lines = loggedLines("error");
    expect(
      lines.some((line) => line.includes("Program stingers reload")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("stack trace"))).toBe(false);
  });
});

describe("the song bus follows the song events", () => {
  it("starts the playing song, once per token, and stops it when it stops", async () => {
    open();
    await advance(10);
    const playing = {
      type: "song_playback_update",
      playback: {
        token: "t-1",
        audioUrl: " https://media.example.test/song.mp3 ",
        isPlaying: true,
        durationMs: 180000,
        artist: "Fictional Artist",
        title: "Fictional Title",
      },
    };
    await emit(playing);
    expect(bus.ensure).toHaveBeenCalledWith("main", {
      token: "t-1",
      audioUrl: "https://media.example.test/song.mp3",
      durationMs: 180000,
      artist: "Fictional Artist",
      title: "Fictional Title",
    });

    bus.snapshot.mockReturnValue({ track: { token: "t-1" }, isPlaying: true });
    await emit(playing);
    expect(bus.ensure).toHaveBeenCalledTimes(1);

    bus.snapshot.mockReturnValue({ track: { token: "t-1" }, isPlaying: false });
    await emit(playing);
    expect(bus.ensure).toHaveBeenCalledTimes(2);

    await emit({
      type: "song_playback_update",
      playback: { audioUrl: "https://media.example.test/song.mp3", isPlaying: false },
    });
    expect(bus.stop).toHaveBeenCalledWith("main");
  });

  it("gives a song that carries no token one of its own, and skips one without a usable address", async () => {
    open();
    await advance(10);
    await emit({
      type: "song_playback_update",
      playback: {
        audioUrl: "https://media.example.test/song.mp3",
        isPlaying: true,
        durationMs: "long",
        artist: 4,
        title: null,
      },
    });
    expect(bus.ensure).toHaveBeenCalledTimes(1);
    const track = bus.ensure.mock.calls[0][1];
    expect(track.token).toMatch(/^\d+:https:\/\/media\.example\.test\/song\.mp3$/);
    expect(track.durationMs).toBeUndefined();
    expect(track.artist).toBeUndefined();
    expect(track.title).toBeUndefined();

    await emit({
      type: "song_playback_update",
      playback: { audioUrl: "   ", isPlaying: true },
    });
    await emit({ type: "song_playback_update" });
    expect(bus.ensure).toHaveBeenCalledTimes(1);
    expect(bus.stop).not.toHaveBeenCalled();
  });

  it("leaves the song to the page on air when it is only a console monitor", async () => {
    open("?confidence=program");
    await advance(10);
    await emit({
      type: "song_playback_update",
      playback: { audioUrl: "https://media.example.test/song.mp3", isPlaying: true },
    });
    expect(bus.ensure).not.toHaveBeenCalled();
  });

  it("stops the song when this program's song goes off air, and only then", async () => {
    open();
    await advance(10);
    await emit({ type: "song_off_air", programId: "other" });
    expect(bus.stop).not.toHaveBeenCalled();
    await emit({ type: "song_off_air", programId: "main" });
    expect(bus.stop).toHaveBeenCalledWith("main");
  });
});

describe("a reload", () => {
  const replaced: string[] = [];
  beforeEach(() => {
    replaced.length = 0;
    vi.stubGlobal("location", {
      ...window.location,
      href: "https://alcantara.example.test/program/main?x=1",
      replace: (url: string) => replaced.push(url),
    });
  });

  it("clears the browser caches and reloads with a cache-busting address", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", {
      keys: async () => ["a", "b"],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
    });
    open();
    await advance(10);
    await emit({ type: "program_reload", programId: "main" });
    await advance(10);
    expect(deleted).toEqual(["a", "b"]);
    expect(replaced).toHaveLength(1);
    const next = new URL(replaced[0]);
    expect(next.searchParams.get("x")).toBe("1");
    expect(next.searchParams.get("_reload")).toMatch(/^\d+$/);
  });

  it("reloads anyway, with one logged line, when the caches cannot be cleared", async () => {
    vi.stubGlobal("caches", {
      keys: async () => {
        throw new Error("blocked");
      },
      delete: async () => true,
    });
    open();
    await advance(10);
    await emit({ type: "program_reload" });
    await advance(10);
    expect(replaced).toHaveLength(1);
    expect(
      loggedLines("warn").some((line) =>
        line.includes("Failed to clear CacheStorage before program reload"),
      ),
    ).toBe(true);
  });

  it("reloads at once when the browser has no cache storage", async () => {
    open();
    await advance(10);
    await emit({ type: "program_reload", programId: "main" });
    expect(replaced).toHaveLength(1);
  });

  it("does not reload for another program", async () => {
    open();
    await advance(10);
    await emit({ type: "program_reload", programId: "other" });
    await advance(10);
    expect(replaced).toEqual([]);
  });
});
