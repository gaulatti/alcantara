import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import FifthBellProgram from "./FifthBellProgram";
import { clearCachedEvents, type Event as NewsEvent } from "./events";

// The legacy renderer, segment factories, playlist engine, event cache and SSE
// hook remain real. Only browser media, clocks, SSE and remote feeds are fixtures.
vi.mock("../../utils/apiBaseUrl", () => ({
  apiUrl: (path: string) => `https://renderer.example.invalid${path}`,
}));
class FixtureEventSource {
  static instances: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FixtureEventSource.instances.push(this);
  }
  emit(data: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) }));
  }
}
type ComponentProps = Parameters<typeof FifthBellProgram>[0];
let paths: string[];
let unexpected: string[];
let stateMetadata: string | null;
let stateFailure: boolean;
let pendingState: Promise<Response> | null;
let pendingEvents: Promise<Response> | null;
let eventSnapshots: NewsEvent[][];
let articleCount: number;
let play: MockInstance<() => Promise<void>>;
let serial = 0;
const content = (values: Record<string, unknown> = {}) => ({
  showArticles: true,
  showWeather: false,
  showEarthquakes: false,
  showMarkets: false,
  showCallsignTake: false,
  audioCueEnabled: false,
  articlesDurationMs: 120000,
  ...values,
});
const metadata = (values: Record<string, unknown> = {}) => ({
  "fifthbell-content": content(values),
});
function state(raw: string | null = stateMetadata) {
  return {
    id: 1,
    activeSceneId: 7,
    activeScene: {
      id: 7,
      name: "Legacy newsroom",
      layoutId: 1,
      layout: {
        id: 1,
        name: "FifthBell",
        componentType: "fifthbell",
        settings: "{}",
      },
      chyronText: null,
      metadata: raw,
    },
    updatedAt: new Date().toISOString(),
  };
}
const newsEvent = (title = "Initial event"): NewsEvent => ({
  id: 1,
  uuid: "stable-event",
  title,
  summary: "Verified newsroom update",
  status: "open",
  created_at: "2026-10-24T10:00:00Z",
  updated_at: "2026-10-24T10:00:00Z",
  posts_count: 4,
  posts: Array.from({ length: 4 }, (_, index) => ({
    id: index,
    uuid: `post-${index}`,
    content: "Fixture update",
    source: "Fixture newsroom",
    uri: "https://news.example.invalid/story",
    hash: String(index),
    author: "Reporter",
    createdAt: "2026-10-24T10:00:00Z",
    relevance: 8,
    match_score: 1,
  })),
});
async function transport(input: RequestInfo | URL) {
  const url = new URL(String(input));
  // Record only the endpoint; provider query credentials never enter evidence.
  paths.push(`${url.hostname}${url.pathname}`);
  if (
    url.hostname === "renderer.example.invalid" &&
    url.pathname.endsWith("/state")
  ) {
    if (pendingState) return pendingState;
    if (stateFailure) throw new Error("Fixture state unavailable");
    return Response.json(state());
  }
  if (url.hostname === "cdn.fifthbell.com") {
    const language = url.pathname.includes("-es.")
      ? "Spanish"
      : url.pathname.includes("-it.")
        ? "Italian"
        : "English";
    return Response.json({
      articles: Array.from({ length: articleCount }, (_, index) => ({
        id: index + 1,
        title: `${language} newsroom story ${index + 1}`,
        excerpt: "Verified published story",
        slug: `newsroom-story-${index + 1}`,
        featured: true,
        featuredImage: {
          url: `https://images.example.invalid/story-${index + 1}.jpg`,
        },
        categories: [{ name: "News", slug: "news" }],
        publishedAt: new Date().toISOString(),
        status: "published",
      })),
    });
  }
  if (url.hostname === "api.open-meteo.com")
    return Response.json({
      current: { temperature_2m: 70, weather_code: 0 },
      daily: { temperature_2m_max: [74], temperature_2m_min: [60] },
    });
  if (
    url.hostname === "api.monitor.gaulatti.com" &&
    url.pathname === "/earthquakes"
  )
    return Response.json([
      {
        id: 1,
        magnitude: 5.5,
        depth: 12,
        timestamp: new Date().toISOString(),
        latitude: -33,
        longitude: -71,
        datapoints: [
          {
            source: "Fixture seismic agency",
            additionalData: { place: "Fixture coast" },
          },
        ],
      },
    ]);
  if (
    url.hostname === "api.monitor.gaulatti.com" &&
    url.pathname === "/events"
  ) {
    if (pendingEvents) return pendingEvents;
    const events =
      eventSnapshots.length > 1
        ? eventSnapshots.shift()!
        : (eventSnapshots[0] ?? []);
    return Response.json({ events, total: events.length });
  }
  if (url.hostname === "financialmodelingprep.com")
    return Response.json([
      {
        symbol: "UP",
        name: "Fixture rising company",
        price: 20,
        change: 2,
        changesPercentage: 10,
      },
      {
        symbol: "DOWN",
        name: "Fixture falling company",
        price: 30,
        change: -1,
        changesPercentage: -3,
      },
    ]);
  unexpected.push(`${url.hostname}${url.pathname}`);
  throw new Error(
    `Unexpected fixture endpoint: ${url.hostname}${url.pathname}`,
  );
}

