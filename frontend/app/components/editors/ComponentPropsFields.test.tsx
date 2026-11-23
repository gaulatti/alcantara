import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComponentPropsFields, ZIndexField } from "./ComponentPropsFields";
import { FIFTHBELL_AVAILABLE_WEATHER_CITIES } from "../../utils/broadcast";

// gaulatti/alcantara#186, group E4: the scene attribute editor for every
// component type, through its props and the update it sends for each field.

// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fields(
  componentType: string,
  props: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const updateProp = vi.fn();
  const replaceProps = vi.fn();
  const view = render(
    <ComponentPropsFields
      componentType={componentType}
      props={props}
      updateProp={updateProp}
      replaceProps={replaceProps}
      songCatalog={[]}
      mediaGroups={[]}
      isLoadingMediaGroups={false}
      mediaLabels={[]}
      isLoadingMediaLabels={false}
      {...extra}
    />,
  );
  return { updateProp, replaceProps, view };
}

/** Changes the field showing `shown` and expects `prop` to receive `expected`. */
function edits(
  updateProp: ReturnType<typeof vi.fn>,
  type: string,
  shown: string,
  value: string,
  prop: string,
  expected: unknown,
) {
  fireEvent.change(screen.getByDisplayValue(shown), { target: { value } });
  expect(updateProp).toHaveBeenLastCalledWith(type, prop, expected);
}

const box = (name: string) =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;

it("edits the text fields of the ticker, chyron, header, QR code and Crónica types", () => {
  const ticker = fields("ticker", { hashtag: "#uno", url: "uno.test" });
  edits(ticker.updateProp, "ticker", "#uno", "#due", "hashtag", "#due");
  edits(ticker.updateProp, "ticker", "uno.test", "due.test", "url", "due.test");
  cleanup();
  const chyron = fields("chyron", { text: "Breaking" });
  edits(chyron.updateProp, "chyron", "Breaking", "Later", "text", "Later");
  cleanup();
  const header = fields("header", { title: "Morning", date: "Today" });
  edits(header.updateProp, "header", "Morning", "Evening", "title", "Evening");
  edits(header.updateProp, "header", "Today", "Tomorrow", "date", "Tomorrow");
  cleanup();
  const qr = fields("qr-code", { content: "https://a.test" });
  edits(
    qr.updateProp,
    "qr-code",
    "https://a.test",
    "https://b.test",
    "content",
    "https://b.test",
  );
  cleanup();
  const cronica = fields("cronica-chyron", { text: "Line one" });
  edits(
    cronica.updateProp,
    "cronica-chyron",
    "Line one",
    "Line two",
    "text",
    "Line two",
  );
  cleanup();
  // Without saved values every field starts empty.
  for (const type of [
    "ticker",
    "chyron",
    "header",
    "qr-code",
    "cronica-chyron",
    "video-stream",
    "stream-wall",
    "scoreboard",
    "broadcast-layout",
    "modoitaliano-disclaimer",
  ]) {
    fields(type);
    cleanup();
  }
});

it("says when a type has nothing to configure or no editor", () => {
  for (const [type, text] of [
    ["live-indicator", "No configurable attributes."],
    ["logo-widget", "No configurable attributes."],
    ["toni-logo", "No configurable attributes."],
    ["cronica-background", "No configurable fields for Cronica background."],
    ["corner-bug", "Corner bug has no configurable scene attributes."],
    ["brand-new-type", "No editor available for “brand-new-type”."],
  ]) {
    fields(type);
    expect(screen.getByText(text)).toBeInTheDocument();
    cleanup();
  }
});

