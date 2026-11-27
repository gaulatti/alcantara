import assert from "node:assert/strict";
import { test } from "node:test";
import { proven, toneReport } from "./onair-proof.mjs";

const RATE = 44_100;
// Music-like material: several moving partials and noise, some of them near the tone.
function music(seconds) {
  const out = new Float32Array(RATE * seconds);
  let seed = 7;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const t = i / RATE;
    out[i] =
      0.25 * Math.sin(2 * Math.PI * 220 * t) +
      0.15 * Math.sin(2 * Math.PI * 880 * t + 1.2 * Math.sin(2 * Math.PI * 5 * t)) +
      0.1 * Math.sin(2 * Math.PI * 3100 * t) +
      0.1 * (seed / 2147483647 - 0.5);
  }
  return out;
}
const withTone = (samples, gain, hz = 1000) => samples.map((v, i) => v + gain * Math.sin((2 * Math.PI * hz * i) / RATE));

test("hears a steady tone under music, at full and at a tenth of its level", () => {
  for (const gain of [0.2, 0.02]) {
    const result = toneReport(withTone(music(10), gain), RATE, 1000);
    assert.equal(result.present, true, JSON.stringify(result));
    assert.ok(Math.abs(result.toneDbfs - 20 * Math.log10(gain)) < 3, JSON.stringify(result));
  }
});

test("does not hear it in music alone, in silence, or in a tone beside it", () => {
  for (const samples of [music(10), new Float32Array(RATE * 5), withTone(music(10), 0.2, 1040)]) {
    const result = toneReport(samples, RATE, 1000);
    assert.equal(result.present, false, JSON.stringify(result));
    assert.equal(result.absent, true, JSON.stringify(result));
  }
});

test("a tone for part of the time is neither present nor absent", () => {
  const samples = music(10);
  samples.set(withTone(samples.subarray(0, RATE * 5), 0.2));
  const result = toneReport(samples, RATE, 1000);
  assert.deepEqual([result.present, result.absent], [false, false]);
});

test("passes only on absent, then present, then absent", () => {
  const yes = { present: true, absent: false };
  const no = { present: false, absent: true };
  // The guest page said On air and then Off air in time.
  const page = { liveShown: true, offShown: true };
  assert.equal(proven(no, yes, no, page), true);
  assert.equal(proven(no, yes, yes, page), false);
  assert.equal(proven(no, no, no, page), false);
  assert.equal(proven(yes, yes, no, page), false);
  assert.equal(proven(no, yes, null, page), false);
  assert.equal(proven(no, yes, no, { liveShown: true, offShown: false }), false);
  assert.equal(proven(no, yes, no), false);
  assert.equal(toneReport(new Float32Array(0), RATE, 1000).absent, false);
});
