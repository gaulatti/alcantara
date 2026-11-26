import { describe, expect, it } from "vitest";
import type { ProgramSongPlaybackState } from "../../models/broadcast";
import type { ProgramSongSequence } from "../../utils/programSequence";
import { nextUp, type SongLeaf } from "./songs";

// Walk part 4 (an operator's hour on the radio desk): a song put on air from Play Next stays in the queue, marked
// Playing, until it ends. Next must not name it, or Cue next and Take would put the same song on air again.

const leaf = (id: string): SongLeaf =>
  ({ kind: "preset", id, title: `Title ${id}`, artist: "Artist", coverUrl: "", audioUrl: `https://media.test/${id}.mp3` }) as SongLeaf;
const sequence = {
  items: [leaf("a"), leaf("b"), leaf("c")],
  activeItemId: "a",
  loop: true,
} as unknown as ProgramSongSequence;
const airing = (queueEntryId: string | null, token: string) =>
  ({ isPlaying: true, token, audioUrl: null, queueEntryId }) as unknown as ProgramSongPlaybackState;

describe("nextUp and the queue entry on air", () => {
  it("skips the queue entry on air and names the next one queued", () => {
    const queue = [
      { id: "q1", itemId: "c", enqueuedAt: 1 },
      { id: "q2", itemId: "b", enqueuedAt: 2 },
    ];
    expect(nextUp({ sequence, queue, playback: airing("q1", "c:playback") })).toMatchObject({ itemId: "b", via: "queue" });
  });

  it("falls back to the rotation after the song on air when only that entry is queued", () => {
    const queue = [{ id: "q1", itemId: "b", enqueuedAt: 1 }];
    expect(nextUp({ sequence, queue, playback: airing("q1", "b:playback") })).toMatchObject({ itemId: "c", via: "rotation" });
  });

  it("still names a queued song when nothing from the queue is on air", () => {
    const queue = [{ id: "q1", itemId: "c", enqueuedAt: 1 }];
    expect(nextUp({ sequence, queue, playback: airing(null, "a:playback") })).toMatchObject({ itemId: "c", via: "queue" });
    expect(nextUp({ sequence, queue, playback: null })).toMatchObject({ itemId: "c", via: "queue" });
  });

  // A one-song rotation, asked on the desk's own terms: the only song is the one on air.
  it("names the only rotation song as next when it is on air and nothing is queued (the loop repeats it)", () => {
    const one = { items: [leaf("a")], activeItemId: "a", loop: true } as unknown as ProgramSongSequence;
    expect(nextUp({ sequence: one, queue: [], playback: airing(null, "a:playback") })).toMatchObject({ itemId: "a", via: "rotation" });
  });

  it("returns no next song for a one-song rotation that does not loop, when that song is on air", () => {
    const one = { items: [leaf("a")], activeItemId: "a", loop: false } as unknown as ProgramSongSequence;
    expect(nextUp({ sequence: one, queue: [], playback: airing(null, "a:playback") })).toBeNull();
  });

  // A playback that carries no queue entry id cannot tell which queued entry is on air, so the entry is not skipped.
  it("does not skip a queued song when the playback carries no queue entry id", () => {
    const queue = [{ id: "q1", itemId: "a", enqueuedAt: 1 }];
    expect(nextUp({ sequence, queue, playback: airing(undefined as unknown as null, "a:playback") })).toMatchObject({ itemId: "a", via: "queue" });
  });
});
