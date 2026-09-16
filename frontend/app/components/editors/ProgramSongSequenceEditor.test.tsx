import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProgramSongSequenceEditor } from "./ProgramSongSequenceEditor";

describe("ProgramSongSequenceEditor Play Next action", () => {
  it("queues the selected playlist item without changing the playlist", () => {
    const onChange = vi.fn();
    const onQueueItem = vi.fn();
    render(
      <ProgramSongSequenceEditor
        sequence={{
          mode: "shuffle",
          loop: true,
          activeItemId: "song-1",
          items: [
            {
              id: "song-1",
              kind: "preset",
              title: "The queued song",
              artist: "Queue artist",
              coverUrl: "",
              audioUrl: "https://example.test/song.mp3",
            },
          ],
        }}
        view="queue"
        onChange={onChange}
        onQueueItem={onQueueItem}
      />,
    );

    fireEvent.click(screen.getByLabelText("Play The queued song next"));

    expect(onQueueItem).toHaveBeenCalledWith("song-1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks a playlist song for high rotation", () => {
    const onChange = vi.fn();
    render(
      <ProgramSongSequenceEditor
        sequence={{
          mode: "shuffle",
          loop: true,
          activeItemId: "song-1",
          items: [
            {
              id: "song-1",
              kind: "preset",
              title: "Favorite song",
              artist: "Favorite artist",
              coverUrl: "",
              audioUrl: "https://example.test/favorite.mp3",
            },
          ],
        }}
        view="queue"
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByLabelText("Add Favorite song to high rotation"),
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "song-1", highRotation: true })],
      }),
    );
  });

  it("disables adding a thirteenth high rotation song", () => {
    const onChange = vi.fn();
    render(
      <ProgramSongSequenceEditor
        sequence={{
          mode: "shuffle",
          loop: true,
          activeItemId: "song-1",
          items: [
            ...Array.from({ length: 12 }, (_, index) => ({
              id: `favorite-${index}`,
              kind: "preset" as const,
              highRotation: true,
              title: `Favorite ${index}`,
              artist: "Artist",
              coverUrl: "",
              audioUrl: `https://example.test/favorite-${index}.mp3`,
            })),
            {
              id: "normal",
              kind: "preset",
              title: "Normal song",
              artist: "Artist",
              coverUrl: "",
              audioUrl: "https://example.test/normal.mp3",
            },
          ],
        }}
        view="queue"
        onChange={onChange}
      />,
    );

    expect(
      screen.getByLabelText("Add Normal song to high rotation"),
    ).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
