import { describe, expect, it } from "vitest";
import type {
  FlightCue,
  InstantItem,
  SongCatalogItem,
} from "../models/broadcast";
import {
  rundownFixtureLog,
  rundownFixtureSongs,
} from "../components/RundownFixture";
import {
  UNKNOWN_DISPLAY_MS,
  cueFor,
  dropIndex,
  insertCue,
  libraryRows,
  moveAnchor,
  parseLibraryDrag,
  snapSeconds,
  timelineLayout,
} from "./rundownBuilder";
import { rundownTiming } from "./rundownTiming";

const songs = [
  { id: 1, durationMs: 60_000 },
  { id: 2, durationMs: null },
];
const cue = (id: string, extra: Partial<FlightCue> = {}): FlightCue => ({
  id,
  kind: "instant",
  instantId: 1,
  durationMs: 30_000,
  ...extra,
});

describe("cueFor", () => {
  it("creates the cue shapes the forms created", () => {
    const song = cueFor({ type: "song", id: 4 }, true);
    expect(song).toEqual({
      id: expect.any(String),
      kind: "playSong",
      songId: 4,
      clockOffsetSeconds: 0,
    });
    expect(cueFor({ type: "clip", id: 9 }, false)).toEqual({
      id: expect.any(String),
      kind: "instant",
      instantId: 9,
    });
    expect(cueFor({ type: "stop" }, false)).toEqual({
      id: expect.any(String),
      kind: "stopSong",
    });
    expect(cueFor({ type: "stop" }, false).id).not.toBe(song.id);
  });
});

describe("insertCue", () => {
  const open = cue("open", { clockOffsetSeconds: 0 });
  const end: FlightCue = {
    id: "end",
    kind: "stopSong",
    clockOffsetSeconds: 3600,
  };
  it("appends ahead of a closing fixed stop, and at the end otherwise", () => {
    expect(insertCue([open, end], cue("new")).map((c) => c.id)).toEqual([
      "open",
      "new",
      "end",
    ]);
    const loose: FlightCue = { id: "stop", kind: "stopSong" };
    expect(insertCue([open, loose], cue("new")).map((c) => c.id)).toEqual([
      "open",
      "stop",
      "new",
    ]);
    expect(insertCue([], cue("new"))).toEqual([cue("new")]);
  });
  it("inserts at a position, never before what has played", () => {
    const items = [open, cue("b"), cue("c")];
    expect(insertCue(items, cue("new"), 2).map((c) => c.id)).toEqual([
      "open",
      "b",
      "new",
      "c",
    ]);
    expect(insertCue(items, cue("new"), 0, 1).map((c) => c.id)).toEqual([
      "open",
      "b",
      "new",
      "c",
    ]);
    expect(insertCue(items, cue("new"), 99).at(-1)?.id).toBe("new");
  });
  it("makes an item inserted first the opener at 0, and the old opener follow it", () => {
    const next = insertCue([open, cue("b")], cue("new"), 0);
    expect(next[0]).toEqual({ ...cue("new"), clockOffsetSeconds: 0 });
    expect(next[1]).toEqual(cue("open"));
    // An opener fixed somewhere other than 0 keeps its fixed start.
    const late = cue("late", { clockOffsetSeconds: 120 });
    expect(insertCue([late], cue("new"), 0)[1]).toBe(late);
  });
});

describe("anchors", () => {
  it("snaps to 5 s and never below 0", () => {
    expect(snapSeconds(62.4)).toBe(60);
    expect(snapSeconds(62.6)).toBe(65);
    expect(snapSeconds(-30)).toBe(0);
  });
  it("moves a fixed start, but not the opener or an item that follows", () => {
    const items = [
      cue("open", { clockOffsetSeconds: 0 }),
      cue("b"),
      cue("c", { clockOffsetSeconds: 300 }),
    ];
    expect(moveAnchor(items, 2, 421)[2].clockOffsetSeconds).toBe(420);
    expect(moveAnchor(items, 0, 30)).toBe(items);
    expect(moveAnchor(items, 1, 30)).toBe(items);
    expect(moveAnchor(items, 7, 30)).toBe(items);
  });
});

