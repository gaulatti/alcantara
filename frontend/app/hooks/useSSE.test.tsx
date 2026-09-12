import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSSE } from './useSSE';

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

it('marks SSE unavailable before scheduling a reconnect', () => {
  vi.useFakeTimers();
  const onConnectionChange = vi.fn();
  const onConnectionStateChange = vi.fn();
  const { result, unmount } = renderHook(() =>
    useSSE({
      url: 'https://api.example.test/program/radio/events',
      onConnectionChange,
      onConnectionStateChange,
      reconnectInterval: 3000,
    }),
  );
  act(() => FakeEventSource.instances[0].onopen?.());

  act(() => FakeEventSource.instances[0].onerror?.());

  expect(result.current.isConnected).toBe(false);
  expect(onConnectionChange).toHaveBeenLastCalledWith(false);
  expect(onConnectionStateChange).toHaveBeenLastCalledWith('disconnected');
  expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(3000));
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(onConnectionStateChange).toHaveBeenLastCalledWith('disconnected');

  unmount();
});
