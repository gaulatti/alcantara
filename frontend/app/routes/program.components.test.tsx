import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlServer, stubConsoleBrowser } from "../../test/controlKit";
import { faderToGain } from "../utils/audioTaper";

// gaulatti/alcantara#195, groups 8 to 10: which component the on-air page puts
// on screen for each scene layout, and what it hands that component (its text,
// its volume, the time override, whether it may act on the program). Every
// component is replaced by a stand-in that prints the props it was given, so
// the assertions are what each component is asked to show.

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

  // A stand-in that prints the props it received (an undefined prop is printed
  // as a marker, so "not given" can be told from "given empty").
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
// The page places the Fifth Bell program through its Brokaw reader (alcantara#381).
vi.mock("../components/BrokawFifthBellProgramRenderer", async () => ({
  default: await hoisted.standIn("FifthBellProgram"),
}));

import ProgramRoute from "./program";

type Props = Record<string, unknown>;

const sceneOf = (
  types: string[],
  metadata: Record<string, Props> = {},
  id = 7,
) => ({
  id,
  name: "Fictional scene",
  layoutId: 1,
  metadata: JSON.stringify(metadata),
  layout: { id: 1, name: "Fictional layout", componentType: types.join(",") },
});
const stateOf = (activeScene: unknown, stagedScene: unknown = null) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: (activeScene as { id: number } | null)?.id ?? null,
  activeScene,
  stagedScene,
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
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
  controlServer({
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
const show = async (
  scene: unknown,
  options: { search?: string; staged?: unknown } = {},
) => {
  open(options.search ?? "");
  await advance(10);
  await emit({
    type: "program_state_snapshot",
    state: stateOf(scene, options.staged ?? null),
  });
};
const stubs = (name: string) =>
  [...view.container.querySelectorAll(`[data-stub="${name}"]`)].map(
    (node) => JSON.parse(node.getAttribute("data-props") ?? "{}") as Props,
  );
const stub = (name: string) => {
  const found = stubs(name);
  expect(found, `a ${name} on screen`).toHaveLength(1);
  return found[0];
};
const present = (name: string) => stubs(name).length > 0;
const UNSET = "__undefined__";

describe("the layouts that are a single component", () => {
  it.each([
    ["lower-third", "Lower Third"],
    ["full-screen", "Full Screen"],
    ["corner-bug", "LIVE"],
  ])("puts a %s on screen with its text, or its own default", async (type, fallback) => {
    await show(sceneOf([type], { [type]: { text: "Fictional words" } }));
    expect(view.container.textContent).toContain("Fictional words");
    cleanup();
    await show(sceneOf([type]));
    expect(view.container.textContent).toContain(fallback);
  });

  it("asks for the broadcast layout with its settings and its defaults", async () => {
    await show(
      sceneOf(["broadcast-layout"], {
        "broadcast-layout": {
          headerTitle: "Fictional title",
          hashtag: "#Fictional",
          url: "fictional.example",
          chyronText: "Fictional chyron",
          showChyron: false,
          qrCodeContent: "https://fictional.example/qr",
          clockTimezone: "Europe/Lisbon",
        },
      }),
    );
    expect(stub("BroadcastLayout")).toMatchObject({
      headerTitle: "Fictional title",
      hashtag: "#Fictional",
      url: "fictional.example",
      chyronText: "Fictional chyron",
      showChyron: false,
      qrCodeContent: "https://fictional.example/qr",
      clockTimezone: "Europe/Lisbon",
      showLiveIndicator: true,
    });
    cleanup();

    await show(sceneOf(["broadcast-layout"]));
    expect(stub("BroadcastLayout")).toMatchObject({
      headerTitle: "",
      chyronText: "",
      showChyron: false,
      clockTimezone: "America/Argentina/Buenos_Aires",
    });
    cleanup();

    await show(
      sceneOf(["broadcast-layout"], {
        "broadcast-layout": { chyronText: "Only text" },
      }),
    );
    expect(stub("BroadcastLayout")).toMatchObject({ showChyron: true });
  });
});

describe("the layouts that stack several components", () => {
  it("gives the simple widgets their text and their defaults", async () => {
    await show(
      sceneOf(
        [
          "ticker",
          "chyron",
          "header",
          "clock-widget",
          "qr-code",
          "live-indicator",
          "logo-widget",
        ],
        {
          ticker: { hashtag: "#Fictional", url: "fictional.example" },
          chyron: { text: "Fictional chyron" },
          header: { title: "Fictional header", date: "1 Jan" },
          "clock-widget": { iconUrl: "https://x.example/i.png", timezone: "UTC" },
          "qr-code": { content: "https://fictional.example" },
          "live-indicator": { animate: false },
          "logo-widget": { logoUrl: "https://x.example/l.png", position: "left" },
        },
      ),
    );
    expect(stub("Ticker")).toMatchObject({
      hashtag: "#Fictional",
      url: "fictional.example",
    });
    expect(stub("ChyronHolder")).toMatchObject({
      text: "Fictional chyron",
      show: true,
    });
    expect(stub("Header")).toMatchObject({ title: "Fictional header", date: "1 Jan" });
    expect(stub("ClockWidget")).toMatchObject({
      iconUrl: "https://x.example/i.png",
      timezone: "UTC",
    });
    expect(stub("QRCodeWidget")).toMatchObject({
      content: "https://fictional.example",
    });
    expect(stub("LiveIndicator")).toMatchObject({ animate: false });
    expect(stub("LogoWidget")).toMatchObject({
      logoUrl: "https://x.example/l.png",
      position: "left",
    });
    cleanup();

    await show(
      sceneOf([
        "ticker",
        "chyron",
        "header",
        "qr-code",
        "live-indicator",
        "corner-bug",
      ]),
    );
    expect(stub("Ticker")).toMatchObject({
      hashtag: "#Default",
      url: "website.com",
    });
    expect(stub("ChyronHolder")).toMatchObject({ text: "Chyron" });
    expect(stub("Header")).toMatchObject({ title: "Header" });
    expect(String(stub("Header").date).length).toBeGreaterThan(0);
    expect(stub("QRCodeWidget")).toMatchObject({ content: "https://example.com" });
    expect(stub("LiveIndicator")).toMatchObject({ animate: true });
    expect(view.container.textContent).toContain("LIVE");
  });

  it("puts a component above or below the others by its z-index, and says so for an unknown one", async () => {
    await show(
      sceneOf(["header", "ticker", "made-up-widget"], {
        header: { zIndex: 5 },
        ticker: { zIndex: "" },
      }),
    );
    const header = view.container.querySelector('[data-stub="Header"]')!;
    expect((header.parentElement as HTMLElement).style.zIndex).toBe("5");
    const ticker = view.container.querySelector('[data-stub="Ticker"]')!;
    expect((ticker.parentElement as HTMLElement).style.zIndex).toBe("");
    expect(view.container.textContent).toContain("Unknown component: made-up-widget");
    expect(console.warn).toHaveBeenCalledWith(
      "Unknown component type:",
      "made-up-widget",
    );
  });

  it("shows the scene it can read and logs the metadata it cannot", async () => {
    const broken = { ...sceneOf(["header"]), metadata: "{ not json" };
    await show(broken);
    expect(stub("Header")).toMatchObject({ title: "Header" });
    expect(console.error).toHaveBeenCalledWith(
      "Failed to parse scene metadata:",
      expect.anything(),
    );
    cleanup();
    await show({ ...sceneOf(["header"]), metadata: "" });
    expect(stub("Header")).toMatchObject({ title: "Header" });
  });

  it("hands the slideshow its settings and its pictures", async () => {
    await show(
      sceneOf(["slideshow"], {
        slideshow: {
          intervalMs: 4000,
          transitionMs: 500,
          shuffle: true,
          fitMode: "cover",
          kenBurns: true,
          images: [],
        },
      }),
    );
    expect(stub("Slideshow")).toMatchObject({
      intervalMs: 4000,
      transitionMs: 500,
      shuffle: true,
      fitMode: "cover",
      kenBurns: true,
      images: [],
    });
  });

  it("hands the video, the stream wall and the guest their sources and the stream volume", async () => {
    await show(
      sceneOf(["video-stream", "stream-wall", "webrtc-guest"], {
        "video-stream": {
          sourceUrl: "https://x.example/v.m3u8",
          posterUrl: "https://x.example/p.jpg",
          showControls: false,
          loop: true,
          autoPlay: true,
          objectFit: "contain",
        },
        "stream-wall": {
          urls: ["https://x.example/a", "https://x.example/b"],
          maxStreams: 2,
          title: "Fictional wall",
        },
        "webrtc-guest": { slotNumber: 3, objectFit: "cover", showStatus: true },
      }),
    );
    expect(stub("VideoStream")).toMatchObject({
      sourceUrl: "https://x.example/v.m3u8",
      posterUrl: "https://x.example/p.jpg",
      channelGain: 1,
      showControls: false,
      loop: true,
      autoPlay: true,
      objectFit: "contain",
    });
    expect(stub("StreamWall")).toMatchObject({
      urls: ["https://x.example/a", "https://x.example/b"],
      maxStreams: 2,
      title: "Fictional wall",
      suspended: false,
    });
    expect(stub("WebrtcGuestSource")).toMatchObject({
      programId: "main",
      slotNumber: 3,
      objectFit: "cover",
      showStatus: true,
      suppressAudio: false,
      channelGain: 1,
    });
  });

  it("keeps a staged stream playing through a cut: the scene that goes on air is the one already warm", async () => {
    // gaulatti/alcantara#357: a take swaps the scenes (the staged one goes on air,
    // the one it replaces is staged). The warm stream must not be started again.
    const streamScene = (id: number, url: string) =>
      sceneOf(["video-stream"], { "video-stream": { sourceUrl: url } }, id);
    const onAir = streamScene(7, "https://x.example/seven.m3u8");
    const staged = streamScene(8, "https://x.example/eight.m3u8");
    await show(onAir, { staged });
    const streamOf = (url: string) =>
      [...view.container.querySelectorAll('[data-stub="VideoStream"]')].find(
        (node) => JSON.parse(node.getAttribute("data-props") ?? "{}").sourceUrl === url,
      ) as HTMLElement;
    const layerOf = (node: HTMLElement) => node.closest("[data-scene-layer]") as HTMLElement;
    const gainOf = (node: HTMLElement) => JSON.parse(node.getAttribute("data-props") ?? "{}").channelGain;

    const warm = streamOf("https://x.example/eight.m3u8");
    expect(layerOf(warm).dataset.sceneLayer).toBe("staged");
    expect(layerOf(warm).style.opacity).toBe("0");
    expect(layerOf(warm).getAttribute("aria-hidden")).toBe("true");
    expect(gainOf(warm)).toBe(0);
    const order = () =>
      [...view.container.querySelectorAll("[data-scene-layer]")].map((layer) =>
        JSON.parse(layer.querySelector('[data-stub="VideoStream"]')!.getAttribute("data-props")!).sourceUrl,
      );
    const before = order();

    await emit({ type: "scene_change", transitionId: "cut", state: stateOf(staged, onAir) });

    const taken = streamOf("https://x.example/eight.m3u8");
    expect(taken).toBe(warm);
    expect(layerOf(taken).dataset.sceneLayer).toBe("on-air");
    expect(layerOf(taken).style.opacity).toBe("1");
    expect(gainOf(taken)).toBe(1);
    // The scene it replaced stays mounted, hidden and muted, for the cut back.
    const replaced = streamOf("https://x.example/seven.m3u8");
    expect(layerOf(replaced).dataset.sceneLayer).toBe("staged");
    expect(gainOf(replaced)).toBe(0);
    // The layers never change places, so no playing element is moved in the page.
    expect(order()).toEqual(before);

    // A staged scene without a stream is not rendered ahead of time.
    await emit({ type: "scene_change", transitionId: "cut", state: stateOf(staged, sceneOf(["lower-third"], {}, 9)) });
    expect(view.container.querySelectorAll("[data-scene-layer]")).toHaveLength(1);
    expect(streamOf("https://x.example/eight.m3u8")).toBe(warm);
  });

  it("moves no layer in the page across a cut, the swap back, or a new staged scene", async () => {
    // A media element removed from the document pauses, and React moves a keyed node by
    // removing and inserting it, so a persisting layer must never appear in a removal.
    const streamScene = (id: number, url: string) =>
      sceneOf(["video-stream"], { "video-stream": { sourceUrl: url } }, id);
    const a = streamScene(7, "https://x.example/seven.m3u8");
    const b = streamScene(8, "https://x.example/eight.m3u8");
    const c = streamScene(9, "https://x.example/nine.m3u8");
    await show(a, { staged: b });
    const parent = view.container.querySelector("[data-scene-layer]")!.parentElement!;
    const layerFor = (url: string) =>
      [...parent.querySelectorAll("[data-scene-layer]")].find((layer) =>
        layer.querySelector(`[data-props*='${url}']`),
      )!;
    const layerA = layerFor("seven");
    const layerB = layerFor("eight");
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) removed.push(...record.removedNodes);
    });
    observer.observe(parent, { childList: true });

    await emit({ type: "scene_change", transitionId: "cut", state: stateOf(b, a) }); // cut to b
    await emit({ type: "scene_change", transitionId: "cut", state: stateOf(a, b) }); // cut back to a
    await emit({ type: "scene_staged", programId: "main", stagedSceneId: 9, scene: c }); // stage c
    await act(async () => {});
    observer.disconnect();

    expect(removed).not.toContain(layerA);
    // b left the page only when c replaced it as the staged scene, never during a cut.
    expect(removed.filter((node) => node === layerB)).toHaveLength(1);
    expect(layerA.isConnected).toBe(true);
    expect(layerFor("nine")).toBeTruthy();

  });

  it("falls back to an empty wall and a four-stream limit", async () => {
    await show(
      sceneOf(["stream-wall"], {
        "stream-wall": { urls: "not a list", maxStreams: "many", title: 4 },
      }),
    );
    expect(stub("StreamWall")).toMatchObject({ urls: [], maxStreams: 4, title: "" });
  });

  it("follows the stream fader, and keeps the stream silent on a confidence monitor", async () => {
    await show(sceneOf(["video-stream", "stream-wall"]));
    await emit({
      type: "audio_bus_snapshot",
      settings: { mixerSettings: { streamMasterVolume: 0.5 } },
    });
    expect(stub("VideoStream").channelGain).toBeCloseTo(faderToGain(0.5), 5);
    expect(stub("StreamWall").suspended).toBe(false);
    cleanup();

    await show(sceneOf(["video-stream", "stream-wall"]), {
      search: "?confidence=program",
    });
    expect(stub("VideoStream").channelGain).toBe(0);
    expect(stub("StreamWall").suspended).toBe(true);
  });

  it("keeps the guest's own sound off when the page is a renderer", async () => {
    await show(sceneOf(["webrtc-guest"]), { search: "?renderer=1" });
    expect(stub("WebrtcGuestSource").suppressAudio).toBe(true);
  });

  it("hands the scoreboard its figures and shows its period and clock unless told not to", async () => {
    await show(
      sceneOf(["scoreboard"], {
        scoreboard: {
          title: "Fictional cup",
          homeTeam: "Home",
          awayTeam: "Away",
          homeScore: 2,
          awayScore: 1,
          period: "2nd",
          clock: "45:00",
          status: "live",
        },
      }),
    );
    expect(stub("Scoreboard")).toMatchObject({
      title: "Fictional cup",
      homeTeam: "Home",
      awayTeam: "Away",
      homeScore: 2,
      awayScore: 1,
      period: "2nd",
      showPeriod: true,
      clock: "45:00",
      showClock: true,
      status: "live",
    });
    cleanup();
    await show(
      sceneOf(["scoreboard"], {
        scoreboard: { showPeriod: false, showClock: false },
      }),
    );
    expect(stub("Scoreboard")).toMatchObject({ showPeriod: false, showClock: false });
  });
});

