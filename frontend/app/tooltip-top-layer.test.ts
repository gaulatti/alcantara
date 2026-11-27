import { expect, it } from "vitest";

// gaulatti/alcantara#723: floating-ui (Radix tooltips and popovers) asks element.matches(':modal') and
// ':popover-open' on every position update. jsdom's selector engine recursed through ':fullscreen' until the
// stack overflowed, and each check cost seconds, so a test file that opened a tooltip stalled and later tests
// timed out (the reason tooltip tests once had to sit alone in their files, #743). test/setup.ts answers these
// selectors directly. This pins that: they match nothing, at once, and every other selector still works.

it("answers the top-layer selectors floating-ui asks for at once, and matches nothing", () => {
  const button = document.createElement("button");
  document.body.append(button);
  const started = performance.now();
  for (const selector of [":modal", ":popover-open", ":fullscreen", " :modal "]) {
    expect(button.matches(selector)).toBe(false);
  }
  expect(performance.now() - started).toBeLessThan(100);
  button.remove();
});

it("leaves every other selector to jsdom", () => {
  const button = document.createElement("button");
  button.className = "loop";
  document.body.append(button);
  expect(button.matches("button.loop")).toBe(true);
  expect(button.matches("body > button")).toBe(true);
  expect(button.matches("a")).toBe(false);
  expect(() => button.matches(":not(")).toThrow();
  button.remove();
});