beforeEach(() => {
  clearCachedEvents();
  paths = [];
  unexpected = [];
  articleCount = 1;
  stateMetadata = JSON.stringify(metadata());
  stateFailure = false;
  pendingState = null;
  pendingEvents = null;
  eventSnapshots = [[newsEvent()]];
  FixtureEventSource.instances = [];
  vi.useFakeTimers();
  // Advance between tests so real feed caches expire without modifying them.
  vi.setSystemTime(new Date(2026, 9, 24 + serial++, 12, 34, 0));
  vi.stubGlobal("fetch", vi.fn(transport));
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  clearCachedEvents();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
async function mount(props: ComponentProps = { sceneMetadata: metadata() }) {
  const result = render(<FifthBellProgram {...props} />);
  await settle();
  return result;
}
const article = () =>
  screen.queryByRole("heading", { name: "English newsroom story 1" });
function reloadBoundary() {
  const original = window;
  const reload = vi.fn();
  const location = { reload };
  vi.stubGlobal(
    "window",
    new Proxy(original, {
      get(target, key) {
        return key === "location" ? location : Reflect.get(target, key, target);
      },
    }),
  );
  return reload;
}

it("renders the actual published article with its producer URL and a fixed standalone stage", async () => {
  const view = await mount();
  expect(article()).toBeInTheDocument();
  expect(screen.getByAltText("English newsroom story 1")).toHaveAttribute(
    "src",
    "https://images.example.invalid/story-1.jpg",
  );
  expect(screen.getByAltText("Article QR code")).toHaveAttribute(
    "src",
    expect.stringContaining(
      encodeURIComponent("https://fifthbell.com/news/newsroom-story-1"),
    ),
  );
  expect(view.container.querySelector('[style*="width: 1920px"]')).toHaveStyle({
    width: "1920px",
    height: "1080px",
  });
  expect(
    paths.some((path) => path.startsWith("renderer.example.invalid")),
  ).toBe(false);
  expect(FixtureEventSource.instances).toHaveLength(0);
});

it("uses embedded dimensions and accepts null controlled metadata without subscribing to live state", async () => {
  const view = await mount({ embedded: true, sceneMetadata: null });
  expect(article()).toBeInTheDocument();
  expect(view.container.querySelector('[style*="width: 100%"]')).toHaveStyle({
    width: "100%",
    height: "100%",
  });
  expect(FixtureEventSource.instances).toHaveLength(0);
});

it("loads an encoded program identifier and closes the actual live SSE transport on unmount", async () => {
  const view = await mount({ programId: "news/channel 1" });
  expect(paths).toContain(
    "renderer.example.invalid/program/news%2Fchannel%201/state",
  );
  expect(FixtureEventSource.instances[0].url).toBe(
    "https://renderer.example.invalid/program/news%2Fchannel%201/events",
  );
  expect(article()).toBeInTheDocument();
  view.unmount();
  expect(FixtureEventSource.instances[0].close).toHaveBeenCalledTimes(1);
});

it.each(["{broken", "[]", '"not-a-record"', "null", null])(
  "keeps malformed live scene metadata %j from crashing the renderer",
  async (raw) => {
    stateMetadata = raw;
    await mount({});
    expect(article()).toBeInTheDocument();
  },
);

it("keeps remote state failure distinct from the independently loaded editorial feed", async () => {
  stateFailure = true;
  await mount({});
  expect(article()).toBeInTheDocument();
  expect(console.error).toHaveBeenCalledWith(
    "Failed to fetch FifthBell program state:",
    expect.any(Error),
  );
});

it("applies scene changes, scene updates and scene clearing through the real SSE hook", async () => {
  await mount({});
  const source = FixtureEventSource.instances[0];
  source.emit({
    type: "scene_change",
    state: state(
      JSON.stringify(metadata({ showArticles: false, showWeather: true })),
    ),
  });
  await settle();
  expect(screen.getByRole("heading", { name: "WEATHER" })).toBeInTheDocument();
  source.emit({
    type: "scene_update",
    scene: state(
      JSON.stringify(metadata({ showArticles: false, showMarkets: true })),
    ).activeScene,
  });
  await settle();
  expect(screen.getByText("Fixture rising company")).toBeInTheDocument();
  source.emit({ type: "scene_update" });
  source.emit({ type: "unrelated-event" });
  await settle();
  expect(screen.getByText("Fixture rising company")).toBeInTheDocument();
  source.emit({
    type: "program_scenes_changed",
    state: state(
      JSON.stringify(metadata({ showArticles: false, showEarthquakes: true })),
    ),
  });
  await settle();
  expect(screen.getByText("Fixture coast")).toBeInTheDocument();
  source.emit({ type: "scene_cleared" });
  await settle();
  expect(article()).toBeInTheDocument();
});

it("ignores scene-only updates before initial state arrives and later accepts the actual snapshot", async () => {
  let resolve!: (response: Response) => void;
  pendingState = new Promise<Response>((finish) => {
    resolve = finish;
  });
  await mount({});
  const source = FixtureEventSource.instances[0];
  source.emit({ type: "scene_update", scene: state().activeScene });
  source.emit({ type: "scene_cleared" });
  await settle();
  await act(async () => {
    resolve(Response.json(state()));
  });
  await settle();
  expect(article()).toBeInTheDocument();
});

it("never replaces explicitly controlled preview metadata with live state messages", async () => {
  const view = await mount({
    sceneMetadata: metadata({ showArticles: false, showMarkets: true }),
    embedded: true,
  });
  expect(screen.getByText("Fixture rising company")).toBeInTheDocument();
  expect(FixtureEventSource.instances).toHaveLength(0);
  view.rerender(
    <FifthBellProgram
      sceneMetadata={metadata({ showArticles: false, showEarthquakes: true })}
      embedded
    />,
  );
  await settle();
  expect(screen.getByText("Fixture coast")).toBeInTheDocument();
});

it.each([
  [true, true],
  ["yes", true],
  [" ON ", true],
  [1, true],
  [false, false],
  ["no", false],
  ["off", false],
  ["", false],
  [0, false],
  ["unrecognized", true],
  [null, true],
  [{}, true],
])(
  "normalizes authored article visibility %j to %s at the actual rendered layer",
  async (configured, shown) => {
    await mount({ sceneMetadata: metadata({ showArticles: configured }) });
    expect(Boolean(article())).toBe(shown);
  },
);

it.each(
  [undefined, [], ["fifthbell"], ["fifthbell-content"]].map((selection) => [
    selection,
  ]),
)(
  "preserves content availability for the supported layer selection %j",
  async (activeComponents) => {
    await mount({ sceneMetadata: metadata(), activeComponents });
    expect(article()).toBeInTheDocument();
  },
);

it("shows a marquee-only layer without exposing the independent content layer", async () => {
  await mount({
    activeComponents: ["fifthbell-marquee"],
    sceneMetadata: {
      ...metadata(),
      "fifthbell-marquee": { showMarquee: true },
    },
  });
  expect(article()).not.toBeInTheDocument();
  expect(screen.getByText("Initial event")).toBeInTheDocument();
});

it("does not expose the marquee when only the content layer was selected", async () => {
  await mount({
    activeComponents: ["fifthbell-content"],
    sceneMetadata: {
      ...metadata(),
      "fifthbell-marquee": { showMarquee: true },
    },
  });
  expect(article()).toBeInTheDocument();
  expect(screen.queryByText("Initial event")).not.toBeInTheDocument();
});

it("keeps unselected or empty content layers black instead of manufacturing a segment", async () => {
  await mount({
    activeComponents: ["fifthbell-corner"],
    sceneMetadata: metadata(),
  });
  expect(article()).not.toBeInTheDocument();
  expect(screen.queryByText("Initial event")).not.toBeInTheDocument();
});

it("hides the marquee when every playlist segment is explicitly disabled", async () => {
  await mount({
    sceneMetadata: {
      ...metadata({ showArticles: false }),
      "fifthbell-marquee": { showMarquee: true },
    },
  });
  expect(article()).not.toBeInTheDocument();
  expect(screen.queryByText("Initial event")).not.toBeInTheDocument();
});

it("retains the legacy layer configuration while allowing specific content overrides", async () => {
  await mount({
    sceneMetadata: {
      fifthbell: { ...content(), showArticles: false, showMarquee: true },
      "fifthbell-content": { showArticles: true },
    },
  });
  expect(article()).toBeInTheDocument();
  expect(screen.getByText("Initial event")).toBeInTheDocument();
});

it("normalizes legacy marquee thresholds and clamps authored height and movement limits", async () => {
  const view = await mount({
    sceneMetadata: {
      ...metadata(),
      "fifthbell-marquee": {
        showMarquee: true,
        marqueeMinPostsCount: 4,
        marqueeMinAverageRelevance: 5,
        marqueeMinMedianRelevance: 7,
        marqueeHeightPx: 5,
        marqueePixelsPerSecond: 10000,
        marqueeMinDurationSeconds: 0,
      },
    },
  });
  expect(screen.getByText("Initial event")).toBeInTheDocument();
  expect(
    screen.getByText("Initial event").closest('[style*="position: absolute"]'),
  ).toHaveStyle({ height: "72px" });
  await advance(100);
  expect(view.container.querySelector('[style*="marqueeFlow"]')).toHaveStyle({
    animation: "marqueeFlow 1.92s linear infinite",
  });
});

it("filters weather cities with whitespace and accent normalization, dropping empty regions", async () => {
  await mount({
    sceneMetadata: metadata({
      showArticles: false,
      showWeather: true,
      weatherCities: [" New York ", "BÓGOTÁ", "", 5, " New York "],
      weatherDurationMs: 1000,
      playlistUpdateIntervalMs: 1000,
    }),
  });
  expect(screen.getByRole("heading", { name: "New York" })).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Havana" }),
  ).not.toBeInTheDocument();
  for (let tick = 0; tick < 4; tick++) await advance(1000);
  expect(screen.getByRole("heading", { name: "Bogotá" })).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "New York" }),
  ).not.toBeInTheDocument();
});