describe("the clocks", () => {
  it("gives each analogue clock its timezone, or the one it defaults to", async () => {
    await show(
      sceneOf(["reloj-clock", "reloj-loop-clock"], {
        "reloj-clock": { timezone: "UTC" },
        "reloj-loop-clock": { timezone: "Asia/Tokyo" },
      }),
    );
    expect(stub("RelojClone").timezone).toBe("UTC");
    expect(stub("RelojLoopClock").timezone).toBe("Asia/Tokyo");
    cleanup();
    await show(sceneOf(["reloj-clock", "reloj-loop-clock"]));
    expect(stub("RelojClone").timezone).toBe("America/Argentina/Buenos_Aires");
    expect(stub("RelojLoopClock").timezone).toBe("Europe/Madrid");
  });

  it("lets the digital loop clock act on the program, but not on a confidence monitor", async () => {
    await show(
      sceneOf(["reloj-digital-loop-clock"], {
        "reloj-digital-loop-clock": {
          timezone: "Europe/Paris",
          textSequence: ["a"],
          ctaSequence: ["b"],
          mode: "countdown",
          countdownDuration: 60,
          countdownTargetSceneId: 9,
          countdownTransitionId: "fade",
          countdownCommand: 2,
        },
      }),
    );
    expect(stub("RelojDigitalLoopClock")).toMatchObject({
      timezone: "Europe/Paris",
      programId: "main",
      textSequence: ["a"],
      ctaSequence: ["b"],
      mode: "countdown",
      countdownDuration: 60,
      countdownTargetSceneId: 9,
      countdownTransitionId: "fade",
      countdownCommand: 2,
      allowProgramActivation: true,
    });
    cleanup();

    await show(sceneOf(["reloj-digital-loop-clock"]), {
      search: "?confidence=program",
    });
    expect(stub("RelojDigitalLoopClock")).toMatchObject({
      timezone: "America/New_York",
      mode: "clock",
      countdownDuration: 300,
      countdownTargetSceneId: null,
      countdownTransitionId: "cut",
      countdownCommand: 0,
      allowProgramActivation: false,
    });
  });

  it("shows one world clock for a layout, the first of the clock types, with its options", async () => {
    await show(
      sceneOf(["fifthbell-corner", "toni-clock", "fifthbell-clock"], {
        "toni-clock": {
          worldClockCities: ["Lisbon"],
          worldClockRotateIntervalMs: 3000,
          worldClockTransitionMs: 200,
          worldClockShuffle: true,
          worldClockWidthPx: 240,
          showWorldClocks: false,
        },
      }),
    );
    expect(stubs("ToniClock")).toHaveLength(1);
    expect(stub("ToniClock")).toMatchObject({
      cities: ["Lisbon"],
      rotationIntervalMs: 3000,
      transitionDurationMs: 200,
      shuffleCities: true,
      widthPx: 240,
      showWorldClocks: false,
      showBellIcon: true,
    });
    cleanup();

    await show(
      sceneOf(["toni-clock"], { "toni-clock": { showBellIcon: false } }),
    );
    expect(stub("ToniClock").showBellIcon).toBe(false);
    cleanup();
    await show(sceneOf(["toni-clock"]));
    expect(stub("ToniClock")).toMatchObject({
      cities: UNSET,
      rotationIntervalMs: UNSET,
      transitionDurationMs: UNSET,
      shuffleCities: UNSET,
      widthPx: UNSET,
      showWorldClocks: UNSET,
      showBellIcon: UNSET,
    });
  });

  it("passes the time override the broadcast settings carry to every clock", async () => {
    await show(
      sceneOf(["clock-widget", "reloj-clock", "toni-clock"]),
    );
    await emit({
      type: "broadcast_settings_snapshot",
      settings: {
        timeOverrideEnabled: true,
        timeOverrideStartTime: "2030-01-01T10:00:00Z",
        timeOverrideStartedAt: "2030-01-01T09:00:00Z",
      },
    });
    const override = {
      startTime: "2030-01-01T10:00:00Z",
      startedAt: "2030-01-01T09:00:00Z",
    };
    expect(stub("ClockWidget").timeOverride).toEqual(override);
    expect(stub("RelojClone").timeOverride).toEqual(override);
    expect(stub("ToniClock").timeOverride).toEqual(override);

    await emit({
      type: "broadcast_settings_update",
      settings: { timeOverrideEnabled: false },
    });
    expect(stub("ClockWidget").timeOverride).toBeNull();
    await emit({
      type: "broadcast_settings_update",
      settings: {
        timeOverrideEnabled: true,
        timeOverrideStartTime: "2031-01-01T10:00:00Z",
      },
    });
    expect(stub("ClockWidget").timeOverride).toBeNull();
    await emit({ type: "broadcast_settings_update", settings: "nothing" });
    expect(stub("ClockWidget").timeOverride).toBeNull();
  });
});

