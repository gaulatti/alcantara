import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DISCONNECT_GRACE_MS, GRACE_RECONNECT_MS, useSSE } from './useSSE';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reports SSE as connected only after the authoritative stream opens', () => {
  const onConnectionChange = vi.fn();
  const onConnectionStateChange = vi.fn();
  const { result } = renderHook(() =>
    useSSE({
      url: 'https://api.example.test/program/radio/events',
      onConnectionChange,
      onConnectionStateChange,
    }),
  );

  expect(result.current.isConnected).toBe(false);
  expect(onConnectionChange).toHaveBeenLastCalledWith(false);
  expect(onConnectionStateChange).toHaveBeenLastCalledWith('connecting');

  act(() => FakeEventSource.instances[0].onopen?.());

  expect(result.current.isConnected).toBe(true);
  expect(onConnectionChange).toHaveBeenLastCalledWith(true);
  expect(onConnectionStateChange).toHaveBeenLastCalledWith('connected');
});

// Every backend deploy ends the streams, and the instance that takes over answers within moments
// (gaulatti/alcantara#873): a stream that was connected stays reported connected while it reconnects, for up to
// DISCONNECT_GRACE_MS, and is reported disconnected only when it is not back by then.
function connected(reconnectInterval = 3000) {
  vi.useFakeTimers();
  const onConnectionChange = vi.fn();
  const onConnectionStateChange = vi.fn();
  const rendered = renderHook(() =>
    useSSE({
      url: 'https://api.example.test/program/radio/events',
      onConnectionChange,
      onConnectionStateChange,
      reconnectInterval,
    }),
  );
  act(() => FakeEventSource.instances[0].onopen?.());
  onConnectionChange.mockClear();
  onConnectionStateChange.mockClear();
  return { ...rendered, onConnectionChange, onConnectionStateChange };
}

it('stays connected through a drop that reconnects within the grace period, and reports nothing', () => {
  const h = connected();
  act(() => FakeEventSource.instances[0].onerror?.());
  expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  expect(h.result.current).toEqual({ isConnected: true, error: null });

  // It tries again quickly, and again after a second failure, still quiet.
  act(() => vi.advanceTimersByTime(GRACE_RECONNECT_MS));
  expect(FakeEventSource.instances).toHaveLength(2);
  act(() => FakeEventSource.instances[1].onerror?.());
  act(() => vi.advanceTimersByTime(GRACE_RECONNECT_MS));
  expect(FakeEventSource.instances).toHaveLength(3);
  act(() => vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 2 * GRACE_RECONNECT_MS - 1));
  act(() => FakeEventSource.instances[2].onopen?.());

  expect(h.result.current).toEqual({ isConnected: true, error: null });
  expect(h.onConnectionChange).not.toHaveBeenCalled();
  expect(h.onConnectionStateChange).not.toHaveBeenCalled();
  // The grace is over: nothing is reported later.
  act(() => vi.advanceTimersByTime(DISCONNECT_GRACE_MS));
  expect(h.onConnectionStateChange).not.toHaveBeenCalled();
  h.unmount();
});

it('reports disconnected when the stream is not back by the end of the grace period, then connected again', () => {
  const h = connected();
  act(() => FakeEventSource.instances[0].onerror?.());
  act(() => vi.advanceTimersByTime(GRACE_RECONNECT_MS));
  act(() => FakeEventSource.instances[1].onerror?.());
  act(() => vi.advanceTimersByTime(DISCONNECT_GRACE_MS - GRACE_RECONNECT_MS - 1));
  expect(h.result.current.isConnected).toBe(true);
  expect(h.onConnectionStateChange).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(h.result.current.isConnected).toBe(false);
  expect(h.result.current.error?.message).toBe('SSE connection error');
  expect(h.onConnectionChange).toHaveBeenLastCalledWith(false);
  expect(h.onConnectionStateChange).toHaveBeenLastCalledWith('disconnected');

  const open = FakeEventSource.instances.length;
  act(() => FakeEventSource.instances[open - 1].onopen?.());
  expect(h.result.current).toEqual({ isConnected: true, error: null });
  expect(h.onConnectionStateChange).toHaveBeenLastCalledWith('connected');
  h.unmount();
});

it('after a reported disconnect, a further drop has no grace again until the stream reopens, and retries at the interval', () => {
  const h = connected(3000);
  act(() => FakeEventSource.instances[0].onerror?.());
  act(() => vi.advanceTimersByTime(DISCONNECT_GRACE_MS));
  expect(h.onConnectionStateChange).toHaveBeenLastCalledWith('disconnected');
  const before = FakeEventSource.instances.length;
  act(() => FakeEventSource.instances[before - 1].onerror?.());
  act(() => vi.advanceTimersByTime(2999));
  expect(FakeEventSource.instances).toHaveLength(before);
  act(() => vi.advanceTimersByTime(1));
  expect(FakeEventSource.instances).toHaveLength(before + 1);
  h.unmount();
});

it('drops the grace timer when it unmounts', () => {
  const h = connected();
  act(() => FakeEventSource.instances[0].onerror?.());
  h.unmount();
  act(() => vi.advanceTimersByTime(DISCONNECT_GRACE_MS));
  expect(h.onConnectionStateChange).not.toHaveBeenCalled();
  expect(FakeEventSource.instances).toHaveLength(1);
});
