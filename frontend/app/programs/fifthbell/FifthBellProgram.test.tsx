import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FifthBellProgram from "./FifthBellProgram";

const m = vi.hoisted(() => ({
  engine: { current: null as any },
  engineState: { currentItemIndex: 2, progress: 0.5, isPaused: false },
  pause: vi.fn(),
  resume: vi.fn(),
  reset: vi.fn(),
  sse: { current: null as any },
  segs: {} as Record<string, any>,
  fetchEvents: vi.fn(),
  getCachedEvents: vi.fn(),
  hasEventChanges: vi.fn(),
  fetchArticles: vi.fn(),
  fetchEarthquakes: vi.fn(),
  fetchWeatherData: vi.fn(),
  fetchMarketData: vi.fn(),
  marquee: { current: null as any },
}));

vi.mock("../../hooks/useSSE", () => ({ useSSE: (options: any) => void (m.sse.current = options) }));
vi.mock("./events", () => ({
  fetchEvents: (...a: any[]) => m.fetchEvents(...a),
  getCachedEvents: () => m.getCachedEvents(),
  hasEventChanges: (...a: any[]) => m.hasEventChanges(...a),
}));
vi.mock("./components/Marquee", () => ({
  default: (props: any) => {
    m.marquee.current = props;
    return <button data-testid="marquee" onClick={props.onCycleComplete} />;
  },
}));
vi.mock("./components/MarqueeCurtain", () => ({
  MarqueeCurtain: ({ onComplete }: any) => <button data-testid="curtain" onClick={onComplete} />,
}));
vi.mock("./components/slides/CallsignSlide", () => ({
  CallsignSlide: ({ currentTime }: any) => <div data-testid="callsign">{currentTime.toISOString()}</div>,
}));
vi.mock("./components/slides/slideStyles", () => ({ slideStyles: ".x{}" }));
vi.mock("./segments", () => {
  const make = (name: string) => (items: any, setItems: any, language: string) => {
    const segment = m.segs[name]?.(items, setItems, language) ?? {
      id: name,
      render: (i: number, p: number) => <div data-testid={`seg-${name}`}>{`${name}:${i}:${p}`}</div>,
    };
    return segment;
  };
  return {
    createArticlesSegment: make("articles"),
    createWeatherSegment: make("weather"),
    createEarthquakeSegment: make("earthquakes"),
    createMarketsSegment: make("markets"),
    fetchArticles: (...a: any[]) => m.fetchArticles(...a),
    fetchEarthquakes: (...a: any[]) => m.fetchEarthquakes(...a),
    fetchWeatherData: (...a: any[]) => m.fetchWeatherData(...a),
    fetchMarketData: (...a: any[]) => m.fetchMarketData(...a),
    usePlaylistEngine: (options: any) => {
      m.engine.current = options;
      return {
        state: m.engineState,
        currentSegment: options.segments[0] ?? null,
        pause: m.pause,
        resume: m.resume,
        reset: m.reset,
      };
    },
  };
});

