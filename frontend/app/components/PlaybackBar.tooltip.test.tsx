import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaybackBar } from "./PlaybackBar";
import type { ProgramSongSequence } from "../utils/programSequence";

// Kept in its own file: opening the Radix tooltip in jsdom leaves work behind that
// blocks the event loop for seconds at every later test in the same file, so a
// test after it in PlaybackBar.test.tsx timed out on a loaded runner. Vitest
// gives each file its own environment, which keeps that cost here.

const sequence: ProgramSongSequence = {
  mode: "manual",
  loop: false,
  startedAt: 1_000,
  activeItemId: "song-2",
  items: [
    {
      id: "song-1",
      kind: "preset",
      artist: "Artist one",
      title: "Song one",
      coverUrl: "",
      audioUrl: "https://example.test/song-1.mp3",
      durationMs: 60_000,
    },
    {
      id: "song-2",
      kind: "preset",
      artist: "Artist two",
      title: "Song two",
      coverUrl: "",
      audioUrl: "https://example.test/song-2.mp3",
      durationMs: 60_000,
    },
    {
      id: "song-3",
      kind: "preset",
      artist: "Artist three",
      title: "Song three",
      coverUrl: "",
      audioUrl: "https://example.test/song-3.mp3",
      durationMs: 60_000,
    },
  ],
};

afterEach(() => cleanup());

// gaulatti/alcantara#189: control-room help is Bleecker's tooltip, not a native
// title (BleeckerButtons moves `title` into the tooltip). Keyboard focus opens
// it at once, as hover does after its delay. The tooltip carries the loop
// state, and its text uses the readable dark-console colour that Bleecker
// 0.1.42 and later give it (gaulatti/alcantara#191 removed #189's local class).
it("shows the loop help in a readable tooltip when the loop toggle is focused", () => {
  // jsdom has no ResizeObserver; Radix measures the open tooltip with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const view = render(
    <PlaybackBar sequence={sequence} programSongPlayback={null} onChange={vi.fn()} />,
  );
  const loop = screen.getByLabelText("Loop playlist: off");
  expect(loop).not.toHaveAttribute("title");
  expect(document.querySelector("[role=tooltip]")).toBeNull();

  act(() => {
    fireEvent.focus(loop);
  });
  const tooltip = document.querySelector("[role=tooltip]")!;
  expect(tooltip.textContent).toBe("Loop is off");
  expect(loop).toHaveAttribute("aria-describedby", tooltip.id);
  const content = document.querySelector("[data-radix-popper-content-wrapper] [data-state]")!;
  expect(content).toHaveClass("dark:text-text-primary");
  expect(content).not.toHaveClass("dark:text-deep-sea");

  act(() => {
    fireEvent.blur(loop);
  });
  view.unmount();
  vi.unstubAllGlobals();
});