it("keeps all weather cities when an old nonarray city setting is encountered", async () => {
  await mount({
    sceneMetadata: metadata({
      showArticles: false,
      showWeather: true,
      weatherCities: "New York",
    }),
  });
  expect(screen.getByRole("heading", { name: "New York" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Havana" })).toBeInTheDocument();
});

it("tolerates malformed optional corner records while keeping the live content and playlist valid", async () => {
  await mount({
    sceneMetadata: {
      ...metadata(),
      "toni-clock": null,
      "fifthbell-corner": {
        worldClockCities: [
          null,
          [],
          "bad",
          {},
          { city: 42, timezone: false },
          { city: " New York ", timezone: " America/New_York " },
        ],
        worldClockWidthPx: "not-number",
        worldClockShuffle: "yes",
      },
    },
  });
  expect(article()).toBeInTheDocument();
});

it("switches to the configured language and falls back when its language list is empty or invalid", async () => {
  const view = await mount({
    sceneMetadata: metadata({ languageRotation: ["it", "unsupported", 5] }),
  });
  expect(
    screen.getByRole("heading", { name: "Italian newsroom story 1" }),
  ).toBeInTheDocument();
  view.rerender(
    <FifthBellProgram sceneMetadata={metadata({ languageRotation: [] })} />,
  );
  await settle();
  expect(article()).toBeInTheDocument();
  view.rerender(
    <FifthBellProgram
      sceneMetadata={metadata({ languageRotation: "not-an-array" })}
    />,
  );
  await settle();
  expect(article()).toBeInTheDocument();
});

it("rotates language only after a complete real multi-segment playlist loop and resets a shortened list", async () => {
  const values = {
    articlesDurationMs: 1000,
    marketsDurationMs: 1000,
    playlistUpdateIntervalMs: 1000,
    showMarkets: true,
    languageRotation: ["en", "es"],
  };
  const view = await mount({ sceneMetadata: metadata(values) });
  for (let tick = 0; tick < 4; tick++) await advance(1000);
  await settle();
  expect(
    screen.getByRole("heading", { name: "Spanish newsroom story 1" }),
  ).toBeInTheDocument();
  view.rerender(
    <FifthBellProgram
      sceneMetadata={metadata({ ...values, languageRotation: ["it"] })}
    />,
  );
  await settle();
  expect(
    screen.getByRole("heading", { name: "Italian newsroom story 1" }),
  ).toBeInTheDocument();
});

it("takes the callsign during the authored prelaunch period and restores the playlist after launch", async () => {
  const view = await mount({
    sceneMetadata: metadata({
      showCallsignTake: true,
      callsignPrelaunchUntilNyc: "2100-01-01T12:00:00",
    }),
  });
  expect(screen.getByText(/This is fifth/)).toBeInTheDocument();
  expect(article()).not.toBeInTheDocument();
  view.rerender(
    <FifthBellProgram
      sceneMetadata={metadata({
        showCallsignTake: true,
        callsignPrelaunchUntilNyc: "2000-01-01T12:00:00",
      })}
    />,
  );
  await settle();
  expect(article()).toBeInTheDocument();
});

it("treats an invalid prelaunch date through the released default and honors an explicit disabled take", async () => {
  const view = await mount({
    sceneMetadata: metadata({
      showCallsignTake: true,
      callsignPrelaunchUntilNyc: "not-a-date",
    }),
  });
  expect(article()).toBeInTheDocument();
  view.rerender(
    <FifthBellProgram
      sceneMetadata={metadata({
        showCallsignTake: false,
        callsignPrelaunchUntilNyc: "2100-01-01T12:00:00",
      })}
    />,
  );
  await settle();
  expect(article()).toBeInTheDocument();
});

it("takes and releases the callsign at the real hourly schedule boundaries", async () => {
  vi.setSystemTime(new Date(2026, 9, 24, 12, 59, 49));
  await mount({
    sceneMetadata: metadata({
      showCallsignTake: true,
      callsignPrelaunchUntilNyc: "2000-01-01T00:00:00",
      callsignWindowStartSecond: 50,
      callsignWindowEndSecond: 3,
    }),
  });
  expect(article()).toBeInTheDocument();
  await advance(1000);
  expect(screen.getByText(/This is fifth/)).toBeInTheDocument();
  await advance(14000);
  expect(article()).toBeInTheDocument();
});

it("applies changed master gain and mute state to the real media element", async () => {
  const view = await mount();
  const audio = view.container.querySelector("audio")!;
  view.rerender(
    <FifthBellProgram sceneMetadata={metadata()} masterGain={0.25} />,
  );
  await settle();
  expect(audio.volume).toBe(0.25);
  expect(audio.muted).toBe(false);
  view.rerender(<FifthBellProgram sceneMetadata={metadata()} masterGain={0} />);
  await settle();
  expect(audio.volume).toBe(0);
  expect(audio.muted).toBe(true);
  view.rerender(<FifthBellProgram sceneMetadata={metadata()} masterGain={2} />);
  await settle();
  expect(audio.volume).toBe(1);
  expect(audio.muted).toBe(false);
});

it("plays the exact authored cue once at its scheduled second and rewinds the same media element", async () => {
  vi.setSystemTime(new Date(2026, 9, 24, 12, 34, 50));
  const view = await mount({
    sceneMetadata: metadata({
      audioCueEnabled: true,
      audioCueMinute: 34,
      audioCueSecond: 51,
    }),
  });
  const audio = view.container.querySelector("audio")!;
  audio.currentTime = 9;
  await advance(1000);
  expect(play).toHaveBeenCalledTimes(1);
  expect(audio.currentTime).toBe(0);
  await advance(1000);
  expect(play).toHaveBeenCalledTimes(1);
});

it("contains browser autoplay rejection and leaves the running editorial segment intact", async () => {
  vi.setSystemTime(new Date(2026, 9, 24, 12, 34, 50));
  play.mockRejectedValue(new Error("Fixture autoplay denied"));
  await mount({
    sceneMetadata: metadata({
      audioCueEnabled: true,
      audioCueMinute: 34,
      audioCueSecond: 51,
    }),
  });
  await advance(1000);
  expect(console.log).toHaveBeenCalledWith(
    "Audio playback prevented:",
    expect.any(Error),
  );
  expect(article()).toBeInTheDocument();
});

it("keeps disabled cues silent and removes all interval work when unmounted", async () => {
  vi.setSystemTime(new Date(2026, 9, 24, 12, 34, 50));
  const view = await mount({
    sceneMetadata: metadata({
      audioCueEnabled: false,
      audioCueMinute: 34,
      audioCueSecond: 51,
    }),
  });
  await advance(1000);
  expect(play).not.toHaveBeenCalled();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("publishes a changed event snapshot only after the real marquee cycle and curtain complete", async () => {
  eventSnapshots = [[newsEvent("Initial event")], [newsEvent("Updated event")]];
  const view = await mount({
    sceneMetadata: {
      ...metadata(),
      "fifthbell-marquee": { showMarquee: true },
    },
  });
  expect(screen.getByText("Initial event")).toBeInTheDocument();
  expect(screen.queryByText("Updated event")).not.toBeInTheDocument();
  fireEvent.animationIteration(
    view.container.querySelector('[style*="marqueeFlow"]')!,
  );
  await settle();
  expect(screen.queryByText("Initial event")).not.toBeInTheDocument();
  expect(
    screen.getByText(
      (_, node) =>
        node?.tagName === "SPAN" && node.textContent === "This is fifthbell.",
    ),
  ).toBeInTheDocument();
  await advance(5000);
  expect(screen.getByText("Updated event")).toBeInTheDocument();
  fireEvent.animationIteration(
    view.container.querySelector('[style*="marqueeFlow"]')!,
  );
  await settle();
  expect(screen.getByText("Updated event")).toBeInTheDocument();
});

it("keeps an unchanged marquee snapshot on air across a cycle without inserting a curtain", async () => {
  const view = await mount({
    sceneMetadata: {
      ...metadata(),
      "fifthbell-marquee": { showMarquee: true },
    },
  });
  fireEvent.animationIteration(
    view.container.querySelector('[style*="marqueeFlow"]')!,
  );
  await settle();
  expect(screen.getByText("Initial event")).toBeInTheDocument();
  expect(
    screen.queryByText(
      (_, node) =>
        node?.tagName === "SPAN" && node.textContent === "This is fifthbell.",
    ),
  ).not.toBeInTheDocument();
});

it("requests a browser reload only after an unfinished initial data deadline expires", async () => {
  const reload = reloadBoundary();
  pendingEvents = new Promise<Response>(() => undefined);
  await mount({ sceneMetadata: metadata({ dataLoadTimeoutMs: 1000 }) });
  await advance(999);
  expect(reload).not.toHaveBeenCalled();
  await advance(1);
  expect(reload).toHaveBeenCalledTimes(1);
});

it("cancels the data deadline when real feeds finish before it", async () => {
  const reload = reloadBoundary();
  let resolve!: (response: Response) => void;
  pendingEvents = new Promise<Response>((finish) => {
    resolve = finish;
  });
  await mount({ sceneMetadata: metadata({ dataLoadTimeoutMs: 1000 }) });
  await advance(500);
  pendingEvents = null;
  await act(async () => {
    resolve(Response.json({ events: [], total: 0 }));
  });
  await settle();
  expect(article()).toBeInTheDocument();
  await advance(1500);
  expect(reload).not.toHaveBeenCalled();
});

it("removes a pending reload deadline when its renderer unmounts", async () => {
  const reload = reloadBoundary();
  pendingEvents = new Promise<Response>(() => undefined);
  const view = await mount({
    sceneMetadata: metadata({ dataLoadTimeoutMs: 1000 }),
  });
  await advance(500);
  view.unmount();
  await advance(2000);
  expect(reload).not.toHaveBeenCalled();
});
