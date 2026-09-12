import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaybackBar } from "./PlaybackBar";
import type { ProgramSongSequence } from "../utils/programSequence";

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
