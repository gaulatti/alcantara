import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser } from "../../test/controlKit";

// The public state the renderer reads (the public GET and the public SSE snapshot) is projected: it may carry only
// the fields the renderer uses. This test renders the on-air page from a full state and from that projected state,
// for each kind of scene the renderer draws, and asserts the two render the same. Every component is a stand-in
// that prints the props it was given, so equal output means equal props.

const sse = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
}));
vi.mock("../hooks/useSSE", () => ({
  useSSE: (options: { onMessage: (data: unknown) => void }) => {
    sse.onMessage = options.onMessage;
    return { isConnected: false };
  },
}));

vi.mock("../utils/programAudioBus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/programAudioBus")>()),
  ensureProgramAudioBusTrack: vi.fn(),
  stopProgramAudioBus: vi.fn(),
  getProgramAudioBusSnapshot: vi.fn(() => ({ track: null, isPlaying: false })),
}));

const chart = vi.hoisted(() => ({ load: vi.fn() }));
const EMPTY_CHARTS = { byId: {}, byKey: {}, updatedAt: null };
vi.mock("../utils/chartFeed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chartFeed")>()),
  loadChartLookup: chart.load,
}));

const hoisted = vi.hoisted(() => {
  const NAMES = [
    "BroadcastLayout",
    "Ticker",
    "ChyronHolder",
    "Header",
    "ClockWidget",
    "QRCodeWidget",
    "LiveIndicator",
    "LogoWidget",
    "FifthBellChyron",
    "ToniClock",
    "ToniLogo",
    "Earone",
    "ModoItalianoGiorgiaClock",
    "ModoItalianoGiorgiaChyron",
    "ModoItalianoBracket",
    "ModoItalianoGiorgiaPodcastPlayer",
    "ModoItalianoGiorgiaArtistBumper",
    "CronicaChyron",
    "CronicaBackground",
    "CronicaReiteramos",
    "Slideshow",
    "VideoStream",
    "WebrtcGuestSource",
    "StreamWall",
    "Scoreboard",
  ] as const;

  // A stand-in that prints the props it received (an undefined prop is printed as a marker).
  async function standIn(name: string) {
    const { createElement } = await import("react");
    return (props: Record<string, unknown>) =>
      createElement("div", {
        "data-stub": name,
        "data-props": JSON.stringify(props, (_key, value) =>
          value === undefined ? "__undefined__" : value,
        ),
      });
  }
  return { NAMES, standIn };
});
vi.mock("../components", async () => {
  const stubs: Record<string, unknown> = {};
  for (const name of hoisted.NAMES) stubs[name] = await hoisted.standIn(name);
  return stubs;
});
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return { ...actual, PodcastPlayer: await hoisted.standIn("PodcastPlayer") };
});
vi.mock("../components/RelojClone", async () => ({
  default: await hoisted.standIn("RelojClone"),
}));
vi.mock("../components/RelojLoopClock", async () => ({
  default: await hoisted.standIn("RelojLoopClock"),
}));
vi.mock("../components/RelojDigitalLoopClock", async () => ({
  default: await hoisted.standIn("RelojDigitalLoopClock"),
}));
vi.mock("../components/ModoItalianoProgramRow", async () => ({
  ModoItalianoProgramRow: await hoisted.standIn("ModoItalianoProgramRow"),
}));
vi.mock("../components/BrokawFifthBellProgramRenderer", async () => ({
  default: await hoisted.standIn("FifthBellProgram"),
}));

import ProgramRoute from "./program";
import { ensureProgramAudioBusTrack } from "../utils/programAudioBus";

type Props = Record<string, unknown>;

