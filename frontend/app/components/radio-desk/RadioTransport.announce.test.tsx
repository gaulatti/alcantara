import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RadioTransport } from "./RadioTransport";

// The transport's status line announces each outcome once: a take shows the song it took, a confirmed
// stop shows "Stopped.", and the next cue clears it. A refused stop stays in its alert. Fictional names only.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const next = { itemId: "s2", via: "rotation" as const, title: "Copper Season", artist: "The Paper Hours", durationMs: 241_000 };

// Holds the stop control with Space for longer than its hold time, as an operator does.
async function holdStop(control: HTMLElement) {
  fireEvent.keyDown(control, { key: " " });
  await act(async () => {
    vi.advanceTimersByTime(700);
  });
  fireEvent.keyUp(control, { key: " " });
  await act(async () => {
    await Promise.resolve();
  });
}

it("announces a take with the song taken", async () => {
  const onTake = vi.fn(async () => undefined);
  render(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} />);
  fireEvent.keyDown(window, { key: "n" });
  await act(async () => {
    fireEvent.keyDown(window, { key: " " });
  });
  expect(onTake).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent(/Taken\s*Copper Season: waiting for the engine/);
});

it("announces a confirmed stop once, and the next cue clears it", async () => {
  const onTakeOffAir = vi.fn(async () => undefined);
  render(<RadioTransport next={next} onTake={vi.fn()} onTakeOffAir={onTakeOffAir} />);
  await holdStop(screen.getByRole("button", { name: "Stop the song on air" }));
  expect(onTakeOffAir).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent(/^Stopped\.$/);

  fireEvent.click(screen.getByRole("button", { name: /Cue next/ }));
  expect(screen.getByRole("status")).not.toHaveTextContent("Stopped.");
});

it("does not announce a stop the engine refused; the refusal stays in its alert", async () => {
  const onTakeOffAir = vi.fn(async () => {
    throw new Error("Engine refused off air");
  });
  render(<RadioTransport next={next} onTake={vi.fn()} onTakeOffAir={onTakeOffAir} />);
  await holdStop(screen.getByRole("button", { name: "Stop the song on air" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Engine refused off air");
  expect(screen.getByRole("status")).not.toHaveTextContent("Stopped.");
});
