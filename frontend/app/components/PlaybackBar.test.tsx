import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaybackBar } from "./PlaybackBar";
import type {
  ProgramSongSequence,
  ProgramSongSequenceLeafItem,
} from "../utils/programSequence";
import type { ProgramSongPlaybackState } from "../models/broadcast";

const sequence: ProgramSongSequence = {
  mode: "manual",
  loop: false,
  startedAt: 1_000,
  activeItemId: "song-2",
  items: [
    {
      id: "song-1",
      kind: "preset",
      artist: "Artist one",
      title: "Song one",
      coverUrl: "",
      audioUrl: "https://example.test/song-1.mp3",
      durationMs: 60_000,
    },
    {
      id: "song-2",
      kind: "preset",
      artist: "Artist two",
      title: "Song two",
      coverUrl: "",
      audioUrl: "https://example.test/song-2.mp3",
      durationMs: 60_000,
    },
    {
      id: "song-3",
      kind: "preset",
      artist: "Artist three",
      title: "Song three",
      coverUrl: "",
      audioUrl: "https://example.test/song-3.mp3",
      durationMs: 60_000,
    },
  ],
};

/** The fixture's songs, typed as the leaves they are. */
const songs = sequence.items as ProgramSongSequenceLeafItem[];

afterEach(() => cleanup());

it("exposes mutually exclusive playback modes and independent loop state", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={onChange}
    />,
  );

  expect(screen.getByRole("button", { name: "Manual" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Autoplay" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    screen.getByRole("button", { name: "Shuffle playlist" }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    screen.getByRole("button", { name: "Loop playlist: off" }),
  ).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(screen.getByRole("button", { name: "Autoplay" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "autoplay", activeItemId: "song-2" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: off" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ loop: true }),
  );

  rerender(
    <PlaybackBar
      sequence={{ ...sequence, mode: "shuffle" }}
      programSongPlayback={null}
      onChange={onChange}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Shuffle playlist" }),
  ).toHaveAttribute("aria-pressed", "true");
  const beforeShuffle = Date.now();
  fireEvent.click(screen.getByRole("button", { name: "Shuffle playlist" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      mode: "shuffle",
      activeItemId: "song-2",
      startedAt: expect.any(Number),
    }),
  );
  expect(onChange.mock.lastCall?.[0].startedAt).toBeGreaterThanOrEqual(
    beforeShuffle,
  );
});

it("plays the current selection once and does not duplicate persistence", () => {
  const onChange = vi.fn();
  const onTakeSelection = vi.fn();
  render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={onChange}
      onTakeSelection={onTakeSelection}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Play selection" }));

  expect(onTakeSelection).toHaveBeenCalledTimes(1);
  expect(onTakeSelection).toHaveBeenCalledWith(
    expect.objectContaining({ activeItemId: "song-2" }),
  );
  expect(onChange).not.toHaveBeenCalled();
});

it("advances a playing track and respects a non-looped end", () => {
  const onTakeSelection = vi.fn();
  const playback = {
    token: "song-2:https://example.test/song-2.mp3",
    audioUrl: "https://example.test/song-2.mp3",
    progress: 0.5,
    currentTimeMs: 30_000,
    durationMs: 60_000,
    isPlaying: true,
    updatedAt: "2026-09-11T12:00:30.000Z",
    telemetryStale: false,
  };
  const { rerender } = render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={playback}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );

  expect(screen.getByText("Feedback live")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Advance" }));
  expect(onTakeSelection).toHaveBeenCalledWith(
    expect.objectContaining({ activeItemId: "song-3" }),
  );

  rerender(
    <PlaybackBar
      sequence={{ ...sequence, activeItemId: "song-3" }}
      programSongPlayback={{
        ...playback,
        token: "song-3:https://example.test/song-3.mp3",
        audioUrl: "https://example.test/song-3.mp3",
        telemetryStale: true,
      }}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  expect(screen.getByText("Feedback stale")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Advance" })).toBeDisabled();
});

it("routes Previous, Next, and Stop All Instants to one action each", () => {
  const onTakeSelection = vi.fn();
  const onStopAllInstants = vi.fn();
  render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={{
        token: "song-2:https://example.test/song-2.mp3",
        audioUrl: "https://example.test/song-2.mp3",
        progress: 0.5,
        currentTimeMs: 30_000,
        durationMs: 60_000,
        isPlaying: true,
        updatedAt: "2026-09-11T12:00:30.000Z",
      }}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
      onStopAllInstants={onStopAllInstants}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-1" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-3" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop All Instants" }));
  expect(onStopAllInstants).toHaveBeenCalledTimes(1);
  expect(onTakeSelection).toHaveBeenCalledTimes(2);
});

it("routes Stop through the authoritative off-air action only", () => {
  const onChange = vi.fn();
  const onTakeSelection = vi.fn();
  const onTakeOffAir = vi.fn();
  render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={onChange}
      onTakeSelection={onTakeSelection}
      onTakeOffAir={onTakeOffAir}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Stop / Take Off Air" }));

  expect(onTakeOffAir).toHaveBeenCalledTimes(1);
  expect(onTakeSelection).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});

const playing = (
  overrides: Partial<ProgramSongPlaybackState> = {},
): ProgramSongPlaybackState => ({
  token: "",
  audioUrl: "",
  progress: 0.5,
  currentTimeMs: 30_000,
  durationMs: 60_000,
  isPlaying: true,
  updatedAt: "2026-09-11T12:00:30.000Z",
  ...overrides,
});

it("plays nested playlists as one flat list and falls back to the first song", () => {
  const onChange = vi.fn();
  render(
    <PlaybackBar
      sequence={{
        mode: "manual",
        loop: true,
        activeItemId: "block",
        items: [
          {
            id: "block",
            kind: "sequence",
            label: "Block",
            sequence: { mode: "manual", items: [sequence.items[0]] },
          },
          sequence.items[2],
        ],
      }}
      programSongPlayback={null}
      onChange={onChange}
    />,
  );
  // The block itself is not a song, so its first song is the selection.
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-3" }),
  );
  expect(onChange.mock.lastCall?.[0].items.map((i: { id: string }) => i.id))
    .toEqual(["song-1", "song-3"]);
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
});

it("selects through onChange when there is no take or off-air action", () => {
  const onChange = vi.fn();
  render(
    <PlaybackBar
      sequence={{ ...sequence, activeItemId: null }}
      programSongPlayback={null}
      onChange={onChange}
    />,
  );
  expect(screen.getByText("Nothing on air")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Play selection" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-1" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop / Take Off Air" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "manual", activeItemId: null }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Manual" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "manual", activeItemId: null }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Shuffle playlist" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "shuffle" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: off" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ loop: true }),
  );
});

