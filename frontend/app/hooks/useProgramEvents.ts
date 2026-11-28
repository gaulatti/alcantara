import { useEffect, useRef } from 'react';
import { openProgramEvents } from '../services/programControl';

export type ProgramEventsConnection = 'connecting' | 'connected' | 'disconnected';

interface UseProgramEventsOptions {
  programId: string;
  onMessage: (data: unknown, event: string) => void;
  onConnectionStateChange?: (state: ProgramEventsConnection) => void;
  enabled?: boolean;
}

/** The console's program event stream, read with the bearer token; reconnects with backoff while mounted. */
export function useProgramEvents({ programId, onMessage, onConnectionStateChange, enabled = true }: UseProgramEventsOptions) {
  const onMessageRef = useRef(onMessage);
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  onMessageRef.current = onMessage;
  onConnectionStateChangeRef.current = onConnectionStateChange;

  useEffect(() => {
    if (!enabled) {
      onConnectionStateChangeRef.current?.('disconnected');
      return;
    }
    onConnectionStateChangeRef.current?.('connecting');
    const stop = openProgramEvents({
      programId,
      onMessage: (data, event) => onMessageRef.current(data, event),
      onOpen: () => onConnectionStateChangeRef.current?.('connected'),
      onError: () => onConnectionStateChangeRef.current?.('disconnected'),
    });
    return () => {
      stop();
      onConnectionStateChangeRef.current?.('disconnected');
    };
  }, [programId, enabled]);
}
