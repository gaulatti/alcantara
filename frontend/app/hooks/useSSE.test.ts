import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSSE } from "./useSSE";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static failNext = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    if (FakeEventSource.failNext) {
      FakeEventSource.failNext = false;
      throw new Error("cannot construct");
    }
    FakeEventSource.instances.push(this);
  }
}
const last = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

beforeEach(() => {
  FakeEventSource.instances = [];
  FakeEventSource.failNext = false;
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSSE", () => {
  it("connects, reports the connection, and delivers parsed messages", () => {
    const onMessage = vi.fn();
    const onConnectionChange = vi.fn();
    const onConnectionStateChange = vi.fn();
    const { result } = renderHook(() => useSSE({ url: "/e", onMessage, onConnectionChange, onConnectionStateChange }));
    expect(last().url).toBe("/e");
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("connecting");
    act(() => last().onopen!());
    expect(result.current).toEqual({ isConnected: true, error: null });
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("connected");
    act(() => last().onmessage!({ data: '{"a":1}' }));
    expect(onMessage).toHaveBeenCalledWith({ a: 1 });
  });

  it("logs unparseable messages and works without callbacks", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() => useSSE({ url: "/e" }));
    act(() => last().onopen!());
    act(() => last().onmessage!({ data: "{nope" }));
    expect(error).toHaveBeenCalledWith("Failed to parse SSE data:", expect.any(SyntaxError));
  });

  it("uses the latest callbacks without reconnecting", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useSSE({ url: "/e", onMessage: cb, onConnectionChange: cb, onConnectionStateChange: cb }), { initialProps: { cb: first } });
    rerender({ cb: second });
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => last().onmessage!({ data: "1" }));
    expect(second).toHaveBeenCalledWith(1);
  });

  it("closes the stream on error and reconnects after the interval", () => {
    const onConnectionStateChange = vi.fn();
    const { result } = renderHook(() => useSSE({ url: "/e", reconnectInterval: 500, onConnectionStateChange }));
    const first = last();
    act(() => first.onerror!());
    expect(first.close).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error?.message).toBe("SSE connection error");
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("disconnected");
    act(() => void vi.advanceTimersByTime(499));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => last().onopen!());
    expect(result.current.error).toBeNull();
  });

  it("retries when the stream cannot be created", () => {
    FakeEventSource.failNext = true;
    const { result } = renderHook(() => useSSE({ url: "/e" }));
    expect(result.current.error?.message).toBe("cannot construct");
    act(() => void vi.advanceTimersByTime(3000));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("stops everything when it unmounts, ignoring late events", () => {
    const onConnectionChange = vi.fn();
    const { unmount } = renderHook(() => useSSE({ url: "/e", onConnectionChange }));
    const source = last();
    unmount();
    expect(source.close).toHaveBeenCalled();
    onConnectionChange.mockClear();
    source.onopen!();
    source.onerror!();
    expect(onConnectionChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("cancels a pending reconnect when it unmounts", () => {
    const { unmount } = renderHook(() => useSSE({ url: "/e" }));
    act(() => last().onerror!());
    unmount();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("does not connect while disabled, and reports disconnected", () => {
    const onConnectionChange = vi.fn();
    const onConnectionStateChange = vi.fn();
    const { result, rerender } = renderHook(({ enabled }) => useSSE({ url: "/e", enabled, onConnectionChange, onConnectionStateChange }), { initialProps: { enabled: false } });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current).toEqual({ isConnected: false, error: null });
    expect(onConnectionChange).toHaveBeenLastCalledWith(false);
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("disconnected");
    rerender({ enabled: true });
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