// Scene fixtures as the full state carries them. The metadata is the JSON text the backend stores.
const giorgiaMetadata = {
  "modoitaliano-giorgia-chyron": {
    show: false,
    textSequence: { mode: "manual", items: [] },
  },
  "modoitaliano-giorgia-clock": {
    showWorldClocks: false,
    showLogo: false,
    showPlaybackProgress: false,
  },
};
const broadcastMetadata = {
  "broadcast-layout": {
    headerTitle: "Fictional title",
    hashtag: "#Fictional",
    url: "fictional.example",
    chyronText: "Fictional chyron",
    showChyron: true,
    qrCodeContent: "https://fictional.example/qr",
    clockTimezone: "UTC",
  },
};
const toniMetadata = {
  "toni-chyron": { text: "Fictional headline", useMarquee: false },
};

const FIXTURES: Array<{
  name: string;
  componentType: string;
  metadata: Record<string, Props>;
  chyronText: string;
  expects: string;
}> = [
  {
    name: "a Giorgia program row",
    componentType: "modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron",
    metadata: giorgiaMetadata,
    chyronText: "",
    expects: "ModoItalianoProgramRow",
  },
  {
    name: "a broadcast layout",
    componentType: "broadcast-layout",
    metadata: broadcastMetadata,
    chyronText: "",
    expects: "BroadcastLayout",
  },
  {
    name: "a toni chyron",
    componentType: "toni-chyron",
    metadata: toniMetadata,
    chyronText: "Fictional headline",
    expects: "FifthBellChyron",
  },
];

// The scene as the full state carries it: every field the backend stores for a scene.
const fullScene = (
  fixture: (typeof FIXTURES)[number],
  id: number,
) => ({
  id,
  name: `Fictional ${fixture.name}`,
  layoutId: 1,
  chyronText: fixture.chyronText,
  description: "Fictional description the renderer never reads",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  metadata: JSON.stringify(fixture.metadata),
  layout: {
    id: 1,
    name: "Fictional layout",
    componentType: fixture.componentType,
    description: "Fictional layout note",
  },
});

// The projected scene: only the fields the renderer reads.
const projectedScene = (scene: ReturnType<typeof fullScene>) => ({
  id: scene.id,
  chyronText: scene.chyronText,
  metadata: scene.metadata,
  layout: { componentType: scene.layout.componentType },
});

const fullState = (scene: ReturnType<typeof fullScene>, version: number) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: scene.id,
  activeScene: scene,
  stagedSceneId: null,
  stagedScene: null,
  fadeToBlack: false,
  scenes: [scene],
  mediaGroups: [{ id: 3, name: "Fictional group", position: 0 }],
  stingers: [],
  version,
});

