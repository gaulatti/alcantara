import { describe, expect, it } from "vitest";
import type { ProgramSongPlaybackState, SongCatalogItem } from "../../models/broadcast";
import type { ProgramSongSequence } from "../../utils/programSequence";
import { findPlayableSongs, nextUp, onAirLeaf, type SongLeaf } from "./songs";

// gaulatti/alcantara#404 (radio desk songs, from the full-run table): rotation items that come without a
// length or an audio address, and a playback report that names neither. These are the rows a rotation can
// hold before the library fills them in; the desk must still find, cue and report them.

const bare = (id: string, extra: Partial<SongLeaf> = {}): SongLeaf =>
  ({ kind: "preset", id, title: `Title ${id}`, artist: "Artist", coverUrl: "", audioUrl: `https://media.test/${id}.mp3`, ...extra }) as SongLeaf;

const sequence = (items: SongLeaf[], extra: Partial<ProgramSongSequence> = {}): ProgramSongSequence =>
  ({ items, activeItemId: null, loop: true, ...extra }) as unknown as ProgramSongSequence;

describe("radio desk songs with missing length or address", () => {
  it("reports a rotation song with no length as having none, in the next-up and the search", () => {
    const seq = sequence([bare("s1", { durationMs: undefined })]);
    expect(nextUp({ sequence: seq, queue: [], playback: null })).toMatchObject({ itemId: "s1", durationMs: null, via: "rotation" });
    const found = findPlayableSongs(seq.items, [], "title");
    expect(found).toEqual([expect.objectContaining({ key: "rotation:s1", durationMs: null, source: "rotation" })]);
  });

  it("keeps a rotation song's length when it has one", () => {
    const seq = sequence([bare("s2", { durationMs: 95_000 })]);
    expect(nextUp({ sequence: seq, queue: [], playback: null })).toMatchObject({ durationMs: 95_000 });
    expect(findPlayableSongs(seq.items, [], "title")[0]).toMatchObject({ durationMs: 95_000 });
  });

  it("finds nothing on air for a playing report with no token and no address", () => {
    const leaves = [bare("s3")];
    const playing = { isPlaying: true, token: null, audioUrl: null } as unknown as ProgramSongPlaybackState;
    expect(onAirLeaf(leaves, playing, null)).toBeNull();
  });

  it("matches an on-air address to a rotation song that has no address of its own", () => {
    const leaves = [bare("s4", { audioUrl: "" }), bare("s5")];
    const playing = { isPlaying: true, token: null, audioUrl: "https://media.test/s5.mp3" } as unknown as ProgramSongPlaybackState;
    expect(onAirLeaf(leaves, playing, null)?.id).toBe("s5");
    const idle = { isPlaying: true, token: null, audioUrl: "" } as unknown as ProgramSongPlaybackState;
    expect(onAirLeaf(leaves, idle, null)).toBeNull();
  });

  it("does not hold a library song to a rotation address it does not share", () => {
    const catalog: SongCatalogItem[] = [
      { id: 7, artist: "Artist", title: "Title library", audioUrl: "https://media.test/lib.mp3", coverUrl: null, durationMs: 120_000, earoneSongId: null, earoneRank: null, earoneSpins: null, enabled: true },
    ];
    const found = findPlayableSongs([bare("s6", { audioUrl: "" })], catalog, "library");
    expect(found.map((candidate) => candidate.key)).toEqual(["library:7"]);
  });
});
