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
import type { ProgramSongSequence } from "@modoitaliano/giorgia/scenes";

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

  it("finds songs inside nested playlists and flags entries it cannot resolve", () => {
    const nested: ProgramSongSequence = {
      mode: "manual",
      items: [
        {
          id: "block-a",
          kind: "sequence",
          label: "Block A",
          sequence: {
            mode: "manual",
            items: [
              { ...sequence.items[1], id: "nested-song" },
              { ...sequence.items[2], id: "twice" },
            ],
          },
        },
        { ...sequence.items[0], id: "twice" },
      ],
    };
    render(
      <PlayNextQueue
        queue={[
          { id: "q-nested", itemId: "nested-song", enqueuedAt: 1 },
          { id: "q-twice", itemId: "twice", enqueuedAt: 2 },
          { id: "q-gone", itemId: "deleted-song", enqueuedAt: 3 },
        ]}
        sequence={nested}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    expect(screen.getByText("Second song")).toBeInTheDocument();
    expect(screen.getByText("Second artist")).toBeInTheDocument();
    // An id that appears twice in the playlist is ambiguous, like a deleted one.
    expect(screen.getAllByText("Unavailable playlist item")).toHaveLength(2);
    expect(
      screen.getAllByText("Remove this entry before playback can continue"),
    ).toHaveLength(2);
    expect(screen.getAllByLabelText("Move queued song earlier")).toHaveLength(2);
    expect(screen.getAllByLabelText("Move queued song later")).toHaveLength(2);
    expect(
      screen.getAllByLabelText("Remove queued song from Play Next"),
    ).toHaveLength(2);
  });

  it("explains how to fill an empty queue", () => {
    render(
      <PlayNextQueue
        queue={[]}
        sequence={sequence}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Use the Play Next action on any playlist song."),
    ).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("locks the queue while a change is pending and reports a change that failed", async () => {
    let fail!: (error: Error) => void;
    const onRemove = vi.fn(
      () =>
        new Promise<void>((_done, reject) => {
          fail = reject;
        }),
    );
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(
      <PlayNextQueue
        queue={queue}
        sequence={sequence}
        onRemove={onRemove}
        onReorder={onReorder}
      />,
    );

    fireEvent.click(screen.getByLabelText("Remove Second song from Play Next"));
    expect(screen.getByLabelText("Move Third song earlier")).toBeDisabled();
    expect(screen.getByLabelText("Move First song later")).toBeDisabled();
    fail(new Error("offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Play Next queue was not changed. Try again.",
    );
    expect(screen.getByLabelText("Move First song later")).toBeEnabled();

    fireEvent.click(screen.getByLabelText("Move First song later"));
    await waitFor(() =>
      expect(onReorder).toHaveBeenCalledWith([
        "queue-2",
        "queue-1",
        "queue-3",
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