describe("the chyron and logo of the news program", () => {
  it("merges the chyron settings, the most specific one winning", async () => {
    await show(
      sceneOf(["toni-chyron", "fifthbell-chyron"], {
        "toni-chyron": { text: "From the old key", useMarquee: true },
        "fifthbell-chyron": {
          text: "From the new key",
          contentMode: "sequence",
          sequence: [{ text: "x" }],
          socialHandles: ["@x"],
        },
      }),
    );
    const chyrons = stubs("FifthBellChyron");
    expect(chyrons).toHaveLength(2);
    expect(chyrons[0]).toMatchObject({
      text: "From the old key",
      useMarquee: true,
      contentMode: "sequence",
      show: true,
    });
    expect(chyrons[1]).toMatchObject({
      text: "From the new key",
      useMarquee: true,
      sequence: [{ text: "x" }],
      socialHandles: ["@x"],
    });
  });

  it("falls back to empty text and no mode when the settings are not usable", async () => {
    await show(
      sceneOf(["toni-chyron"], {
        "toni-chyron": { text: 4, useMarquee: "yes", contentMode: "other" },
      }),
    );
    expect(stub("FifthBellChyron")).toMatchObject({
      text: "",
      useMarquee: UNSET,
      contentMode: UNSET,
    });
    cleanup();
    await show(
      sceneOf(["toni-chyron"], { "toni-chyron": { contentMode: "text" } }),
    );
    expect(stub("FifthBellChyron").contentMode).toBe("text");
  });

  it("shows the logo with its callsign, or none when the scene supplies none", async () => {
    await show(
      sceneOf(["toni-logo"], { "toni-logo": { callsign: "ZZ", subtitle: "Fictional" } }),
    );
    expect(stub("ToniLogo")).toMatchObject({ callsign: "ZZ", subtitle: "Fictional" });
    cleanup();
    await show(sceneOf(["toni-logo"]));
    // The console hardcodes no station mark: without a configured callsign there is none (#334).
    expect(stub("ToniLogo").callsign).toBe("");
  });

  it("shows the news program once, for the first of its component types, with the scene's settings", async () => {
    await show(
      sceneOf(["fifthbell-marquee", "fifthbell", "ticker"], {
        fifthbell: { headline: "Fictional" },
      }),
    );
    expect(stubs("FifthBellProgram")).toHaveLength(1);
    expect(stub("FifthBellProgram")).toMatchObject({
      programId: "main",
      embedded: true,
      masterGain: 1,
      activeComponents: ["fifthbell-marquee", "fifthbell", "ticker"],
      sceneMetadata: { fifthbell: { headline: "Fictional" } },
    });
    cleanup();
    await show(sceneOf(["header"]), {
      search: "?confidence=preview",
      staged: sceneOf(["fifthbell-content"], {}, 8),
    });
    expect(stub("FifthBellProgram").masterGain).toBe(0);
  });
});

