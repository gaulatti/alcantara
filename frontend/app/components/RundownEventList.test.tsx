import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  FlightCue,
  InstantItem,
  SongCatalogItem,
} from "../models/broadcast";
import { RundownEventList, formatRundownDuration } from "./RundownEventList";

afterEach(cleanup);

const song = (
  id: number,
  title: string,
  artist: string,
  durationMs: number | null,
): SongCatalogItem => ({
  id,
  title,
  artist,
  durationMs,
  audioUrl: `https://media.example/${id}.mp3`,
  coverUrl: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
});

const SONGS = [
  song(1, "Harbor Light", "The Lighthouse Keepers", 60_000),
  song(2, "Low Tide", "Quay Street", 60_000),
];

const CLIPS: InstantItem[] = [
  {
    id: 7,
    name: "Station ident",
    audioUrl: "https://media.example/ident.mp3",
    volume: 1,
    enabled: true,
    position: 0,
  },
];

// A block that exercises every row the operator can see: a locked song with a
// voice track, a clip followed by a gap, a filler cut at the next fixed start,
// a song that overruns, a labelled stop followed by silence, and cues whose
// timing cannot be known.
const ITEMS: FlightCue[] = [
  {
    id: "open",
    kind: "playSong",
    songId: 1,
    clockOffsetSeconds: 0,
    voiceTrackInstantId: 5,
  },
  { id: "ident", kind: "instant", instantId: 7, durationMs: 30_000 },
  {
    id: "filler",
    kind: "playSong",
    songId: 2,
    isFiller: true,
    clockOffsetSeconds: 120,
  },
  { id: "overrun", kind: "playSong", songId: 1, clockOffsetSeconds: 150 },
  {
    id: "break",
    kind: "stopSong",
    label: "Station break",
    clockOffsetSeconds: 200,
  },
  { id: "missing-song", kind: "playSong", songId: 99, clockOffsetSeconds: 230 },
  { id: "missing-clip", kind: "instant", instantId: 999, durationMs: 5_000 },
  { id: "stop", kind: "stopSong" },
];

function renderList(
  overrides: Partial<Parameters<typeof RundownEventList>[0]> = {},
) {
  const onSelect = vi.fn();
  render(
    <RundownEventList
      items={ITEMS}
      songs={SONGS}
      clips={CLIPS}
      scheduledAt="2026-11-17T10:00:00"
      selectedCueId="filler"
      activeIndex={0}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  const table = screen.getByRole("table", { name: "Scheduled rundown events" });
  const rows = within(table).getAllByRole("row").slice(1);
  return { onSelect, rows };
}

it("formats durations as minutes and seconds, and a missing one as a dash", () => {
  expect(formatRundownDuration(null)).toBe("—");
  expect(formatRundownDuration(undefined)).toBe("—");
  expect(formatRundownDuration(65_400)).toBe("01:05");
});

it("shows each event's type, title, length and timing status", () => {
  const { rows } = renderList();
  // 8 events plus a gap after the clip and a silence after the stop.
  expect(rows).toHaveLength(10);
  const [
    open,
    ident,
    gap,
    filler,
    overrun,
    brk,
    silence,
    missingSong,
    missingClip,
    stop,
  ] = rows;

  expect(open).toHaveTextContent("Music");
  expect(open).toHaveTextContent("Harbor Light");
  expect(open).toHaveTextContent("The Lighthouse Keepers");
  expect(open).toHaveTextContent("Fixed");
  expect(open).toHaveTextContent("01:00");
  expect(open).toHaveTextContent("Locked");
  expect(open).toHaveAttribute("data-active", "true");

  expect(ident).toHaveTextContent("Clip");
  expect(ident).toHaveTextContent("Station ident");
  expect(ident).toHaveTextContent("Standalone audio");
  expect(ident).toHaveTextContent("Est.");
  expect(ident).toHaveTextContent("Fits");

  expect(gap).toHaveTextContent("Gap");
  expect(gap).toHaveTextContent("Unfilled time · preview fillers");
  expect(gap).toHaveTextContent("00:30");

  expect(filler).toHaveTextContent("Filler");
  expect(filler).toHaveTextContent("Quay Street · Filler");
  expect(filler).toHaveTextContent("00:30 cut at fixed start");
  expect(within(filler).getByText("Cut")).toBeVisible();
  expect(within(filler).getByRole("button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  expect(overrun).toHaveTextContent("00:10 content overrun");
  expect(within(overrun).getByText("Overrun")).toBeVisible();

  expect(brk).toHaveTextContent("Stop");
  expect(brk).toHaveTextContent("Station break");
  expect(silence).toHaveTextContent("Intentional silence");
  expect(silence).toHaveTextContent("Silence");

  expect(missingSong).toHaveTextContent("Choose song");
  expect(within(missingSong).getByText("Unknown")).toBeVisible();

  // After an unknown length the start of the next event cannot be known.
  expect(missingClip).toHaveTextContent("Choose clip");
  expect(within(missingClip).getAllByText("—")[0]).toBeVisible();

  expect(stop).toHaveTextContent("Stop program audio");
});

it("selects the event the operator clicks", () => {
  const { onSelect, rows } = renderList();
  fireEvent.click(within(rows[1]).getByRole("button"));
  expect(onSelect).toHaveBeenCalledWith("ident");
});

it("marks an event that falls on the next day with its date", () => {
  const scheduledAt = "2026-11-17T23:59:30";
  const { rows } = renderList({
    items: [
      { id: "late", kind: "playSong", songId: 1, clockOffsetSeconds: 60 },
    ],
    scheduledAt,
    activeIndex: -1,
    selectedCueId: null,
  });
  const nextDay = new Date(Date.parse(scheduledAt) + 60_000);
  expect(rows[0]).toHaveTextContent(
    nextDay.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
  );
  expect(rows[0]).toHaveTextContent("Fits");
});

it("invites the operator to build an empty block", () => {
  renderList({ items: [] });
  expect(screen.getByText("Build this block")).toBeVisible();
});
