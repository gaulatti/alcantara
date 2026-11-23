import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ProgramSongPlaybackState,
  SongCatalogItem,
} from "../../models/broadcast";
import type { ProgramSongSequence } from "../../utils/programSequence";
import { deriveOnAir, formatClock, type OnAirInput } from "./onAir";
import { OnAirStrip } from "./OnAirStrip";
import { PlaySongNow } from "./PlaySongNow";
import { Meter } from "./primitives";
import { RadioTransport } from "./RadioTransport";
import {
  findPlayableSongs,
  foldForSearch,
  nextUp,
  onAirLeaf,
  rotationLeaves,
  type NextUpSong,
} from "./songs";
import { ARM_TIMEOUT_MS, useArmed } from "./useArmed";

// gaulatti/alcantara#298: the pieces of the Radio desk, each at the boundary where it could
// regress on a live program: arming and taking, holding to stop, searching to play now, and what
// the on-air strip says in each state.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const leaf = (id: string, title: string, artist = "Artist", extra = {}) => ({
  kind: "preset" as const,
  id,
  title,
  artist,
  coverUrl: "",
  audioUrl: `https://media.test/${id}.mp3`,
  songId: Number(id.replace(/\D/g, "")) || undefined,
  durationMs: 200_000,
  ...extra,
});
const sequence = (
  items: ReturnType<typeof leaf>[],
  extra: Partial<ProgramSongSequence> = {},
): ProgramSongSequence =>
  ({
    mode: "manual",
    loop: true,
    activeItemId: null,
    items,
    ...extra,
  }) as unknown as ProgramSongSequence;
const playback = (
  extra: Partial<ProgramSongPlaybackState> = {},
): ProgramSongPlaybackState => ({
  token: "s1:1",
  audioUrl: "https://media.test/s1.mp3",
  title: "Harbor Lights",
  artist: "Marisol Vega",
  progress: 0.3,
  currentTimeMs: 72_000,
  durationMs: 214_000,
  isPlaying: true,
  updatedAt: "2026-11-22T12:00:00Z",
  ...extra,
});
const nextSong: NextUpSong = {
  itemId: "s2",
  via: "rotation",
  title: "Copper Season",
  artist: "The Paper Hours",
  durationMs: 241_000,
};

/** Holds a hold-to-confirm control for longer than its hold time. */
async function hold(control: HTMLElement, ms = 700) {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
  try {
    fireEvent.pointerDown(control);
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    fireEvent.pointerUp(control);
  } finally {
    vi.useRealTimers();
  }
}

// ---------------------------------------------------------------- arm, then take

it("arms a value, never takes it without arming, and disarms itself after five seconds", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useArmed<string>());
  expect(result.current.take()).toBeNull();
  act(() => result.current.arm("song"));
  expect(result.current.armed).toBe("song");
  act(() => {
    vi.advanceTimersByTime(ARM_TIMEOUT_MS - 1);
  });
  expect(result.current.armed).toBe("song");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current.armed).toBeNull();
  expect(result.current.take()).toBeNull();

  // Arming again restarts the time, and taking clears it.
  act(() => result.current.arm("a"));
  act(() => {
    vi.advanceTimersByTime(4_000);
  });
  act(() => result.current.arm("b"));
  act(() => {
    vi.advanceTimersByTime(4_000);
  });
  expect(result.current.armed).toBe("b");
  let taken: string | null = null;
  act(() => {
    taken = result.current.take();
  });
  expect(taken).toBe("b");
  expect(result.current.armed).toBeNull();
});

function transport(
  overrides: Partial<React.ComponentProps<typeof RadioTransport>> = {},
) {
  const props = {
    next: nextSong as NextUpSong | null,
    onTake: vi.fn(async () => undefined),
    onTakeOffAir: vi.fn(async () => undefined),
    onListen: vi.fn(),
    listening: false,
    ...overrides,
  };
  render(<RadioTransport {...props} />);
  return props;
}

