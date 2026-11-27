import type {
  ProgramSongPlaybackState,
  ProgramSongQueueEntry,
  SongCatalogItem,
} from "../../models/broadcast";
import type {
  ProgramSongSequence,
  ProgramSongSequenceItem,
} from "../../utils/programSequence";
import { programSongPlayOrder } from "../../utils/programSequence";
import type { NextUp } from "./onAir";

export type SongLeaf = Extract<ProgramSongSequenceItem, { kind: "preset" }>;

/** The songs of a rotation in play order, with nested sequences flattened. */
export function rotationLeaves(items: ProgramSongSequenceItem[]): SongLeaf[] {
  const leaves: SongLeaf[] = [];
  for (const item of items) {
    if (item.kind === "preset") leaves.push(item);
    else leaves.push(...rotationLeaves(item.sequence.items));
  }
  return leaves;
}

/** Lower case without accents, so "cancion" finds "Canción". */
export function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** The rotation song that is on air now, by the playback token or its audio address. */
export function onAirLeaf(
  leaves: SongLeaf[],
  playback: ProgramSongPlaybackState | null,
  selectedItemId: string | null,
): SongLeaf | null {
  if (!playback?.isPlaying) return null;
  const token = (playback.token || "").trim();
  if (token) {
    const byToken = leaves.find((leaf) => token.startsWith(`${leaf.id}:`));
    if (byToken) return byToken;
  }
  const url = (playback.audioUrl || "").trim();
  if (url) {
    const matches = leaves.filter((leaf) => (leaf.audioUrl || "").trim() === url);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      return matches.find((leaf) => leaf.id === selectedItemId) ?? matches[0];
  }
  return null;
}

export interface NextUpSong extends NextUp {
  itemId: string;
  via: "queue" | "rotation";
  /** The Play Next entry this song comes from (via "queue"): a take of it must consume the entry. */
  entryId?: string;
}

/** The song the cursor is on, followed into a nested block. */
function cursorLeafId(sequence: ProgramSongSequence): string | null {
  const item = sequence.items.find((entry) => entry.id === sequence.activeItemId);
  if (!item) return null;
  return item.kind === "preset" ? item.id : cursorLeafId(item.sequence);
}

/**
 * What Cue next would cue: the head of the Play Next queue, else the song after the one on air in
 * the rotation (the first one when nothing is on air, the first again when the rotation loops).
 * After a Stop or a rotation that ran out, the song the engine cued without airing it.
 */
export function nextUp({
  sequence,
  queue,
  playback,
}: {
  sequence: ProgramSongSequence;
  queue: ProgramSongQueueEntry[];
  playback: ProgramSongPlaybackState | null;
}): NextUpSong | null {
  // In the order that plays, which in shuffle is not the rows' order.
  const leaves = rotationLeaves(programSongPlayOrder(sequence));
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const current = onAirLeaf(leaves, playback, sequence.activeItemId ?? null);
  // The entry on air stays in the queue until it ends (PlayNextQueue marks it Playing): it is not next (walk part 4).
  // A playback that reports no queue entry at all (an older backend) is matched by position: the head is on air when
  // its song is. An explicit null says the song did not come from the queue, so a queued replay of it still shows.
  // A report that nothing plays still names the entry that last played: a failed or stopped claim is next again.
  const onAirEntryId = !playback?.isPlaying
    ? null
    : playback.queueEntryId !== undefined
      ? playback.queueEntryId
      : current && queue[0]?.itemId === current.id
        ? queue[0].id
        : null;
  const queuedEntry = queue.find(
    (entry) => entry.id !== onAirEntryId && byId.has(entry.itemId),
  );
  const queued = queuedEntry ? byId.get(queuedEntry.itemId) : undefined;
  const describe = (
    leaf: SongLeaf,
    via: "queue" | "rotation",
    sameSong = false,
  ): NextUpSong => ({
    itemId: leaf.id,
    via,
    title: leaf.title,
    artist: leaf.artist,
    durationMs: typeof leaf.durationMs === "number" ? leaf.durationMs : null,
    ...(sameSong ? { sameSong: true } : {}),
  });
  if (queued) return { ...describe(queued, "queue"), entryId: queuedEntry!.id };
  if (leaves.length === 0) return null;

  // The cursor is on a song that has not aired: it is next, not the one after it. A cursor since moved is not cued.
  const cued =
    sequence.cuedItemId === cursorLeafId(sequence)
      ? byId.get(sequence.cuedItemId ?? "")
      : undefined;
  if (cued && cued !== current) return describe(cued, "rotation");

  const anchor =
    current ??
    (sequence.activeItemId ? byId.get(sequence.activeItemId) : undefined) ??
    null;
  if (!anchor) return describe(leaves[0], "rotation");
  const index = leaves.indexOf(anchor);
  const following = leaves[index + 1];
  if (following) return describe(following, "rotation");
  // A looping rotation of one song repeats the song on air: Next says so rather than looking like a mistake.
  return sequence.loop === false
    ? null
    : describe(leaves[0], "rotation", leaves[0] === current);
}

export interface PlayCandidate {
  key: string;
  title: string;
  artist: string;
  durationMs: number | null;
  source: "rotation" | "library";
  /** The rotation item, when the song is in the rotation. */
  leaf?: SongLeaf;
  /** The catalog song, when it is only in the library. */
  song?: SongCatalogItem;
}

/** Songs of the rotation, then enabled library songs that are not in it, matching the query. */
export function findPlayableSongs(
  leaves: SongLeaf[],
  catalog: SongCatalogItem[],
  query: string,
  limit = 12,
): PlayCandidate[] {
  const needle = foldForSearch(query.trim());
  if (!needle) return [];
  const matches = (artist: string, title: string) =>
    foldForSearch(`${artist} ${title}`).includes(needle);
  const out: PlayCandidate[] = [];
  const knownSongIds = new Set<number>();
  const knownUrls = new Set<string>();
  for (const leaf of leaves) {
    if (typeof leaf.songId === "number") knownSongIds.add(leaf.songId);
    if (leaf.audioUrl) knownUrls.add(leaf.audioUrl);
    if (matches(leaf.artist, leaf.title))
      out.push({
        key: `rotation:${leaf.id}`,
        title: leaf.title,
        artist: leaf.artist,
        durationMs:
          typeof leaf.durationMs === "number" ? leaf.durationMs : null,
        source: "rotation",
        leaf,
      });
  }
  for (const song of catalog) {
    if (!song.enabled || !song.audioUrl) continue;
    if (knownSongIds.has(song.id) || knownUrls.has(song.audioUrl)) continue;
    if (!matches(song.artist, song.title)) continue;
    out.push({
      key: `library:${song.id}`,
      title: song.title,
      artist: song.artist,
      durationMs: song.durationMs,
      source: "library",
      song,
    });
  }
  return out.slice(0, limit);
}