it("takes Stop off air through the take action when there is no off-air action", async () => {
  const onTakeSelection = vi.fn();
  render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop / Take Off Air" }));
  expect(onTakeSelection).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "manual", activeItemId: null }),
  );
});

it("shows the loop as on and turns it off", () => {
  const onChange = vi.fn();
  render(
    <PlaybackBar
      sequence={{ ...sequence, loop: true }}
      programSongPlayback={null}
      onChange={onChange}
    />,
  );
  const loop = screen.getByRole("button", { name: "Loop playlist: on" });
  expect(loop).toHaveAttribute("aria-pressed", "true");
  expect(loop).toHaveTextContent("Loop on");
  fireEvent.click(loop);
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ loop: false }),
  );
});

it("wraps Advance to the first song on a looped playlist", () => {
  const onTakeSelection = vi.fn();
  render(
    <PlaybackBar
      sequence={{ ...sequence, loop: true, activeItemId: "song-3" }}
      programSongPlayback={playing({
        token: "song-3:https://example.test/song-3.mp3",
      })}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Advance" }));
  expect(onTakeSelection).toHaveBeenCalledWith(
    expect.objectContaining({ activeItemId: "song-1" }),
  );
});

it("reshuffles a playing playlist without restarting its clock", () => {
  const onChange = vi.fn();
  render(
    <PlaybackBar
      sequence={{ ...sequence, startedAt: 1_000 }}
      programSongPlayback={playing({
        token: "song-2:https://example.test/song-2.mp3",
      })}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Shuffle playlist" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "shuffle", activeItemId: "song-2" }),
  );
  expect(onChange.mock.lastCall?.[0].startedAt).not.toBeGreaterThan(1_000);
});

it("identifies the on-air song by its audio URL when the token does not name it", () => {
  const onTakeSelection = vi.fn();
  const { rerender } = render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={playing({
        token: "unknown:token",
        audioUrl: " https://example.test/song-1.mp3 ",
      })}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  // song-1 is on air, so Previous has nowhere to go and Next goes to song-2.
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-2" }),
  );

  // Two songs share one URL: the selected one is the on-air one.
  const shared = {
    ...sequence,
    activeItemId: "song-3",
    items: [
      sequence.items[0],
      { ...songs[1], audioUrl: "https://example.test/same.mp3" },
      { ...songs[2], audioUrl: "https://example.test/same.mp3" },
      { ...songs[0], id: "song-4", audioUrl: undefined },
    ],
  };
  rerender(
    <PlaybackBar
      sequence={shared}
      programSongPlayback={playing({
        audioUrl: "https://example.test/same.mp3",
      })}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-2" }),
  );
});

