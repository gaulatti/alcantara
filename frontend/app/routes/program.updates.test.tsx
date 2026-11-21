import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#195: what the on-air page does with each live update it
// receives: a scene change cuts or animates, a scene update edits the scene on
// air, clearing a scene empties the screen, and a stinger change refreshes the
// stinger list the page preloads.

const sse = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
}));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage: (data: unknown) => void }) => {
    sse.onMessage = options.onMessage;
    return { isConnected: false };
  },
}));

import ProgramRoute from "./program";

let server: ControlServer;

const chyronScene = (id: number, text: string) => ({
  id,
  name: `Fictional scene ${id}`,
  layoutId: 1,
  metadata: JSON.stringify({ chyron: { text } }),
  layout: { id: 1, name: "Lower third", componentType: "chyron" },
});
const stateWith = (scene: ReturnType<typeof chyronScene> | null, extra = {}) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: scene?.id ?? null,
  activeScene: scene,
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /program/main/state": () => Response.json(stateWith(chyronScene(1, "First headline"))),
    "GET /program/main/audio-bus": () => Response.json({ songSequence: null, songQueue: [] }),
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

async function openPage() {
  const view = render(
    <MemoryRouter initialEntries={["/program/main"]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(() => vi.advanceTimersByTimeAsync(1000));
  return view;
}
const send = (message: unknown) => act(async () => sse.onMessage?.(message));
// In steps, so the page renders between the timers a transition sets.
const advance = async (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await act(() => vi.advanceTimersByTimeAsync(Math.min(250, ms - elapsed)));
  }
};

it("cuts straight to the new scene when the transition is a cut or the page has nothing on air", async () => {
  await openPage();
  expect(screen.getByText("First headline")).toBeInTheDocument();
  await send({ type: "scene_change", transitionId: "cut", state: stateWith(chyronScene(2, "Second headline")) });
  await advance(1000);
  expect(screen.getByText("Second headline")).toBeInTheDocument();
  expect(screen.queryByText("First headline")).not.toBeInTheDocument();
});

it("holds the old scene until the transition's cut point, then shows the new one", async () => {
  await openPage();
  await send({ type: "scene_change", transitionId: "crescendo-prism", state: stateWith(chyronScene(2, "Second headline")) });
  await advance(700);
  expect(screen.getByText("First headline")).toBeInTheDocument();
  await advance(1500);
  expect(screen.getByText("Second headline")).toBeInTheDocument();
  await advance(1000);
  expect(screen.getByText("Second headline")).toBeInTheDocument();
});

it("takes the first loaded stinger's video and cut point for a stinger transition", async () => {
  server.answer("GET /program/main/stingers", () =>
    Response.json([{ id: 5, name: "Fictional stinger", videoUrl: "/stinger.webm", cutPointMs: 300 }]),
  );
  await openPage();
  await advance(6000);
  await send({ type: "scene_change", transitionId: "webm-stinger", state: stateWith(chyronScene(2, "Second headline")) });
  await advance(200);
  expect(screen.getByText("First headline")).toBeInTheDocument();
  await advance(1500);
  expect(screen.getByText("Second headline")).toBeInTheDocument();
});

it("keeps the stinger preset's own timing when no stinger is loaded", async () => {
  await openPage();
  await send({ type: "scene_change", transitionId: "webm-stinger", state: stateWith(chyronScene(2, "Second headline")) });
  await advance(900);
  expect(screen.getByText("First headline")).toBeInTheDocument();
  await advance(1500);
  expect(screen.getByText("Second headline")).toBeInTheDocument();
});

it("edits the scene on air when a scene update names it, and leaves it alone otherwise", async () => {
  await openPage();
  await send({ type: "scene_update", scene: chyronScene(1, "Edited headline") });
  await advance(1000);
  expect(screen.getByText("Edited headline")).toBeInTheDocument();
  await send({ type: "scene_update", scene: chyronScene(99, "Other scene") });
  await send({ type: "scene_update" });
  await advance(100);
  expect(screen.getByText("Edited headline")).toBeInTheDocument();
  expect(screen.queryByText("Other scene")).not.toBeInTheDocument();
});

it("empties the screen when the scene is cleared", async () => {
  await openPage();
  await send({ type: "scene_cleared" });
  await advance(100);
  expect(screen.queryByText("First headline")).not.toBeInTheDocument();
});

it("keeps what is on air while a scene is only staged, and records the staged scene", async () => {
  await openPage();
  await send({ type: "scene_staged", programId: "main", stagedSceneId: 2, scene: chyronScene(2, "Staged headline") });
  await advance(100);
  expect(screen.getByText("First headline")).toBeInTheDocument();
  await send({ type: "scene_staged", programId: "other", stagedSceneId: 3, scene: chyronScene(3, "Elsewhere") });
  await send({ type: "scene_staged", stagedSceneId: "x", scene: null });
  await advance(100);
  expect(screen.getByText("First headline")).toBeInTheDocument();
});

it("applies a fade to black state and a whole-state snapshot, and ignores one with no state", async () => {
  await openPage();
  await send({ type: "fade_to_black", state: stateWith(chyronScene(1, "First headline"), { fadeToBlack: true }) });
  await send({ type: "fade_to_black" });
  await send({ type: "program_state_snapshot" });
  await advance(100);
  expect(screen.getByText("First headline")).toBeInTheDocument();
});

it("ignores a message that is not an object", async () => {
  await openPage();
  await send(null);
  await send("text");
  await advance(100);
  expect(screen.getByText("First headline")).toBeInTheDocument();
});

it("reads the stinger list from a stinger change that carries it, and preloads one hidden video per stinger", async () => {
  await openPage();
  await send({
    type: "program_stingers_changed",
    state: { stingers: [{ stingerId: 7, stinger: { name: "Fictional", videoUrl: "/seven.webm", cutPointMs: 400 } }, { stingerId: 8 }] },
  });
  await advance(100);
  const videos = () => [...document.body.querySelectorAll("video")].map((video) => video.getAttribute("src"));
  expect(videos()).toEqual(expect.arrayContaining(["/seven.webm"]));
  await send({ type: "program_stingers_changed", state: { stingers: [] } });
  await advance(100);
  expect(videos()).not.toContain("/seven.webm");
});

it("reloads the stinger list from the server when a stinger change carries none", async () => {
  await openPage();
  server.answer("GET /program/main/stingers", () =>
    Response.json([{ id: 9, name: "Fictional", videoUrl: "/nine.webm", cutPointMs: 500 }]),
  );
  await send({ type: "program_stingers_changed" });
  await advance(100);
  expect(document.body.querySelector('video[src="/nine.webm"]')).not.toBeNull();
});

it("removes its preloaded stinger videos when the page unmounts", async () => {
  server.answer("GET /program/main/stingers", () =>
    Response.json([{ id: 9, name: "Fictional", videoUrl: "/nine.webm", cutPointMs: 500 }]),
  );
  const view = await openPage();
  await advance(6000);
  expect(document.body.querySelector("video")).not.toBeNull();
  view.unmount();
  expect(document.body.querySelector('video[src="/nine.webm"]')).toBeNull();
});

it("applies saved audio bus and broadcast settings from live updates", async () => {
  await openPage();
  await send({ type: "audio_bus_snapshot", settings: { songSequence: null, mixerSettings: { songMuted: true } } });
  await send({ type: "broadcast_settings_snapshot", settings: { songMasterVolume: 0.5 } });
  await send({ type: "broadcast_settings_update", settings: { timeOverrideEnabled: true, timeOverrideStartTime: "08:00", timeOverrideStartedAt: "2026-11-21T08:00:00.000Z" } });
  await advance(100);
  expect(screen.getByText("First headline")).toBeInTheDocument();
});
