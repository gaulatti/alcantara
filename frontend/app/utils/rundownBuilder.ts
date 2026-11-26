import type {
  FlightCue,
  InstantItem,
  SongCatalogItem,
} from "../models/broadcast";
import { rundownTiming } from "./rundownTiming";

/**
 * The direct-manipulation rundown (gaulatti/alcantara#299) edits the same
 * FlightCue list the parameter forms did; these helpers are its only writers.
 */

/** Fixed starts snap to this many seconds, by drag or arrow key. */
export const ANCHOR_STEP_SECONDS = 5;
/** Width given to an item with no stored length, so it can still be seen. */
export const UNKNOWN_DISPLAY_MS = 30_000;

export type LibraryEntry =
  | { type: "song"; id: number }
  | { type: "clip"; id: number }
  | { type: "stop" };

/** The MIME type a library drag carries; nothing else is accepted. */
export const LIBRARY_DRAG_TYPE = "application/x-alcantara-rundown-entry";

/**
 * A new cue for a library entry, in the shape the forms always created: an
 * id and kind, its song or clip, and a fixed start at 0 only when it opens
 * the block.
 */
export function cueFor(entry: LibraryEntry, opensBlock: boolean): FlightCue {
  const cue: FlightCue = {
    id: crypto.randomUUID(),
    kind:
      entry.type === "song"
        ? "playSong"
        : entry.type === "clip"
          ? "instant"
          : "stopSong",
    ...(opensBlock ? { clockOffsetSeconds: 0 } : {}),
  };
  if (entry.type === "song") cue.songId = entry.id;
  if (entry.type === "clip") cue.instantId = entry.id;
  return cue;
}

/**
 * Inserts `cue` at `index` (the end when omitted). Appending keeps a closing
 * fixed-start stop last, as the forms did; nothing is inserted before a locked
 * (already played) item.
 */
export function insertCue(
  items: FlightCue[],
  cue: FlightCue,
  index?: number,
  lockedThrough = -1,
): FlightCue[] {
  if (index === undefined) {
    const end = items.at(-1);
    return end?.kind === "stopSong" && end.clockOffsetSeconds !== undefined
      ? [...items.slice(0, -1), cue, end]
      : [...items, cue];
  }
  const at = Math.min(Math.max(index, lockedThrough + 1, 0), items.length);
  const next = [...items.slice(0, at), cue, ...items.slice(at)];
  // The block's first item always starts at 0, as the forms enforced.
  // The old opener then follows the new one instead of restarting at 0.
  if (at === 0) {
    next[0] = { ...cue, clockOffsetSeconds: 0 };
    if (next[1]?.clockOffsetSeconds === 0) {
      const { clockOffsetSeconds: _opened, ...follows } = next[1];
      next[1] = follows;
    }
  }
  return next;
}

export function snapSeconds(seconds: number): number {
  return Math.max(
    0,
    Math.round(seconds / ANCHOR_STEP_SECONDS) * ANCHOR_STEP_SECONDS,
  );
}

/** Moves a fixed start (the first item stays at 0). */
export function moveAnchor(
  items: FlightCue[],
  index: number,
  seconds: number,
): FlightCue[] {
  if (index <= 0 || items[index]?.clockOffsetSeconds === undefined)
    return items;
  const clockOffsetSeconds = snapSeconds(seconds);
  return items.map((item, row) =>
    row === index ? { ...item, clockOffsetSeconds } : item,
  );
}

export interface TimelineItem {
  cue: FlightCue;
  index: number;
  /** Where the item is drawn, in ms from the block start. */
  leftMs: number;
  widthMs: number;
  /** Start and length as rundownTiming() computes them (null: unknown). */
  startMs: number | null;
  durationMs: number | null | undefined;
  unknown: boolean;
}

export interface TimelineZone {
  kind: "gap" | "cut";
  /** The item after which the zone falls. */
  index: number;
  leftMs: number;
  widthMs: number;
}

export interface TimelineLayout {
  items: TimelineItem[];
  zones: TimelineZone[];
  anchors: Array<{ index: number; seconds: number }>;
  /** Sum of the stored lengths (unknown lengths count as 0). */
  contentMs: number;
  gapMs: number;
  /** Content lost at fixed starts, fillers excluded. */
  overrunMs: number;
  /** Fillers cut at fixed starts. */
  fillerCutMs: number;
  unknownCount: number;
  /** Total span drawn, at least the last fixed start plus one minute. */
  spanMs: number;
}

/**
 * Lays the block out on a time axis. Every number comes from rundownTiming();
 * the only invention is where to draw an item whose start or length is
 * unknown: right after the previous one, UNKNOWN_DISPLAY_MS wide, dashed.
 */
