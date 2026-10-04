import { expect, it } from "vitest";
import { rundownTiming } from "./rundownTiming";
it("shows real gaps, filler cuts, unknown durations, and declared clip time", () => {
  const timing = rundownTiming(
    [
      { id: "a", kind: "playSong", songId: 1, clockOffsetSeconds: 0 },
      {
        id: "b",
        kind: "playSong",
        songId: 2,
        clockOffsetSeconds: 60,
        isFiller: true,
      },
      {
        id: "c",
        kind: "instant",
        instantId: 4,
        durationMs: 10000,
        clockOffsetSeconds: 120,
      },
      { id: "d", kind: "playSong", songId: 3, clockOffsetSeconds: 180 },
    ],
    [
      { id: 1, durationMs: 20000 },
      { id: 2, durationMs: 70000 },
      { id: 3, durationMs: null },
    ],
  );
  expect(timing[0].gapMs).toBe(40000);
  expect(timing[1].cutMs).toBe(10000);
  expect(timing[2].gapMs).toBe(50000);
  expect(timing[3].gapMs).toBeNull();
});

it("has no implicit hourly end or cut after the last content event", () => {
  const [last] = rundownTiming(
    [{ id: "a", kind: "playSong", songId: 1, clockOffsetSeconds: 7200 }],
    [{ id: 1, durationMs: 200000 }],
  );
  expect(last).toMatchObject({ startMs: 7200000, gapMs: null, cutMs: null });
});
