import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProgramSongSequenceEditor } from "./ProgramSongSequenceEditor";

// The radio desk's rotation list (dense): one line per song, a state column and a row tint for On air and Next instead
// of pills, no cover and no playing bars, and every function kept: reorder, PFL, star, edit, remove and Play Next.
afterEach(cleanup);

const item = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "preset" as const,
  title,
  artist: "Seed Artist",
  coverUrl: "https://media.example.test/cover.jpg",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 240_000,
  ...extra,
});

const sequence = {
  mode: "manual" as const,
  loop: true,
  activeItemId: "a",
  items: [item("a", "One"), item("b", "Two"), item("c", "Three", { highRotation: true })],
};

const rows = () => [...document.querySelectorAll<HTMLElement>(".playlist-row")];

function view(extra: Partial<Parameters<typeof ProgramSongSequenceEditor>[0]> = {}) {
  const onChange = vi.fn();
  const onQueueItem = vi.fn();
  render(
    <ProgramSongSequenceEditor
      sequence={sequence}
      view="queue"
      undoScope="radio-dense"
      rotationLabel="Filler rotation"
      onChange={onChange}
      onQueueItem={onQueueItem}
      liveItemId="a"
      nextItemId="b"
      dense
      {...extra}
    />,
  );
  return { onChange, onQueueItem };
}

it("names On air and Next in a state column with a row tint, never as pills, and shows no cover or bars", () => {
  view();
  expect(screen.getByText("State")).toBeInTheDocument();
  const [a, b, c] = rows();
  expect(a).toHaveAttribute("data-desk-state", "on-air");
  expect(within(a).getByText("On air")).toHaveClass("desk-row-state");
  expect(b).toHaveAttribute("data-desk-state", "next");
  expect(within(b).getByText("Next")).toHaveAttribute("data-state", "next");
  expect(c).not.toHaveAttribute("data-desk-state");
  expect(document.querySelector("[data-tone]")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
  expect(a.innerHTML).not.toContain("eq-bar");
  // The number stays on the row on air; the title and the artist share one line; the time is tabular.
  expect(within(a).getByText("1")).not.toHaveClass("opacity-0");
  expect(within(a).getByText("· Seed Artist")).toBeInTheDocument();
  expect(within(a).getByText("4:00")).toHaveClass("font-mono", "tabular-nums");
});

it("marks the song behind a jingle in the state column", () => {
  view({ programSongPlayback: { token: "a:x", isPlaying: true, jingle: { name: "CUÑA 1" } } as never });
  expect(rows()[0]).toHaveAttribute("data-desk-state", "after-jingle");
  expect(within(rows()[0]).getByText("After jingle")).toBeInTheDocument();
});

it("shows the take icon on a selected row that is not on air, and an artistless song as its title alone", () => {
  view({
    liveItemId: null,
    nextItemId: null,
    sequence: { ...sequence, items: [item("a", "One", { artist: "" }), ...sequence.items.slice(1)] },
  });
  expect(rows()[0].querySelector("[data-testid='take-icon']")).not.toBeNull();
  expect(rows()[0]).toHaveClass("bg-white/[0.05]");
  expect(within(rows()[0]).queryByText(/^·/)).toBeNull();
});

it("keeps every row tool, shown on hover or focus: reorder, PFL, star, edit, remove and Play Next", () => {
  const { onChange, onQueueItem } = view();
  const row = rows()[1];
  for (const name of ["Drag to reorder"]) expect(within(row).getByLabelText(name)).toHaveClass("desk-hover");
  expect(within(row).getByRole("button", { name: "Preview locally" })).toHaveClass("desk-hover");
  expect(within(row).getByRole("button", { name: "Add Two to high rotation" })).toHaveClass("desk-hover");
  // A starred song keeps its star in view.
  expect(within(rows()[2]).getByRole("button", { name: "Remove Three from high rotation" })).not.toHaveClass("desk-hover");
  expect(row.querySelector(".playlist-row-actions")).toHaveClass("desk-hover");
  fireEvent.click(within(row).getByRole("button", { name: "Play Two next" }));
  expect(onQueueItem).toHaveBeenCalledWith("b");
  fireEvent.click(within(row).getByRole("button", { name: "Move Two up" }));
  expect(onChange.mock.calls.at(-1)![0].items.map((entry: { id: string }) => entry.id)).toEqual(["b", "a", "c"]);
  fireEvent.click(within(row).getByRole("button", { name: "Edit song" }));
  expect(screen.getByText("Swap song...")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Remove Two" }));
  expect(onChange.mock.calls.at(-1)![0].items.map((entry: { id: string }) => entry.id)).toEqual(["a", "c"]);
});
