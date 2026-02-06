import { useEffect, useState, useCallback } from 'react';

interface UseSSEOptions {
  url: string;
  onMessage?: (data: any) => void;
  reconnectInterval?: number;
}

export function useSSE({ url, onMessage, reconnectInterval = 3000 }: UseSSEOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const connect = useCallback(() => {
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
  }, [url, onMessage, reconnectInterval]);

  useEffect(() => {
    const cleanup = connect();
    return cleanup;
  }, [connect]);

  return { isConnected, error };
}
