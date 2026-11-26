import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RundownLibrary } from "./RundownLibrary";

// gaulatti/alcantara#527 (rundown library, untriaged gaps): the Recipes tab can be left selected after the
// program's recipes are removed; the library then falls back to showing every song and clip.

afterEach(cleanup);

const songs = [{ id: 1, artist: "Artist", title: "Harbor Song", audioUrl: "https://media.test/1.mp3", coverUrl: null, durationMs: 180_000, earoneSongId: null, earoneRank: null, earoneSpins: null, enabled: true }] as never;
const clips = [{ id: 9, name: "Fictional clip", audioUrl: "https://media.test/c.mp3", volume: 1, enabled: true, position: 0 }] as never;

it("falls back to every song and clip when the recipes go away while the Recipes tab is selected", () => {
  const recipes = [{ id: 3, name: "Morning bumper" }];
  const view = render(
    <RundownLibrary songs={songs} clips={clips} disabled={false} onAdd={vi.fn()} recipes={recipes} onAddRecipe={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Recipes/ }));
  expect(screen.getByRole("combobox", { name: "Recipe" })).toBeInTheDocument();
  view.rerender(<RundownLibrary songs={songs} clips={clips} disabled={false} onAdd={vi.fn()} recipes={[]} onAddRecipe={vi.fn()} />);
  expect(screen.queryByRole("combobox", { name: "Recipe" })).toBeNull();
  expect(screen.getByText("Harbor Song")).toBeInTheDocument();
  expect(screen.getByText("Fictional clip")).toBeInTheDocument();
});

// The walk's B4: an empty Clips or Songs tab says where to add one, never `Nothing matches ""`.
it("says where to add clips or songs when the tab is empty, and what was searched otherwise", () => {
  render(<RundownLibrary songs={[]} clips={[]} disabled={false} onAdd={vi.fn()} />);
  const search = screen.getByRole("searchbox", { name: "Search the library" });
  fireEvent.click(screen.getByRole("button", { name: "Clips" }));
  expect(screen.getByText(/No audio clips yet: upload one in/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Media" })).toHaveAttribute("href", "/media");
  expect(screen.queryByText(/Nothing matches/)).toBeNull();
  fireEvent.change(search, { target: { value: "   " } });
  expect(screen.getByText(/No audio clips yet/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Songs" }));
  expect(screen.getByText(/No songs yet: add one in/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Songs" })).toHaveAttribute("href", "/songs");
  fireEvent.change(search, { target: { value: "harbor" } });
  expect(screen.getByText("Nothing matches “harbor”.")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});
