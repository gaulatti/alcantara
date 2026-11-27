import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser } from "../../test/controlKit";

// gaulatti/alcantara#195: the on-air page keeps one realtime connection to its
// program, reconnects after a drop or an error, and does not connect at all
// when it only shows a confidence monitor.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));

import ProgramRoute from "./program";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static failNext = false;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<() => void>>();
  constructor(public url: string) {
    if (FakeSocket.failNext) {
      FakeSocket.failNext = false;
      throw new Error("refused");
    }
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  send() {}
}

beforeEach(() => {
  FakeSocket.instances = [];
  FakeSocket.failNext = false;
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  vi.stubGlobal("WebSocket", FakeSocket);
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

const open = (search = "") =>
  render(
    <MemoryRouter initialEntries={[`/program/main${search}`]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it("connects to its program as the program role", async () => {
  open();
  await advance(10);
  expect(FakeSocket.instances).toHaveLength(1);
  const url = new URL(FakeSocket.instances[0].url);
  expect(url.pathname).toBe("/program/ws");
  expect(url.searchParams.get("programId")).toBe("main");
  expect(url.searchParams.get("role")).toBe("program");
});

it("reconnects 1.5 s after the connection drops and after an error", async () => {
  open();
  await advance(10);
  const first = FakeSocket.instances[0];
  act(() => first.emit("open"));
  act(() => first.emit("close"));
  await advance(1400);
  expect(FakeSocket.instances).toHaveLength(1);
  await advance(200);
  expect(FakeSocket.instances).toHaveLength(2);

  const second = FakeSocket.instances[1];
  act(() => second.emit("error"));
  expect(second.closed).toBe(true);
  act(() => second.emit("close"));
  await advance(1600);
  expect(FakeSocket.instances).toHaveLength(3);
});

it("tries again when the connection cannot even be opened", async () => {
  FakeSocket.failNext = true;
  open();
  await advance(10);
  expect(FakeSocket.instances).toHaveLength(0);
  await advance(1600);
  expect(FakeSocket.instances).toHaveLength(1);
});

it("closes a connection that opens after the page has left, and one still open when it unmounts", async () => {
  const view = open();
  await advance(10);
  const socket = FakeSocket.instances[0];
  socket.readyState = FakeSocket.OPEN;
  view.unmount();
  expect(socket.closed).toBe(true);
  act(() => socket.emit("open"));
  act(() => socket.emit("close"));
  await advance(3000);
  expect(FakeSocket.instances).toHaveLength(1);
});

it("does not connect for a confidence monitor", async () => {
  open("?confidence=preview");
  await advance(2000);
  expect(FakeSocket.instances).toHaveLength(0);
});

it("reconnects after a connection that had opened, and opens again on the new one", async () => {
  open();
  await advance(10);
  act(() => FakeSocket.instances[0].emit("open"));
  act(() => FakeSocket.instances[0].emit("close"));
  await advance(1600);
  expect(FakeSocket.instances).toHaveLength(2);
  act(() => FakeSocket.instances[1].emit("open"));
  await advance(10);
  expect(FakeSocket.instances).toHaveLength(2);
});