it("takes the next song only after it was cued: one press never goes on air", async () => {
  const props = transport();
  expect(screen.getByRole("button", { name: /^Take/ })).toBeDisabled();

  // Space with nothing cued explains itself and takes nothing.
  fireEvent.keyDown(window, { key: " " });
  expect(props.onTake).not.toHaveBeenCalled();
  expect(screen.getByText(/Cue next \(N\) first/)).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "n" });
  expect(screen.getByText("Cued")).toBeInTheDocument();
  expect(screen.getByText(/Copper Season — The Paper Hours/)).toBeInTheDocument();
  expect(props.onTake).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: " " });
  await waitFor(() => expect(props.onTake).toHaveBeenCalledTimes(1));
  expect(props.onTake).toHaveBeenCalledWith(nextSong);
  // The cue is spent: a second Space takes nothing.
  fireEvent.keyDown(window, { key: " " });
  expect(props.onTake).toHaveBeenCalledTimes(1);
});

it("takes with the Take button, clears a cue with Esc, and clears it by itself after five seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const props = transport();
  fireEvent.click(screen.getByRole("button", { name: /^Cue next/ }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByText("Cued")).toBeNull();
  expect(screen.getByRole("button", { name: /^Take/ })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: /^Cue next/ }));
  act(() => {
    vi.advanceTimersByTime(ARM_TIMEOUT_MS);
  });
  expect(screen.queryByText("Cued")).toBeNull();
  fireEvent.keyDown(window, { key: " " });
  expect(props.onTake).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /^Cue next/ }));
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: /^Take/ }));
  await waitFor(() => expect(props.onTake).toHaveBeenCalledWith(nextSong));
});

it("ignores the desk keys while a field has the focus or another layer owns the keyboard", () => {
  const props = transport();
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  fireEvent.keyDown(field, { key: "n" });
  fireEvent.keyDown(field, { key: " " });
  expect(screen.queryByText("Cued")).toBeNull();
  field.remove();
  cleanup();
  const closed = transport({ keysEnabled: false });
  fireEvent.keyDown(window, { key: "n" });
  expect(screen.queryByText("Cued")).toBeNull();
  expect(props.onTake).not.toHaveBeenCalled();
  expect(closed.onTake).not.toHaveBeenCalled();
});

it("says there is nothing to cue when the rotation has no next song, and shows a refused take", async () => {
  transport({ next: null });
  fireEvent.keyDown(window, { key: "n" });
  expect(screen.getByText(/Nothing to cue/)).toBeInTheDocument();
  cleanup();

  const refused = transport({
    onTake: vi.fn(async () => {
      throw new Error("Palazzo could not load the song");
    }),
  });
  fireEvent.keyDown(window, { key: "n" });
  fireEvent.keyDown(window, { key: " " });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Palazzo could not load the song",
  );
  expect(refused.onTake).toHaveBeenCalledOnce();
});

it("stops the song only on a hold, with the button or with the keys, and a click explains itself", async () => {
  const props = transport();
  const stop = screen.getByRole("button", { name: "Stop the song on air" });
  fireEvent.pointerDown(stop);
  fireEvent.pointerUp(stop);
  expect(props.onTakeOffAir).not.toHaveBeenCalled();
  expect(screen.getByText("Hold to stop the song on air (0.6 s).")).toBeInTheDocument();

  await hold(stop, 300);
  expect(props.onTakeOffAir).not.toHaveBeenCalled();
  await hold(stop, 700);
  await waitFor(() => expect(props.onTakeOffAir).toHaveBeenCalledOnce());
});

it("holds Alt and the period to stop the song, and releasing early cancels", async () => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
  const props = transport();
  fireEvent.keyDown(window, { key: ".", code: "Period", altKey: true });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  fireEvent.keyUp(window, { key: ".", code: "Period", altKey: true });
  await act(async () => {
    vi.advanceTimersByTime(700);
  });
  expect(props.onTakeOffAir).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: ".", code: "Period", altKey: true });
  await act(async () => {
    vi.advanceTimersByTime(700);
  });
  expect(props.onTakeOffAir).toHaveBeenCalledOnce();
  fireEvent.keyUp(window, { key: ".", code: "Period", altKey: true });
});