describe("the chart badge", () => {
  it("asks for the live charts while the badge is on screen, and shows its rank and spins", async () => {
    chart.load.mockResolvedValue(EMPTY_CHARTS);
    await show(
      sceneOf(["earone"], { earone: { label: "Top 10", rank: 3, spins: 41 } }),
    );
    expect(chart.load).toHaveBeenCalledTimes(1);
    expect(stub("Earone")).toMatchObject({ label: "Top 10" });
    await advance(15000);
    expect(chart.load).toHaveBeenCalledTimes(2);
    cleanup();
    await show(sceneOf(["earone"]));
    expect(stub("Earone").label).toBe("EARONE");
  });

  it("logs a failed chart read and keeps the badge", async () => {
    chart.load.mockRejectedValue(new Error("feed down"));
    await show(sceneOf(["earone"]));
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch the chart feed:",
      expect.any(Error),
    );
    expect(present("Earone")).toBe(true);
  });

  it("does not ask for the charts for a layout without the badge", async () => {
    await show(sceneOf(["header"]));
    expect(chart.load).not.toHaveBeenCalled();
  });

  it("stops asking when the layout changes away from the badge", async () => {
    await show(sceneOf(["earone"]));
    expect(chart.load).toHaveBeenCalledTimes(1);
    await emit({
      type: "program_state_snapshot",
      state: stateOf(sceneOf(["header"])),
    });
    await advance(30000);
    expect(chart.load).toHaveBeenCalledTimes(1);
  });
});