it("uses the scheduled song to break a shared URL, and the selection when neither matches", () => {
  const onTakeSelection = vi.fn();
  const scheduled = render(
    <PlaybackBar
      sequence={{
        mode: "autoplay",
        loop: true,
        // song-3 started 70 s ago, so the schedule has moved on to song-1.
        startedAt: Date.now() - 70_000,
        activeItemId: "song-3",
        items: [
          { ...songs[0], audioUrl: "https://example.test/same.mp3" },
          { ...songs[1], audioUrl: "https://example.test/same.mp3" },
          sequence.items[2],
        ],
      }}
      programSongPlayback={playing({
        audioUrl: "https://example.test/same.mp3",
      })}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-2" }),
  );
  scheduled.unmount();

  // Neither the selection nor the schedule is one of the URL matches, so the
  // on-air song stays unidentified and the selection (song-2) is current.
  render(
    <PlaybackBar
      sequence={{
        ...sequence,
        loop: true,
        items: [
          { ...songs[0], audioUrl: "https://example.test/same.mp3" },
          sequence.items[1],
          { ...songs[2], audioUrl: "https://example.test/same.mp3" },
        ],
      }}
      programSongPlayback={playing({
        audioUrl: "https://example.test/same.mp3",
      })}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-3" }),
  );
});

it("keeps the last identified song while playback continues and drops it when it leaves the playlist or stops", () => {
  const onTakeSelection = vi.fn();
  const props = {
    onChange: vi.fn(),
    onTakeSelection,
  };
  const { rerender } = render(
    <PlaybackBar
      {...props}
      sequence={sequence}
      programSongPlayback={playing({
        token: "song-3:https://example.test/song-3.mp3",
      })}
    />,
  );
  // Telemetry stops naming a song: the bar still shows song-3 as current.
  rerender(
    <PlaybackBar
      {...props}
      sequence={sequence}
      programSongPlayback={playing({ token: "", audioUrl: "" })}
    />,
  );
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-2" }),
  );

  // song-3 is removed from the playlist: the bar falls back to the selection.
  rerender(
    <PlaybackBar
      {...props}
      sequence={{ ...sequence, items: sequence.items.slice(0, 2) }}
      programSongPlayback={playing({ token: "", audioUrl: "" })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-1" }),
  );

  rerender(
    <PlaybackBar
      {...props}
      sequence={sequence}
      programSongPlayback={playing({
        token: "song-3:https://example.test/song-3.mp3",
      })}
    />,
  );
  rerender(
    <PlaybackBar {...props} sequence={sequence} programSongPlayback={null} />,
  );
  // Off air, the selection (song-2) is current again.
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-3" }),
  );
});

it("follows the schedule in automatic modes when nothing is selected", () => {
  const onTakeSelection = vi.fn();
  const scheduled = {
    ...sequence,
    mode: "autoplay" as const,
    activeItemId: null,
    startedAt: Date.now(),
  };
  const { rerender } = render(
    <PlaybackBar
      sequence={scheduled}
      programSongPlayback={null}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  rerender(
    <PlaybackBar
      sequence={{ ...scheduled, activeItemId: undefined }}
      programSongPlayback={playing()}
      onChange={vi.fn()}
      onTakeSelection={onTakeSelection}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(onTakeSelection).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeItemId: "song-2" }),
  );
});

it("describes the on-air track, its intro and its remaining time", () => {
  const { rerender } = render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={playing({
        title: "On-air title",
        artist: "On-air artist",
        coverUrl: "https://example.test/cover.jpg",
        currentTimeMs: 75_000,
        durationMs: 60_000,
        introStatus: "degraded",
        introFailureReason: "voice file missing",
        telemetryStale: true,
      })}
      onChange={vi.fn()}
    />,
  );
  const player = screen.getByRole("region", { name: "On-air player" });
  expect(player).toHaveTextContent("On-air title");
  expect(player).toHaveTextContent("On-air artist");
  expect(player).toHaveTextContent("Intro unavailable: voice file missing");
  expect(player).toHaveTextContent("Last reported remaining");
  expect(player).toHaveTextContent("00:00");
  expect(player).toHaveTextContent("01:00 elapsed");
  expect(screen.getByRole("progressbar", { name: "Track progress" }))
    .toHaveAttribute("aria-valuenow", "100");
  expect(player.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/cover.jpg",
  );

  rerender(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={playing({
        currentTimeMs: -5,
        durationMs: null,
        introStatus: "degraded",
      })}
      onChange={vi.fn()}
    />,
  );
  expect(player).toHaveTextContent("Title unavailable");
  expect(player).toHaveTextContent("Artist unavailable");
  expect(player).toHaveTextContent(/Intro unavailable(?!:)/);
  expect(player).toHaveTextContent("Remaining");
  expect(player).toHaveTextContent("—:—");
  expect(player).toHaveTextContent("00:00 elapsed");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/Feedback/)).toBeNull();

  rerender(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={playing({ introStatus: "playing" })}
      onChange={vi.fn()}
    />,
  );
  expect(player).toHaveTextContent("Intro playing");
});

