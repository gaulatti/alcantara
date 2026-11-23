import { afterEach, describe, expect, it } from "vitest";
import {
  cartChordLabel,
  cartModifierHeld,
  isMacPlatform,
  platformIsMac,
  resetPlatformForTests,
} from "./cartModifier";

const none = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

afterEach(() => resetPlatformForTests());

describe("isMacPlatform", () => {
  it("prefers userAgentData.platform over navigator.platform", () => {
    expect(isMacPlatform({ userAgentData: { platform: "macOS" }, platform: "Win32" })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: "Windows" }, platform: "MacIntel" })).toBe(false);
  });

  it("falls back to navigator.platform when userAgentData is absent", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "iPhone" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
  });

  it("treats a platform it cannot name as not Apple", () => {
    expect(isMacPlatform({})).toBe(false);
  });
});

describe("platformIsMac", () => {
  it("reads the platform once and keeps it until a test reset", () => {
    expect(platformIsMac()).toBe(true);
    Object.defineProperty(window.navigator, "platform", { configurable: true, get: () => "Win32" });
    expect(platformIsMac()).toBe(true);
    resetPlatformForTests();
    expect(platformIsMac()).toBe(false);
  });
});

describe("cartModifierHeld", () => {
  it("uses Ctrl alone on macOS", () => {
    expect(cartModifierHeld({ ...none, ctrlKey: true }, true)).toBe(true);
    expect(cartModifierHeld({ ...none, altKey: true }, true)).toBe(false);
    expect(cartModifierHeld({ ...none, ctrlKey: true, altKey: true }, true)).toBe(false);
    expect(cartModifierHeld({ ...none, ctrlKey: true, shiftKey: true }, true)).toBe(false);
    expect(cartModifierHeld({ ...none, ctrlKey: true, metaKey: true }, true)).toBe(false);
    expect(cartModifierHeld(none, true)).toBe(false);
  });

  it("uses Alt alone on Windows and Linux, so Ctrl+C, V, X, Z, A, F and P never play", () => {
    expect(cartModifierHeld({ ...none, altKey: true }, false)).toBe(true);
    for (const key of ["c", "v", "x", "z", "a", "f", "p"]) {
      expect(cartModifierHeld({ ...none, ctrlKey: true }, false), key).toBe(false);
    }
    expect(cartModifierHeld({ ...none, altKey: true, ctrlKey: true }, false)).toBe(false);
    expect(cartModifierHeld({ ...none, altKey: true, shiftKey: true }, false)).toBe(false);
    expect(cartModifierHeld({ ...none, altKey: true, metaKey: true }, false)).toBe(false);
  });
});

describe("cartChordLabel", () => {
  it("shows the chord for the platform", () => {
    expect(cartChordLabel("Q", true)).toBe("Ctrl+Q");
    expect(cartChordLabel("Q", false)).toBe("Alt+Q");
  });
});
