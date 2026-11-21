import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser, type ControlServer } from "../../test/controlKit";

// gaulatti/alcantara#194: the console's reads of the program (state, audio bus,
// meters, song playback, scene audio). An answer for a program the operator
// has already left changes nothing, whether it succeeds or fails, and an
// answer older than what is shown is ignored.

const program = vi.hoisted(() => ({ id: "main" }));
const sse = vi.hoisted(() => ({ state: "connected" as string }));
vi.mock("../hooks/useSSE", async () => {
  const { useEffect } = await import("react");
  return {
    useSSE: (options: { onConnectionStateChange?: (state: string) => void }) => {
      useEffect(() => {
        options.onConnectionStateChange?.(sse.state);
      }, []);
      return { isConnected: sse.state === "connected" };
    },
  };
});
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => [program.id] }));
vi.mock("../contexts/ConsolePreferencesContext", async (original) => {
  const actual = await original<typeof import("../contexts/ConsolePreferencesContext")>();
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

const state = (programId: string, version?: number) => ({
  id: 1,
  programId,
  type: "radio",
  activeSceneId: null,
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
  ...(version === undefined ? {} : { version }),
});
const READS = ["state", "audio-bus", "audio-meter", "song-playback", "scene-instant"];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  stubConsoleBrowser();
  program.id = "main";
  sse.state = "connected";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function base(): Record<string, Response> {
  return {
    "GET /scenes": Response.json([]),
    "GET /instants": Response.json([]),
    "GET /songs?limit=0": Response.json([]),
  };
}

const song = (id: string, title: string) => ({
  id,
  kind: "preset",
  songId: 1,
  artist: "Fictional artist",
  title,
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 180_000,
});
const rotationOf = (title: string) => ({ mode: "manual", items: [song("s1", title)], activeItemId: "s1", loop: true });

// What the left program's late answers would show if they were applied: a TV
// program, its own rotation, and its own song playing.
const lateAnswer: Record<string, () => Response> = {
  state: () => Response.json({ ...state("main"), type: "tv" }),
  "audio-bus": () => Response.json({ songSequence: rotationOf("Fictional late song"), songQueue: [] }),
  "audio-meter": () => Response.json({ song: { vu: 0.9, peak: 0.9 } }),
  "song-playback": () => Response.json({ token: "late", audioUrl: "https://media.example.test/late.mp3", isPlaying: true, title: "Fictional late song" }),
  "scene-instant": () => Response.json({ isPlaying: true }),
};

it.each(["answer", "fail"])("ignores every program read that comes back (%s) after the operator left the program", async (outcome) => {
  const held = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  const hold = (read: string) => () =>
    new Promise<Response>((resolve, reject) => {
      held.set(read, { resolve, reject });
    });
  server = controlServer({
    ...base(),
    ...Object.fromEntries(READS.map((read) => [`GET /program/main/${read}`, hold(read)])),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/other/state": Response.json(state("other")),
    "GET /program/other/media-groups": Response.json([]),
    "GET /program/other/audio-bus": Response.json({ songSequence: rotationOf("Fictional current song"), songQueue: [] }),
  });
  const errors = vi.mocked(console.error);
  const view = render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  await waitFor(() => expect(held.size).toBe(READS.length));
  program.id = "other";
  view.rerender(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Fictional current song")).toBeVisible();
  const errorsBefore = errors.mock.calls.length;
  await act(async () => {
    for (const [read, pending] of held) {
      if (outcome === "answer") pending.resolve(lateAnswer[read]());
      else pending.reject(new Error("network"));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // Still the other program: radio, its own rotation, nothing of the left one.
  expect(screen.getByRole("region", { name: "Continuous fillers" })).toBeVisible();
  expect(screen.getByText("Fictional current song")).toBeVisible();
  expect(screen.queryByText("Fictional late song")).toBeNull();
  expect(screen.queryByRole("button", { name: "ARM FADE TO BLACK" })).toBeNull();
  // A late failure for the left program is not reported either.
  expect(errors.mock.calls.slice(errorsBefore)).toEqual([]);
});

it("ignores a fallback poll older than what the console already shows", async () => {
  sse.state = "disconnected";
  let version = 5;
  server = controlServer({
    ...base(),
    "GET /program/main/state": () =>
      Response.json(version === 5 ? state("main", 5) : { ...state("main", 3), type: "tv" }),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/main/audio-bus": () =>
      Response.json({ version, songSequence: rotationOf(version === 5 ? "Fictional current song" : "Fictional old song"), songQueue: [] }),
    "GET /program/main/audio-meter": () => Response.json({ version, song: { vu: 0.2, peak: 0.3 } }),
    "GET /program/main/song-playback": () =>
      Response.json({ version, token: "t", audioUrl: "u", isPlaying: version !== 5, title: "Fictional old song" }),
    "GET /program/main/scene-instant": () => Response.json({ version, isPlaying: false }),
  });
  render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Fictional current song")).toBeVisible();
  const reads = () => server.calls.filter((call) => call.path === "/program/main/audio-bus").length;
  await waitFor(() => expect(reads()).toBe(1));
  version = 3;
  // The fallback poll reads again after 900 ms; its older answers are ignored.
  await waitFor(() => expect(reads()).toBe(2), { timeout: 3000 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.getByText("Fictional current song")).toBeVisible();
  expect(screen.queryByText("Fictional old song")).toBeNull();
  expect(screen.queryByRole("button", { name: "ARM FADE TO BLACK" })).toBeNull();
});

it("reuses a clip length it already measured when the next program lists the same clip", async () => {
  const loads: string[] = [];
  class FakeAudio {
    preload = "";
    src = "";
    duration = Number.NaN;
    onloadedmetadata: (() => void) | null = null;
    onerror: (() => void) | null = null;
    load() {
      loads.push(this.src);
      queueMicrotask(() => {
        this.duration = 2;
        this.onloadedmetadata?.();
      });
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
  const instant = (id: number, name: string, url: string) => ({ id, name, audioUrl: url, volume: 1, enabled: true, position: id });
  let list = [instant(1, "Fictional bell", "https://media.example.test/bell.mp3"), instant(2, "Fictional sting", "https://media.example.test/sting.mp3")];
  server = controlServer({
    ...base(),
    "GET /instants": () => Response.json(list),
    "GET /program/main/state": Response.json(state("main")),
    "GET /program/main/media-groups": Response.json([]),
    "GET /program/other/state": Response.json(state("other")),
    "GET /program/other/media-groups": Response.json([]),
    "POST /instants/3/play?programId=other": Response.json({}),
  });
  const view = render(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: "Fictional sting" });
  await waitFor(() => expect(loads).toHaveLength(2));
  // The other program lists one clip the console has already measured.
  list = [instant(3, "Fictional bell again", "https://media.example.test/bell.mp3")];
  program.id = "other";
  view.rerender(
    <MemoryRouter>
      <Control />
    </MemoryRouter>,
  );
  const again = await screen.findByRole("button", { name: "Fictional bell again" });
  expect(screen.queryByRole("button", { name: "Fictional sting" })).toBeNull();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.click(again);
  expect(await screen.findByRole("button", { name: "Fictional bell again · playing" })).toBeVisible();
  await act(async () => {
    vi.advanceTimersByTime(2100);
  });
  expect(await screen.findByRole("button", { name: "Fictional bell again" })).toBeVisible();
  // Measured once: no new load for the clip it already knew.
  expect(loads).toHaveLength(2);
  vi.useRealTimers();
});