it("stages a scene from the quick bar and marks the live and staged ones", () => {
  const onStageScene = vi.fn();
  render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={vi.fn()}
      onStageScene={onStageScene}
      sceneQuickActions={[
        { id: 1, name: "Studio", isActive: true, isStaged: false, shortcutLabel: "F1" },
        { id: 2, name: "Wide", isActive: false, isStaged: true, shortcutLabel: "F2" },
        { id: 3, name: "Remote", isActive: false, isStaged: false, shortcutLabel: "F3" },
      ]}
    />,
  );
  const remote = screen.getByRole("button", { name: "F3 Remote" });
  expect(remote).toHaveTextContent("F3");
  fireEvent.click(remote);
  expect(onStageScene).toHaveBeenCalledWith(3);
  expect(screen.getByRole("button", { name: "F1 Studio" }).className).toContain(
    "bg-terracotta/35",
  );
  expect(screen.getByRole("button", { name: "F2 Wide" }).className).toContain(
    "bg-accent-blue/35",
  );
});

it("ignores a quick-bar click when there is no stage action", () => {
  render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={vi.fn()}
      sceneQuickActions={[
        { id: 1, name: "Studio", isActive: false, isStaged: false, shortcutLabel: "F1" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "F1 Studio" }));
  expect(screen.getByText("Nothing on air")).toBeInTheDocument();
});

it("drives a rundown log instead of the playlist when one is attached", () => {
  const logTransport = {
    isRunning: true,
    canStart: false,
    canAdvance: true,
    busy: false,
    label: "Rundown running",
    onStart: vi.fn(),
    onStop: vi.fn(),
    onAdvance: vi.fn(),
  };
  const { rerender } = render(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={vi.fn()}
      logTransport={logTransport}
    />,
  );
  expect(screen.queryByRole("button", { name: "Play selection" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Playback mode" })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Rundown running");
  expect(screen.getByRole("status")).toHaveAttribute("data-tone", "ready");
  expect(screen.getByRole("button", { name: "Start rundown" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Advance rundown" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Stop rundown / Take Off Air" }),
  );
  expect(logTransport.onAdvance).toHaveBeenCalledTimes(1);
  expect(logTransport.onStop).toHaveBeenCalledTimes(1);

  rerender(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={vi.fn()}
      logTransport={{
        ...logTransport,
        isRunning: false,
        canStart: true,
        busy: true,
        label: "Rundown stopped",
      }}
    />,
  );
  expect(screen.getByRole("status")).toHaveAttribute("data-tone", "warning");
  expect(screen.getByRole("button", { name: "Start rundown" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Stop rundown / Take Off Air" }),
  ).toBeDisabled();
  rerender(
    <PlaybackBar
      sequence={sequence}
      programSongPlayback={null}
      onChange={vi.fn()}
      logTransport={{ ...logTransport, isRunning: false, canStart: true }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start rundown" }));
  expect(logTransport.onStart).toHaveBeenCalledTimes(1);
});

it("has nothing to play when the playlist holds only an empty block", () => {
  render(
    <PlaybackBar
      sequence={{
        mode: "manual",
        activeItemId: "block",
        items: [
          {
            id: "block",
            kind: "sequence",
            label: "Empty block",
            sequence: { mode: "manual", items: [] },
          },
        ],
      }}
      programSongPlayback={null}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Play selection" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Shuffle playlist" })).toBeDisabled();
});

it("has no current song on air when nothing is selected and nothing identifies it", () => {
  const onChange = vi.fn();
  const cleared = { ...sequence, activeItemId: null };
  const { rerender } = render(
    <PlaybackBar
      sequence={{ ...cleared, mode: "autoplay" }}
      programSongPlayback={playing()}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  rerender(
    <PlaybackBar
      sequence={cleared}
      programSongPlayback={playing()}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Autoplay" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "autoplay", activeItemId: null }),
  );
});

it("shows an empty manual playlist when the sequence from the API is malformed", () => {
  const onChange = vi.fn();
  render(
    <PlaybackBar
      // A response that is not a sequence object, as a bad API payload would
      // arrive; the prop type cannot rule this out at runtime.
      sequence={null as unknown as ProgramSongSequence}
      programSongPlayback={null}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Manual" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Play selection" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Shuffle playlist" })).toBeDisabled();
  expect(screen.getByText("Nothing on air")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "manual", items: [], loop: false }),
  );
});