it("toggles the monitor with M and reports it pressed", () => {
  const props = transport({ listening: true });
  fireEvent.keyDown(window, { key: "m" });
  expect(props.onListen).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: /^Listen/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// ---------------------------------------------------------------- play a song now

const library = (id: number, title: string, artist = "Library Artist"): SongCatalogItem => ({
  id,
  artist,
  title,
  audioUrl: `https://media.test/lib-${id}.mp3`,
  coverUrl: null,
  durationMs: 180_000,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
});

it("finds songs in the rotation first and the library after it, ignoring accents and case, without repeats", () => {
  const leaves = [
    leaf("s1", "Canción de Cuna", "Marisol"),
    leaf("s2", "Copper Season"),
  ];
  const catalog = [
    library(1, "Canción de Cuna"), // the rotation's own song (same id as s1)
    library(5, "Cancion del Mar"),
    { ...library(6, "Cancion Prohibida"), enabled: false },
    library(7, "Other"),
  ];
  expect(foldForSearch("Canción")).toBe("cancion");
  const found = findPlayableSongs(leaves, catalog, "CANCION");
  expect(found.map((entry) => [entry.source, entry.title])).toEqual([
    ["rotation", "Canción de Cuna"],
    ["library", "Cancion del Mar"],
  ]);
  expect(findPlayableSongs(leaves, catalog, "  ")).toEqual([]);
  expect(findPlayableSongs(leaves, catalog, "marisol")[0].leaf?.id).toBe("s1");
  expect(findPlayableSongs(leaves, catalog, "o", 1)).toHaveLength(1);
});

function findSong(overrides: Partial<React.ComponentProps<typeof PlaySongNow>> = {}) {
  const props = {
    open: true,
    leaves: [leaf("s1", "Harbor Lights"), leaf("s2", "Copper Season")],
    catalog: [library(9, "Copper Library Cut")],
    onClose: vi.fn(),
    onCueNext: vi.fn(async () => undefined),
    onTakeNow: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<PlaySongNow {...props} />);
  return props;
}
const typeQuery = (value: string) =>
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search the rotation and the library" }),
    { target: { value } },
  );

it("queues a rotation song next with Enter or the button, and closes", async () => {
  const props = findSong();
  typeQuery("copper");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  await waitFor(() => expect(props.onCueNext).toHaveBeenCalledTimes(1));
  expect(props.onCueNext).toHaveBeenCalledWith(
    expect.objectContaining({ id: "s2" }),
  );
  expect(props.onTakeNow).not.toHaveBeenCalled();
  expect(props.onClose).toHaveBeenCalled();
});

it("takes a song now only after arming it: the first press arms, Confirm within five seconds takes", async () => {
  const props = findSong();
  typeQuery("harbor");
  fireEvent.click(screen.getByRole("button", { name: "Take now Harbor Lights" }));
  expect(props.onTakeNow).not.toHaveBeenCalled();
  expect(screen.getByText(/Confirm within 5 seconds/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Harbor Lights" }));
  await waitFor(() => expect(props.onTakeNow).toHaveBeenCalledTimes(1));
  expect(props.onTakeNow).toHaveBeenCalledWith(
    expect.objectContaining({ key: "rotation:s1" }),
  );
});

it("lets an armed take lapse after five seconds, and Esc disarms before it closes", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const props = findSong();
  typeQuery("harbor");
  fireEvent.click(screen.getByRole("button", { name: "Take now Harbor Lights" }));
  act(() => {
    vi.advanceTimersByTime(ARM_TIMEOUT_MS);
  });
  expect(screen.getByRole("button", { name: "Take now Harbor Lights" })).toBeInTheDocument();
  expect(screen.queryByText(/Confirm within/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Take now Harbor Lights" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.queryByText(/Confirm within/)).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onTakeNow).not.toHaveBeenCalled();
});

it("offers only Take now for a library song that is not in the rotation, and says so", async () => {
  const props = findSong();
  typeQuery("library");
  expect(screen.getByText("Not in the rotation")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Cue next/ })).toBeNull();
  // Enter arms it instead of queueing.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  expect(props.onCueNext).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Confirm Copper Library Cut" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Copper Library Cut" }));
  await waitFor(() => expect(props.onTakeNow).toHaveBeenCalledOnce());
  expect(vi.mocked(props.onTakeNow).mock.calls[0][0]).toMatchObject({
    source: "library",
    song: { id: 9 },
  });
});

it("moves with the arrow keys, says when nothing matches, and shows a refused take", async () => {
  const props = findSong({
    onTakeNow: vi.fn(async () => {
      throw new Error("Palazzo could not load the song");
    }),
  });
  typeQuery("o");
  const options = () => screen.getAllByRole("option");
  expect(options()[0]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
  expect(options()[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowUp" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowUp" });
  expect(options()[0]).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", shiftKey: true });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", shiftKey: true });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Palazzo could not load the song",
  );
  expect(props.onClose).not.toHaveBeenCalled();

  typeQuery("zzzz");
  expect(screen.getByText(/No song matches/)).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  expect(props.onCueNext).not.toHaveBeenCalled();
});

