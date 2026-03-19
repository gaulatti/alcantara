import { useEffect, useState, useCallback } from 'react';

interface UseSSEOptions {
  url: string;
  onMessage?: (data: any) => void;
  reconnectInterval?: number;
  enabled?: boolean;
}

export function useSSE({ url, onMessage, reconnectInterval = 3000, enabled = true }: UseSSEOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const connect = useCallback(() => {
    if (!enabled) {
      return () => {
        // no-op when disabled
      };
    }

    let eventSource: EventSource | null = null;

    try {
      eventSource = new EventSource(url);

      eventSource.onopen = () => {
        setIsConnected(true);
        setError(null);
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessage?.(data);
        } catch (err) {
          console.error('Failed to parse SSE data:', err);
        }
      };

      eventSource.onerror = (err) => {
        setIsConnected(false);
        setError(new Error('SSE connection error'));
        eventSource?.close();

        // Auto-reconnect
        setTimeout(() => {
          connect();
        }, reconnectInterval);
      };
    } catch (err) {
      setError(err as Error);
    }

    return () => {
      eventSource?.close();
    };
  }, [enabled, url, onMessage, reconnectInterval]);

  useEffect(() => {
    if (!enabled) {
      setIsConnected(false);
      setError(null);
      return;
    }

    const cleanup = connect();
    return cleanup;
  }, [connect, enabled]);

  return { isConnected, error };
}
