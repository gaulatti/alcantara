import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayNextQueue } from "./PlayNextQueue";
import type { ProgramSongSequence } from "../utils/programSequence";

const sequence: ProgramSongSequence = {
  mode: "shuffle",
  loop: true,
  activeItemId: "song-1",
  items: [
    {
      id: "song-1",
      kind: "preset",
      title: "First song",
      artist: "First artist",
      coverUrl: "",
      audioUrl: "https://example.test/first.mp3",
    },
    {
      id: "song-2",
      kind: "preset",
      title: "Second song",
      artist: "Second artist",
      coverUrl: "",
      audioUrl: "https://example.test/second.mp3",
    },
    {
      id: "song-3",
      kind: "preset",
      title: "Third song",
      artist: "Third artist",
      coverUrl: "",
      audioUrl: "https://example.test/third.mp3",
    },
  ],
};

const queue = [
  { id: "queue-1", itemId: "song-1", enqueuedAt: 1 },
  { id: "queue-2", itemId: "song-2", enqueuedAt: 2 },
  { id: "queue-3", itemId: "song-3", enqueuedAt: 3 },
];

afterEach(cleanup);

describe("PlayNextQueue", () => {
  it("shows FIFO order and exposes remove and reorder actions", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(
      <PlayNextQueue
        queue={queue}
        sequence={sequence}
        onRemove={onRemove}
        onReorder={onReorder}
      />,
    );

    expect(screen.getByText("First song")).toBeInTheDocument();
    expect(screen.getByText("Second song")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Move Second song earlier"));
    await waitFor(() =>
      expect(onReorder).toHaveBeenCalledWith([
        "queue-2",
        "queue-1",
        "queue-3",
      ]),
    );

    fireEvent.click(screen.getByLabelText("Remove First song from Play Next"));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("queue-1"));
  });

  it("marks the active queued song and keeps it fixed until it ends", () => {
    const onReorder = vi.fn();
    render(
      <PlayNextQueue
        queue={queue}
        sequence={sequence}
        activeQueueEntryId="queue-1"
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    );

    expect(screen.getByText("Playing")).toBeInTheDocument();
    expect(screen.getByLabelText("Move Second song earlier")).toBeDisabled();
    expect(screen.getByLabelText("Move Third song earlier")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Move Third song earlier"));
    expect(onReorder).toHaveBeenCalledWith([
      "queue-1",
      "queue-3",
      "queue-2",
    ]);
    expect(
      screen.getByLabelText("Remove First song from Play Next"),
    ).toBeDisabled();
  });
});
