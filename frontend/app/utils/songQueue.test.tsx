import { expect, it } from "vitest";
import { normalizeProgramSongQueue } from "./songQueue";

// gaulatti/alcantara#184, group G6: the Play Next queue as it is read back
// from program state.

it("reads nothing from a value that is not a list", () => {
  for (const value of [undefined, null, "queue", 3, { 0: {} }]) {
    expect(normalizeProgramSongQueue(value)).toEqual([]);
  }
});

it("keeps well-formed entries, trimmed and rounded, and drops the rest", () => {
  expect(
    normalizeProgramSongQueue([
      { id: " q1 ", itemId: " song-1 ", enqueuedAt: 1700000000000.4 },
      null,
      "q2",
      ["q3"],
      { id: "q4", itemId: "song-4" },
      { id: "q5", itemId: "song-5", enqueuedAt: 0 },
      { id: "q6", itemId: "song-6", enqueuedAt: -5 },
      { id: "q7", itemId: "song-7", enqueuedAt: Number.POSITIVE_INFINITY },
      { id: "q8", itemId: "song-8", enqueuedAt: "1700000000000" },
      { id: " ", itemId: "song-9", enqueuedAt: 1 },
      { id: "q10", itemId: "", enqueuedAt: 1 },
      { id: 11, itemId: "song-11", enqueuedAt: 1 },
      { id: "q12", itemId: 12, enqueuedAt: 1 },
      { id: "q1", itemId: "song-again", enqueuedAt: 2 },
      { id: "q13", itemId: "song-13", enqueuedAt: 3 },
    ]),
  ).toEqual([
    { id: "q1", itemId: "song-1", enqueuedAt: 1700000000000 },
    { id: "q13", itemId: "song-13", enqueuedAt: 3 },
  ]);
});

it("stops at 100 entries", () => {
  const entries = Array.from({ length: 105 }, (_, index) => ({
    id: `q${index}`,
    itemId: `song-${index}`,
    enqueuedAt: index + 1,
  }));
  const queue = normalizeProgramSongQueue(entries);
  expect(queue).toHaveLength(100);
  expect(queue[99]).toEqual({ id: "q99", itemId: "song-99", enqueuedAt: 100 });
});
