import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgramSongSequenceEditor } from "./ProgramSongSequenceEditor";
import { resetLocalAudio, setHostMicLive } from "../../utils/localAudio";

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
      undoScope="radio-demo"
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

// gaulatti/alcantara#879: while a jingle is on, the song behind it has not started.
it("marks the song behind a jingle After jingle, not On air", () => {
  view("b", { token: "b:x", isPlaying: true, jingle: { name: "CUÑA 1" } });
  expect(screen.getByText("After jingle")).toBeInTheDocument();
  expect(screen.queryByText("On air")).toBeNull();
});

// gaulatti/alcantara#879: a preview that ended or whose editor closed must not stay held for the microphone's mute.
it("lets go of the preview element when it ends, is stopped, or the editor closes", async () => {
  const made: { muted: boolean; onended: null | (() => void) }[] = [];
  vi.stubGlobal(
    "Audio",
    class {
      muted = false;
      onended: null | (() => void) = null;
      onerror = null;
      constructor() {
        made.push(this);
      }
      play = () => Promise.resolve();
      pause = () => {};
    },
  );
  const editor = view();
  const preview = () => screen.getAllByRole("button", { name: /Preview locally/ })[0];
  await act(async () => void fireEvent.click(preview()));
  act(() => made[0].onended!());
  await act(async () => void fireEvent.click(preview()));
  await act(async () => void fireEvent.click(screen.getAllByRole("button", { name: /Preview locally|Stop preview/ })[0]));
  await act(async () => void fireEvent.click(preview()));
  editor.unmount();
  setHostMicLive(true);
  expect(made.map((audio) => audio.muted)).toEqual(made.map(() => false));
  resetLocalAudio();
  vi.unstubAllGlobals();
});
