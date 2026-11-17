import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { FlightCue, SongCatalogItem } from "../models/broadcast";
import { RundownEventList } from "./RundownEventList";

afterEach(cleanup);

const HARBOR: SongCatalogItem = {
  id: 1,
  title: "Harbor Light",
  artist: "The Lighthouse Keepers",
  durationMs: 60_000,
  audioUrl: "https://media.example/1.mp3",
  coverUrl: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
};

function detailFor(items: FlightCue[]) {
  render(
    <RundownEventList
      items={items}
      songs={[HARBOR]}
      clips={[]}
      scheduledAt="2026-11-17T10:00:00"
      selectedCueId={null}
      activeIndex={-1}
      onSelect={() => undefined}
    />,
  );
  const table = screen.getByRole("table", { name: "Scheduled rundown events" });
  const [row] = within(table).getAllByRole("row").slice(1);
  return {
    title: row.querySelector(".rundown-event-title")?.textContent?.trim(),
    detail: row.querySelector(".rundown-event-detail")?.textContent?.trim(),
  };
}

it("says the song is missing from the library instead of calling it intentional silence", () => {
  expect(
    detailFor([{ id: "gone", kind: "playSong", songId: 99 } as FlightCue]),
  ).toEqual({ title: "Choose song", detail: "Song not in the library" });
});

it("says no song is chosen yet for a music cue without a song", () => {
  expect(detailFor([{ id: "empty", kind: "playSong" } as FlightCue])).toEqual({
    title: "Choose song",
    detail: "No song chosen",
  });
});

it("keeps the artist for a song that is in the library", () => {
  expect(
    detailFor([{ id: "ok", kind: "playSong", songId: 1 } as FlightCue]),
  ).toEqual({ title: "Harbor Light", detail: "The Lighthouse Keepers" });
});
