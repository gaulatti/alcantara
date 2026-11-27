import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DEAD_BAND_FRACTION, assertLocalOrigin, longestDeadBand, overlappingPairs } from "./console-layout.mjs";

// Column occupancy is one boolean per step from the top of the fold; each step is 10 px here.
const yes = (n) => Array.from({ length: n }, () => true);
const no = (n) => Array.from({ length: n }, () => false);

test("a column empty beside a neighbour's content is a dead band", () => {
  // The bug: the middle column has a line at the top and a card at the bottom, and is empty between them.
  const middle = [...yes(2), ...no(20), ...yes(2)];
  const right = yes(24);
  assert.equal(longestDeadBand([middle, right], 10), 200);
});

test("trailing space below a column's last element is not a dead band", () => {
  const short = [...yes(3), ...no(20)];
  const tall = yes(24);
  assert.equal(longestDeadBand([short, tall], 10), 0);
});

test("an empty stretch beside no content anywhere is not a dead band", () => {
  assert.equal(longestDeadBand([[...yes(2), ...no(20), ...yes(2)], no(24)], 10), 0);
});

test("the limit is 40% of the fold", () => {
  assert.equal(MAX_DEAD_BAND_FRACTION, 0.4);
});

test("finds the overlapping pairs of boxes", () => {
  assert.deepEqual(overlappingPairs([{ left: 0, right: 100, top: 0, bottom: 100 }, { left: 50, right: 150, top: 50, bottom: 150 }, { left: 200, right: 300, top: 0, bottom: 50 }]), [[0, 1]]);
  assert.deepEqual(overlappingPairs([{ left: 0, right: 100, top: 0, bottom: 100 }, { left: 100, right: 200, top: 0, bottom: 100 }]), []);
});

test("is local only", () => {
  assertLocalOrigin("http://localhost:5173");
  assertLocalOrigin("http://127.0.0.1:5173");
  assert.throws(() => assertLocalOrigin("https://alcantara.gaulatti.com"), /local-only/);
});