it("hosts the dedicated editors for richer types", () => {
  for (const [type, marker] of [
    ["slideshow", "Image label"],
    ["toni-chyron", "Social Handles (comma-separated)"],
    ["fifthbell-chyron", "Social Handles (comma-separated)"],
    ["modoitaliano-chyron", "Main Chyron"],
    ["modoitaliano-giorgia-chyron", "Main Chyron"],
    ["reloj-digital-loop-clock", "Lower Third Title"],
    ["modoitaliano-bracket", "Matches Configuration"],
    ["modoitaliano-podcast-player", "Cover Art"],
    ["modoitaliano-giorgia-podcast-player", "Cover Art"],
    ["modoitaliano-giorgia-artist-bumper", "Show bumper"],
  ]) {
    fields(type);
    expect(screen.getAllByText(marker).length).toBeGreaterThan(0);
    cleanup();
  }
});

it("edits a video stream: source, poster, fit and playback switches stored as strings or numbers", () => {
  const { updateProp } = fields("video-stream", {
    sourceUrl: "https://s.test/a.m3u8",
    posterUrl: "https://s.test/p.jpg",
    objectFit: "contain",
    autoPlay: "off",
    loop: 1,
    showControls: "yes",
  });
  edits(
    updateProp,
    "video-stream",
    "https://s.test/a.m3u8",
    "https://s.test/b.m3u8",
    "sourceUrl",
    "https://s.test/b.m3u8",
  );
  edits(
    updateProp,
    "video-stream",
    "https://s.test/p.jpg",
    "",
    "posterUrl",
    "",
  );
  const fit = screen.getByRole("combobox");
  expect(fit).toHaveValue("contain");
  fireEvent.change(fit, { target: { value: "cover" } });
  expect(updateProp).toHaveBeenLastCalledWith(
    "video-stream",
    "objectFit",
    "cover",
  );
  expect(box("Autoplay").checked).toBe(false);
  expect(box("Loop").checked).toBe(true);
  expect(box("Show Native Controls").checked).toBe(true);
  fireEvent.click(box("Autoplay"));
  expect(updateProp).toHaveBeenLastCalledWith("video-stream", "autoPlay", true);
  fireEvent.click(box("Loop"));
  expect(updateProp).toHaveBeenLastCalledWith("video-stream", "loop", false);
  fireEvent.click(box("Show Native Controls"));
  expect(updateProp).toHaveBeenLastCalledWith(
    "video-stream",
    "showControls",
    false,
  );
  cleanup();
  fields("video-stream", { autoPlay: "maybe", loop: {}, showControls: 0 });
  expect(box("Autoplay").checked).toBe(true);
  expect(box("Loop").checked).toBe(false);
  expect(screen.getByRole("combobox")).toHaveValue("cover");
});

it("binds a WebRTC guest layout to a reusable slot", () => {
  const { updateProp } = fields("webrtc-guest", {
    slotNumber: 3,
    objectFit: "contain",
    showStatus: false,
  });
  const [slot, fit] = screen.getAllByRole("combobox");
  expect(slot).toHaveValue("3");
  expect(within(slot).getAllByRole("option")).toHaveLength(6);
  fireEvent.change(slot, { target: { value: "5" } });
  expect(updateProp).toHaveBeenLastCalledWith("webrtc-guest", "slotNumber", 5);
  expect(fit).toHaveValue("contain");
  fireEvent.change(fit, { target: { value: "cover" } });
  expect(updateProp).toHaveBeenLastCalledWith(
    "webrtc-guest",
    "objectFit",
    "cover",
  );
  fireEvent.click(box("Show offline state"));
  expect(updateProp).toHaveBeenLastCalledWith(
    "webrtc-guest",
    "showStatus",
    true,
  );
  cleanup();
  fields("webrtc-guest");
  expect(screen.getAllByRole("combobox")[0]).toHaveValue("1");
  expect(screen.getAllByRole("combobox")[1]).toHaveValue("cover");
  expect(box("Show offline state").checked).toBe(true);
});

