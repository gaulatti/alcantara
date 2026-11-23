import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HoldButton } from "./HoldButton";

// gaulatti/alcantara#404 (group B): the keyboard path of a hold-to-confirm control (Space and Enter held on the
// focused control), a repeated key that must not restart the hold, a global key that holds the control from
// anywhere but never from inside a field, and a global hold released early by its modifier.

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

it("confirms when Space is held on the focused control, and not when it is released early", async () => {
  const onConfirm = vi.fn();
  render(<HoldButton label="Stop" hint="Hold to stop." holdMs={600} onConfirm={onConfirm}>Stop</HoldButton>);
  const button = screen.getByRole("button", { name: "Stop" });
  fireEvent.keyDown(button, { key: " " });
  await advance(300);
  fireEvent.keyUp(button, { key: " " });
  await advance(400);
  expect(onConfirm).not.toHaveBeenCalled();

  fireEvent.keyDown(button, { key: " " });
  await advance(700);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  fireEvent.keyUp(button, { key: " " });
});

it("says how to use it after a quick Enter press, and a repeated key does not restart the hold", async () => {
  const onConfirm = vi.fn();
  render(<HoldButton label="Stop" hint="Hold to stop." holdMs={600} onConfirm={onConfirm}>Stop</HoldButton>);
  const button = screen.getByRole("button", { name: "Stop" });
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyUp(button, { key: "Enter" });
  expect(screen.getByRole("status")).toHaveTextContent("Hold to stop.");

  fireEvent.keyDown(button, { key: "Enter", repeat: true });
  await advance(700);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("holds a global key from anywhere, and ignores it while a field has the focus", async () => {
  const onConfirm = vi.fn();
  const globalKey = (event: KeyboardEvent) => event.key === "h" && event.altKey;
  render(
    <>
      <input aria-label="Field" />
      <HoldButton label="Stop" hint="Hold to stop." holdMs={600} onConfirm={onConfirm} globalKey={globalKey}>Stop</HoldButton>
    </>,
  );
  fireEvent.keyDown(screen.getByLabelText("Field"), { key: "h", altKey: true });
  await advance(700);
  expect(onConfirm).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: "h", altKey: true });
  await advance(700);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  fireEvent.keyUp(window, { key: "h", altKey: true });
});

it("releasing the global key's modifier ends the hold early", async () => {
  const onConfirm = vi.fn();
  const globalKey = (event: KeyboardEvent) => event.key === "h" && event.altKey;
  render(<HoldButton label="Stop" hint="Hold to stop." holdMs={600} onConfirm={onConfirm} globalKey={globalKey}>Stop</HoldButton>);
  fireEvent.keyDown(window, { key: "h", altKey: true });
  await advance(300);
  fireEvent.keyUp(window, { key: "Alt" });
  await advance(700);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("releasing the period ends a global hold that the period started", async () => {
  const onConfirm = vi.fn();
  const globalKey = (event: KeyboardEvent) => event.key === "h" && event.altKey;
  render(<HoldButton label="Stop" hint="Hold to stop." holdMs={600} onConfirm={onConfirm} globalKey={globalKey}>Stop</HoldButton>);
  fireEvent.keyDown(window, { key: "h", altKey: true });
  await advance(300);
  fireEvent.keyUp(window, { key: ".", code: "Period" });
  await advance(700);
  expect(onConfirm).not.toHaveBeenCalled();
});