it("renders nothing while closed", () => {
  findSong({ open: false });
  expect(screen.queryByRole("dialog")).toBeNull();
});

// ---------------------------------------------------------------- the on-air strip

const base: OnAirInput = {
  playback: playback(),
  next: { title: "Copper Season", artist: "The Paper Hours", durationMs: 241_000 },
  mode: "autoplay",
  streamRunning: true,
  engine: { connected: true, degraded: false, unavailableLabel: "Engine unavailable" },
  monitor: "stopped",
};

it("says on air with the song, the time left, the intro state, what is next and the health chips", () => {
  const view = deriveOnAir({
    ...base,
    playback: playback({ introStatus: "completed" }),
  });
  expect(view).toMatchObject({
    state: "on-air",
    label: "On air",
    title: "Harbor Lights",
    artist: "Marisol Vega",
    elapsedMs: 72_000,
    remainingMs: 142_000,
    intro: { label: "Intro played" },
    next: { title: "Copper Season", detail: "The Paper Hours · 4:01" },
    modeLabel: "Autoplay",
  });
  expect(view.chips.map((chip) => [chip.id, chip.tone, chip.label])).toEqual([
    ["stream", "ok", "Stream verified"],
    ["engine", "ok", "Engine ready"],
    ["monitor", "idle", "Monitor off"],
  ]);

  render(<OnAirStrip view={view} programId="radio-demo" />);
  const strip = screen.getByRole("region", { name: "On air" });
  expect(strip).toHaveAttribute("data-state", "on-air");
  expect(within(strip).getByText("On air")).toBeInTheDocument();
  expect(within(strip).getByText("Harbor Lights")).toBeInTheDocument();
  expect(within(strip).getByTestId("intro-state")).toHaveTextContent("Intro played");
  expect(within(strip).getByLabelText("1:12 played, 2:22 left")).toBeInTheDocument();
  expect(within(strip).getByText("Next · Autoplay")).toBeInTheDocument();
  expect(within(strip).getByText("Copper Season")).toBeInTheDocument();
  expect(within(strip).getByText("Monitor off")).toBeInTheDocument();
});

it("says off air with nothing on air, and nothing cued when the rotation has no next song", () => {
  const view = deriveOnAir({ ...base, playback: null, next: null, mode: "manual" });
  expect(view).toMatchObject({
    state: "off-air",
    label: "Off air",
    title: null,
    elapsedMs: null,
    remainingMs: null,
    intro: null,
    next: null,
  });
  render(<OnAirStrip view={view} programId="radio-demo" />);
  expect(screen.getByText("Off air")).toBeInTheDocument();
  expect(screen.getByText("Nothing on air · radio-demo")).toBeInTheDocument();
  expect(screen.getByText("Nothing cued")).toBeInTheDocument();
  expect(screen.getByText("Next · Manual")).toBeInTheDocument();
});

