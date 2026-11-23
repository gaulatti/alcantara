import { expect, it } from "vitest";
import {
  clampUnit,
  dbToFader,
  dbToGain,
  faderToDb,
  faderToGain,
  formatGainDb,
  gainToDb,
  gainToMeterFill,
  interpolateGainLog,
} from "./audioTaper";

// gaulatti/alcantara#184, group G6: the console's fader taper and meter
// scale, as the mixer's faders, labels and meters use them.

it("keeps unit values in range and treats a non-number as full", () => {
  expect([clampUnit(-0.5), clampUnit(0.25), clampUnit(3)]).toEqual([
    0, 0.25, 1,
  ]);
  expect(clampUnit(Number.NaN)).toBe(1);
  expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(1);
});

it("converts between gain and decibels", () => {
  expect(gainToDb(1)).toBe(0);
  expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4);
  expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  expect(gainToDb(-1)).toBe(Number.NEGATIVE_INFINITY);
  expect(gainToDb(Number.NaN)).toBe(Number.NEGATIVE_INFINITY);
  expect(dbToGain(0)).toBe(1);
  expect(dbToGain(-20)).toBeCloseTo(0.1, 10);
  expect(dbToGain(Number.NEGATIVE_INFINITY)).toBe(0);
  expect(dbToGain(Number.NaN)).toBe(0);
});

it("maps the fader to decibels along the console taper", () => {
  expect(faderToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  expect(faderToDb(-1)).toBe(Number.NEGATIVE_INFINITY);
  expect(faderToDb(1)).toBe(0);
  expect(faderToDb(Number.NaN)).toBe(0);
  // Below the first point the fader fades in from console silence (-80 dB).
  expect(faderToDb(0.015)).toBeCloseTo(-75, 10);
  expect(faderToDb(0.03)).toBeCloseTo(-70, 10);
  // Between points it interpolates linearly in decibels.
  expect(faderToDb(0.5)).toBeCloseTo(-15, 10);
  expect(faderToDb(0.61)).toBeCloseTo(-11.5, 10);
  expect(faderToDb(0.94)).toBeCloseTo(-1.5, 10);
});

it("maps decibels back to the fader position", () => {
  expect(dbToFader(Number.NaN)).toBe(0);
  expect(dbToFader(Number.NEGATIVE_INFINITY)).toBe(0);
  expect(dbToFader(-80)).toBe(0);
  expect(dbToFader(-90)).toBe(0);
  expect(dbToFader(0)).toBe(1);
  expect(dbToFader(6)).toBe(1);
  expect(dbToFader(Number.POSITIVE_INFINITY)).toBe(0);
  expect(dbToFader(-75)).toBeCloseTo(0.015, 10);
  expect(dbToFader(-70)).toBeCloseTo(0.03, 10);
  expect(dbToFader(-15)).toBeCloseTo(0.5, 10);
  expect(dbToFader(-1.5)).toBeCloseTo(0.94, 10);
  // The two directions agree across the travel.
  for (const fader of [0.01, 0.2, 0.4, 0.66, 0.8, 0.99]) {
    expect(dbToFader(faderToDb(fader))).toBeCloseTo(fader, 10);
  }
});

it("turns a fader position into the gain it applies", () => {
  expect(faderToGain(0)).toBe(0);
  expect(faderToGain(1)).toBe(1);
  expect(faderToGain(0.5)).toBeCloseTo(dbToGain(-15), 10);
});

it("labels a gain in decibels for the console", () => {
  expect(formatGainDb(1)).toBe("0.0 dB");
  expect(formatGainDb(0.5)).toBe("-6.0 dB");
  expect(formatGainDb(2)).toBe("6.0 dB");
  expect(formatGainDb(0)).toBe("-inf dB");
});

it("fills the meter from -24 dB up, on a visual curve", () => {
  expect(gainToMeterFill(0)).toBe(0);
  expect(gainToMeterFill(dbToGain(-30))).toBe(0);
  expect(gainToMeterFill(1)).toBe(1);
  expect(gainToMeterFill(2)).toBe(1);
  expect(gainToMeterFill(dbToGain(-12))).toBeCloseTo(Math.pow(0.5, 1.6), 10);
});

it("ramps between two gains on a decibel scale", () => {
  expect(interpolateGainLog(0.2, 0.8, 0)).toBe(0.2);
  expect(interpolateGainLog(-1, 0.8, -3)).toBe(0);
  expect(interpolateGainLog(0.2, 0.8, 1)).toBe(0.8);
  expect(interpolateGainLog(0.2, -1, 5)).toBe(0);
  // Halfway between -20 dB and 0 dB is -10 dB, not the linear midpoint.
  expect(interpolateGainLog(0.1, 1, 0.5)).toBeCloseTo(dbToGain(-10), 10);
  // Silence counts as -80 dB, at either end.
  expect(interpolateGainLog(0, 1, 0.5)).toBeCloseTo(dbToGain(-40), 10);
  expect(interpolateGainLog(1, 0, 0.25)).toBeCloseTo(dbToGain(-20), 10);
});

// gaulatti/alcantara#438: the taper sits on the on-air audio path, so a value that is not a usable
// number must come out as a safe level, never as an error.
it("turns a fader or decibel value that is out of range or not a number into a safe level", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 7, -3, Number.NEGATIVE_INFINITY]) {
    const db = faderToDb(bad);
    expect(Number.isNaN(db)).toBe(false);
    expect(db).toBeLessThanOrEqual(0);
    const fader = dbToFader(bad);
    expect(fader).toBeGreaterThanOrEqual(0);
    expect(fader).toBeLessThanOrEqual(1);
    expect(Number.isNaN(faderToGain(bad))).toBe(false);
  }
  expect(faderToDb(1.5)).toBe(0);
  expect(faderToDb(Number.NaN)).toBe(0);
  expect(faderToDb(-3)).toBe(Number.NEGATIVE_INFINITY);
  expect(dbToFader(1.5)).toBe(1);
  expect(dbToFader(Number.NaN)).toBe(0);
  expect(dbToFader(-500)).toBe(0);
});
