import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HoldButton } from "./HoldButton";

// gaulatti/alcantara#693 review: a hold acts only while the control allows it. A disabled control never starts a
// hold, even when a pointer event reaches it, and a control that becomes disabled mid-hold drops the hold.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const control = (onConfirm: () => void, disabled: boolean) => (
  <HoldButton label="Stop session" hint="Hold to stop." holdMs={600} onConfirm={onConfirm} disabled={disabled}>
    Stop session
  </HoldButton>
);

it("never starts a hold on a disabled control, by pointer or by key", async () => {
  const onConfirm = vi.fn();
  render(control(onConfirm, true));
  const button = screen.getByRole("button", { name: "Stop session" });
  fireEvent.pointerDown(button);
  fireEvent.keyDown(button, { key: " " });
  await advance(700);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByTestId("hold-fill").style.width).toBe("0%");
});

it("drops a hold when the control becomes disabled before the hold completes", async () => {
  const onConfirm = vi.fn();
  const view = render(control(onConfirm, false));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Stop session" }));
  await advance(300);
  view.rerender(control(onConfirm, true));
  await advance(400);
  expect(onConfirm).not.toHaveBeenCalled();
  // Enabled again, a new full hold still acts.
  view.rerender(control(onConfirm, false));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Stop session" }));
  await advance(700);
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
