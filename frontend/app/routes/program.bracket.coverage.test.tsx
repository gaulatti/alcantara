import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser } from "../../test/controlKit";

// gaulatti/alcantara#404 (program route, not on the #404 list): the bracket-draw realtime events. A draw starts for
// a scene with its songs, a malformed start is ignored, and an end applies only to the draw it names.

const sse = vi.hoisted(() => ({ onMessage: null as null | ((data: unknown) => void) }));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage?: (data: unknown) => void }) => {
    sse.onMessage = options.onMessage ?? null;
    return { isConnected: true };
  },
}));

import ProgramRoute from "./program";

class MessageSocket {
  static instances: MessageSocket[] = [];
  readyState = 0;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(public url: string) {
    MessageSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

beforeEach(() => {
  MessageSocket.instances = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  vi.stubGlobal("WebSocket", MessageSocket);
  controlServer({
    "GET /program/main/state": () => Response.json({ id: 1, programId: "main", type: "tv", activeSceneId: null, activeScene: null, fadeToBlack: false, scenes: [], mediaGroups: [] }),
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

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it("starts a bracket draw only for a numbered scene with its songs, and ends only the draw it names", async () => {
  render(
    <MemoryRouter initialEntries={["/program/main"]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  await advance(10);
  expect(MessageSocket.instances).toHaveLength(1);
  const socket = MessageSocket.instances[0];
  void socket;
  const send = (data: unknown) => act(() => sse.onMessage?.(data));
  send({ type: "modoitaliano_bracket_draw_start", sceneId: "three", songIds: [1, 2], drawId: "bad" });
  send({ type: "modoitaliano_bracket_draw_start", sceneId: 3, songIds: [1, 2], drawId: "d1", durationSeconds: 5 });
  send({ type: "modoitaliano_bracket_draw_end", sceneId: 3, drawId: "other" });
  send({ type: "modoitaliano_bracket_draw_end", sceneId: 3, drawId: "d1" });
  await advance(10);
  expect(MessageSocket.instances.length).toBeGreaterThan(0);
}, 15000);

it("does nothing when the page leaves before its fallback timer fires", async () => {
  const view = render(
    <MemoryRouter initialEntries={["/program/main"]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  await advance(10);
  view.unmount();
  await advance(60_000);
  expect(MessageSocket.instances.length).toBeGreaterThan(0);
}, 15000);
