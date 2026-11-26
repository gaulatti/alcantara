import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProgramSongSequenceEditor } from "./ProgramSongSequenceEditor";

// The radio desk's walk 4: a selected row must not look like a playing one, and a row's length is shown when the
// library or the playback knows it.
afterEach(cleanup);

const item = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "preset" as const,
  title,
  artist: "A",
  coverUrl: "",
  audioUrl: `https://media.example.test/${id}.mp3`,
  ...extra,
});

const sequence = {
  mode: "manual" as const,
  loop: true,
  activeItemId: "a",
  items: [item("a", "One"), item("b", "Two", { songId: 2 })],
};

const rows = () => screen.getAllByRole("button", { name: "Take on air" });
const view = (liveItemId?: string | null, playback?: unknown) =>
  render(
    <ProgramSongSequenceEditor
      sequence={sequence}
      view="queue"
      onChange={() => {}}
      liveItemId={liveItemId}
      programSongPlayback={playback as never}
      songCatalog={[{ id: 2, title: "Two", artist: "A", audioUrl: sequence.items[1].audioUrl, durationMs: 210_000, enabled: true } as never]}
    />,
  );

describe("the selected row and the row on air", () => {
  it("shows the take icon on a selected row that is not on air", () => {
    view(null);
    expect(rows()[0].querySelector("[data-testid='take-icon']")).not.toBeNull();
    expect(rows()[0].innerHTML).not.toContain("eq-bar");
  });

  it("shows the playing bars only on the item on air", () => {
    view("b");
    expect(rows()[1].innerHTML).toContain("eq-bar");
    expect(rows()[0].innerHTML).not.toContain("eq-bar");
  });

  it("keeps the bars on the selected item where the console does not say what is on air", () => {
    view();
    expect(rows()[0].innerHTML).toContain("eq-bar");
  });

  it("takes a missing length from the library, or from the playback of the item on air", () => {
    view("a", { token: "a:x", isPlaying: true, durationMs: 185_000 });
    expect(screen.getByText("3:30")).toBeInTheDocument();
    expect(screen.getByText("3:05")).toBeInTheDocument();
  });
});