describe("the Modo Italiano components", () => {
  it("draws a scene stored with the retired clock and chyron ids as the Giorgia row, with the props stored under the old keys", async () => {
    await show(
      sceneOf(["cronica-background", "modoitaliano-chyron", "cronica-chyron", "modoitaliano-clock"], {
        "modoitaliano-chyron": { show: false, textSequence: ["t"], ctaSequence: ["c"] },
        "modoitaliano-clock": { showWorldClocks: "off", showLogo: 0, showPlaybackProgress: "yes" },
      }),
    );
    expect(present("ModoItalianoGiorgiaClock")).toBe(false);
    expect(present("ModoItalianoGiorgiaChyron")).toBe(false);
    expect(present("CronicaBackground")).toBe(true);
    expect(present("CronicaChyron")).toBe(true);
    expect(stub("ModoItalianoProgramRow")).toMatchObject({
      programId: "main",
      plan: { clockType: "modoitaliano-giorgia-clock", chyronType: "modoitaliano-giorgia-chyron" },
      metadata: {
        "modoitaliano-giorgia-chyron": { show: false, textSequence: ["t"], ctaSequence: ["c"] },
        "modoitaliano-giorgia-clock": { showWorldClocks: "off", showLogo: 0, showPlaybackProgress: "yes" },
      },
    });
  });

  it("draws a retired clock beside the bracket as the standalone Giorgia clock with its stored settings", async () => {
    await show(
      sceneOf(["modoitaliano-clock", "modoitaliano-bracket"], {
        "modoitaliano-clock": { showWorldClocks: "off", showLogo: 0, showPlaybackProgress: "yes" },
      }),
    );
    expect(present("ModoItalianoProgramRow")).toBe(false);
    expect(present("ModoItalianoBracket")).toBe(true);
    expect(stub("ModoItalianoGiorgiaClock")).toMatchObject({
      programId: "main",
      transitionDurationMs: 300,
      shuffleCities: false,
      widthPx: 220,
      showWorldClocks: false,
      showLogo: false,
      showPlaybackProgress: true,
      showBellIcon: false,
      language: "es",
    });
  });

  it("draws a type once when a scene lists both its retired and its Giorgia id, with the props under the retired key, as the migration keeps them", async () => {
    await show(
      sceneOf(["modoitaliano-clock", "modoitaliano-giorgia-clock"], {
        "modoitaliano-clock": { showLogo: false },
        "modoitaliano-giorgia-clock": { showLogo: true },
      }),
    );
    expect(stubs("ModoItalianoGiorgiaClock")).toHaveLength(1);
    expect(stub("ModoItalianoGiorgiaClock")).toMatchObject({ showLogo: false });
  });

  it("shows the Giorgia clock and chyron on one bottom row, and the rest standalone", async () => {
    await show(
      sceneOf([
        "modoitaliano-giorgia-clock",
        "modoitaliano-giorgia-chyron",
      ]),
    );
    expect(present("ModoItalianoGiorgiaClock")).toBe(false);
    expect(present("ModoItalianoGiorgiaChyron")).toBe(false);
    expect(stub("ModoItalianoProgramRow")).toMatchObject({
      plan: { clockType: "modoitaliano-giorgia-clock" },
    });
  });

  it("shows the clock and chyron standalone when there is no row, with their settings and the song sequence", async () => {
    await show(
      sceneOf(["modoitaliano-giorgia-clock"], {
        "modoitaliano-giorgia-clock": {
          showWorldClocks: true,
          showLogo: "maybe",
          keySafe: "true",
        },
      }),
    );
    expect(stub("ModoItalianoGiorgiaClock")).toMatchObject({
      showWorldClocks: true,
      showLogo: true,
      showPlaybackProgress: true,
      keySafe: true,
    });
    expect(present("ModoItalianoProgramRow")).toBe(false);
    cleanup();

    await show(
      sceneOf(["modoitaliano-giorgia-chyron"], {
        "modoitaliano-giorgia-chyron": { keySafe: 1, textSequence: ["t"], ctaSequence: ["c"] },
      }),
    );
    expect(stub("ModoItalianoGiorgiaChyron")).toMatchObject({
      show: true,
      keySafe: true,
      textSequence: ["t"],
      ctaSequence: ["c"],
    });
  });

  it("hands the Giorgia clock and chyron their text, and the podcast player its episode and the output volume", async () => {
    await show(
      sceneOf(
        [
          "modoitaliano-podcast-player",
          "modoitaliano-giorgia-podcast-player",
          "modoitaliano-giorgia-artist-bumper",
        ],
        {
          "modoitaliano-podcast-player": {
            show: false,
            coverUrl: "https://x.example/c.jpg",
            episodeTitle: "Fictional episode",
            showName: "Fictional show",
            audioUrl: "https://x.example/e.mp3",
          },
          "modoitaliano-giorgia-artist-bumper": {
            show: false,
            artist: "Fictional artist",
            songTitle: "Fictional song",
            labelId: 4,
            images: ["https://x.example/a.jpg"],
            contentType: "image",
            creditLines: ["line"],
          },
        },
      ),
    );
    expect(stub("PodcastPlayer")).toMatchObject({
      show: false,
      coverUrl: "https://x.example/c.jpg",
      episodeTitle: "Fictional episode",
      showName: "Fictional show",
      audioUrl: "https://x.example/e.mp3",
      masterGain: 1,
    });
    expect(stub("ModoItalianoGiorgiaPodcastPlayer")).toMatchObject({
      show: true,
      coverUrl: "",
      episodeTitle: "",
      showName: "",
      audioUrl: "",
    });
    expect(stub("ModoItalianoGiorgiaArtistBumper")).toMatchObject({
      show: false,
      artist: "Fictional artist",
      songTitle: "Fictional song",
      labelId: 4,
      images: ["https://x.example/a.jpg"],
      contentType: "image",
      creditLines: ["line"],
    });
    cleanup();
    await show(sceneOf(["modoitaliano-giorgia-artist-bumper"]));
    expect(stub("ModoItalianoGiorgiaArtistBumper").show).toBe(true);
  });

  it("gives each podcast player its defaults for props it lacks, and its own when it has them", async () => {
    const episode = {
      show: false,
      coverUrl: "https://x.example/g.jpg",
      episodeTitle: "Fictional second episode",
      showName: "Fictional second show",
      audioUrl: "https://x.example/g.mp3",
    };
    await show(
      sceneOf(["modoitaliano-podcast-player", "modoitaliano-giorgia-podcast-player"], {
        "modoitaliano-podcast-player": { show: "yes", coverUrl: 4, episodeTitle: null, showName: [], audioUrl: {} },
        "modoitaliano-giorgia-podcast-player": episode,
      }),
    );
    expect(stub("PodcastPlayer")).toMatchObject({ show: true, coverUrl: "", episodeTitle: "", showName: "", audioUrl: "" });
    expect(stub("ModoItalianoGiorgiaPodcastPlayer")).toMatchObject(episode);
  });

  it("hands the bracket its rounds and votes, and starts it without a draw", async () => {
    await show(
      sceneOf(["modoitaliano-bracket"], {
        "modoitaliano-bracket": {
          title: "Fictional bracket",
          show: false,
          startRound: 2,
          matches: [{ id: 1 }],
          voters: ["v"],
          matchVotes: { 1: 3 },
          activeVotingMatchId: 1,
          votingWinnerId: 5,
          votingResultStartedAt: "2030-01-01T00:00:00Z",
        },
      }),
    );
    expect(stub("ModoItalianoBracket")).toMatchObject({
      title: "Fictional bracket",
      show: false,
      startRound: 2,
      matches: [{ id: 1 }],
      drawCommand: UNSET,
      voters: ["v"],
      matchVotes: { 1: 3 },
      activeVotingMatchId: 1,
      votingWinnerId: 5,
      votingResultStartedAt: "2030-01-01T00:00:00Z",
    });
    cleanup();
    await show(sceneOf(["modoitaliano-bracket"]));
    expect(stub("ModoItalianoBracket")).toMatchObject({ show: true, matches: [] });
  });
});

