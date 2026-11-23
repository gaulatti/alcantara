import { describe, expect, it } from "vitest";
import type { FlightCue } from "../models/broadcast";
import { detachUse, groupRundown, insertCues, moveRow, removeUse, replaceUse } from "./recipeUses";

const use = (useId: string, steps: string[], songId = 42): FlightCue[] =>
  steps.map((step) => ({
    id: `${useId}.${step}`,
    kind: step === "song" ? "playSong" : "wait",
    recipeUse: { useId, recipeId: 7, recipeRevision: 1, step, params: { songId } },
  }));
const cue = (id: string): FlightCue => ({ id, kind: "wait", durationMs: 1000 });
const ids = (items: FlightCue[]) => items.map((item) => item.id);

describe("recipe use rows (gaulatti/alcantara#425)", () => {
  it("shows contiguous cues of one use as one row, and other cues as their own rows", () => {
    const items = [cue("a"), ...use("use_aaaaaaaaaaaa", ["bumper", "song"]), cue("b")];
    const rows = groupRundown(items);
    expect(rows.map((row) => row.kind)).toEqual(["cue", "use", "cue"]);
    expect(rows[1]).toMatchObject({ useId: "use_aaaaaaaaaaaa", recipeId: 7, songId: 42, start: 1, end: 3, partial: false });
  });

  it("marks a use split by a hand-placed cue as partial, in both parts", () => {
    const [first, second] = use("use_bbbbbbbbbbbb", ["bumper", "song"]);
    const rows = groupRundown([first, cue("x"), second]);
    expect(rows.map((row) => (row.kind === "use" ? row.partial : null))).toEqual([true, null, true]);
  });

  it("detaches a use: the same cues, without the tag, others untouched", () => {
    const other = use("use_cccccccccccc", ["song"]);
    const items = [...use("use_aaaaaaaaaaaa", ["bumper", "song"]), ...other];
    const detached = detachUse(items, "use_aaaaaaaaaaaa");
    expect(ids(detached)).toEqual(ids(items));
    expect(detached.slice(0, 2).every((item) => !("recipeUse" in item))).toBe(true);
    expect(detached[2]).toBe(other[0]);
  });

  it("replaces a use's cues where it was, and leaves the rundown alone for an unknown use", () => {
    const items = [cue("a"), ...use("use_aaaaaaaaaaaa", ["bumper", "song"]), cue("b")];
    const next = use("use_aaaaaaaaaaaa", ["song"], 99);
    expect(ids(replaceUse(items, "use_aaaaaaaaaaaa", next))).toEqual(["a", "use_aaaaaaaaaaaa.song", "b"]);
    expect(replaceUse(items, "use_zzzzzzzzzzzz", next)).toBe(items);
  });

  it("replaces a split use as one, at its first cue", () => {
    const [first, second] = use("use_bbbbbbbbbbbb", ["bumper", "song"]);
    const items = [cue("a"), first, cue("x"), second];
    const next = use("use_bbbbbbbbbbbb", ["bumper", "song"], 5);
    expect(ids(replaceUse(items, "use_bbbbbbbbbbbb", next))).toEqual(["a", "use_bbbbbbbbbbbb.bumper", "use_bbbbbbbbbbbb.song", "x"]);
  });

  it("removes a use", () => {
    const items = [cue("a"), ...use("use_aaaaaaaaaaaa", ["bumper", "song"])];
    expect(ids(removeUse(items, "use_aaaaaaaaaaaa"))).toEqual(["a"]);
  });

  it("moves a whole use past a cue or another use, never splitting it", () => {
    const items = [cue("a"), ...use("use_aaaaaaaaaaaa", ["bumper", "song"]), ...use("use_cccccccccccc", ["song"])];
    expect(ids(moveRow(items, 1, "up"))).toEqual(["use_aaaaaaaaaaaa.bumper", "use_aaaaaaaaaaaa.song", "a", "use_cccccccccccc.song"]);
    expect(ids(moveRow(items, 1, "down"))).toEqual(["a", "use_cccccccccccc.song", "use_aaaaaaaaaaaa.bumper", "use_aaaaaaaaaaaa.song"]);
    expect(moveRow(items, 0, "up")).toBe(items);
    expect(moveRow(items, 2, "down")).toBe(items);
    expect(moveRow(items, 9, "up")).toBe(items);
  });

  it("inserts cues at a position, at the end by default, clamped", () => {
    const items = [cue("a"), cue("b")];
    expect(ids(insertCues(items, [cue("x")], 1))).toEqual(["a", "x", "b"]);
    expect(ids(insertCues(items, [cue("x")]))).toEqual(["a", "b", "x"]);
    expect(ids(insertCues(items, [cue("x")], -3))).toEqual(["x", "a", "b"]);
  });
});
