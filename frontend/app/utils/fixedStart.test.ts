import { describe, expect, it } from "vitest";
import {
  FIXED_START_MAX_HOURS,
  fixedStartClock,
  parseFixedStart,
} from "./fixedStart";

// Built in local time, like the timeline's clock labels, so the cases hold in any time zone.
const at = (hours: number, minutes: number, day = 26) =>
  new Date(2026, 10, day, hours, minutes).toISOString();
const block = at(7, 10);

describe("parseFixedStart", () => {
  it("reads a clock time, with or without seconds, as seconds from the block start", () => {
    expect(parseFixedStart("07:25", block, null)).toEqual({ ok: true, seconds: 900 });
    expect(parseFixedStart(" 07:25:30 ", block, null)).toEqual({ ok: true, seconds: 930 });
    expect(parseFixedStart("7:10", block, null)).toEqual({ ok: true, seconds: 0 });
  });

  it("reads +mm:ss and plain seconds as offsets, as stored", () => {
    expect(parseFixedStart("+15:30", block, null)).toEqual({ ok: true, seconds: 930 });
    expect(parseFixedStart("+930", block, null)).toEqual({ ok: true, seconds: 930 });
    expect(parseFixedStart("930", block, null)).toEqual({ ok: true, seconds: 930 });
    expect(parseFixedStart("+65:00", block, null)).toEqual({ ok: true, seconds: 3900 });
  });

  it("wraps a clock time past midnight into the next day", () => {
    expect(parseFixedStart("00:10", at(23, 50), null)).toEqual({ ok: true, seconds: 1200 });
    expect(fixedStartClock(at(23, 50), 1200)).toMatch(/^00:10:00$/);
  });

  it("says a time shortly before the block start is before it", () => {
    expect(parseFixedStart("07:00", block, null)).toEqual({
      ok: false,
      message: "07:00 is before this block starts at 07:10.",
    });
    expect(parseFixedStart("01:10", block, null)).toEqual({
      ok: false,
      message: "01:10 is before this block starts at 07:10.",
    });
  });

  it("refuses a time more than the bound after the block start", () => {
    expect(FIXED_START_MAX_HOURS).toBe(6);
    expect(parseFixedStart("00:30", block, null)).toEqual({
      ok: false,
      message: "00:30 is more than 6 hours after this block starts at 07:10.",
    });
    expect(parseFixedStart("13:10", block, null)).toEqual({
      ok: false,
      message: "13:10 is more than 6 hours after this block starts at 07:10.",
    });
    expect(parseFixedStart("21600", block, null)).toMatchObject({ ok: false });
    expect(parseFixedStart("13:09:59", block, null)).toEqual({ ok: true, seconds: 21_599 });
  });

  it("refuses a time at or after the next block's start", () => {
    expect(parseFixedStart("07:30", block, at(7, 30))).toEqual({
      ok: false,
      message: "07:30 is after the next block starts at 07:30.",
    });
    expect(parseFixedStart("+19:59", block, at(7, 30))).toEqual({ ok: true, seconds: 1199 });
  });

  it("explains the accepted forms for anything else", () => {
    for (const entry of ["abc", "24:00", "07:60", "+5:7", "-30", "1.5"])
      expect(parseFixedStart(entry, block, null)).toEqual({
        ok: false,
        message: "Enter a clock time (07:10 or 07:10:30), an offset (+05:00) or seconds.",
      });
  });
});
