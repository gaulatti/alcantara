import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { FlightCue } from "../models/broadcast";
import { timelineLayout } from "./rundownBuilder";

// The rundown overrun rule the backend ports for the MCP publish check (backend/src/program/rundown-overrun.ts,
// #788): both run the same cases from shared/rundown-overrun.cases.json, so the two cannot drift unnoticed.
const { cases } = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "shared", "rundown-overrun.cases.json"), "utf8"),
) as {
  cases: {
    name: string;
    songs: Record<string, number | null>;
    items: FlightCue[];
    overrunMs: number;
  }[];
};

it("has the fixed-start, fit, unknown-length and filler cases", () => {
  expect(cases.length).toBeGreaterThanOrEqual(4);
});

it.each(cases.map((one) => [one.name, one] as const))("%s", (_name, one) => {
  const songs = Object.entries(one.songs).map(([id, durationMs]) => ({
    id: Number(id),
    durationMs,
  }));
  expect(timelineLayout(one.items, songs).overrunMs).toBe(one.overrunMs);
});
