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
    setIsConnected(false);
    onConnectionChangeRef.current?.(false);
    onConnectionStateChangeRef.current?.('connecting');

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
          setIsConnected(true);
          onConnectionChangeRef.current?.(true);
          onConnectionStateChangeRef.current?.('connected');
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
          setIsConnected(false);
          onConnectionChangeRef.current?.(false);
          onConnectionStateChangeRef.current?.('disconnected');
          setError(new Error('SSE connection error'));
          eventSource?.close();
          eventSource = null;

          if (!disposed) {
            reconnectTimer = window.setTimeout(connect, reconnectInterval);
          }
        };
      } catch (err) {
        setIsConnected(false);
        onConnectionChangeRef.current?.(false);
        onConnectionStateChangeRef.current?.('disconnected');
        setError(err as Error);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, reconnectInterval);
        }
      }
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      eventSource?.close();
    };
  }, [enabled, url, reconnectInterval]);

  return { isConnected, error };
}
