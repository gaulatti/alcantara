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
});