it("says status delayed, with no frozen clock, when the telemetry is stale", () => {
  const view = deriveOnAir({
    ...base,
    playback: playback({ telemetryStale: true }),
  });
  expect(view).toMatchObject({
    state: "delayed",
    label: "Status delayed",
    elapsedMs: null,
    remainingMs: null,
    title: "Harbor Lights",
  });
  render(<OnAirStrip view={view} programId="radio-demo" />);
  expect(screen.getByText("Status delayed")).toBeInTheDocument();
  expect(screen.getByText("No live clock")).toBeInTheDocument();
  expect(screen.queryByText(/−/)).toBeNull();
});

it("names each intro state and never shows a time when the song has no length", () => {
  const intro = (status: ProgramSongPlaybackState["introStatus"], reason?: string) =>
    deriveOnAir({
      ...base,
      playback: playback({ introStatus: status, introFailureReason: reason ?? null }),
    }).intro;
  expect(intro("pending")).toEqual({ label: "Intro queued", tone: "info" });
  expect(intro("playing")).toEqual({ label: "Intro playing", tone: "info" });
  expect(intro("degraded", "recording missing")).toEqual({
    label: "Intro unavailable: recording missing",
    tone: "warn",
  });
  expect(intro("none")).toBeNull();
  expect(intro(undefined)).toBeNull();

  const noLength = deriveOnAir({
    ...base,
    playback: playback({ durationMs: null, title: "", artist: "" }),
  });
  expect(noLength.remainingMs).toBeNull();
  expect(noLength.elapsedMs).toBe(72_000);
  expect(noLength.title).toBe("Title unavailable");
  expect(noLength.artist).toBe("Artist unavailable");
  expect(formatClock(null)).toBe("—:—");
  expect(formatClock(Number.NaN)).toBe("—:—");
  // A clock past the end stays at the length.
  expect(
    deriveOnAir({ ...base, playback: playback({ currentTimeMs: 999_000 }) }).remainingMs,
  ).toBe(0);
});

it("never turns an unknown or failed state into a good one in the chips", () => {
  const chips = (input: Partial<OnAirInput>) =>
    deriveOnAir({ ...base, ...input }).chips.map((chip) => [chip.tone, chip.label]);
  expect(chips({ streamRunning: null })[0]).toEqual(["warn", "Stream unverified"]);
  expect(chips({ streamRunning: false })[0]).toEqual(["bad", "Stream offline"]);
  expect(
    chips({ engine: { connected: true, degraded: true, unavailableLabel: "x", detail: "slow" } })[1],
  ).toEqual(["warn", "Engine degraded"]);
  expect(
    chips({ engine: { connected: false, degraded: false, unavailableLabel: "Engine unavailable" } })[1],
  ).toEqual(["warn", "Engine unavailable"]);
  expect(chips({ monitor: "playing" })[2]).toEqual(["info", "Listening"]);
  expect(chips({ monitor: "buffering" })[2]).toEqual(["info", "Monitor starting"]);
  expect(chips({ monitor: "unavailable" })[2]).toEqual(["idle", "Monitor unavailable"]);
});

// ---------------------------------------------------------------- what plays next

