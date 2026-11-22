import { expect, it } from "vitest";
import {
  INSTANT_SHORTCUT_KEYS,
  getInstantShortcutIndex,
  getInstantShortcutLetter,
} from "./broadcast";

const RETIRED_KEYS = ["k", "w", "t", "n", "l", "r", "s"];

it("keeps the six chords the palette and the browser own out of the cartwall map", () => {
  for (const key of RETIRED_KEYS) {
    expect(INSTANT_SHORTCUT_KEYS).not.toContain(key);
  }
});

it("plays nothing for Ctrl+K: the key has no cartwall slot", () => {
  expect(getInstantShortcutIndex("k")).toBe(-1);
});

it("maps each remaining letter to its own slot", () => {
  INSTANT_SHORTCUT_KEYS.split("").forEach((key, index) => {
    expect(getInstantShortcutIndex(key)).toBe(index);
  });
});

it("rejects anything that is not a single lowercase letter", () => {
  expect(getInstantShortcutIndex("K")).toBe(-1);
  expect(getInstantShortcutIndex("1")).toBe(-1);
  expect(getInstantShortcutIndex("Enter")).toBe(-1);
});

it("shows a key cap for every slot in the map and none beyond it", () => {
  INSTANT_SHORTCUT_KEYS.split("").forEach((key, index) => {
    expect(getInstantShortcutLetter(index)).toBe(key.toUpperCase());
  });
  expect(getInstantShortcutLetter(INSTANT_SHORTCUT_KEYS.length)).toBeNull();
  expect(getInstantShortcutLetter(-1)).toBeNull();
});

it("never draws a key cap for a retired chord", () => {
  for (let index = 0; index < 30; index += 1) {
    const cap = getInstantShortcutLetter(index);
    if (cap !== null) {
      expect(RETIRED_KEYS).not.toContain(cap.toLowerCase());
    }
  }
});
