import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AudioLibrary,
  type AudioLibraryAsset,
  type AudioLibraryProps,
} from "./AudioLibrary";

// gaulatti/alcantara#288, part B: the dense Audio list, its detail panel and the one shared
// transport, with the stored analysis fields as they come from the media list.

const ANALYSIS = {
  status: "success" as const,
  cueInSeconds: 0.42,
  cueOutSeconds: 209.8,
  fadeInSeconds: null,
  fadeOutSeconds: null,
  overlapSeconds: null,
  integratedLufs: -9.8,
  truePeakDbtp: 0.6,
};

const asset = (
  id: string,
  overrides: Partial<AudioLibraryAsset> = {},
): AudioLibraryAsset => ({
  id,
  name: `Asset ${id}`,
  sourceUrl: `https://media.test/${id}.mp3`,
  capabilities: ["SONG"],
  labels: [],
  song: { durationMs: 214_000 },
  analysis: ANALYSIS,
  ...overrides,
});

const ASSETS: AudioLibraryAsset[] = [
  asset("harbor", { labels: [{ id: "l1", name: "Evening" }] }),
  asset("pending", {
    analysis: {
      ...ANALYSIS,
      status: "pending",
      cueInSeconds: null,
      cueOutSeconds: null,
      integratedLufs: null,
      truePeakDbtp: null,
      attempts: 1,
      nextAttemptAt: "14:20",
    },
  }),
  asset("failed", {
    analysis: {
      ...ANALYSIS,
      status: "failed",
      cueInSeconds: null,
      cueOutSeconds: null,
      integratedLufs: null,
      truePeakDbtp: null,
      error: "decode-failed",
      attempts: 2,
    },
  }),
  asset("station", {
    capabilities: ["INSTANT"],
    song: null,
    analysis: { ...ANALYSIS, cueOutSeconds: null, truePeakDbtp: -2.1 },
  }),
  asset("never", { analysis: null }),
  asset("old", { analysis: undefined }),
];

let paused = true;
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

