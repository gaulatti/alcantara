import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RadioTransport } from "./RadioTransport";

// gaulatti/alcantara#624: the transport's keyboard and refusal paths that the component tests leave out: a stop
// refused with a plain value, Space on a focused button with nothing armed, Escape with nothing armed, and the
// stop's Alt-period key when keys are switched off. Fictional names only.

afterEach(cleanup);

const next = { itemId: "s2", via: "rotation", title: "Copper Season", artist: "The Paper Hours", durationMs: 241_000 } as const;

function transport(overrides: Partial<React.ComponentProps<typeof RadioTransport>> = {}) {
  const props = {
    next,
    onTake: vi.fn(async () => undefined),
    onTakeOffAir: vi.fn(async () => undefined),
    onListen: vi.fn(),
    listening: false,
    ...overrides,
  };
  render(<RadioTransport {...(props as React.ComponentProps<typeof RadioTransport>)} />);
  return props;
}

it("shows the stop refusal when the stop fails with a plain value", async () => {
  transport({ onTakeOffAir: vi.fn(() => Promise.reject("line busy")) as never });
  const stop = screen.getByRole("button", { name: "Stop the song on air" });
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  try {
    fireEvent.pointerDown(stop);
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.pointerUp(stop);
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(screen.getByText("The stop was refused")).toBeInTheDocument());
});

it("leaves Space alone on a focused button when no cue is armed", () => {
  const props = transport();
  const button = screen.getByRole("button", { name: "Stop the song on air" });
  button.focus();
  fireEvent.keyDown(button, { key: " " });
  expect(props.onTake).not.toHaveBeenCalled();
});

it("ignores Escape when no cue is armed", () => {
  const props = transport();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(props.onTake).not.toHaveBeenCalled();
  expect(props.onTakeOffAir).not.toHaveBeenCalled();
});

it("does not stop the song from Alt and period when keys are switched off", async () => {
  const props = transport({ keysEnabled: false } as never);
  fireEvent.keyDown(window, { key: ".", code: "Period", altKey: true });
  await new Promise((resolve) => setTimeout(resolve, 700));
  fireEvent.keyUp(window, { key: ".", code: "Period", altKey: true });
  expect(props.onTakeOffAir).not.toHaveBeenCalled();
});

it("shows the message of a stop that fails with an error", async () => {
  transport({ onTakeOffAir: vi.fn(() => Promise.reject(new Error("Playout is unreachable"))) as never });
  const stop = screen.getByRole("button", { name: "Stop the song on air" });
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  try {
    fireEvent.pointerDown(stop);
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.pointerUp(stop);
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(screen.getByText("Playout is unreachable")).toBeInTheDocument());
});

it("does not stop the song from a period without Alt, or from Alt with another key", async () => {
  const props = transport();
  fireEvent.keyDown(window, { key: ".", code: "Period" });
  fireEvent.keyDown(window, { key: "x", altKey: true });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(props.onTakeOffAir).not.toHaveBeenCalled();
});
