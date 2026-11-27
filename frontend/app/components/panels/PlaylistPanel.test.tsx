import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaylistPanel } from "./PlaylistPanel";

// gaulatti/alcantara#184, group G7: the console's playlist queue.

afterEach(cleanup);

const sequence = {
  mode: "manual",
  loop: true,
  activeItemId: "a",
  items: [
    {
      id: "a",
      kind: "preset",
      title: "First",
      artist: "Artist",
      coverUrl: "",
      audioUrl: "https://audio.test/a.mp3",
    },
    {
      id: "b",
      kind: "preset",
      title: "Second",
      artist: "Artist",
      coverUrl: "",
      audioUrl: "https://audio.test/b.mp3",
    },
  ],
} as any;

it("takes a song on air through the console, and queues it next", async () => {
  const onChange = vi.fn();
  const onTakeSelection = vi.fn();
  const onQueueItem = vi.fn();
  render(
    <PlaylistPanel
      programId="test-program"
      sequence={sequence}
      songCatalog={[]}
      programSongPlayback={null}
      onChange={onChange}
      onTakeSelection={onTakeSelection}
      onQueueItem={onQueueItem}
    />,
  );
  // The queue view: no catalog search.
  expect(screen.queryByPlaceholderText("Search catalog to add...")).toBeNull();
  fireEvent.click(screen.getAllByLabelText("Take on air")[1]);
  await vi.waitFor(() =>
    expect(onTakeSelection).toHaveBeenCalledWith(
      expect.objectContaining({ activeItemId: "b" }),
    ),
  );
  fireEvent.click(screen.getByLabelText("Play Second next"));
  expect(onQueueItem).toHaveBeenCalledWith("b");
  fireEvent.click(screen.getAllByLabelText("Remove")[0]);
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ items: [expect.objectContaining({ id: "b" })] }),
  );
});

it("saves the take as a plain change when the console takes nothing", () => {
  const onChange = vi.fn();
  render(
    <PlaylistPanel
      programId="test-program"
      sequence={sequence}
      songCatalog={[]}
      programSongPlayback={null}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getAllByLabelText("Take on air")[1]);
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ activeItemId: "b" }),
  );
  expect(screen.queryByLabelText("Play Second next")).toBeNull();
});