describe("the Cronica components", () => {
  it("shows the background, the chyron and the repeat notice with their text", async () => {
    await show(
      sceneOf(["cronica-background", "cronica-chyron", "cronica-reiteramos"], {
        "cronica-chyron": { text: "Fictional chyron" },
        "cronica-reiteramos": { text: "Fictional repeat", show: true },
      }),
    );
    expect(present("CronicaBackground")).toBe(true);
    expect(stub("CronicaChyron").text).toBe("Fictional chyron");
    expect(stub("CronicaReiteramos")).toMatchObject({
      text: "Fictional repeat",
      show: true,
    });
  });
});

describe("a scene that is not on air", () => {
  it("shows nothing for a scene that is missing", async () => {
    await show(null);
    expect(view.container.textContent).toContain("No Active Scene");
  });

  it("keeps a staged video scene on screen but silent until it is the scene on air", async () => {
    const staged = sceneOf(
      ["video-stream"],
      { "video-stream": { sourceUrl: "https://x.example/staged.m3u8" } },
      8,
    );
    await show(sceneOf(["header"]), { staged });
    expect(stub("VideoStream")).toMatchObject({
      sourceUrl: "https://x.example/staged.m3u8",
      channelGain: 0,
    });
    expect(present("Header")).toBe(true);
    cleanup();

    await show(staged, { staged });
    expect(stub("VideoStream")).toMatchObject({
      sourceUrl: "https://x.example/staged.m3u8",
      channelGain: 1,
    });
  });

  it("shows the staged scene on the preview monitor and the scene on air on the program monitor", async () => {
    const staged = sceneOf(["header"], { header: { title: "Staged scene" } }, 8);
    const live = sceneOf(["ticker"]);
    await show(live, { staged, search: "?confidence=preview" });
    expect(stub("Header").title).toBe("Staged scene");
    expect(present("Ticker")).toBe(false);
    cleanup();
    await show(live, { staged, search: "?confidence=program" });
    expect(present("Ticker")).toBe(true);
    expect(present("Header")).toBe(false);
    cleanup();
    await show(live, { search: "?confidence=other" });
    expect(present("Ticker")).toBe(true);
  });
});