it("edits a stream wall, bounding the stream count and the URL list", () => {
  const { updateProp } = fields("stream-wall", {
    title: "Guests",
    maxStreams: 3,
    urls: ["https://v.test/a", 7, "https://v.test/b"],
  });
  edits(updateProp, "stream-wall", "Guests", "Panel", "title", "Panel");
  const count = screen.getByRole("spinbutton");
  expect(count).toHaveValue(3);
  fireEvent.change(count, { target: { value: "9" } });
  expect(updateProp).toHaveBeenLastCalledWith("stream-wall", "maxStreams", 4);
  fireEvent.change(count, { target: { value: "2.4" } });
  expect(updateProp).toHaveBeenLastCalledWith("stream-wall", "maxStreams", 2);
  fireEvent.change(count, { target: { value: "0" } });
  expect(updateProp).toHaveBeenLastCalledWith("stream-wall", "maxStreams", 1);
  const urls = screen.getByPlaceholderText(
    "https://vdo.ninja/?view=...",
  ) as HTMLTextAreaElement;
  expect(urls.value).toBe("https://v.test/a\nhttps://v.test/b");
  fireEvent.blur(urls, {
    target: {
      value:
        " https://v.test/1 ,https://v.test/2\n\nhttps://v.test/3\nhttps://v.test/4\nhttps://v.test/5",
    },
  });
  expect(updateProp).toHaveBeenLastCalledWith("stream-wall", "urls", [
    "https://v.test/1",
    "https://v.test/2",
    "https://v.test/3",
    "https://v.test/4",
  ]);
  cleanup();
  fields("stream-wall", { urls: "not a list" });
  expect(screen.getByRole("spinbutton")).toHaveValue(4);
  expect(
    (
      screen.getByPlaceholderText(
        "https://vdo.ninja/?view=...",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe("");
});

it("edits a scoreboard and its period and clock switches", () => {
  const { updateProp } = fields("scoreboard", {
    title: "FINAL",
    homeTeam: "ROMA",
    awayTeam: "LAZIO",
    homeScore: "2",
    awayScore: "1",
    period: "2ND",
    clock: "45:00",
    status: "LIVE",
    showPeriod: "no",
    showClock: true,
  });
  edits(updateProp, "scoreboard", "FINAL", "SEMIFINAL", "title", "SEMIFINAL");
  edits(updateProp, "scoreboard", "ROMA", "MILAN", "homeTeam", "MILAN");
  edits(updateProp, "scoreboard", "LAZIO", "INTER", "awayTeam", "INTER");
  edits(updateProp, "scoreboard", "2", "3", "homeScore", "3");
  edits(updateProp, "scoreboard", "1", "0", "awayScore", "0");
  edits(updateProp, "scoreboard", "2ND", "1ST", "period", "1ST");
  edits(updateProp, "scoreboard", "45:00", "12:00", "clock", "12:00");
  edits(updateProp, "scoreboard", "LIVE", "HT", "status", "HT");
  expect(box("Show Period").checked).toBe(false);
  fireEvent.click(box("Show Period"));
  expect(updateProp).toHaveBeenLastCalledWith("scoreboard", "showPeriod", true);
  fireEvent.click(box("Show Clock"));
  expect(updateProp).toHaveBeenLastCalledWith("scoreboard", "showClock", false);
  cleanup();
  fields("scoreboard");
  expect(screen.getAllByDisplayValue("0")).toHaveLength(2);
  expect(box("Show Period").checked).toBe(true);
});

it("edits a broadcast layout and shows its chyron text only while the chyron is on", () => {
  const { updateProp } = fields("broadcast-layout", {
    headerTitle: "News",
    hashtag: "#news",
    url: "news.test",
    showChyron: "true",
    chyronText: "Below",
    qrCodeContent: "https://qr.test",
    clockTimezone: "Europe/Rome",
  });
  edits(
    updateProp,
    "broadcast-layout",
    "News",
    "Evening news",
    "headerTitle",
    "Evening news",
  );
  edits(
    updateProp,
    "broadcast-layout",
    "#news",
    "#evening",
    "hashtag",
    "#evening",
  );
  edits(
    updateProp,
    "broadcast-layout",
    "news.test",
    "evening.test",
    "url",
    "evening.test",
  );
  edits(
    updateProp,
    "broadcast-layout",
    "Below",
    "Lower",
    "chyronText",
    "Lower",
  );
  edits(
    updateProp,
    "broadcast-layout",
    "https://qr.test",
    "https://qr2.test",
    "qrCodeContent",
    "https://qr2.test",
  );
  const zone = screen.getByRole("combobox");
  expect(zone).toHaveValue("Europe/Rome");
  fireEvent.change(zone, { target: { value: "Europe/Madrid" } });
  expect(updateProp).toHaveBeenLastCalledWith(
    "broadcast-layout",
    "clockTimezone",
    "Europe/Madrid",
  );
  fireEvent.click(box("Show Chyron"));
  expect(updateProp).toHaveBeenLastCalledWith(
    "broadcast-layout",
    "showChyron",
    false,
  );
  cleanup();
  fields("broadcast-layout", { showChyron: true });
  expect(screen.getByPlaceholderText("Optional lower chyron text")).toHaveValue(
    "",
  );
  cleanup();
  fields("broadcast-layout");
  expect(
    screen.queryByPlaceholderText("Optional lower chyron text"),
  ).toBeNull();
  // The Buenos Aires default is not asserted here: the picker lists the zones
  // Intl reports, which spell it America/Buenos_Aires (reported separately).
  expect(screen.getByRole("combobox")).toBeInTheDocument();
});

it("picks the timezone of the clock widgets, each with its own default", () => {
  const clocks: [type: string, fallback: string | null][] = [
    ["clock-widget", null],
    ["reloj-clock", null],
    ["reloj-loop-clock", "Europe/Madrid"],
  ];
  for (const [type, fallback] of clocks) {
    const { updateProp } = fields(type);
    const zone = screen.getByRole("combobox");
    if (fallback) expect(zone).toHaveValue(fallback);
    fireEvent.change(zone, { target: { value: "Europe/Rome" } });
    expect(updateProp).toHaveBeenLastCalledWith(
      type,
      "timezone",
      "Europe/Rome",
    );
    cleanup();
    fields(type, { timezone: "Asia/Tokyo" });
    expect(screen.getByRole("combobox")).toHaveValue("Asia/Tokyo");
    cleanup();
  }
  fields("reloj-loop-clock");
  expect(
    screen.getByText(/Loop sequence: Madrid, Sanremo, New York, Santiago/),
  ).toBeInTheDocument();
});

it("toggles the Modo Italiano clocks, with key-safe only on the Giorgia clock", () => {
  const { updateProp } = fields("modoitaliano-giorgia-clock", {
    showWorldClocks: false,
    showLogo: "off",
    showPlaybackProgress: 1,
    keySafe: true,
  });
  expect(box("Show World Clocks").checked).toBe(false);
  expect(box("Show Logo").checked).toBe(false);
  expect(box("Show Playback Progress").checked).toBe(true);
  for (const [name, prop, value] of [
    ["Show World Clocks", "showWorldClocks", true],
    ["Show Logo", "showLogo", true],
    ["Show Playback Progress", "showPlaybackProgress", false],
    ["Key-safe (for chroma key scenes)", "keySafe", false],
  ] as const) {
    fireEvent.click(box(name));
    expect(updateProp).toHaveBeenLastCalledWith(
      "modoitaliano-giorgia-clock",
      prop,
      value,
    );
  }
  cleanup();
  fields("modoitaliano-clock");
  expect(
    screen.queryByRole("checkbox", {
      name: "Key-safe (for chroma key scenes)",
    }),
  ).toBeNull();
  expect(box("Show World Clocks").checked).toBe(true);
});

it("edits the Toni and FifthBell clocks, their timing and the world clock cities", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const cities = [{ city: "SANREMO", timezone: "Europe/Rome" }];
  const { updateProp } = fields("toni-clock", {
    showBellIcon: true,
    worldClockShuffle: "yes",
    worldClockRotateIntervalMs: 7000,
    worldClockTransitionMs: 450,
    worldClockWidthPx: 260,
    worldClockCities: cities,
  });
  fireEvent.click(box("Show World Clocks"));
  expect(updateProp).toHaveBeenLastCalledWith(
    "toni-clock",
    "showWorldClocks",
    false,
  );
  fireEvent.click(box("Show Bell Icon"));
  expect(updateProp).toHaveBeenLastCalledWith(
    "toni-clock",
    "showBellIcon",
    false,
  );
  fireEvent.click(box("Shuffle world clocks"));
  expect(updateProp).toHaveBeenLastCalledWith(
    "toni-clock",
    "worldClockShuffle",
    false,
  );
  edits(
    updateProp,
    "toni-clock",
    "7000",
    "8000",
    "worldClockRotateIntervalMs",
    8000,
  );
  edits(updateProp, "toni-clock", "450", "300", "worldClockTransitionMs", 300);
  edits(updateProp, "toni-clock", "260", "220", "worldClockWidthPx", 220);
  const json = screen.getByDisplayValue(/SANREMO/) as HTMLTextAreaElement;
  expect(JSON.parse(json.value)).toEqual(cities);
  fireEvent.blur(json, {
    target: {
      value: JSON.stringify([
        { city: " ROMA ", timezone: " Europe/Rome " },
        { city: "", timezone: "x" },
        { city: "X" },
        { city: "Y", timezone: 5 },
        { timezone: "Europe/Rome" },
        [1],
        null,
        "text",
      ]),
    },
  });
  expect(updateProp).toHaveBeenLastCalledWith(
    "toni-clock",
    "worldClockCities",
    [{ city: "ROMA", timezone: "Europe/Rome" }],
  );
  fireEvent.blur(json, { target: { value: "   " } });
  expect(updateProp).toHaveBeenLastCalledWith(
    "toni-clock",
    "worldClockCities",
    [],
  );
  const calls = updateProp.mock.calls.length;
  fireEvent.blur(json, { target: { value: '{"city":"ROMA"}' } });
  fireEvent.blur(json, { target: { value: "[not json" } });
  expect(updateProp.mock.calls.length).toBe(calls);
  expect(errors).toHaveBeenCalledWith(
    "Invalid worldClockCities JSON:",
    expect.any(SyntaxError),
  );
  cleanup();
  fields("fifthbell-clock");
  expect(
    screen.getByText("FifthBell clock icon is always enabled."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Show Bell Icon" })).toBeNull();
  expect(screen.getByDisplayValue("5000")).toBeInTheDocument();
  expect(screen.getByDisplayValue("300")).toBeInTheDocument();
  expect(screen.getByDisplayValue("200")).toBeInTheDocument();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("[]");
});

it("edits the Modo Italiano disclaimer", () => {
  const { updateProp } = fields("modoitaliano-disclaimer", {
    text: "Fiction",
    show: "false",
    align: "center",
    bottomPx: 30,
    fontSizePx: 18,
    opacity: 0.5,
  });
  edits(
    updateProp,
    "modoitaliano-disclaimer",
    "Fiction",
    "Satire",
    "text",
    "Satire",
  );
  expect(box("Show Disclaimer").checked).toBe(false);
  fireEvent.click(box("Show Disclaimer"));
  expect(updateProp).toHaveBeenLastCalledWith(
    "modoitaliano-disclaimer",
    "show",
    true,
  );
  const align = screen.getByRole("combobox");
  expect(align).toHaveValue("center");
  fireEvent.change(align, { target: { value: "left" } });
  expect(updateProp).toHaveBeenLastCalledWith(
    "modoitaliano-disclaimer",
    "align",
    "left",
  );
  edits(updateProp, "modoitaliano-disclaimer", "30", "40", "bottomPx", 40);
  edits(updateProp, "modoitaliano-disclaimer", "18", "22", "fontSizePx", 22);
  edits(updateProp, "modoitaliano-disclaimer", "0.5", "0.9", "opacity", 0.9);
  cleanup();
  fields("modoitaliano-disclaimer");
  expect(screen.getByRole("combobox")).toHaveValue("right");
  for (const value of ["24", "20", "0.82"])
    expect(screen.getByDisplayValue(value)).toBeInTheDocument();
});

it("edits the Crónica banner and the EarOne chart card", () => {
  const banner = fields("cronica-reiteramos", { show: 0 });
  edits(
    banner.updateProp,
    "cronica-reiteramos",
    "REITERAMOS",
    "ÚLTIMO MOMENTO",
    "text",
    "ÚLTIMO MOMENTO",
  );
  fireEvent.click(box("Show banner"));
  expect(banner.updateProp).toHaveBeenLastCalledWith(
    "cronica-reiteramos",
    "show",
    true,
  );
  cleanup();
  fields("cronica-reiteramos", { text: "URGENTE" });
  expect(screen.getByDisplayValue("URGENTE")).toBeInTheDocument();
  expect(box("Show banner").checked).toBe(true);
  cleanup();
  const earone = fields("earone", { rank: "3", spins: "120" });
  edits(earone.updateProp, "earone", "EARONE", "CHART", "label", "CHART");
  edits(earone.updateProp, "earone", "3", "4", "rank", "4");
  edits(earone.updateProp, "earone", "120", "121", "spins", "121");
  cleanup();
  fields("earone", { label: "TOP 40" });
  expect(screen.getByDisplayValue("TOP 40")).toBeInTheDocument();
  expect(
    screen
      .getAllByPlaceholderText("Uses active sequence item")
      .map((input) => (input as HTMLInputElement).value),
  ).toEqual(["", ""]);
});

it("edits the full FifthBell program: segments, timing, weather cities, languages and marquee", () => {
  const { updateProp } = fields("fifthbell", {
    showArticles: false,
    showMarquee: "on",
    weatherCities: ["Rome", 9],
    languageRotation: ["it", 3, "en"],
    dataLoadTimeoutMs: 11000,
    articlesDurationMs: 12000,
    weatherDurationMs: 6000,
    earthquakesDurationMs: 13000,
    marketsDurationMs: 14000,
    playlistDefaultDurationMs: 15000,
    playlistUpdateIntervalMs: 250,
    audioCueEnabled: false,
    audioCueMinute: 58,
    audioCueSecond: 44,
    callsignPrelaunchUntilNyc: "2026-01-02T21:30:00",
    callsignWindowStartSecond: 41,
    callsignWindowEndSecond: 7,
    marqueeMinPostsCount: 6,
    marqueeMinAverageRelevance: 0.25,
    marqueeMinMedianRelevance: 0.35,
    marqueePixelsPerSecond: 180,
    marqueeMinDurationSeconds: 16,
    marqueeHeightPx: 90,
  });
  for (const [name, prop, value] of [
    ["Show Articles", "showArticles", true],
    ["Show Weather", "showWeather", false],
    ["Show Earthquakes", "showEarthquakes", false],
    ["Show Markets", "showMarkets", false],
    ["Show Bottom Marquee", "showMarquee", false],
    ["Show Callsign Take", "showCallsignTake", false],
    ["Audio Cue", "audioCueEnabled", true],
  ] as const) {
    fireEvent.click(box(name));
    expect(updateProp).toHaveBeenLastCalledWith("fifthbell", prop, value);
  }
  for (const [shown, value, prop, expected] of [
    ["11000", "9000", "dataLoadTimeoutMs", 9000],
    ["12000", "8000", "articlesDurationMs", 8000],
    ["6000", "7000", "weatherDurationMs", 7000],
    ["13000", "3000", "earthquakesDurationMs", 3000],
    ["14000", "4000", "marketsDurationMs", 4000],
    ["15000", "5000", "playlistDefaultDurationMs", 5000],
    ["250", "150", "playlistUpdateIntervalMs", 150],
    ["58", "57", "audioCueMinute", 57],
    ["44", "45", "audioCueSecond", 45],
    ["2026-01-02T21:30:00", "", "callsignPrelaunchUntilNyc", ""],
    ["41", "42", "callsignWindowStartSecond", 42],
    ["7", "8", "callsignWindowEndSecond", 8],
    ["6", "5", "marqueeMinPostsCount", 5],
    ["0.25", "0.3", "marqueeMinAverageRelevance", 0.3],
    ["0.35", "0.4", "marqueeMinMedianRelevance", 0.4],
    ["180", "200", "marqueePixelsPerSecond", 200],
    ["16", "12", "marqueeMinDurationSeconds", 12],
    ["90", "80", "marqueeHeightPx", 80],
  ] as const) {
    edits(updateProp, "fifthbell", shown, value, prop, expected);
  }
  expect(box("Rome").checked).toBe(true);
  fireEvent.click(box("Rome"));
  expect(updateProp).toHaveBeenLastCalledWith("fifthbell", "weatherCities", []);
  fireEvent.click(box("Tokyo"));
  expect(updateProp).toHaveBeenLastCalledWith("fifthbell", "weatherCities", [
    "Rome",
    "Tokyo",
  ]);
  expect(
    screen.getAllByRole("checkbox", {
      name: (name) =>
        (FIFTHBELL_AVAILABLE_WEATHER_CITIES as readonly string[]).includes(
          name,
        ),
    }),
  ).toHaveLength(FIFTHBELL_AVAILABLE_WEATHER_CITIES.length);
  edits(updateProp, "fifthbell", "it, en", " es , ,it ", "languageRotation", [
    "es",
    "it",
  ]);
});

it("shows only the content settings for FifthBell content, only the marquee for the marquee, and neither for the corner", () => {
  fields("fifthbell-content");
  expect(box("Show Articles").checked).toBe(true);
  expect(
    screen.queryByRole("checkbox", { name: "Show Bottom Marquee" }),
  ).toBeNull();
  expect(screen.queryByText("Marquee Settings")).toBeNull();
  expect(screen.getByDisplayValue("en, es, en, it")).toBeInTheDocument();
  for (const value of ["15000", "5000", "100", "59", "55", "50", "3"])
    expect(screen.getAllByDisplayValue(value).length).toBeGreaterThan(0);
  expect(box("Audio Cue").checked).toBe(true);
  cleanup();
  fields("fifthbell-marquee");
  expect(box("Show Bottom Marquee").checked).toBe(false);
  expect(screen.queryByRole("checkbox", { name: "Show Articles" })).toBeNull();
  expect(screen.queryByText("Weather Cities")).toBeNull();
  for (const value of ["4", "0", "150", "10", "72"])
    expect(screen.getAllByDisplayValue(value).length).toBeGreaterThan(0);
  cleanup();
  fields("fifthbell-corner");
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
});

it("edits a component z-index, defaulting a missing or invalid one to 0", () => {
  const updateProp = vi.fn();
  const { rerender } = render(
    <ZIndexField
      componentType="clock-widget"
      props={{ zIndex: 12 }}
      updateProp={updateProp}
    />,
  );
  const field = screen.getByRole("spinbutton");
  expect(field).toHaveValue(12);
  fireEvent.change(field, { target: { value: "-3" } });
  expect(updateProp).toHaveBeenLastCalledWith("clock-widget", "zIndex", -3);
  for (const zIndex of [undefined, Number.NaN, "5"]) {
    rerender(
      <ZIndexField
        componentType="clock-widget"
        props={{ zIndex }}
        updateProp={updateProp}
      />,
    );
    expect(screen.getByRole("spinbutton")).toHaveValue(0);
  }
});

// gaulatti/alcantara#333: the analog clock that renders as reloj-clock takes the
// station's logo from the scene instead of a fixed image.
it("sets the reloj-clock's logo from the scene", () => {
  const { updateProp } = fields("reloj-clock", { logoUrl: "/old.svg" });
  edits(updateProp, "reloj-clock", "/old.svg", "https://example.com/logo.svg", "logoUrl", "https://example.com/logo.svg");
  cleanup();
  fields("reloj-clock");
  expect(screen.getByPlaceholderText("https://example.com/logo.svg")).toHaveValue("");
});