const flush = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const fetchMock = vi.fn();
const reload = vi.fn();
const city = (name: string) => ({ name });
const weather = [
  { region: "A", cities: [city("São Paulo"), city("Lima")] },
  { region: "B", cities: [city("Oslo")] },
];
const mount = async (props: any = {}) => {
  render(<FifthBellProgram sceneMetadata={{}} {...props} />);
  await flush();
};
const meta = (content: any = {}, marquee: any = {}, corner: any = {}) => ({
  "fifthbell-content": content,
  "fifthbell-marquee": marquee,
  "fifthbell-corner": corner,
});
const names = () => m.engine.current.segments.map((s: any) => s.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2030-06-01T12:30:10Z"));
  Object.values(m).forEach((v: any) => v?.mockReset?.());
  m.segs = {};
  m.engineState.isPaused = false;
  m.fetchArticles.mockResolvedValue([{ id: 1 }]);
  m.fetchEarthquakes.mockResolvedValue([{ id: 2 }]);
  m.fetchWeatherData.mockResolvedValue(weather);
  m.fetchMarketData.mockResolvedValue([{ id: 3 }]);
  m.fetchEvents.mockResolvedValue(undefined);
  m.getCachedEvents.mockReturnValue(null);
  m.hasEventChanges.mockReturnValue(false);
  fetchMock.mockReset().mockResolvedValue({ json: async () => ({ id: 1, activeSceneId: 5, activeScene: null, updatedAt: "" }) });
  vi.stubGlobal("fetch", fetchMock);
  reload.mockReset();
  vi.stubGlobal("location", { reload });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loading and layout", () => {
  it("shows the callsign slide while data loads, full-page or embedded, and reloads on timeout", async () => {
    m.fetchArticles.mockReturnValue(new Promise(() => {}));
    const { container } = render(<FifthBellProgram sceneMetadata={meta({ dataLoadTimeoutMs: 2000 })} />);
    await flush();
    expect(screen.getByTestId("callsign")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("min-h-screen");
    await flush(1999);
    expect(reload).not.toHaveBeenCalled();
    await flush(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("embeds without the page chrome and blanks the content layer when it is not active", async () => {
    m.fetchArticles.mockReturnValue(new Promise(() => {}));
    const { container } = render(<FifthBellProgram embedded sceneMetadata={{}} activeComponents={["fifthbell-marquee"]} />);
    await flush();
    expect(container.firstElementChild).toHaveClass("h-full");
    expect(screen.queryByTestId("callsign")).toBeNull();
  });
  it("renders the live stage with the current segment once data arrives", async () => {
    await mount();
    expect(screen.getByTestId("seg-articles")).toHaveTextContent("articles:2:0.5");
    expect(m.fetchArticles).toHaveBeenCalledWith("en");
    expect(names()).toEqual(["articles", "weather", "earthquakes", "markets"]);
  });
  it("embedded live stage has no scaling and the content layer can be blank", async () => {
    const { container } = render(<FifthBellProgram embedded sceneMetadata={{}} activeComponents={["fifthbell-marquee"]} />);
    await flush();
    expect(container.querySelector(".absolute.inset-0.bg-black")).not.toBeNull();
    expect(screen.queryByTestId("seg-articles")).toBeNull();
  });
  it("draws black when no segment is enabled", async () => {
    await mount({ sceneMetadata: meta({ showArticles: "off", showWeather: 0, showEarthquakes: "no", showMarkets: false }) });
    expect(names()).toEqual([]);
    expect(screen.queryByTestId("seg-articles")).toBeNull();
  });
  it("treats legacy and empty active components as everything active", async () => {
    await mount({ activeComponents: ["fifthbell"], sceneMetadata: meta({}, { showMarquee: true }) });
    expect(screen.getByTestId("marquee")).toBeInTheDocument();
    cleanup();
    await mount({ activeComponents: [], sceneMetadata: meta({}, { showMarquee: true }) });
    expect(screen.getByTestId("marquee")).toBeInTheDocument();
    cleanup();
    await mount({ activeComponents: ["fifthbell-content"], sceneMetadata: meta({}, { showMarquee: true }) });
    expect(screen.queryByTestId("marquee")).toBeNull();
  });
});

describe("scene state", () => {
  const scene = (metadata: string | null) => ({ id: 1, name: "s", layoutId: 1, layout: {}, chyronText: null, metadata });
  it("reads its config from the program state when not driven by a scene renderer", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ id: 1, activeSceneId: 1, activeScene: scene(JSON.stringify(meta({ showWeather: false }, { showMarquee: true }))), updatedAt: "" }),
    });
    render(<FifthBellProgram programId="my prog" />);
    await flush();
    expect(fetchMock.mock.calls[0][0]).toContain("/program/my%20prog/state");
    expect(names()).toEqual(["articles", "earthquakes", "markets"]);
    expect(screen.getByTestId("marquee")).toBeInTheDocument();
  });
  it("falls back to defaults for missing, unparseable or non-object metadata", async () => {
    for (const metadata of [null, "{nope", "[1]"]) {
      fetchMock.mockResolvedValue({ json: async () => ({ id: 1, activeSceneId: 1, activeScene: scene(metadata), updatedAt: "" }) });
      render(<FifthBellProgram />);
      await flush();
      expect(names()).toHaveLength(4);
      cleanup();
    }
  });
  it("logs a failed state fetch", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error("x"));
    render(<FifthBellProgram />);
    await flush();
    expect(error).toHaveBeenCalledWith("Failed to fetch FifthBell program state:", expect.any(Error));
  });
  it("follows scene changes announced over SSE and ignores them when driven by a scene renderer", async () => {
    render(<FifthBellProgram />);
    await flush();
    expect(m.sse.current.enabled).toBe(true);
    expect(m.sse.current.url).toContain("/program/fifthbell/events");
    const send = (data: any) => act(async () => void m.sse.current.onMessage(data));
    await send({ type: "scene_update", scene: scene(JSON.stringify(meta({ showArticles: false }))) });
    expect(names()).toEqual(["weather", "earthquakes", "markets"]);
    await send({ type: "scene_update" });
    expect(names()).toEqual(["weather", "earthquakes", "markets"]);
    await send({ type: "scene_cleared" });
    expect(names()).toHaveLength(4);
    await send({ type: "scene_change", state: { id: 1, activeSceneId: 1, activeScene: scene(JSON.stringify(meta({ showMarkets: false }))), updatedAt: "" } });
    expect(names()).toEqual(["articles", "weather", "earthquakes"]);
    await send({ type: "program_scenes_changed", state: { id: 1, activeSceneId: null, activeScene: null, updatedAt: "" } });
    await send({ type: "scene_change" });
    await send({ type: "other" });
  });
  it("ignores partial-state events before any state has loaded", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<FifthBellProgram />);
    await flush();
    await act(async () => {
      m.sse.current.onMessage({ type: "scene_update", scene: null });
      m.sse.current.onMessage({ type: "scene_cleared" });
    });
    expect(names()).toHaveLength(4);
    cleanup();
    fetchMock.mockClear();
    await mount();
    expect(m.sse.current.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("configuration", () => {
  it("clamps numbers, keeps strings, and reads legacy and corner props", async () => {
    await mount({
      sceneMetadata: {
        fifthbell: { playlistDefaultDurationMs: 99, showMarquee: "1", marqueeMinPostsCount: "7", worldClockWidthPx: 9999 },
        "fifthbell-content": {
          playlistUpdateIntervalMs: "250",
          playlistDefaultDurationMs: "abc",
          articlesDurationMs: 5000,
          weatherDurationMs: 1,
          callsignPrelaunchUntilNyc: " 2000-01-01T00:00:00 ",
          languageRotation: ["it", "xx", 4],
          weatherCities: [" Lima ", "Lima", "", 3],
        },
        "toni-clock": { showWorldClocks: "false", worldClockCities: [{ city: "A", timezone: "UTC" }, { city: "", timezone: "x" }, null, [], "s"] },
        "fifthbell-corner": { worldClockShuffle: "maybe", worldClockCities: "nope" },
        "fifthbell-marquee": { marqueePixelsPerSecond: 5, marqueeMinDurationSeconds: 500, marqueeHeightPx: 10 },
      },
    });
    expect(m.engine.current.defaultDurationMs).toBe(10000);
    expect(m.engine.current.updateIntervalMs).toBe(250);
    expect(m.segs).toBeDefined();
    expect(m.marquee.current).toMatchObject({ minPostsCount: 7, pixelsPerSecond: 10, minDurationSeconds: 120, heightPx: 72 });
    expect(m.fetchArticles).toHaveBeenCalledWith("it");
  });
  it("accepts a world clock list, drops its malformed entries, and defaults when none are usable", async () => {
    await mount({ sceneMetadata: meta({}, {}, { worldClockCities: [{ city: " A ", timezone: " UTC " }, { city: "", timezone: "x" }, null, [], "s", { city: 1, timezone: 2 }] }) });
    expect(screen.getByTestId("seg-articles")).toBeInTheDocument();
    cleanup();
    await mount({ sceneMetadata: meta({}, {}, { worldClockCities: [{ city: "", timezone: "" }] }) });
    expect(screen.getByTestId("seg-articles")).toBeInTheDocument();
  });
  it("uses the default language rotation when none of the configured languages is supported or it is not a list", async () => {
    await mount({ sceneMetadata: meta({ languageRotation: ["xx"] }) });
    expect(m.fetchArticles).toHaveBeenLastCalledWith("en");
    await act(async () => m.engine.current.onPlaylistLoop());
    await flush();
    expect(m.fetchArticles).toHaveBeenLastCalledWith("es");
  });
  it("treats the old OR-logic marquee trio as no thresholds", async () => {
    await mount({ sceneMetadata: meta({}, { showMarquee: true, marqueeMinPostsCount: 4, marqueeMinAverageRelevance: 5, marqueeMinMedianRelevance: 7 }) });
    expect(m.marquee.current).toMatchObject({ minPostsCount: 4, minAverageRelevance: 0, minMedianRelevance: 0 });
    cleanup();
    await mount({ sceneMetadata: meta({}, { showMarquee: true, marqueeMinPostsCount: 4, marqueeMinAverageRelevance: 6, marqueeMinMedianRelevance: 7 }) });
    expect(m.marquee.current).toMatchObject({ minAverageRelevance: 6, minMedianRelevance: 7 });
  });
  it("applies per-segment durations and filters weather by accented, case-insensitive city", async () => {
    const captured: Record<string, any> = {};
    for (const n of ["articles", "weather", "earthquakes", "markets"]) {
      m.segs[n] = (items: any) => (captured[n] = { id: n, items, render: () => null });
    }
    await mount({ sceneMetadata: meta({ articlesDurationMs: 11000, weatherDurationMs: 2000, earthquakesDurationMs: 3000, marketsDurationMs: 4000, weatherCities: ["sao paulo", "OSLO"] }) });
    expect(captured.articles.durationMsPerItem).toBe(11000);
    expect(captured.weather.durationMsPerItem).toBe(2000);
    expect(captured.earthquakes.durationMsPerItem).toBe(3000);
    expect(captured.markets.durationMsPerItem).toBe(4000);
    expect(captured.weather.items).toEqual([
      { region: "A", cities: [city("São Paulo")] },
      { region: "B", cities: [city("Oslo")] },
    ]);
  });
  it("rotates languages on each playlist loop and recovers when the rotation shrinks", async () => {
    const view = render(<FifthBellProgram sceneMetadata={meta({ languageRotation: ["en", "es", "it"] })} />);
    await flush();
    await act(async () => m.engine.current.onPlaylistLoop());
    await flush();
    expect(m.fetchArticles).toHaveBeenLastCalledWith("es");
    await act(async () => m.engine.current.onPlaylistLoop());
    await flush();
    expect(m.fetchArticles).toHaveBeenLastCalledWith("it");
    view.rerender(<FifthBellProgram sceneMetadata={meta({ languageRotation: ["en"] })} />);
    await flush();
    expect(m.fetchArticles).toHaveBeenLastCalledWith("en");
  });
});

describe("events and the marquee curtain", () => {
  const onMarquee = meta({}, { showMarquee: true });
  const stage = [{ id: "a" }];
  const articleSegment = (hooks: { onEnter?: boolean } = {}) => {
    const render = vi.fn(() => null);
    const onEnter = hooks.onEnter ? vi.fn() : undefined;
    m.segs.articles = () => ({ id: "articles", render, onEnter });
    return { render, onEnter };
  };
  it("loads cached events on startup", async () => {
    m.getCachedEvents.mockReturnValue(stage);
    await mount({ sceneMetadata: onMarquee });
    expect(m.marquee.current.events).toEqual(stage);
    expect(m.fetchEvents).toHaveBeenCalledWith({ language: "en", allowedLanguages: ["en"] });
  });
  it("refreshes events once per article and again after re-entering the segment", async () => {
    const hooks = articleSegment({ onEnter: true });
    await mount({ sceneMetadata: onMarquee });
    const segment = m.engine.current.segments[0];
    const before = m.fetchEvents.mock.calls.length;
    segment.render(0, 0);
    segment.render(0, 0.5);
    await flush();
    expect(m.fetchEvents.mock.calls.length).toBe(before + 1);
    segment.render(1, 0);
    await flush();
    expect(m.fetchEvents.mock.calls.length).toBe(before + 2);
    segment.onEnter();
    segment.render(1, 0);
    await flush();
    expect(m.fetchEvents.mock.calls.length).toBe(before + 3);
    expect(hooks.onEnter).toHaveBeenCalled();
    expect(hooks.render).toHaveBeenCalled();
  });
  it("tolerates a segment without an enter hook and an empty event cache", async () => {
    articleSegment();
    await mount({ sceneMetadata: onMarquee });
    const segment = m.engine.current.segments[0];
    segment.onEnter();
    segment.render(0, 0);
    await flush();
  });
  it("curtains the marquee after a cycle when new events differ, then adopts them", async () => {
    articleSegment();
    m.getCachedEvents.mockReturnValue(stage);
    await mount({ sceneMetadata: onMarquee });
    fireEvent.click(screen.getByTestId("marquee"));
    expect(screen.getByTestId("marquee")).toBeInTheDocument();
    m.hasEventChanges.mockReturnValue(true);
    const next = [{ id: "a" }, { id: "b" }];
    m.getCachedEvents.mockReturnValue(next);
    await act(async () => void m.engine.current.segments[0].render(7, 0));
    await flush();
    fireEvent.click(screen.getByTestId("marquee"));
    expect(screen.getByTestId("curtain")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("curtain"));
    expect(screen.getByTestId("marquee")).toBeInTheDocument();
    expect(m.marquee.current.events).toEqual(next);
  });
  it("keeps the stage events when the refreshed cache is identical", async () => {
    articleSegment();
    m.getCachedEvents.mockReturnValue(stage);
    await mount({ sceneMetadata: onMarquee });
    m.getCachedEvents.mockReturnValue([{ id: "a" }]);
    await act(async () => void m.engine.current.segments[0].render(1, 0));
    await flush();
    expect(m.hasEventChanges).not.toHaveBeenCalledWith(expect.anything(), [{ id: "a" }, { id: "b" }]);
  });
});

describe("audio", () => {
  const audio = () => document.querySelector("audio") as HTMLAudioElement;
  it("preloads once and follows the master gain", async () => {
    const view = render(<FifthBellProgram sceneMetadata={{}} masterGain={0.4} />);
    await flush();
    // The audio element only exists after the data loads, so the initial gain is not applied until it changes.
    view.rerender(<FifthBellProgram sceneMetadata={{}} masterGain={0.7} />);
    await flush();
    expect(audio().volume).toBeCloseTo(0.7);
    expect(audio().muted).toBe(false);
    view.rerender(<FifthBellProgram sceneMetadata={{}} masterGain={0} />);
    await flush();
    expect(audio().muted).toBe(true);
    view.rerender(<FifthBellProgram sceneMetadata={{}} masterGain={5} />);
    await flush();
    expect(audio().volume).toBe(1);
  });
  it("plays the cue at the configured minute and second, and logs a blocked playback", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const when = new Date("2030-06-01T12:30:10Z");
    await mount({ sceneMetadata: meta({ audioCueMinute: when.getMinutes(), audioCueSecond: when.getSeconds() + 3 }) });
    await flush(2000);
    expect(play).not.toHaveBeenCalled();
    await flush(1000);
    expect(play).toHaveBeenCalledTimes(1);
    play.mockRejectedValue(new Error("blocked"));
    cleanup();
    vi.setSystemTime(when);
    await mount({ sceneMetadata: meta({ audioCueMinute: when.getMinutes(), audioCueSecond: when.getSeconds() + 1 }) });
    await flush(1000);
    expect(log).toHaveBeenCalledWith("Audio playback prevented:", expect.any(Error));
  });
  it("does not schedule the cue when disabled", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    await mount({ sceneMetadata: meta({ audioCueEnabled: false, audioCueMinute: 30, audioCueSecond: 11 }) });
    await flush(5000);
    expect(play).not.toHaveBeenCalled();
  });
});

