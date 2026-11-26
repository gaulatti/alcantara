import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useArmed } from "./useArmed";

// gaulatti/alcantara#527 (untriaged gaps): unmounting the desk with nothing armed is quiet, and an armed value is
// returned once by take and then gone.

afterEach(() => {
  vi.useRealTimers();
});

it("unmounts quietly when nothing is armed", () => {
  vi.useFakeTimers();
  const { unmount } = renderHook(() => useArmed<string>());
  expect(() => unmount()).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

it("returns an armed value once, then nothing", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useArmed<string>(1000));
  act(() => result.current.arm("cue-1"));
  expect(result.current.armed).toBe("cue-1");
  let taken: string | null = null;
  act(() => {
    taken = result.current.take();
  });
  expect(taken).toBe("cue-1");
  expect(result.current.armed).toBeNull();
  let again: string | null = "unset";
  act(() => {
    again = result.current.take();
  });
  expect(again).toBeNull();
});

it("cancels a pending disarm timer when unmounted while armed", () => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() => useArmed<string>(1000));
  act(() => result.current.arm("cue-2"));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
