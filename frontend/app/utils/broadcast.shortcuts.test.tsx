import { expect, it } from "vitest";
import {
  INSTANT_SHORTCUT_KEYS,
  INSTANT_SHORTCUT_KEYS_ALT,
  getInstantShortcutIndex,
  getInstantShortcutLetter,
} from "./broadcast";

// Keys that belong to the command palette, the scene hotkey, or the browser or OS.
const RETIRED_KEYS = ["k", "w", "t", "n", "l", "r", "s"];
// Chrome and Edge Alt+F, Alt+E, Alt+D; Firefox Alt menu F, E, V, S, B, T, H (#308).
const ALT_MENU_KEYS = ["e", "d", "f", "v", "b", "h"];

it("keeps the six chords the palette and the browser own out of the cartwall map", () => {
  for (const key of RETIRED_KEYS) {
    expect(INSTANT_SHORTCUT_KEYS).not.toContain(key);
    expect(INSTANT_SHORTCUT_KEYS_ALT).not.toContain(key);
  }
});

it("plays nothing for Ctrl+K: the key has no cartwall slot", () => {
  expect(getInstantShortcutIndex("k", true)).toBe(-1);
});

it("maps each macOS letter to its own slot", () => {
  INSTANT_SHORTCUT_KEYS.split("").forEach((key, index) => {
    expect(getInstantShortcutIndex(key, true)).toBe(index);
  });
});

it("rejects anything that is not a single lowercase letter", () => {
  expect(getInstantShortcutIndex("K", true)).toBe(-1);
  expect(getInstantShortcutIndex("1", true)).toBe(-1);
  expect(getInstantShortcutIndex("Enter", true)).toBe(-1);
});

it("shows a key cap for every macOS slot and none beyond it", () => {
  INSTANT_SHORTCUT_KEYS.split("").forEach((key, index) => {
    expect(getInstantShortcutLetter(index, true)).toBe(key.toUpperCase());
  });
  expect(getInstantShortcutLetter(INSTANT_SHORTCUT_KEYS.length, true)).toBeNull();
  expect(getInstantShortcutLetter(-1, true)).toBeNull();
});

it("never draws a key cap for a retired chord on either platform", () => {
  for (const isMac of [true, false]) {
    for (let index = 0; index < 30; index += 1) {
      const cap = getInstantShortcutLetter(index, isMac);
      if (cap !== null) expect(RETIRED_KEYS).not.toContain(cap.toLowerCase());
    }
  }
});

it("on Windows and Linux, Alt+F, Alt+E and Alt+D play nothing: the browser menu letters are not slots", () => {
  for (const key of ALT_MENU_KEYS) {
    expect(getInstantShortcutIndex(key, false), key).toBe(-1);
  }
});

it("removes the Firefox Alt menu letters from the Windows and Linux map", () => {
  for (const key of ALT_MENU_KEYS) {
    expect(INSTANT_SHORTCUT_KEYS_ALT).not.toContain(key);
  }
});

it("keeps the Windows and Linux map an ordered subset of the macOS map", () => {
  let cursor = 0;
  for (const key of INSTANT_SHORTCUT_KEYS_ALT) {
    const found = INSTANT_SHORTCUT_KEYS.indexOf(key, cursor);
    expect(found, key).toBeGreaterThanOrEqual(0);
    cursor = found + 1;
  }
});

it("shows Alt key caps for the Windows and Linux slots", () => {
  INSTANT_SHORTCUT_KEYS_ALT.split("").forEach((key, index) => {
    expect(getInstantShortcutLetter(index, false)).toBe(key.toUpperCase());
    expect(getInstantShortcutIndex(key, false)).toBe(index);
  });
});
