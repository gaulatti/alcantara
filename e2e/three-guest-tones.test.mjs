import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWN_BELOW,
  PRESENT,
  TONE_GUESTS,
  analyseTones,
} from "./three-guest-tones.mjs";

const [a, b, c] = TONE_GUESTS;
const spectrum = (levels) => ({
  samples: 100,
  levels: { [a.hz]: levels.a, [b.hz]: levels.b, [c.hz]: levels.c },
});

test("three distinct tones, apart from the shared 440 Hz and from each other's low harmonics", () => {
  const tones = TONE_GUESTS.map((guest) => guest.hz);
  assert.equal(new Set(tones).size, 3);
  for (const hz of tones) assert.notEqual(hz % 440, 0);
  for (const x of tones)
    for (const y of tones)
      if (x < y) for (const k of [2, 3]) assert.ok(Math.abs(x * k - y) > 40);
});

test("a correct mix-minus: both other guests present, its own tone absent", () => {
  const verdict = analyseTones(
    a,
    TONE_GUESTS,
    spectrum({ a: 0.0001, b: 0.05, c: 0.04 }),
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.hears, { B: 0.05, C: 0.04 });
});

test("a self-echo fails, however loud the others are", () => {
  const verdict = analyseTones(
    b,
    TONE_GUESTS,
    spectrum({ a: 0.05, b: 0.05 * OWN_BELOW * 2, c: 0.05 }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ownAbsent, false);
});

test("a missing other guest fails", () => {
  const verdict = analyseTones(
    c,
    TONE_GUESTS,
    spectrum({ a: 0.05, b: PRESENT / 2, c: 0 }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.othersPresent, false);
});

test("a return never measured fails", () => {
  assert.equal(
    analyseTones(a, TONE_GUESTS, { samples: 0, levels: {} }).ok,
    false,
  );
  assert.equal(analyseTones(a, TONE_GUESTS, undefined).ok, false);
});