export function timelineLayout(
  items: FlightCue[],
  songs: Pick<SongCatalogItem, "id" | "durationMs">[],
): TimelineLayout {
  const timing = rundownTiming(items, songs);
  let drawCursor = 0;
  const laid: TimelineItem[] = [];
  const zones: TimelineZone[] = [];
  const anchors: TimelineLayout["anchors"] = [];
  let contentMs = 0;
  let gapMs = 0;
  let overrunMs = 0;
  let fillerCutMs = 0;
  let unknownCount = 0;
  items.forEach((cue, index) => {
    const row = timing[index];
    if (cue.clockOffsetSeconds !== undefined) {
      drawCursor = cue.clockOffsetSeconds * 1000;
      anchors.push({ index, seconds: cue.clockOffsetSeconds });
    }
    const leftMs = row.startMs ?? drawCursor;
    const knownMs = row.durationMs;
    const unknown = knownMs == null;
    const widthMs = knownMs == null ? UNKNOWN_DISPLAY_MS : Math.max(0, knownMs);
    if (unknown) unknownCount += 1;
    else contentMs += widthMs;
    laid.push({
      cue,
      index,
      leftMs,
      widthMs,
      startMs: row.startMs,
      durationMs: row.durationMs,
      unknown,
    });
    drawCursor = leftMs + widthMs;
    const boundary = items[index + 1]?.clockOffsetSeconds;
    if (boundary === undefined) return;
    if (row.gapMs) {
      if (cue.kind !== "stopSong") gapMs += row.gapMs;
      zones.push({
        kind: "gap",
        index,
        leftMs: drawCursor,
        widthMs: row.gapMs,
      });
    }
    if (row.cutMs) {
      if (cue.isFiller) fillerCutMs += row.cutMs;
      else overrunMs += row.cutMs;
      zones.push({
        kind: "cut",
        index,
        leftMs: boundary * 1000,
        widthMs: row.cutMs,
      });
    }
  });
  const ends = [
    ...laid.map((item) => item.leftMs + item.widthMs),
    ...anchors.map((anchor) => anchor.seconds * 1000 + 60_000),
    15 * 60_000,
  ];
  return {
    items: laid,
    zones,
    anchors,
    contentMs,
    gapMs,
    overrunMs,
    fillerCutMs,
    unknownCount,
    spanMs: Math.ceil(Math.max(...ends) / 60_000) * 60_000,
  };
}

/** The index an entry dropped at `atMs` is inserted at. */
export function dropIndex(layout: TimelineLayout, atMs: number): number {
  const after = layout.items.find(
    (item) => item.leftMs + item.widthMs / 2 > atMs,
  );
  return after ? after.index : layout.items.length;
}

export interface LibraryRow {
  key: string;
  entry: LibraryEntry;
  title: string;
  detail: string;
  durationMs: number | null;
  group: "song" | "clip" | "stop";
}

/** The searchable library: enabled songs and clips, plus a stop. */
export function libraryRows(
  songs: SongCatalogItem[],
  clips: InstantItem[],
  query: string,
  filter: "all" | "song" | "clip",
): LibraryRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const rows: LibraryRow[] = [
    ...songs
      .filter((song) => song.enabled)
      .map(
        (song): LibraryRow => ({
          key: `song-${song.id}`,
          entry: { type: "song", id: song.id },
          title: song.title,
          detail: song.artist,
          durationMs: song.durationMs,
          group: "song",
        }),
      ),
    ...clips
      .filter((clip) => clip.enabled)
      .map(
        (clip): LibraryRow => ({
          key: `clip-${clip.id}`,
          entry: { type: "clip", id: clip.id },
          title: clip.name,
          detail: "Clip",
          durationMs: null,
          group: "clip",
        }),
      ),
    {
      key: "stop",
      entry: { type: "stop" },
      title: "Stop program audio",
      detail: "Intentional silence",
      durationMs: 0,
      group: "stop",
    },
  ];
  return rows.filter(
    (row) =>
      (filter === "all" || row.group === filter) &&
      (!needle ||
        `${row.title} ${row.detail}`.toLocaleLowerCase().includes(needle)),
  );
}

export function parseLibraryDrag(data: string): LibraryEntry | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object") return null;
    const { type, id } = value as { type?: unknown; id?: unknown };
    if (type === "stop") return { type };
    if ((type === "song" || type === "clip") && Number.isInteger(id))
      return { type, id: id as number };
    return null;
  } catch {
    return null;
  }
}
