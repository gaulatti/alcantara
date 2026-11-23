import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#201: the on-air page reads its snapshots without ever
// letting an error answer replace what is on air. It keeps the last good
// value and logs one fixed line per source, never the answer's body.

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

const onAir = (text: string) => ({
  id: 7,
  name: "Fictional lower third",
  layoutId: 1,
  // The on-air page receives scene metadata as a JSON string.
  metadata: JSON.stringify({ chyron: { text } }),
  layout: { id: 1, name: "Lower third", componentType: "chyron" },
});
const state = (text: string) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: 7,
  activeScene: onAir(text),
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
});

const ERROR_BODY = "Fictional backend stack trace";
const refused = () =>
  Response.json({ statusCode: 500, message: ERROR_BODY }, { status: 500 });

const SOURCES = [
  "GET /program/main/state",
  "GET /program/main/audio-bus",
  "GET /program/broadcast-settings",
  "GET /program/main/scene-instant",
  "GET /program/main/stingers",
];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
  server = controlServer({
    "GET /program/main/state": () =>
      Response.json(state("Fictional on-air headline")),
    "GET /program/main/audio-bus": () =>
      Response.json({ songSequence: null, songQueue: [] }),
    "GET /program/broadcast-settings": () => Response.json({}),
    "GET /program/main/scene-instant": () =>
      Response.json({ isPlaying: false }),
    "GET /program/main/stingers": () => Response.json([]),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openOnAirPage() {
  return render(
    <MemoryRouter initialEntries={["/program/main"]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

// What is on air, without the fade-to-black overlay's transition timing: that
// is how a future fade would animate, not what the viewer sees (its opacity
// stays in the markup and is compared).
const onAirMarkup = (container: HTMLElement) =>
  container.innerHTML.replace(/ transition: [^;"]*;/g, "");

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const loggedLines = () =>
  vi.mocked(console.error).mock.calls.map((call) => call.join(" "));

it("keeps what is on air when every poll answers an error", async () => {
  const view = openOnAirPage();
  // Settle through the first reads and one good poll before comparing.
  await advance(6000);
  expect(screen.getByText("Fictional on-air headline")).toBeInTheDocument();
  const onAirBefore = onAirMarkup(view.container);

  const readsBefore = SOURCES.map((source) => server.requests(source).length);
  for (const source of SOURCES) server.answer(source, refused);
  await advance(5000);
  SOURCES.forEach((source, index) =>
    expect(server.requests(source).length).toBeGreaterThan(readsBefore[index]),
  );
  expect(onAirMarkup(view.container)).toBe(onAirBefore);

  expect(loggedLines()).toEqual(
    expect.arrayContaining([
      "[program] Program state poll could not be read; keeping the last good value. HTTP 500",
      "[program] Audio bus poll could not be read; keeping the last good value. HTTP 500",
      "[program] Broadcast settings poll could not be read; keeping the last good value. HTTP 500",
      "[program] Scene clip playback poll could not be read; keeping the last good value. HTTP 500",
      "[program] Program stingers poll could not be read; keeping the last good value. HTTP 500",
    ]),
  );
  expect(loggedLines().some((line) => line.includes(ERROR_BODY))).toBe(false);
});

it("puts nothing on air from error answers to the first reads, then the next good poll", async () => {
  for (const source of SOURCES) server.answer(source, refused);
  const view = openOnAirPage();
  await advance(1000);
  expect(screen.queryByText(ERROR_BODY)).not.toBeInTheDocument();
  expect(loggedLines()).toEqual(
    expect.arrayContaining([
      "[program] Initial program state could not be read; keeping the last good value. HTTP 500",
      "[program] Initial audio bus could not be read; keeping the last good value. HTTP 500",
      "[program] Initial broadcast settings could not be read; keeping the last good value. HTTP 500",
      "[program] Initial scene clip playback could not be read; keeping the last good value. HTTP 500",
      "[program] Initial program stingers could not be read; keeping the last good value. HTTP 500",
    ]),
  );

  server.answer("GET /program/main/state", () =>
    Response.json(state("Fictional on-air headline")),
  );
  await advance(5000);
  expect(screen.getByText("Fictional on-air headline")).toBeInTheDocument();
  expect(view.container.textContent).not.toContain(ERROR_BODY);
});

it("refuses answers of the wrong shape: a state that is not an object, stingers that are not a list", async () => {
  const view = openOnAirPage();
  await advance(6000);
  expect(screen.getByText("Fictional on-air headline")).toBeInTheDocument();
  const onAirBefore = onAirMarkup(view.container);
  server.answer("GET /program/main/state", () =>
    Response.json(["not", "a", "state"]),
  );
  server.answer("GET /program/main/stingers", () =>
    Response.json({ stingers: [] }),
  );
  await advance(5000);
  expect(onAirMarkup(view.container)).toBe(onAirBefore);
  expect(loggedLines()).toEqual(
    expect.arrayContaining([
      "[program] Program stingers poll could not be read; keeping the last good value. unreadable answer",
    ]),
  );
});

it("keeps the stingers when a stinger change cannot be reloaded", async () => {
  openOnAirPage();
  await advance(1000);
  server.answer("GET /program/main/stingers", refused);
  await act(async () =>
    sse.onMessage!({ type: "program_stingers_changed", programId: "main" }),
  );
  await advance(10);
  expect(
    server.requests("GET /program/main/stingers").length,
  ).toBeGreaterThanOrEqual(2);
  expect(loggedLines()).toEqual(
    expect.arrayContaining([
      "[program] Program stingers reload could not be read; keeping the last good value. HTTP 500",
    ]),
  );
  expect(screen.getByText("Fictional on-air headline")).toBeInTheDocument();
});

// gaulatti/alcantara#195: an update is applied only when its version is newer
// than the last one applied for that topic, so a late older message never
// replaces what is on air.
it("puts a newer program snapshot on air and ignores an older one that arrives late", async () => {
  openOnAirPage();
  await advance(1000);
  expect(screen.getByText("Fictional on-air headline")).toBeInTheDocument();

  await act(async () => {
    sse.onMessage?.({
      type: "program_state_snapshot",
      version: 5,
      state: { ...state("Fictional newer headline"), activeSceneId: 8, activeScene: { ...onAir("Fictional newer headline"), id: 8 } },
    });
  });
  await advance(1000);
  expect(screen.getByText("Fictional newer headline")).toBeInTheDocument();

  await act(async () => {
    sse.onMessage?.({
      type: "program_state_snapshot",
      version: 4,
      state: state("Fictional late older headline"),
    });
  });
  await advance(1000);
  expect(screen.getByText("Fictional newer headline")).toBeInTheDocument();
  expect(
    screen.queryByText("Fictional late older headline"),
  ).not.toBeInTheDocument();
});
