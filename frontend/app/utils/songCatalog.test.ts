import { describe, expect, it } from "vitest";
import {
  catalogCounts,
  formatLength,
  formatRuntime,
  songLengthSeconds,
} from "./songCatalog";

describe("song catalog helpers", () => {
  it("reads the analysis length before durationMs, and ignores anything that is not a length", () => {
    expect(songLengthSeconds({ durationMs: 60_000, analysis: { durationSeconds: 200 } })).toBe(200);
    expect(songLengthSeconds({ durationMs: 60_000 })).toBe(60);
    expect(songLengthSeconds({ durationMs: 60_000, analysis: { durationSeconds: null } })).toBe(60);
    expect(songLengthSeconds({ durationMs: 60_000, analysis: { durationSeconds: 0 } })).toBe(60);
    expect(songLengthSeconds({ durationMs: null, analysis: { durationSeconds: 95 } })).toBe(95);
    expect(songLengthSeconds({ durationMs: null })).toBeNull();
    expect(songLengthSeconds({ durationMs: 0, analysis: null })).toBeNull();
    expect(songLengthSeconds({ durationMs: Number.NaN })).toBeNull();
  });

  it("writes a length as m:ss or h:mm:ss, and a dash for none", () => {
    expect(formatLength(null)).toBe("—");
    expect(formatLength(0)).toBe("0:00");
    expect(formatLength(214.9)).toBe("3:34");
    expect(formatLength(3600)).toBe("1:00:00");
    expect(formatLength(3725)).toBe("1:02:05");
    expect(formatLength(-5)).toBe("0:00");
  });

  it("writes a runtime as h:mm", () => {
    expect(formatRuntime(0)).toBe("0:00");
    expect(formatRuntime(3_725_000)).toBe("1:02");
    expect(formatRuntime(96_060_000)).toBe("26:41");
    expect(formatRuntime(-1)).toBe("0:00");
  });

  it("counts the catalog from the server's totals, never more known lengths than songs", () => {
    expect(catalogCounts({ catalogTotal: 412, catalogEnabled: 402, catalogKnownDurationCount: 388 })).toEqual({
      total: 412,
      enabled: 402,
      withLength: 388,
      withoutLength: 24,
    });
    expect(catalogCounts({ catalogTotal: 3, catalogEnabled: 3, catalogKnownDurationCount: 9 })).toMatchObject({
      withLength: 3,
      withoutLength: 0,
    });
  });
});