describe("callsign take", () => {
  const live = (content: any = {}, marquee: any = {}) => ({ sceneMetadata: meta({ callsignPrelaunchUntilNyc: "2000-01-01T00:00:00", ...content }, marquee) });
  it("is not shown outside the window after launch", async () => {
    await mount(live());
    expect(screen.queryByTestId("callsign")).toBeNull();
    expect(m.pause).not.toHaveBeenCalled();
  });
  it("shows before the launch time, pauses the playlist and hides the marquee", async () => {
    await mount({ sceneMetadata: meta({ callsignPrelaunchUntilNyc: "2999-01-01T00:00:00" }, { showMarquee: true }) });
    expect(screen.getByTestId("callsign")).toBeInTheDocument();
    expect(m.reset).toHaveBeenCalled();
    expect(m.pause).toHaveBeenCalled();
    expect(screen.queryByTestId("marquee")).toBeNull();
  });
  it("uses the default launch date when the configured one is not a date", async () => {
    await mount(live({ callsignPrelaunchUntilNyc: "garbage" }));
    expect(screen.queryByTestId("callsign")).toBeNull();
  });
  it("shows within the top-of-hour window on both sides of the hour", async () => {
    vi.setSystemTime(new Date("2030-06-01T12:59:55Z"));
    await mount(live({ callsignWindowStartSecond: 50 }));
    expect(screen.getByTestId("callsign")).toBeInTheDocument();
    cleanup();
    vi.setSystemTime(new Date("2030-06-01T13:00:02Z"));
    await mount(live({ callsignWindowEndSecond: 3 }));
    expect(screen.getByTestId("callsign")).toBeInTheDocument();
    cleanup();
    vi.setSystemTime(new Date("2030-06-01T13:00:10Z"));
    await mount(live());
    expect(screen.queryByTestId("callsign")).toBeNull();
  });
  it("can be switched off and resumes a paused playlist afterwards", async () => {
    m.engineState.isPaused = true;
    await mount({ sceneMetadata: meta({ showCallsignTake: false, callsignPrelaunchUntilNyc: "2999-01-01T00:00:00" }) });
    expect(screen.queryByTestId("callsign")).toBeNull();
    expect(m.resume).toHaveBeenCalled();
  });
  it("updates the displayed time each second while the take is up and does not reset twice", async () => {
    await mount({ sceneMetadata: meta({ callsignPrelaunchUntilNyc: "2999-01-01T00:00:00" }) });
    const first = screen.getByTestId("callsign").textContent;
    const resets = m.reset.mock.calls.length;
    await flush(2000);
    expect(screen.getByTestId("callsign").textContent).not.toBe(first);
    expect(m.reset.mock.calls.length).toBe(resets);
  });
});
