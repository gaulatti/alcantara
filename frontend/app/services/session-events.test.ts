import { afterEach, expect, it, vi } from "vitest";
import { reportInvalidSession, SESSION_INVALID_EVENT } from "./session-events";

afterEach(() => vi.unstubAllGlobals());

it("announces an invalid session to the window", () => {
  const listener = vi.fn();
  window.addEventListener(SESSION_INVALID_EVENT, listener);
  reportInvalidSession();
  window.removeEventListener(SESSION_INVALID_EVENT, listener);
  expect(SESSION_INVALID_EVENT).toBe("alcantara:session-invalid");
  expect(listener).toHaveBeenCalledTimes(1);
});
it("does nothing without a window", () => {
  vi.stubGlobal("window", undefined);
  expect(() => reportInvalidSession()).not.toThrow();
});