const projectedState = (scene: ReturnType<typeof fullScene>, version: number) => ({
  activeSceneId: scene.id,
  activeScene: projectedScene(scene),
  fadeToBlack: false,
  stingers: [],
  version,
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
  chart.load.mockReset().mockResolvedValue(EMPTY_CHARTS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Renders the on-air page for one state, served by the public GET and pushed by the public snapshot, and returns
// the DOM it drew.
async function renderFrom(state: unknown): Promise<string> {
  controlServer({
    "GET /program/main/state": () => Response.json(state),
    "GET /program/main/audio-bus": () =>
      Response.json({ songSequence: null, songQueue: [] }),
    "GET /program/broadcast-settings": () => Response.json({}),
    "GET /program/main/scene-instant": () => Response.json({ isPlaying: false }),
    "GET /program/main/stingers": () => Response.json([]),
  });
  const view = render(
    <MemoryRouter initialEntries={["/program/main"]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(() => vi.advanceTimersByTimeAsync(10));
  await act(async () => {
    sse.onMessage?.({
      type: "program_state_snapshot",
      programId: "main",
      state,
      version: (state as { version: number }).version,
    });
  });
  await act(() => vi.advanceTimersByTimeAsync(10));
  const html = view.container.innerHTML;
  view.unmount();
  return html;
}

function stubsIn(html: string): string[] {
  return [...html.matchAll(/data-stub="([^"]+)"/g)].map((match) => match[1]);
}

describe("the on-air page renders the same from the projected public state as from the full state", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}`, async () => {
      const scene = fullScene(fixture, 7);
      const fromFull = await renderFrom(fullState(scene, 4));
      const fromProjected = await renderFrom(projectedState(scene, 4));

      expect(fromProjected).toBe(fromFull);
      expect(stubsIn(fromProjected)).toContain(fixture.expects);
    });
  }

  it("a staged scene's own metadata renders the same from the projected state", async () => {
    const active = fullScene(FIXTURES[0], 7);
    const staged = fullScene(FIXTURES[1], 8);
    const full = { ...fullState(active, 5), stagedSceneId: 8, stagedScene: staged, scenes: [active, staged] };
    const projected = {
      ...projectedState(active, 5),
      stagedSceneId: 8,
      stagedScene: projectedScene(staged),
    };
    expect(await renderFrom(projected)).toBe(await renderFrom(full));
  });

  it("the projected state's stingers reach the page the same way", async () => {
    const scene = fullScene(FIXTURES[2], 7);
    const stingers = [
      { stingerId: 2, stinger: { name: "Fictional stinger", videoUrl: "", cutPointMs: 900 } },
    ];
    const full = { ...fullState(scene, 6), stingers };
    const projected = { ...projectedState(scene, 6), stingers };
    expect(await renderFrom(projected)).toBe(await renderFrom(full));
  });
});


describe("a manual song sequence leaf with only the projected fields", () => {
  const leafFull = {
    id: "song-leaf-1",
    kind: "preset",
    songId: 41,
    highRotation: true,
    title: "Fictional song",
    artist: "Fictional artist",
    coverUrl: "https://fictional.example/cover.jpg",
    audioUrl: "https://fictional.example/song.mp3",
    durationMs: 180000,
    earoneSongId: "9001",
    earoneRank: "3",
    earoneSpins: "120",
  };
  // The leaf as Dot's projection keeps it: id, kind, audioUrl, title, artist, durationMs, coverUrl and the chart fields.
  const { songId: _songId, highRotation: _highRotation, ...leafProjected } = leafFull;
  void _songId;
  void _highRotation;

  const sequenceOf = (leaf: Record<string, unknown>) => ({
    mode: "manual",
    items: [leaf],
    activeItemId: leaf.id,
    intervalMs: 0,
    loop: false,
    startedAt: null,
    shuffleOrder: null,
    endedAt: null,
    cuedItemId: null,
  });

  // Plays the page with that sequence and returns the track the now-playing graphics are given.
  async function trackFor(leaf: Record<string, unknown>) {
    vi.mocked(ensureProgramAudioBusTrack).mockClear();
    controlServer({
      "GET /program/main/state": () => Response.json(stateFor()),
      "GET /program/main/audio-bus": () =>
        Response.json({ songSequence: sequenceOf(leaf), songQueue: [] }),
      "GET /program/broadcast-settings": () => Response.json({}),
      "GET /program/main/scene-instant": () => Response.json({ isPlaying: false }),
      "GET /program/main/stingers": () => Response.json([]),
    });
    const view = render(
      <MemoryRouter initialEntries={["/program/main"]}>
        <Routes>
          <Route path="/program/:id" element={<ProgramRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(async () => {
      sse.onMessage?.({ type: "program_state_snapshot", programId: "main", state: stateFor(), version: 3 });
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const calls = vi.mocked(ensureProgramAudioBusTrack).mock.calls;
    view.unmount();
    expect(calls.length, "the page starts the leaf").toBeGreaterThan(0);
    return calls[calls.length - 1][1];
  }

  it("reaches the now-playing track with the same cover and chart rank as the full leaf", async () => {
    const fromFull = await trackFor(leafFull);
    const fromProjected = await trackFor(leafProjected);
    expect(fromProjected).toEqual(fromFull);
    expect(fromProjected).toMatchObject({
      coverUrl: "https://fictional.example/cover.jpg",
      earoneSongId: "9001",
      earoneRank: "3",
      earoneSpins: "120",
    });
  });
});

function stateFor() {
  return {
    activeSceneId: null,
    activeScene: null,
    fadeToBlack: false,
    stingers: [],
    version: 3,
  };
}