describe("the remaining settings of the components", () => {
  it("keeps the guest source silent on a confidence monitor", async () => {
    await show(sceneOf(["webrtc-guest"]), { search: "?confidence=program" });
    expect(stub("WebrtcGuestSource").channelGain).toBe(0);
  });

  it("reads the chyron settings from whichever key the scene carries", async () => {
    await show(
      sceneOf(["fifthbell-chyron"], {
        "fifthbell-chyron": { text: "Only the new key" },
      }),
    );
    expect(stub("FifthBellChyron").text).toBe("Only the new key");
    cleanup();
    await show(
      sceneOf(["toni-chyron"], {
        "fifthbell-chyron": { text: "Only the other key" },
      }),
    );
    expect(stub("FifthBellChyron").text).toBe("Only the other key");
  });

  it("shows the chyrons of the Modo Italiano family unless told to hide them", async () => {
    await show(
      sceneOf(["modoitaliano-giorgia-chyron"]),
    );
    expect(stub("ModoItalianoGiorgiaChyron").show).toBe(true);
    cleanup();
    await show(
      sceneOf(["modoitaliano-giorgia-chyron"], {
        "modoitaliano-giorgia-chyron": { show: false },
      }),
    );
    expect(stub("ModoItalianoGiorgiaChyron").show).toBe(false);
  });

  it("shows the chart values of the song the chyron sequence is on", async () => {
    await show(
      sceneOf(["toni-chyron", "earone"], {
        "toni-chyron": {
          contentMode: "sequence",
          sequence: {
            mode: "manual",
            activeItemId: "a",
            items: [
              {
                id: "a",
                kind: "preset",
                text: "Fictional song",
                earoneSongId: "42",
                earoneRank: "3",
                earoneSpins: "9",
              },
            ],
          },
        },
      }),
    );
    expect(stub("Earone")).toMatchObject({ rank: "3", spins: "9" });
  });

  it("fades the program monitor to black and back from the state an event carries", async () => {
    await show(sceneOf(["header"]), { search: "?confidence=program" });
    const overlay = () =>
      view.container.querySelector(
        "[data-confidence-fade-to-black]",
      ) as HTMLElement;
    expect(overlay().getAttribute("data-confidence-fade-to-black")).toBe(
      "inactive",
    );
    await emit({
      type: "fade_to_black",
      state: { ...stateOf(sceneOf(["header"])), fadeToBlack: true },
    });
    expect(overlay().getAttribute("data-confidence-fade-to-black")).toBe("active");
    expect(overlay().style.opacity).toBe("1");
    await emit({
      type: "fade_to_black",
      state: { ...stateOf(sceneOf(["header"])), fadeToBlack: false },
    });
    expect(overlay().getAttribute("data-confidence-fade-to-black")).toBe(
      "inactive",
    );
    expect(overlay().style.opacity).toBe("0");
  });
});
