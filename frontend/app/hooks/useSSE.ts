import { useEffect, useRef, useState } from 'react';

interface UseSSEOptions {
  url: string;
  onMessage?: (data: any) => void;
  onConnectionChange?: (isConnected: boolean) => void;
  onConnectionStateChange?: (state: SSEConnectionState) => void;
  reconnectInterval?: number;
  enabled?: boolean;
}

export type SSEConnectionState = 'connecting' | 'connected' | 'disconnected';

/** How long a stream that was connected may be away before it is reported disconnected. */
export const DISCONNECT_GRACE_MS = 5_000;
/** How soon a dropped stream that was connected tries again, within its grace period. */
export const GRACE_RECONNECT_MS = 500;

export function useSSE({ url, onMessage, onConnectionChange, onConnectionStateChange, reconnectInterval = 3000, enabled = true }: UseSSEOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const onMessageRef = useRef(onMessage);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    onConnectionChangeRef.current = onConnectionChange;
  }, [onConnectionChange]);

  useEffect(() => {
    onConnectionStateChangeRef.current = onConnectionStateChange;
  }, [onConnectionStateChange]);

  useEffect(() => {
    if (!enabled) {
      setIsConnected(false);
      setError(null);
      onConnectionChangeRef.current?.(false);
      onConnectionStateChangeRef.current?.('disconnected');
      return;
    }

    let disposed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | null = null;
    // A stream that was connected and dropped is in its grace period until this timer fires or it reopens.
    let graceTimer: number | null = null;
    let wasConnected = false;
    setIsConnected(false);
    onConnectionChangeRef.current?.(false);
    onConnectionStateChangeRef.current?.('connecting');

    const reportDisconnected = (cause: Error) => {
      wasConnected = false;
      setIsConnected(false);
      onConnectionChangeRef.current?.(false);
      onConnectionStateChangeRef.current?.('disconnected');
      setError(cause);
    };

    /**
     * A stream that had been connected and drops stays reported connected while it reconnects, for up to
     * DISCONNECT_GRACE_MS: every backend deploy ends the streams, and the new instance answers within moments
     * (gaulatti/alcantara#873). Only a stream that is not back by then reports disconnected. One that never
     * connected reports at once.
     */
    const dropped = (cause: Error) => {
      eventSource?.close();
      eventSource = null;
      if (wasConnected && graceTimer === null) {
        graceTimer = window.setTimeout(() => {
          graceTimer = null;
          reportDisconnected(cause);
        }, DISCONNECT_GRACE_MS);
      } else if (graceTimer === null) {
        reportDisconnected(cause);
      }
      if (!disposed) {
        reconnectTimer = window.setTimeout(connect, graceTimer === null ? reconnectInterval : GRACE_RECONNECT_MS);
      }
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      try {
        eventSource = new EventSource(url);

        eventSource.onopen = () => {
          if (disposed) {
            return;
          }
          if (graceTimer !== null) {
            window.clearTimeout(graceTimer);
            graceTimer = null;
          }
          if (!wasConnected) {
            wasConnected = true;
            setIsConnected(true);
            onConnectionChangeRef.current?.(true);
            onConnectionStateChangeRef.current?.('connected');
          }
          setError(null);
        };

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            onMessageRef.current?.(data);
          } catch (err) {
            console.error('Failed to parse SSE data:', err);
          }
        };

        eventSource.onerror = () => {
          if (disposed) {
            return;
          }
          dropped(new Error('SSE connection error'));
        };
      } catch (err) {
        dropped(err as Error);
      }
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (graceTimer !== null) {
        window.clearTimeout(graceTimer);
      }
      eventSource?.close();
    };
  }, [enabled, url, reconnectInterval]);

  return { isConnected, error };
}