it("names the next song: the Play Next queue first, then the one after the song on air, wrapping when it loops", () => {
  const items = [leaf("s1", "One"), leaf("s2", "Two"), leaf("s3", "Three")];
  const live = playback({ token: "s2:9", audioUrl: items[1].audioUrl });
  const via = (
    seq: ProgramSongSequence,
    playing: ProgramSongPlaybackState | null,
    queue: Array<{ id: string; itemId: string; enqueuedAt: number }> = [],
  ) => nextUp({ sequence: seq, queue, playback: playing });

  expect(via(sequence(items), live)).toMatchObject({ itemId: "s3", via: "rotation" });
  expect(
    via(sequence(items), live, [{ id: "q1", itemId: "s1", enqueuedAt: 1 }]),
  ).toMatchObject({ itemId: "s1", via: "queue", title: "One" });
  // The queued entry of a song that is no longer in the rotation is skipped.
  expect(
    via(sequence(items), live, [
      { id: "q0", itemId: "gone", enqueuedAt: 1 },
      { id: "q1", itemId: "s1", enqueuedAt: 2 },
    ]),
  ).toMatchObject({ itemId: "s1" });
  // The last song wraps when the rotation loops, and has no next when it does not.
  const last = playback({ token: "s3:9", audioUrl: items[2].audioUrl });
  expect(via(sequence(items), last)).toMatchObject({ itemId: "s1" });
  expect(via(sequence(items, { loop: false }), last)).toBeNull();
  // Nothing on air: the selected song's follower, else the first song.
  expect(via(sequence(items, { activeItemId: "s1" }), null)).toMatchObject({ itemId: "s2" });
  expect(via(sequence(items), null)).toMatchObject({ itemId: "s1" });
  expect(via(sequence([]), null)).toBeNull();
});

it("finds the song on air by its token, else by its audio address, else by the selection when addresses repeat", () => {
  const items = [
    leaf("s1", "One", "A", { audioUrl: "https://media.test/shared.mp3" }),
    leaf("s2", "Two", "A", { audioUrl: "https://media.test/shared.mp3" }),
    leaf("s3", "Three"),
  ];
  const leaves = rotationLeaves(items);
  expect(onAirLeaf(leaves, null, null)).toBeNull();
  expect(onAirLeaf(leaves, playback({ isPlaying: false }), null)).toBeNull();
  expect(onAirLeaf(leaves, playback({ token: "s3:1", audioUrl: "" }), null)?.id).toBe("s3");
  expect(
    onAirLeaf(leaves, playback({ token: "", audioUrl: "https://media.test/s3.mp3" }), null)?.id,
  ).toBe("s3");
  expect(
    onAirLeaf(leaves, playback({ token: "", audioUrl: "https://media.test/shared.mp3" }), "s2")?.id,
  ).toBe("s2");
  expect(
    onAirLeaf(leaves, playback({ token: "", audioUrl: "https://media.test/shared.mp3" }), null)?.id,
  ).toBe("s1");
  expect(onAirLeaf(leaves, playback({ token: "x:1", audioUrl: "https://media.test/none.mp3" }), null)).toBeNull();
  // Nested sequences are flattened in play order.
  expect(
    rotationLeaves([
      leaf("a", "A"),
      { kind: "sequence", id: "n", label: "n", sequence: sequence([leaf("b", "B"), leaf("c", "C")]) } as never,
    ]).map((entry) => entry.id),
  ).toEqual(["a", "b", "c"]);
});

// ---------------------------------------------------------------- the meter

it("draws the level, the live peak and the held peak, and colours a hold in the warning zone", () => {
  const { rerender } = render(
    <Meter label="Music live peak" value={40} peak={55} hold={95} min={0} max={100} warnFrom={90} />,
  );
  const meter = screen.getByRole("meter", { name: "Music live peak" });
  expect(meter).toHaveAttribute("aria-valuenow", "40");
  expect(within(meter).getByTestId("meter-fill").style.width).toBe("40%");
  expect(within(meter).getByTestId("meter-peak").style.left).toBe("calc(55% - 1px)");
  expect(within(meter).getByTestId("meter-hold").className).toContain("bg-terracotta");
  expect(within(meter).getByTestId("meter-warn").style.left).toBe("90%");
  rerender(<Meter label="Music live peak" value={null} min={-30} max={0} unit="LUFS" />);
  const empty = screen.getByRole("meter", { name: "Music live peak" });
  expect(empty).toHaveAttribute("aria-valuetext", "No level");
  expect(within(empty).queryByTestId("meter-fill")).toBeNull();
  rerender(<Meter label="Music live peak" value={-9.8} hold={-20} min={-30} max={0} unit="LUFS" warnFrom={-3} />);
  expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "-9.8 LUFS");
  expect(within(screen.getByRole("meter")).getByTestId("meter-hold").className).toContain("bg-accent-yellow");
});
