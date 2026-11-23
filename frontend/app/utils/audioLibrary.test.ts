import { expect, it } from "vitest";
import { formatCue } from "./audioLibrary";

// gaulatti/alcantara#288: a cue point is shown as m:ss.s and rounds to tenths before it splits,
// so a value just under a boundary never reads 0:010.0 or 0:60.0.
it("formats cue points as m:ss.s", () => {
  expect(formatCue(0)).toBe("0:00.0");
  expect(formatCue(0.42)).toBe("0:00.4");
  expect(formatCue(209.8)).toBe("3:29.8");
  expect(formatCue(61.25)).toBe("1:01.3");
});

it("carries a value that rounds up to the next ten seconds or minute", () => {
  expect(formatCue(9.96)).toBe("0:10.0");
  expect(formatCue(59.96)).toBe("1:00.0");
  expect(formatCue(119.99)).toBe("2:00.0");
});
