import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHoldToConfirm } from "./holdToConfirm";

// gaulatti/alcantara#527 (untriaged gaps): a second press while a hold is already running must not start another
// frame, and a quick release reports a tap without confirming.

let frames: Map<number, FrameRequestCallback>;
let nextId: number;
let clock: number;

beforeEach(() => {
  frames = new Map();
  nextId = 1;
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runFrame = (at: number) => {
  clock = at;
  const pending = [...frames.entries()];
  frames.clear();
  act(() => {
    for (const [, cb] of pending) cb(at);
  });
};

it("starts one hold for a second press while the first is still running", () => {
  const onConfirm = vi.fn();
  const { result } = renderHook(() => useHoldToConfirm({ holdMs: 1000, onConfirm }));
  act(() => {
    result.current.begin();
    result.current.begin();
  });
  expect(frames.size).toBe(1);
});

it("reports a quick release as a tap and does not confirm", () => {
  const onConfirm = vi.fn();
  const onTap = vi.fn();
  const { result } = renderHook(() => useHoldToConfirm({ holdMs: 1000, onConfirm, onTap }));
  act(() => result.current.begin());
  runFrame(200);
  act(() => result.current.end());
  expect(onTap).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("confirms once when the hold runs its full length", () => {
  const onConfirm = vi.fn();
  const { result } = renderHook(() => useHoldToConfirm({ holdMs: 1000, onConfirm }));
  act(() => result.current.begin());
  runFrame(500);
  expect(result.current.progress).toBeCloseTo(0.5);
  runFrame(1000);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(result.current.holding).toBe(false);
});

it("never confirms from a frame that fires after the hold was released", () => {
  const onConfirm = vi.fn();
  const onTap = vi.fn();
  const { result } = renderHook(() => useHoldToConfirm({ holdMs: 1000, onConfirm, onTap }));
  act(() => result.current.begin());
  const [[, stale]] = [...frames.entries()];
  act(() => result.current.end());
  // The frame that was already scheduled fires anyway, past the full hold length.
  act(() => stale(5000));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onTap).toHaveBeenCalledTimes(1);
});
