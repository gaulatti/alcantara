import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RundownLibrary } from "./RundownLibrary";

// A phone or tablet has no drag and no double-click, so the library row needs a button to add it. Without one the
// operator can only select a row, and Enter is not on a touch keyboard.

afterEach(cleanup);

const songs = [
  { id: 1, artist: "Artist", title: "Harbor Song", audioUrl: "https://media.test/1.mp3", coverUrl: null, durationMs: 180_000, earoneSongId: null, earoneRank: null, earoneSpins: null, enabled: true },
] as never;
const clips = [{ id: 9, name: "Fictional clip", audioUrl: "https://media.test/c.mp3", volume: 1, enabled: true, position: 0 }] as never;

it("adds a song with its Add button, without a drag or a double-click", () => {
  const onAdd = vi.fn();
  render(<RundownLibrary songs={songs} clips={clips} disabled={false} onAdd={onAdd} />);
  fireEvent.click(screen.getByRole("button", { name: "Add Harbor Song to the rundown" }));
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "song", id: 1 }));
});

it("adds a clip with its Add button", () => {
  const onAdd = vi.fn();
  render(<RundownLibrary songs={songs} clips={clips} disabled={false} onAdd={onAdd} />);
  fireEvent.click(screen.getByRole("button", { name: "Clips" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Fictional clip to the rundown" }));
  expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "clip", id: 9 }));
});

it("disables every Add button while the rundown is disabled", () => {
  render(<RundownLibrary songs={songs} clips={clips} disabled onAdd={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Add Harbor Song to the rundown" })).toBeDisabled();
});

it("adds only songs with a recipe selected, and disables the Add button on a clip", () => {
  const onAddRecipe = vi.fn();
  render(
    <RundownLibrary
      songs={songs}
      clips={clips}
      disabled={false}
      onAdd={vi.fn()}
      recipes={[{ id: 3, name: "Morning bumper" }]}
      onAddRecipe={onAddRecipe}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Recipes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add Harbor Song to the rundown" }));
  expect(onAddRecipe).toHaveBeenCalledWith(3, 1);
});
