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
  expect(screen.getByRole("status")).toHaveTextContent(/Taken\s*Copper Season · awaiting engine/);
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

// gaulatti/alcantara#688: once the engine confirms the taken song, the same live region says it is on air.
it("announces the taken song on air once the engine confirms it, until the next stop or cue", async () => {
  const onTake = vi.fn(async () => undefined);
  const props = { next, onTake, onTakeOffAir: vi.fn(async () => undefined) };
  const view = render(<RadioTransport {...props} />);
  const status = screen.getByRole("status");
  expect(status).toHaveAttribute("aria-live", "polite");
  fireEvent.keyDown(window, { key: "n" });
  await act(async () => {
    fireEvent.keyDown(window, { key: " " });
  });
  expect(status).toHaveTextContent(/awaiting engine/);
  // Another item confirmed on air does not end the wait.
  view.rerender(<RadioTransport {...props} confirmedItemId="s9" />);
  expect(status).toHaveTextContent(/awaiting engine/);
  view.rerender(<RadioTransport {...props} confirmedItemId="s2" />);
  expect(status).toHaveTextContent(/^On air: Copper Season\.$/);
  expect(screen.getAllByRole("status")).toHaveLength(1);

  await holdStop(screen.getByRole("button", { name: "Stop the song on air" }));
  expect(status).toHaveTextContent(/^Stopped\.$/);
  // Off air, the engine confirms nothing.
  view.rerender(<RadioTransport {...props} confirmedItemId={null} />);

  // A new cue clears the line; the take waits for its own confirmation before saying On air again.
  fireEvent.keyDown(window, { key: "n" });
  expect(status).not.toHaveTextContent("Stopped.");
  await act(async () => {
    fireEvent.keyDown(window, { key: " " });
  });
  expect(status).toHaveTextContent(/awaiting engine/);
  view.rerender(<RadioTransport {...props} confirmedItemId="s2" />);
  expect(status).toHaveTextContent(/^On air: Copper Season\.$/);
});

// Wakko's #781 review: the line said "On air: X." after X ended or automation moved on, until the next cue or stop.
it("stops naming the taken song once the engine confirms another item or nothing", async () => {
  const onTake = vi.fn(async () => undefined);
  const props = { next, onTake, onTakeOffAir: vi.fn(async () => undefined) };
  for (const after of ["s3", null]) {
    const view = render(<RadioTransport {...props} confirmedItemId={null} />);
    const status = screen.getByRole("status");
    fireEvent.keyDown(window, { key: "n" });
    await act(async () => {
      fireEvent.keyDown(window, { key: " " });
    });
    view.rerender(<RadioTransport {...props} confirmedItemId="s2" />);
    expect(status).toHaveTextContent(/^On air: Copper Season\.$/);
    view.rerender(<RadioTransport {...props} confirmedItemId={after} />);
    // Back to quiet (what plays next is in the strip, not repeated here), never On air.
    expect(status).not.toHaveTextContent("On air:");
    expect(status).toHaveTextContent(/^$/);
    view.unmount();
  }
});

it("clears an armed cue with a button, for a touch screen with no Esc", () => {
  render(<RadioTransport next={next} onTake={vi.fn()} onTakeOffAir={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Clear cue" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Cue next/ }));
  const take = screen.getByRole("button", { name: /Take/ });
  expect(take).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Clear cue" }));
  expect(screen.queryByRole("button", { name: "Clear cue" })).toBeNull();
  expect(take).toBeDisabled();
});

it("does not take the cued song when Space is pressed on Clear cue", async () => {
  const onTake = vi.fn(async () => undefined);
  render(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} />);
  fireEvent.keyDown(window, { key: "n" });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: "Clear cue" }), { key: " " });
  });
  expect(onTake).not.toHaveBeenCalled();
});
