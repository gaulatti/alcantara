import { authFetch } from './api';
import { apiUrl } from '../utils/apiBaseUrl';

// The signed-in console reads a program through its control routes (docs/program-realtime.md). The public
// routes stay the renderer's, and the console reads them only while a control route answers 404, so this
// console can ship before the backend that serves the control routes is deployed.

export type ProgramRead = 'state' | 'audio-bus';

/** GET the console's program state or audio bus with the bearer token. */
export async function fetchProgramControl(programId: string, read: ProgramRead, signal?: AbortSignal): Promise<Response> {
  const id = encodeURIComponent(programId);
  const control = await authFetch(`/program/${id}/control/${read}`, { signal });
  if (control.status !== 404) return control;
  return fetch(apiUrl(`/program/${id}/${read}`), { signal });
}

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * A text/event-stream parser that accepts chunks split anywhere. It reads `data:` and `event:` fields, joins
 * multi-line data with newlines, ignores comments (`:` lines such as heartbeats) and dispatches on a blank line.
 */
export function createSseParser(onMessage: (message: SseMessage) => void) {
  let pending = '';
  let event = '';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };

  const line = (raw: string) => {
    if (raw === '') return dispatch();
    if (raw.startsWith(':')) return;
    const colon = raw.indexOf(':');
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  };

  return {
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) line(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    },
  };
}

export interface ProgramEventsOptions {
  programId: string;
  onMessage: (data: unknown, event: string) => void;
  /** Called each time the stream opens; `reconnect` is true after the first open, when events may have been missed. */
  onOpen: (info: { reconnect: boolean }) => void;
  onError?: (error: Error) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Reads the console's SSE stream with fetch, because EventSource cannot send the bearer token. It reconnects with
 * exponential backoff until stopped, and falls back to the public events route only while the control route is 404.
 * Returns a function that stops the stream.
 */
export function openProgramEvents(options: ProgramEventsOptions): () => void {
  const { programId, onMessage, onOpen, onError } = options;
  const initialBackoff = options.initialBackoffMs ?? 1_000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const id = encodeURIComponent(programId);
  const controller = new AbortController();
  const { signal } = controller;
  let opened = false;

  const connect = async (): Promise<Response> => {
    const headers = { Accept: 'text/event-stream' };
    const control = await authFetch(`/program/${id}/control/events`, { headers, signal });
    if (control.status !== 404) return control;
    return fetch(apiUrl(`/program/${id}/events`), { headers, signal });
  };

  const run = async () => {
    let backoff = initialBackoff;
    while (!signal.aborted) {
      try {
        const res = await connect();
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        backoff = initialBackoff;
        onOpen({ reconnect: opened });
        opened = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser(({ event, data }) => {
          try {
            onMessage(JSON.parse(data), event);
          } catch (err) {
            console.error('Failed to parse program event:', err);
          }
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        throw new Error('program event stream ended');
      } catch (err) {
        if (signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  };

  void run();
  return () => controller.abort();
}