beforeEach(() => {
  paused = true;
  play = vi.fn(async function (this: HTMLMediaElement) {
    paused = false;
    this.dispatchEvent(new Event("play"));
  });
  pause = vi.fn(function (this: HTMLMediaElement) {
    paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
    play as never,
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    pause as never,
  );
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
    () => paused,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(overrides: Partial<AudioLibraryProps<AudioLibraryAsset>> = {}) {
  const props: AudioLibraryProps<AudioLibraryAsset> = {
    assets: ASSETS,
    total: ASSETS.length,
    loading: false,
    capability: "",
    onCapabilityChange: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
    filtered: false,
    selectedIds: new Set(),
    onToggleSelected: vi.fn(),
    canDelete: () => false,
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<AudioLibrary {...props} />);
  return props;
}

const table = () => within(screen.getByRole("table"));
const rowOf = (name: string) =>
  table().getByText(name, { selector: "p" }).closest("tr")!;
const transport = () => screen.getByRole("group", { name: "Audio transport" });
const element = () =>
  screen.getByTestId("audio-transport") as HTMLAudioElement;

it("lists each asset with its length, loudness, peak and analysis state, reading only stored values", () => {
  setup();
  const harbor = rowOf("Asset harbor");
  expect(harbor).toHaveTextContent("Song");
  expect(harbor).toHaveTextContent("Evening");
  expect(harbor).toHaveTextContent("3:34");
  expect(harbor).toHaveTextContent("-9.8");
  expect(harbor).toHaveTextContent("+0.6");
  expect(harbor).toHaveTextContent("Measured");

  expect(rowOf("Asset pending")).toHaveTextContent("Measuring");
  // A failure keeps its pill to one line: the code is the tooltip (and the detail panel's State row).
  const failedPill = within(rowOf("Asset failed")).getByTestId("analysis-pill");
  expect(failedPill).toHaveTextContent("Failed");
  expect(failedPill).not.toHaveTextContent("decode-failed");
  expect(failedPill).toHaveAttribute("title", "Failed · decode-failed");
  expect(failedPill).toHaveClass("whitespace-nowrap");
  expect(
    within(rowOf("Asset harbor")).getByTestId("analysis-pill"),
  ).not.toHaveAttribute("title");
  // A clip with no stored length has no timeline, and no length.
  const station = rowOf("Asset station");
  expect(station).toHaveTextContent("No duration stored");
  expect(station).toHaveTextContent("Unlabeled");
  expect(within(station).queryByTestId("timeline")).toBeNull();
  // No analysis row, and no analysis in the response, are told apart.
  expect(rowOf("Asset never")).toHaveTextContent("Not analysed");
  expect(rowOf("Asset old")).toHaveTextContent("Analysis unavailable");
  expect(rowOf("Asset old")).not.toHaveTextContent("Not analysed");
  // Nothing that was not measured is shown as a number.
  for (const name of ["pending", "failed", "never", "old"]) {
    expect(rowOf(`Asset ${name}`)).not.toHaveTextContent("-9.8");
  }
});

it("reads the length from the analysis first, then from the song, and draws a timeline when either exists", () => {
  setup({
    assets: [
      asset("probed", {
        song: null,
        capabilities: ["INSTANT"],
        analysis: { ...ANALYSIS, durationSeconds: 12.5 },
      }),
      asset("both", {
        song: { durationMs: 214_000 },
        analysis: { ...ANALYSIS, durationSeconds: 200 },
      }),
      asset("song-only", { analysis: { ...ANALYSIS, durationSeconds: null } }),
      asset("neither", { song: null, analysis: ANALYSIS }),
    ],
  });
  expect(rowOf("Asset probed")).toHaveTextContent("0:12");
  expect(within(rowOf("Asset probed")).getByTestId("timeline")).toBeInTheDocument();
  // The analysis wins over the song's own length.
  expect(rowOf("Asset both")).toHaveTextContent("3:20");
  expect(rowOf("Asset song-only")).toHaveTextContent("3:34");
  expect(rowOf("Asset neither")).toHaveTextContent("No duration stored");
  expect(rowOf("Asset neither")).not.toHaveTextContent("0:00");
});

it("draws the cue-in and cue-out markers only where the analysis stored them", () => {
  setup();
  const harbor = within(rowOf("Asset harbor"));
  expect(harbor.getByTestId("cue-in")).toHaveAttribute("title", "In 0:00.4");
  expect(harbor.getByTestId("cue-out")).toHaveAttribute("title", "Out 3:29.8");
  expect(harbor.getByTestId("timeline-live").style.left).toMatch(/^0\.19/);
  // A song that was not measured has a span and no markers; one with no cue out has one marker.
  const pending = within(rowOf("Asset pending"));
  expect(pending.getByTestId("timeline")).toBeInTheDocument();
  expect(pending.queryByTestId("cue-in")).toBeNull();
  expect(pending.queryByTestId("timeline-live")).toBeNull();
});

it("filters by analysis state, with the count of each state", () => {
  setup();
  const state = screen.getByRole("group", { name: "Analysis state" });
  expect(within(state).getByRole("button", { name: /^All/ })).toHaveTextContent(
    "6",
  );
  expect(
    within(state).getByRole("button", { name: /^Measured/ }),
  ).toHaveTextContent("2");
  expect(
    within(state).getByRole("button", { name: /^Pending/ }),
  ).toHaveTextContent("1");
  fireEvent.click(within(state).getByRole("button", { name: /^Failed/ }));
  expect(table().getByText("Asset failed")).toBeInTheDocument();
  expect(table().queryByText("Asset harbor")).toBeNull();
  expect(screen.getByText("1 of 6 on this page")).toBeInTheDocument();
  fireEvent.click(within(state).getByRole("button", { name: /^All/ }));
  expect(screen.getByText("6 assets")).toBeInTheDocument();
});

it("asks the page for the capability and the search, and offers the same capabilities as the library", () => {
  const props = setup();
  const capability = screen.getByRole("group", { name: "Capability" });
  expect(
    within(capability)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Any", "Song", "Instant", "Background", "Transition"]);
  fireEvent.click(within(capability).getByRole("button", { name: "Instant" }));
  expect(props.onCapabilityChange).toHaveBeenCalledWith("INSTANT");
  fireEvent.change(screen.getByPlaceholderText("Search audio media…"), {
    target: { value: "bed" },
  });
  expect(props.onSearchChange).toHaveBeenCalledWith("bed");
});

it("shows the detail panel of the selected asset: timeline, meters and every stored field", () => {
  setup();
  const detail = screen.getByRole("complementary", {
    name: "Asset harbor details",
  });
  expect(within(detail).getByText("In 0:00.4")).toBeInTheDocument();
  expect(within(detail).getByText("Out 3:29.8")).toBeInTheDocument();
  expect(within(detail).getByText("LUFS")).toBeInTheDocument();
  expect(within(detail).getByTestId("meter-integratedLufs")).toBeInTheDocument();
  expect(within(detail).getByText("0.42 s")).toBeInTheDocument();
  expect(within(detail).getByText("209.80 s")).toBeInTheDocument();
  // The analysis stores no fades or overlap yet.
  expect(within(detail).getAllByText("Not measured")).toHaveLength(3);
  // ISRC and MusicBrainz rows exist only when the list returns them.
  expect(within(detail).queryByText("isrc")).toBeNull();

  fireEvent.click(rowOf("Asset failed"));
  const failed = screen.getByRole("complementary", {
    name: "Asset failed details",
  });
  expect(within(failed).getByText("2 of 3")).toBeInTheDocument();
  expect(within(failed).queryByTestId("meter-integratedLufs")).toBeNull();

  fireEvent.click(rowOf("Asset station"));
  const station = screen.getByRole("complementary", {
    name: "Asset station details",
  });
  expect(
    within(station).getByText(/No duration stored for this asset/),
  ).toBeInTheDocument();

  fireEvent.click(rowOf("Asset old"));
  expect(
    screen.getByText(/Analysis unavailable: the media list did not include it/),
  ).toBeInTheDocument();
});

it("shows the ISRC and MusicBrainz id when the list returns them", () => {
  setup({
    assets: [
      asset("tagged", {
        analysis: {
          ...ANALYSIS,
          isrc: "QZFAK2600123",
          musicbrainzRecordingId: "7d1c2a4e-9b20",
        },
      }),
    ],
  });
  expect(screen.getByText("QZFAK2600123")).toBeInTheDocument();
  expect(screen.getByText("7d1c2a4e-9b20")).toBeInTheDocument();
});

it("plays every asset through one shared transport, not one player per row", () => {
  setup();
  expect(document.querySelectorAll("audio")).toHaveLength(1);
  expect(within(transport()).getByText("Asset harbor")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Play Asset pending" }));
  expect(element().getAttribute("src")).toBe("https://media.test/pending.mp3");
  expect(play).toHaveBeenCalledTimes(1);
  expect(within(transport()).getByText("Asset pending")).toBeInTheDocument();
  expect(rowOf("Asset pending")).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("button", { name: "Pause Asset pending" }),
  ).toBeInTheDocument();

  // Another row takes over the same element.
  fireEvent.click(screen.getByRole("button", { name: "Play Asset station" }));
  expect(element().getAttribute("src")).toBe("https://media.test/station.mp3");
  expect(pause).toHaveBeenCalled();
  expect(document.querySelectorAll("audio")).toHaveLength(1);

  // Pause from the transport, then step through the list.
  fireEvent.click(within(transport()).getByRole("button", { name: "Pause" }));
  expect(screen.getByRole("button", { name: "Play Asset station" })).toBeInTheDocument();
  fireEvent.click(within(transport()).getByRole("button", { name: "Next" }));
  expect(within(transport()).getByText("Asset never")).toBeInTheDocument();
  fireEvent.click(
    within(transport()).getByRole("button", { name: "Previous" }),
  );
  expect(within(transport()).getByText("Asset station")).toBeInTheDocument();
});

it("selects with the arrow keys and plays with Space", () => {
  setup();
  rowOf("Asset harbor").focus();
  fireEvent.keyDown(rowOf("Asset harbor"), { key: "ArrowDown" });
  expect(rowOf("Asset pending")).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(rowOf("Asset pending"));
  fireEvent.keyDown(rowOf("Asset pending"), { key: " " });
  expect(play).toHaveBeenCalledTimes(1);
  expect(element().getAttribute("src")).toBe("https://media.test/pending.mp3");
  fireEvent.keyDown(rowOf("Asset pending"), { key: "ArrowUp" });
  expect(rowOf("Asset harbor")).toHaveAttribute("aria-selected", "true");
});

it("follows the clip's own length and position when the asset stores none", () => {
  setup({ assets: [asset("station", { song: null })] });
  fireEvent.click(screen.getByRole("button", { name: "Play Asset station" }));
  Object.defineProperty(element(), "duration", {
    configurable: true,
    value: 12,
  });
  fireEvent.loadedMetadata(element());
  Object.defineProperty(element(), "currentTime", {
    configurable: true,
    value: 5,
  });
  fireEvent.timeUpdate(element());
  expect(transport()).toHaveTextContent("0:05 / 0:12");
});

it("says when a clip cannot be played", async () => {
  play.mockRejectedValueOnce(new Error("blocked"));
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Play Asset harbor" }));
  expect(
    await screen.findByText("This clip cannot be played in the browser."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play Asset harbor" })).toBeInTheDocument();
});

it("leaves other audio alone: leaving the library pauses only the transport", () => {
  const listener = document.createElement("audio");
  document.body.append(listener);
  const listenerPause = vi.spyOn(listener, "pause");
  const { unmount } = render(
    <AudioLibrary
      assets={ASSETS}
      total={ASSETS.length}
      loading={false}
      capability=""
      onCapabilityChange={() => undefined}
      search=""
      onSearchChange={() => undefined}
      filtered={false}
      selectedIds={new Set()}
      onToggleSelected={() => undefined}
      canDelete={() => false}
      onDelete={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Play Asset harbor" }));
  expect(paused).toBe(false);
  unmount();
  expect(paused).toBe(true);
  expect(listenerPause).not.toHaveBeenCalled();
  listener.remove();
});

it("keeps selection, bulk controls and delete for standalone clips", () => {
  const onToggle = vi.fn();
  const onDelete = vi.fn();
  setup({
    selectedIds: new Set(["harbor"]),
    onToggleSelected: onToggle,
    canDelete: (candidate) => candidate.id === "old",
    onDelete,
    bulk: <p>Bulk label controls</p>,
  });
  expect(screen.getByText("Bulk label controls")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Asset pending" }));
  expect(onToggle).toHaveBeenCalledWith("pending", true);
  expect(element().getAttribute("src")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  fireEvent.click(rowOf("Asset old"));
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset old" }));
  expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "old" }));
});

it("shows a spinner while loading and an empty state when nothing matches", () => {
  const { rerender } = render(
    <AudioLibrary
      assets={[]}
      total={0}
      loading
      capability=""
      onCapabilityChange={() => undefined}
      search=""
      onSearchChange={() => undefined}
      filtered={false}
      selectedIds={new Set()}
      onToggleSelected={() => undefined}
      canDelete={() => false}
      onDelete={() => undefined}
    />,
  );
  expect(screen.queryByText("No audio media found")).toBeNull();
  rerender(
    <AudioLibrary
      assets={[]}
      total={0}
      loading={false}
      capability=""
      onCapabilityChange={() => undefined}
      search="x"
      onSearchChange={() => undefined}
      filtered
      selectedIds={new Set()}
      onToggleSelected={() => undefined}
      canDelete={() => false}
      onDelete={() => undefined}
    />,
  );
  expect(screen.getByText("No audio media found")).toBeInTheDocument();
  expect(screen.getByText("Clear the filters and try again.")).toBeInTheDocument();
});

it("unloads the playing clip when a filter unlists it, so the transport never acts on another clip", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Play Asset harbor" }));
  expect(element().getAttribute("src")).toBe("https://media.test/harbor.mp3");
  expect(
    within(transport()).getByRole("button", { name: "Pause" }),
  ).toBeInTheDocument();

  const state = screen.getByRole("group", { name: "Analysis state" });
  fireEvent.click(within(state).getByRole("button", { name: /^Failed/ }));
  // The audible clip is stopped and unloaded; the transport offers the first listed clip as Play.
  expect(pause).toHaveBeenCalled();
  expect(element().getAttribute("src")).toBeNull();
  expect(within(transport()).getByText("Asset failed")).toBeInTheDocument();
  expect(
    within(transport()).getByRole("button", { name: "Play" }),
  ).toBeInTheDocument();
  expect(
    within(transport()).queryByRole("button", { name: "Pause" }),
  ).toBeNull();

  // Pressing it plays that clip, and only then does it say Pause.
  fireEvent.click(within(transport()).getByRole("button", { name: "Play" }));
  expect(element().getAttribute("src")).toBe("https://media.test/failed.mp3");
  expect(
    within(transport()).getByRole("button", { name: "Pause" }),
  ).toBeInTheDocument();
});


// gaulatti/alcantara#404 (group B): the edge branches of the library: a stat the analysis did not store, the
// arrow keys at either end of the list, a clip the browser refuses after it loaded, the empty states, and the
// singular count.

it("shows a dash for a stat the analysis did not store", () => {
  setup();
  fireEvent.click(table().getByText("Asset pending", { selector: "p" }));
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
});

it("does not move past either end of the list with the arrow keys", () => {
  setup();
  const rows = screen.getAllByRole("row");
  const first = rows[1];
  const last = rows[rows.length - 1];
  fireEvent.keyDown(first, { key: "ArrowUp" });
  expect(element().getAttribute("src")).toBeNull();
  fireEvent.keyDown(last, { key: "ArrowDown" });
  expect(element().getAttribute("src")).toBeNull();
});

it("says a loaded clip cannot be played when the browser refuses it", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Play Asset harbor" }));
  fireEvent.error(element());
  expect(screen.getByText("This clip cannot be played in the browser.")).toBeInTheDocument();
});

it("explains an empty library with no filter, and asks for the filters to be cleared when one is set", () => {
  const { unmount } = render(
    <AudioLibrary assets={[]} total={0} loading={false} capability="" onCapabilityChange={() => undefined} search="" onSearchChange={() => undefined} filtered={false} selectedIds={new Set()} onToggleSelected={() => undefined} canDelete={() => false} onDelete={() => undefined} />,
  );
  expect(screen.getByText("This physical media type has no assets yet.")).toBeInTheDocument();
  unmount();
  render(
    <AudioLibrary assets={[]} total={6} loading={false} capability="" onCapabilityChange={() => undefined} search="zzz" onSearchChange={() => undefined} filtered selectedIds={new Set()} onToggleSelected={() => undefined} canDelete={() => false} onDelete={() => undefined} />,
  );
  expect(screen.getByText("Clear the filters and try again.")).toBeInTheDocument();
});

it("counts a single asset in the singular", () => {
  setup({ assets: [ASSETS[0]], total: 1 });
  expect(screen.getByText("1 asset")).toBeInTheDocument();
});
