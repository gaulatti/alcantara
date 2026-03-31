import { useEffect, useRef, useState } from 'react';

interface UseSSEOptions {
  url: string;
  onMessage?: (data: any) => void;
  reconnectInterval?: number;
  enabled?: boolean;
}

export function useSSE({ url, onMessage, reconnectInterval = 3000, enabled = true }: UseSSEOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!enabled) {
      setIsConnected(false);
      setError(null);
      return;
    }

    let disposed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | null = null;

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
          setIsConnected(false);
          setError(new Error('SSE connection error'));
          eventSource?.close();
          eventSource = null;

          if (!disposed) {
            reconnectTimer = window.setTimeout(connect, reconnectInterval);
          }
        };
      } catch (err) {
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
