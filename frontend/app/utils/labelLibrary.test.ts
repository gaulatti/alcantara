import { describe, expect, it } from "vitest";
import {
  formatChanged,
  matchesLabel,
  mediaMix,
  moveItem,
  sortLabels,
  type LabelLike,
} from "./labelLibrary";

const label = (
  name: string,
  assetCount: number,
  updatedAt: string,
  types: string[] = [],
  description: string | null = null,
): LabelLike => ({
  id: name,
  name,
  description,
  assetCount,
  updatedAt,
  assets: types.map((mediaType, index) => ({
    position: index,
    asset: { id: `${name}-${index}`, mediaType },
  })),
});

describe("label library helpers", () => {
  it("counts a label's listed media by type and ignores a type it does not show", () => {
    expect(
      mediaMix(label("x", 5, "2026-11-01T00:00:00Z", ["AUDIO", "AUDIO", "IMAGE", "VIDEO", "OTHER"])),
    ).toEqual({ AUDIO: 2, IMAGE: 1, VIDEO: 1 });
    expect(mediaMix(label("empty", 0, "2026-11-01T00:00:00Z"))).toEqual({
      AUDIO: 0,
      IMAGE: 0,
      VIDEO: 0,
    });
  });

  it("sorts by use, name or last change, breaking ties by name", () => {
    const labels = [
      label("Beta", 3, "2026-11-10T00:00:00Z"),
      label("Alpha", 3, "2026-11-01T00:00:00Z"),
      label("Gamma", 9, "2026-10-01T00:00:00Z"),
    ];
    const names = (sort: Parameters<typeof sortLabels>[1]) =>
      sortLabels(labels, sort).map((entry) => entry.name);
    expect(names("used")).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(names("name")).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(names("changed")).toEqual(["Beta", "Alpha", "Gamma"]);
    // The input is not reordered.
    expect(labels.map((entry) => entry.name)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(
      sortLabels(
        [label("B", 1, "2026-11-01T00:00:00Z"), label("A", 1, "2026-11-01T00:00:00Z")],
        "changed",
      ).map((entry) => entry.name),
    ).toEqual(["A", "B"]);
  });

  it("matches a label by name or description, ignoring case and blanks", () => {
    const entry = label("Station IDs", 1, "2026-11-01T00:00:00Z", [], "Identifiers and sweepers");
    expect(matchesLabel(entry, "")).toBe(true);
    expect(matchesLabel(entry, "  ")).toBe(true);
    expect(matchesLabel(entry, "station")).toBe(true);
    expect(matchesLabel(entry, "SWEEP")).toBe(true);
    expect(matchesLabel(entry, "sponsor")).toBe(false);
    expect(matchesLabel(label("Plain", 0, "2026-11-01T00:00:00Z"), "x")).toBe(false);
  });

  it("writes a change time as today, yesterday or a date", () => {
    const now = new Date(2026, 10, 22, 15, 30);
    expect(formatChanged(new Date(2026, 10, 22, 9, 5).toISOString(), now)).toBe("Today 09:05");
    expect(formatChanged(new Date(2026, 10, 21, 23, 0).toISOString(), now)).toBe("Yesterday");
    expect(formatChanged(new Date(2026, 10, 18, 8, 0).toISOString(), now)).toBe("Nov 18");
    expect(formatChanged(new Date(2025, 11, 30, 8, 0).toISOString(), now)).toBe("Dec 30, 2025");
    expect(formatChanged("not a date", now)).toBe("—");
  });

  it("moves an item to another place and leaves the list alone when nothing changes", () => {
    const items = ["a", "b", "c", "d"];
    expect(moveItem(items, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(items, 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(items).toEqual(["a", "b", "c", "d"]);
    expect(moveItem(items, 1, 1)).toBe(items);
    expect(moveItem(items, -1, 2)).toBe(items);
    expect(moveItem(items, 1, 9)).toBe(items);
    expect(moveItem(items, 9, 1)).toBe(items);
  });
});
