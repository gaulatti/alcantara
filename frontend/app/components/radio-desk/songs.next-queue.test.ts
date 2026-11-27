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
    // It names the entry, so a take of it can consume that entry (walk part 5).
    expect(nextUp({ sequence, queue, playback: airing("q1", "c:playback") })).toMatchObject({ itemId: "b", via: "queue", entryId: "q2" });
  });

  it("falls back to the rotation after the song on air when only that entry is queued", () => {
    const queue = [{ id: "q1", itemId: "b", enqueuedAt: 1 }];
    expect(nextUp({ sequence, queue, playback: airing("q1", "b:playback") })).toMatchObject({ itemId: "c", via: "rotation" });
    expect(nextUp({ sequence, queue, playback: airing("q1", "b:playback") })).not.toHaveProperty("entryId");
  });

  it("still names a queued song when nothing from the queue is on air", () => {
    const queue = [{ id: "q1", itemId: "c", enqueuedAt: 1 }];
    expect(nextUp({ sequence, queue, playback: airing(null, "a:playback") })).toMatchObject({ itemId: "c", via: "queue" });
    expect(nextUp({ sequence, queue, playback: null })).toMatchObject({ itemId: "c", via: "queue" });
  });

  // A one-song rotation, asked on the desk's own terms: the only song is the one on air. GM's call on #816: a loop of
  // one is the same song, so Next names it and says so.
  it("names the only rotation song as next when it is on air and nothing is queued, marked as the same song", () => {
    const one = { items: [leaf("a")], activeItemId: "a", loop: true } as unknown as ProgramSongSequence;
    expect(nextUp({ sequence: one, queue: [], playback: airing(null, "a:playback") })).toMatchObject({
      itemId: "a",
      via: "rotation",
      sameSong: true,
    });
    // Off air, the first song of a one-song rotation is simply next.
    expect(nextUp({ sequence: one, queue: [], playback: null })).not.toHaveProperty("sameSong");
  });

  it("returns no next song for a one-song rotation that does not loop, when that song is on air", () => {
    const one = { items: [leaf("a")], activeItemId: "a", loop: false } as unknown as ProgramSongSequence;
    expect(nextUp({ sequence: one, queue: [], playback: airing(null, "a:playback") })).toBeNull();
  });

  // GM's call on #816: Next never names the song on air. A playback that reports no queue entry at all (an older
  // backend) is matched by position: the head whose song is on air is the one airing.
  it("skips the queue head whose song is on air when the playback reports no queue entry", () => {
    const queue = [{ id: "q1", itemId: "a", enqueuedAt: 1 }];
    expect(nextUp({ sequence, queue, playback: airing(undefined as unknown as null, "a:playback") })).toMatchObject({ itemId: "b", via: "rotation" });
    const two = [...queue, { id: "q2", itemId: "c", enqueuedAt: 2 }];
    expect(nextUp({ sequence, queue: two, playback: airing(undefined as unknown as null, "a:playback") })).toMatchObject({ itemId: "c", via: "queue" });
  });

  it("keeps a queued replay of the song on air when the playback says it did not come from the queue", () => {
    const queue = [{ id: "q1", itemId: "a", enqueuedAt: 1 }];
    expect(nextUp({ sequence, queue, playback: airing(null, "a:playback") })).toMatchObject({ itemId: "a", via: "queue" });
  });
});

describe("nextUp and the song the engine cued", () => {
  const cued = { ...sequence, activeItemId: "b", cuedItemId: "b" } as ProgramSongSequence;

  it("names the cued song, off air or over a song taken from outside the rotation", () => {
    expect(nextUp({ sequence: cued, queue: [], playback: null })).toMatchObject({ itemId: "b", via: "rotation" });
    expect(nextUp({ sequence: cued, queue: [], playback: airing(null, "x:playback") })).toMatchObject({ itemId: "b" });
  });

  it("follows the queue first, and moves on once the cued song is on air", () => {
    const queue = [{ id: "q1", itemId: "c", enqueuedAt: 1 }];
    expect(nextUp({ sequence: cued, queue, playback: null })).toMatchObject({ itemId: "c", via: "queue" });
    expect(nextUp({ sequence: cued, queue: [], playback: airing(null, "b:playback") })).toMatchObject({ itemId: "c" });
  });

  it("ignores a mark the cursor has left", () => {
    const moved = { ...cued, activeItemId: "a" } as ProgramSongSequence;
    expect(nextUp({ sequence: moved, queue: [], playback: null })).toMatchObject({ itemId: "b" });
    const gone = { ...cued, activeItemId: "c", cuedItemId: "a" } as ProgramSongSequence;
    expect(nextUp({ sequence: gone, queue: [], playback: null })).toMatchObject({ itemId: "a" });
  });
});

describe("nextUp after a claim stops or fails", () => {
  it("names the queue head again once nothing plays, though the report still names it", () => {
    const queue = [{ id: "q1", itemId: "c", enqueuedAt: 1 }, { id: "q2", itemId: "b", enqueuedAt: 2 }];
    const stopped = { ...airing("q1", "c:playback"), isPlaying: false } as ProgramSongPlaybackState;
    expect(nextUp({ sequence, queue, playback: stopped })).toMatchObject({ itemId: "c", entryId: "q1" });
  });
});

describe("nextUp and a cued song inside a nested block", () => {
  const block = { id: "block", kind: "sequence", label: "Block", sequence: { items: [leaf("p1"), leaf("p2"), leaf("p3")], activeItemId: "p2", loop: true } };
  const nested = { items: [leaf("a"), block], activeItemId: "block", loop: true, cuedItemId: "p2" } as unknown as ProgramSongSequence;

  it("names the cued leaf, and nothing cued once the block's cursor has left it", () => {
    expect(nextUp({ sequence: nested, queue: [], playback: null })).toMatchObject({ itemId: "p2" });
    const moved = { ...nested, items: [leaf("a"), { ...block, sequence: { ...block.sequence, activeItemId: "p3" } }] } as unknown as ProgramSongSequence;
    expect(nextUp({ sequence: moved, queue: [], playback: null })?.itemId).not.toBe("p2");
  });
});

it("names a rotation song when neither a cue nor a cursor is stored", () => {
  const bare = { items: [leaf("a"), leaf("b")], activeItemId: null, cuedItemId: null, loop: true } as unknown as ProgramSongSequence;
  expect(nextUp({ sequence: bare, queue: [], playback: null })).toMatchObject({ via: "rotation" });
});