describe("timelineLayout", () => {
  it("draws every item where rundownTiming() starts it, for the fixture hour", () => {
    const layout = timelineLayout(rundownFixtureLog.items, rundownFixtureSongs);
    const timing = rundownTiming(rundownFixtureLog.items, rundownFixtureSongs);
    layout.items.forEach((item, index) => {
      expect(item.startMs).toBe(timing[index].startMs);
      expect(item.durationMs).toBe(timing[index].durationMs);
    });
    const gaps = layout.zones.filter((zone) => zone.kind === "gap");
    expect(gaps.map((zone) => zone.widthMs)).toEqual(
      timing.flatMap((row) => (row.gapMs ? [row.gapMs] : [])),
    );
  });
  it("totals content, gaps, overruns and filler cuts, and draws unknown lengths dashed", () => {
    const items: FlightCue[] = [
      cue("open", { clockOffsetSeconds: 0, durationMs: 90_000 }),
      cue("news", { clockOffsetSeconds: 60 }),
      { id: "song", kind: "playSong", songId: 1, isFiller: true },
      cue("top", { clockOffsetSeconds: 100 }),
      { id: "unknown", kind: "playSong", songId: 2 },
      cue("after"),
      { id: "end", kind: "stopSong", clockOffsetSeconds: 600 },
    ];
    const layout = timelineLayout(items, songs);
    expect(layout.overrunMs).toBe(30_000);
    expect(layout.fillerCutMs).toBe(50_000);
    expect(layout.contentMs).toBe(90_000 + 30_000 + 60_000 + 30_000 + 30_000);
    expect(layout.unknownCount).toBe(1);
    expect(layout.gapMs).toBe(0);
    const unknown = layout.items[4];
    expect(unknown).toMatchObject({
      unknown: true,
      widthMs: UNKNOWN_DISPLAY_MS,
      leftMs: 130_000,
    });
    // After an unknown length the start is unknown; it is drawn right after.
    expect(layout.items[5]).toMatchObject({ startMs: null, leftMs: 160_000 });
    expect(layout.zones).toEqual([
      { kind: "cut", index: 0, leftMs: 60_000, widthMs: 30_000 },
      { kind: "cut", index: 2, leftMs: 100_000, widthMs: 50_000 },
    ]);
    expect(layout.anchors.map((anchor) => anchor.seconds)).toEqual([
      0, 60, 100, 600,
    ]);
    expect(layout.spanMs).toBe(15 * 60_000);
  });
  it("counts no gap before an intentional stop, and grows past 15 minutes", () => {
    const items: FlightCue[] = [
      cue("open", { clockOffsetSeconds: 0 }),
      { id: "stop", kind: "stopSong" },
      cue("late", { clockOffsetSeconds: 1500 }),
    ];
    const layout = timelineLayout(items, songs);
    expect(layout.gapMs).toBe(0);
    expect(layout.zones).toEqual([
      { kind: "gap", index: 1, leftMs: 30_000, widthMs: 1_470_000 },
    ]);
    expect(layout.spanMs).toBe(26 * 60_000);
  });
  it("puts a drop ahead of the first item whose middle is past it", () => {
    const layout = timelineLayout(
      [cue("a", { clockOffsetSeconds: 0 }), cue("b")],
      songs,
    );
    expect(dropIndex(layout, 0)).toBe(0);
    expect(dropIndex(layout, 20_000)).toBe(1);
    expect(dropIndex(layout, 50_000)).toBe(2);
  });
});

describe("library", () => {
  const catalog = [
    {
      id: 1,
      title: "Harbor Light",
      artist: "Keepers",
      durationMs: 60_000,
      enabled: true,
    },
    {
      id: 2,
      title: "Old jingle",
      artist: "Keepers",
      durationMs: null,
      enabled: false,
    },
  ] as SongCatalogItem[];
  const clips = [
    { id: 9, name: "Station ident", enabled: true },
    { id: 8, name: "Retired", enabled: false },
  ] as InstantItem[];
  it("lists enabled songs and clips and a stop, filtered and searched", () => {
    expect(
      libraryRows(catalog, clips, "", "all").map((row) => row.key),
    ).toEqual(["song-1", "clip-9", "stop"]);
    expect(
      libraryRows(catalog, clips, "", "song").map((row) => row.key),
    ).toEqual(["song-1"]);
    expect(
      libraryRows(catalog, clips, " IDENT ", "all").map((row) => row.key),
    ).toEqual(["clip-9"]);
    expect(libraryRows(catalog, clips, "keepers", "clip")).toEqual([]);
  });
  it("reads only well-formed library drags", () => {
    expect(parseLibraryDrag('{"type":"song","id":1}')).toEqual({
      type: "song",
      id: 1,
    });
    expect(parseLibraryDrag('{"type":"stop"}')).toEqual({ type: "stop" });
    for (const data of [
      "",
      "null",
      "7",
      '{"type":"song","id":"1"}',
      '{"type":"scene","id":1}',
    ])
      expect(parseLibraryDrag(data)).toBeNull();
  });
});
