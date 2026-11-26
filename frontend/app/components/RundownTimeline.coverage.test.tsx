import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RundownTimeline } from "./RundownTimeline";
import type { FlightCue } from "../models/broadcast";

// gaulatti/alcantara#527: the fixed-start pins on the timeline. A pin that is already on air or first cannot be
// dragged, and a movable pin reports a pointer move as a new start. The ruler has no width in jsdom, so the
// pointer maps to 0. Fictional names only.

afterEach(cleanup);

const items: FlightCue[] = [
  { id: "open", kind: "wait", durationMs: 60_000, label: "Open" },
  { id: "bumper", kind: "wait", durationMs: 60_000, label: "Bumper", clockOffsetSeconds: 60 },
  { id: "song", kind: "wait", durationMs: 60_000, label: "Song", clockOffsetSeconds: 120 },
] as FlightCue[];

function renderTimeline(onMoveAnchor = vi.fn()) {
  render(
    <RundownTimeline
      items={items}
      songs={[]}
      clips={[]}
      scheduledAt="2026-11-23T12:00:00Z"
      activeIndex={1}
      selectedCueId={null}
      disabled={false}
      onSelect={vi.fn()}
      onDropEntry={vi.fn()}
      onMoveAnchor={onMoveAnchor}
    />,
  );
  return onMoveAnchor;
}

it("does not start a drag on a pin that is already on air", () => {
  const onMoveAnchor = renderTimeline();
  const onAir = screen.getByRole("slider", { name: "Fixed start of Bumper" });
  expect(onAir).toHaveAttribute("aria-disabled", "true");
  fireEvent.pointerDown(onAir, { pointerId: 1, clientX: 40 });
  fireEvent.pointerMove(onAir, { clientX: 80 });
  expect(onMoveAnchor).not.toHaveBeenCalled();
});

it("drags a movable pin and reports the pointer position as its new start", () => {
  const onMoveAnchor = renderTimeline();
  const pin = screen.getByRole("slider", { name: "Fixed start of Song" });
  expect(pin).toHaveAttribute("aria-disabled", "false");
  const capture = vi.fn();
  (pin as unknown as { setPointerCapture: typeof capture }).setPointerCapture = capture;
  fireEvent.pointerDown(pin, { pointerId: 1, clientX: 40 });
  expect(capture).toHaveBeenCalledTimes(1);
  fireEvent.pointerMove(pin, { clientX: 80 });
  expect(onMoveAnchor).toHaveBeenCalledWith(2, 0);
  fireEvent.pointerUp(pin);
  fireEvent.pointerMove(pin, { clientX: 120 });
  expect(onMoveAnchor).toHaveBeenCalledTimes(1);
});
