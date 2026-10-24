import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSSE } from './useSSE';

class EventStream {
  static instances: EventStream[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { EventStream.instances.push(this); }
}

beforeEach(() => { EventStream.instances = []; vi.stubGlobal('EventSource', EventStream); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('event-stream lifecycle boundaries', () => {
  it('does not open disabled streams and reports disconnected state', () => {
    const onConnectionChange = vi.fn();
    const onConnectionStateChange = vi.fn();
    const { result } = renderHook(() => useSSE({ url: 'https://api.example/events', enabled: false, onConnectionChange, onConnectionStateChange }));
    expect(result.current).toEqual({ isConnected: false, error: null });
    expect(EventStream.instances).toHaveLength(0);
    expect(onConnectionChange).toHaveBeenLastCalledWith(false);
    expect(onConnectionStateChange).toHaveBeenLastCalledWith('disconnected');
  });
  it('delivers parsed updates to the current handler without reconnecting', () => {
    const first = vi.fn(); const second = vi.fn();
    const { rerender } = renderHook(({ onMessage }) => useSSE({ url: 'https://api.example/events', onMessage }), { initialProps: { onMessage: first } });
    act(() => EventStream.instances[0].onmessage?.({ data: '{"version":1}' }));
    expect(first).toHaveBeenCalledWith({ version: 1 });
    rerender({ onMessage: second });
    act(() => EventStream.instances[0].onmessage?.({ data: '{"version":2}' }));
    expect(second).toHaveBeenCalledWith({ version: 2 });
    expect(EventStream.instances).toHaveLength(1);
  });
  it('keeps malformed events from invoking the state consumer or closing a healthy connection', () => {
    const onMessage = vi.fn(); const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useSSE({ url: 'https://api.example/events', onMessage }));
    act(() => EventStream.instances[0].onopen?.());
    act(() => EventStream.instances[0].onmessage?.({ data: 'invalid' }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(true);
    expect(EventStream.instances[0].close).not.toHaveBeenCalled();
  });
  it('ignores delayed connection callbacks after unmount and clears retry timers', () => {
    vi.useFakeTimers();
    const onConnectionChange = vi.fn();
    const { unmount } = renderHook(() => useSSE({ url: 'https://api.example/events', reconnectInterval: 1000, onConnectionChange }));
    const stream = EventStream.instances[0];
    act(() => stream.onerror?.());
    unmount();
    const calls = onConnectionChange.mock.calls.length;
    act(() => { stream.onopen?.(); stream.onerror?.(); vi.advanceTimersByTime(5000); });
    expect(onConnectionChange).toHaveBeenCalledTimes(calls);
    expect(EventStream.instances).toHaveLength(1);
  });
  it('reports constructor failure and retries through the documented interval', () => {
    vi.useFakeTimers();
    const failure = new Error('stream unavailable');
    const construct = vi.fn().mockImplementationOnce(() => { throw failure; }).mockImplementation((url: string) => new EventStream(url));
    vi.stubGlobal('EventSource', construct);
    const { result } = renderHook(() => useSSE({ url: 'https://api.example/events', reconnectInterval: 1000 }));
    expect(result.current.error).toBe(failure);
    act(() => vi.advanceTimersByTime(1000));
    expect(EventStream.instances).toHaveLength(1);
    act(() => EventStream.instances[0].onopen?.());
    expect(result.current).toEqual({ isConnected: true, error: null });
  });
  it('closes an old stream and resets connection state when the target changes', () => {
    const { rerender } = renderHook(({ url, enabled }) => useSSE({ url, enabled }), { initialProps: { url: 'https://api.example/a/events', enabled: true } });
    const first = EventStream.instances[0];
    rerender({ url: 'https://api.example/b/events', enabled: true });
    expect(first.close).toHaveBeenCalledOnce();
    expect(EventStream.instances[1].url).toBe('https://api.example/b/events');
    rerender({ url: 'https://api.example/b/events', enabled: false });
    expect(EventStream.instances[1].close).toHaveBeenCalledOnce();
    expect(EventStream.instances).toHaveLength(2);
  });
});
