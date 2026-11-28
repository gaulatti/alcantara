import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GAIN_TOLERANCE,
  PRESENT,
  gainVerdict,
  presentVerdict,
} from "./routing-levels.mjs";

test("a gain of 0.25 measured about 12 dB down passes", () => {
  const verdict = gainVerdict(0.14, 0.035, 0.25);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.db, -12);
});

test("a gain that did not apply, or applied twice, fails", () => {
  assert.equal(gainVerdict(0.14, 0.14, 0.25).ok, false);
  assert.equal(gainVerdict(0.14, 0.14 * 0.25 * 0.25, 0.25).ok, false);
  assert.equal(
    gainVerdict(0.14, 0.14 * 0.25 * GAIN_TOLERANCE * 0.99, 0.25).ok,
    true,
  );
});

test("a source never heard at unity fails the gain check", () => {
  assert.equal(gainVerdict(PRESENT / 2, PRESENT / 8, 0.25).ok, false);
  assert.equal(gainVerdict(0, 0, 0.25).ok, false);
});

test("present and absent", () => {
  assert.equal(presentVerdict(0.1, true).ok, true);
  assert.equal(presentVerdict(0.0005, false).ok, true);
  assert.equal(presentVerdict(0.0005, true).ok, false);
  assert.equal(presentVerdict(0.1, false).ok, false);
});
