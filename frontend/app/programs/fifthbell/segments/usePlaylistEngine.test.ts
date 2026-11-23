import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaylistEngine } from "./usePlaylistEngine";
import type { Segment } from "./types";

const segment = (id: string, itemCount: number, extra: Partial<Segment> = {}): Segment => ({
  id,
  label: id,
  itemCount,
  durationMsPerItem: 1000,
  render: () => null,
  ...extra,
});
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("usePlaylistEngine", () => {
  it("has no current segment and does not tick without segments", () => {
    const { result } = renderHook(() => usePlaylistEngine({ segments: [] }));
    expect(result.current.currentSegment).toBeNull();
    tick(5000);
    expect(result.current.state.progress).toBe(0);
    act(() => result.current.advanceToNext());
    expect(result.current.state.currentItemIndex).toBe(0);
  });

  it("advances progress by the update interval and moves to the next item", () => {
    const segments = [segment("a", 2)];
    const { result } = renderHook(() => usePlaylistEngine({ segments, updateIntervalMs: 100 }));
    tick(500);
    expect(result.current.state.progress).toBeCloseTo(50);
    tick(600);
    expect(result.current.state.currentItemIndex).toBe(1);
    expect(result.current.state.progress).toBe(0);
    expect(result.current.currentSegment?.id).toBe("a");
  });

  it("uses the default duration and interval when the segment has none", () => {
    const segments = [segment("a", 2, { durationMsPerItem: 0 })];
    const { result } = renderHook(() => usePlaylistEngine({ segments }));
    tick(1000);
    expect(result.current.state.progress).toBeCloseTo(10);
    const custom = renderHook(() => usePlaylistEngine({ segments, defaultDurationMs: 2000, updateIntervalMs: 50 }));
    tick(1000);
    expect(custom.result.current.state.progress).toBeCloseTo(50);
  });

  it("rolls over to the next segment, running its hooks, prefetching the one after, and loops the playlist", () => {
    const calls: string[] = [];
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const segments = [
      segment("a", 1, { onEnter: () => calls.push("enter a"), onExit: () => calls.push("exit a"), prefetch }),
      segment("b", 1, { onEnter: () => calls.push("enter b"), onExit: () => calls.push("exit b"), prefetch }),
    ];
    const onPlaylistLoop = vi.fn();
    const { result } = renderHook(() => usePlaylistEngine({ segments, updateIntervalMs: 500, onPlaylistLoop }));
    tick(1500);
    expect(result.current.currentSegment?.id).toBe("b");
    expect(calls).toEqual(["exit a", "enter b"]);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(onPlaylistLoop).not.toHaveBeenCalled();
    tick(1500);
    expect(result.current.currentSegment?.id).toBe("a");
    expect(onPlaylistLoop).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["exit a", "enter b", "exit b", "enter a"]);
  });

  it("works with a single segment, hooks omitted, and no loop callback", () => {
    const segments = [segment("only", 1)];
    const { result } = renderHook(() => usePlaylistEngine({ segments, updateIntervalMs: 500 }));
    tick(5000);
    expect(result.current.currentSegment?.id).toBe("only");
  });

  it("logs a failed prefetch of the next segment", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error("nope"));
    const segments = [segment("a", 1), segment("b", 1, { prefetch: failing }), segment("c", 1)];
    segments[2] = { ...segments[2] };
    const withPrefetch = [segments[0], { ...segments[1], label: "b" }, { ...segments[2], prefetch: failing, label: "c" }];
    renderHook(() => usePlaylistEngine({ segments: withPrefetch, updateIntervalMs: 500 }));
    tick(2500);
    await act(async () => {
      await Promise.resolve();
    });
    expect(error).toHaveBeenCalledWith("[Playlist] Failed to prefetch c:", expect.any(Error));
  });

  it("pauses, resumes and resets", () => {
    const segments = [segment("a", 3)];
    const { result } = renderHook(() => usePlaylistEngine({ segments, updateIntervalMs: 100 }));
    tick(300);
    act(() => result.current.pause());
    const frozen = result.current.state.progress;
    tick(3000);
    expect(result.current.state).toMatchObject({ isPaused: true, progress: frozen });
    act(() => result.current.resume());
    tick(100);
    expect(result.current.state.progress).toBeGreaterThan(frozen);
    act(() => result.current.advanceToNext());
    expect(result.current.state.currentItemIndex).toBe(1);
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ currentSegmentIndex: 0, currentItemIndex: 0, progress: 0, isPaused: false });
  });

  it("stops when the segment list shrinks below the current index", () => {
    let segments = [segment("a", 1), segment("b", 1)];
    const { result, rerender } = renderHook(() => usePlaylistEngine({ segments, updateIntervalMs: 500 }));
    tick(2500);
    expect(result.current.currentSegment?.id).toBe("b");
    segments = [segment("a", 1)];
    rerender();
    expect(result.current.currentSegment).toBeNull();
    tick(5000);
    act(() => result.current.advanceToNext());
    expect(result.current.state.currentSegmentIndex).toBe(1);
  });
});
