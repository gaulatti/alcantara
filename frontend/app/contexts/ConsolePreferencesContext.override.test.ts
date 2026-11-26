import { afterEach, expect, it, vi } from "vitest";
import { readOverride } from "./ConsolePreferencesContext";

// gaulatti/alcantara#527: the device override is read only where a window exists; with no window there is no
// override, and the reader says so rather than touching storage.

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

it("reads no override when there is no window to read from", () => {
  vi.stubGlobal("window", undefined);
  expect(readOverride()).toBeNull();
});

it("reads a saved device override from the window's storage", () => {
  window.localStorage.setItem("alcantara.console.deviceClassOverride", "tablet");
  expect(readOverride()).toBe("tablet");
});
