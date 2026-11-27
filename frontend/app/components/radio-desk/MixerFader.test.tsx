import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { dbToFader, faderToDb } from "../../utils/audioTaper";
import { MixerFader } from "./MixerFader";

// Walk part 4: one stray click on a mixer fader's track moved on-air music to −45.6 dB. GM's call (on-air safety): a
// fader moves only by drag or a key step, and a click on the track does nothing.

afterEach(cleanup);

// jsdom has no PointerEvent, so a pointer event would carry no coordinates: a MouseEvent with a pointer id stands in.
if (!("PointerEvent" in window)) {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.assign(window, { PointerEvent: TestPointerEvent });
}

const mount = (value = 0.5) => {
  const onChange = vi.fn();
  render(<MixerFader label="Music level" value={value} onChange={onChange} />);
  const slider = screen.getByRole("slider", { name: "Music level" });
  const handle = screen.getByTestId("fader-handle");
  // The track is 116 px wide, so the thumb travels 100 px.
  vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 116 } as DOMRect);
  return { onChange, slider, handle };
};

it("takes no pointer input on the track, so a click there moves nothing", () => {
  const { onChange, slider } = mount();
  expect(slider).toHaveStyle({ pointerEvents: "none" });
  fireEvent.pointerDown(slider, { clientX: 5, pointerId: 1 });
  fireEvent.click(slider, { clientX: 5 });
  expect(onChange).not.toHaveBeenCalled();
});

it("moves by how far the handle is dragged, not to where it was grabbed, and stops when released", () => {
  const { onChange, handle } = mount(0.5);
  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 7 });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerMove(handle, { clientX: 320, pointerId: 7 });
  expect(onChange).toHaveBeenLastCalledWith(0.7);
  fireEvent.pointerMove(handle, { clientX: 500, pointerId: 7 });
  expect(onChange).toHaveBeenLastCalledWith(1);
  fireEvent.pointerMove(handle, { clientX: 250, pointerId: 9 });
  expect(onChange).toHaveBeenCalledTimes(2);
  fireEvent.pointerUp(handle, { pointerId: 7 });
  fireEvent.pointerMove(handle, { clientX: 100, pointerId: 7 });
  expect(onChange).toHaveBeenCalledTimes(2);
  // A cancelled drag ends too, and another pointer's release leaves a drag running.
  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 8 });
  fireEvent.pointerUp(handle, { pointerId: 3 });
  fireEvent.pointerMove(handle, { clientX: 290, pointerId: 8 });
  expect(onChange).toHaveBeenLastCalledWith(0.4);
  fireEvent.pointerCancel(handle, { pointerId: 8 });
  fireEvent.pointerMove(handle, { clientX: 200, pointerId: 8 });
  expect(onChange).toHaveBeenCalledTimes(3);
});

it("ignores a drag on a track too narrow to travel", () => {
  const onChange = vi.fn();
  render(<MixerFader label="Music level" value={0.5} onChange={onChange} />);
  const handle = screen.getByTestId("fader-handle");
  fireEvent.pointerDown(handle, { clientX: 10, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 40, pointerId: 1 });
  expect(onChange).not.toHaveBeenCalled();
});

it("steps one decibel with the arrow keys, from silence too, and never jumps with Home, End or the page keys", () => {
  const { onChange, slider } = mount(0.5);
  const db = faderToDb(0.5);
  fireEvent.keyDown(slider, { key: "ArrowUp" });
  expect(onChange).toHaveBeenLastCalledWith(dbToFader(db + 1));
  fireEvent.keyDown(slider, { key: "ArrowLeft" });
  expect(onChange).toHaveBeenLastCalledWith(dbToFader(db - 1));
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  fireEvent.keyDown(slider, { key: "ArrowDown" });
  expect(onChange).toHaveBeenCalledTimes(4);
  for (const key of ["Home", "End", "PageUp", "PageDown"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    slider.dispatchEvent(event);
    expect(event.defaultPrevented, key).toBe(true);
  }
  fireEvent.keyDown(slider, { key: "Tab" });
  expect(onChange).toHaveBeenCalledTimes(4);
  fireEvent.change(slider, { target: { value: "0.3" } });
  expect(onChange).toHaveBeenLastCalledWith(0.3);
  cleanup();
  const silent = mount(0);
  fireEvent.keyDown(silent.slider, { key: "ArrowUp" });
  expect(silent.onChange).toHaveBeenLastCalledWith(dbToFader(-79));
});

it("starts no drag from a right or control click, and ends one that loses the pointer", () => {
  const { onChange, handle } = mount(0.5);
  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1, button: 2 });
  fireEvent.pointerMove(handle, { clientX: 320, pointerId: 1 });
  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 2, ctrlKey: true });
  fireEvent.pointerMove(handle, { clientX: 320, pointerId: 2 });
  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 3 });
  fireEvent.lostPointerCapture(handle, { pointerId: 3 });
  fireEvent.pointerMove(handle, { clientX: 320, pointerId: 3 });
  expect(onChange).not.toHaveBeenCalled();
});
