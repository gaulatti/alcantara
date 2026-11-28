import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session', () => ({ getAppSession: vi.fn(async () => ({ token: 'tok-123' })) }));

import { createSseParser, fetchProgramControl, openProgramEvents } from './programControl';
import { fetchProgramAudioBusSettings, fetchProgramState } from './program';

const enc = new TextEncoder();

function streamOf(...chunks: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      }
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

function calls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([input, init]) => ({ url: String(input), init: init as RequestInit | undefined }));
}

describe('createSseParser', () => {
  it('reads data and event fields, joins multi-line data, skips comments, and accepts chunks split anywhere', () => {
    const seen: Array<{ event: string; data: string }> = [];
    const parser = createSseParser((message) => seen.push(message));
    parser.push('retry: 1000\r\n: heartbeat\r\n');
    parser.push('event: state\r\ndata: {"a"');
    parser.push(':1}\r\ndata: second line\r\n\r');
    parser.push('\ndata: plain\n\n');
    expect(seen).toEqual([
      { event: 'state', data: '{"a":1}\nsecond line' },
      { event: 'message', data: 'plain' }
    ]);
  });

  it('dispatches nothing for a blank line with no data', () => {
    const seen: unknown[] = [];
    const parser = createSseParser((message) => seen.push(message));
    parser.push('\n\n: only a comment\n\n');
    expect(seen).toEqual([]);
  });
});

describe('createSseParser field forms', () => {
  it('takes a field with no colon, a value with no space, and ignores other fields', () => {
    const seen: Array<{ event: string; data: string }> = [];
    const parser = createSseParser((message) => seen.push(message));
    parser.push('data\nid: 7\n\ndata:tight\n\n');
    expect(seen).toEqual([
      { event: 'message', data: '' },
      { event: 'message', data: 'tight' }
    ]);
  });
});

describe('fetchProgramControl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the control route with the bearer token and does not touch the public route', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const res = await fetchProgramControl('p1', 'state');
    expect(res.status).toBe(200);
    const [call] = calls(fetchMock);
    expect(call.url).toMatch(/\/program\/p1\/control\/state$/);
    expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer tok-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the public route only when the control route answers 404', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetchMock.mockResolvedValueOnce(new Response('{"public":true}', { status: 200 }));
    const res = await fetchProgramControl('p1', 'audio-bus');
    expect(await res.json()).toEqual({ public: true });
    const [, fallback] = calls(fetchMock);
    expect(fallback.url).toMatch(/\/program\/p1\/audio-bus$/);
    expect(new Headers(fallback.init?.headers).get('Authorization')).toBeNull();
  });

  it('does not fall back on other failures', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const res = await fetchProgramControl('p1', 'state');
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('openProgramEvents', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams the control events with the bearer token and parses each message', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(streamOf('data: {"n":1}\n\n', 'event: signal\ndata: {"n":2}\n\n'));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const messages: Array<[unknown, string]> = [];
    const opens: boolean[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: (data, event) => messages.push([data, event]),
      onOpen: ({ reconnect }) => opens.push(reconnect)
    });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    stop();
    expect(messages).toEqual([
      [{ n: 1 }, 'message'],
      [{ n: 2 }, 'signal']
    ]);
    expect(opens).toEqual([false]);
    const [call] = calls(fetchMock);
    expect(call.url).toMatch(/\/program\/p1\/control\/events$/);
    expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer tok-123');
    expect(new Headers(call.init?.headers).get('Accept')).toBe('text/event-stream');
  });

  it('reconnects after the stream ends, with backoff, and reports the reconnect so callers re-read state', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(streamOf('data: {"first":true}\n\n'));
    fetchMock.mockResolvedValueOnce(streamOf('data: {"second":true}\n\n'));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const messages: unknown[] = [];
    const opens: boolean[] = [];
    const errors: string[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: (data) => messages.push(data),
      onOpen: ({ reconnect }) => opens.push(reconnect),
      onError: (error) => errors.push(error.message),
      initialBackoffMs: 1,
      maxBackoffMs: 4
    });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    stop();
    expect(messages).toEqual([{ first: true }, { second: true }]);
    expect(opens).toEqual([false, true]);
    expect(errors[0]).toBe('program event stream ended');
  });

  it('falls back to the public events route only when the control route answers 404', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetchMock.mockResolvedValueOnce(streamOf('data: {"public":true}\n\n'));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const messages: unknown[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: (data) => messages.push(data),
      onOpen: () => {}
    });
    await vi.waitFor(() => expect(messages).toEqual([{ public: true }]));
    stop();
    const [control, fallback] = calls(fetchMock);
    expect(control.url).toMatch(/\/program\/p1\/control\/events$/);
    expect(fallback.url).toMatch(/\/program\/p1\/events$/);
    expect(new Headers(fallback.init?.headers).get('Authorization')).toBeNull();
  });

  it('reports a rejection that is not an Error as one', async () => {
    vi.mocked(fetch).mockRejectedValueOnce('offline').mockImplementation(() => new Promise(() => {}));
    const errors: Error[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: () => {},
      onOpen: () => {},
      onError: (error) => errors.push(error),
      initialBackoffMs: 1
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    stop();
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe('offline');
  });

  it('reports nothing for a request it stopped itself', async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    const errors: Error[] = [];
    const stop = openProgramEvents({ programId: 'p1', onMessage: () => {}, onOpen: () => {}, onError: (error) => errors.push(error) });
    await vi.waitFor(() => expect(fail).toBeDefined());
    stop();
    fail(new Error('aborted'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(errors).toEqual([]);
  });

  it('skips a message that is not JSON and keeps reading the stream', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch)
      .mockResolvedValueOnce(streamOf('data: not json\n\ndata: {"n":2}\n\n'))
      .mockImplementation(() => new Promise(() => {}));
    const messages: unknown[] = [];
    const stop = openProgramEvents({ programId: 'p1', onMessage: (data) => messages.push(data), onOpen: () => {} });
    await vi.waitFor(() => expect(messages).toEqual([{ n: 2 }]));
    stop();
    expect(logged).toHaveBeenCalledWith('Failed to parse program event:', expect.any(SyntaxError));
    logged.mockRestore();
  });

  it('stops reconnecting once stopped', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const errors: string[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: () => {},
      onOpen: () => {},
      onError: (error) => errors.push(error.message),
      initialBackoffMs: 1,
      maxBackoffMs: 2
    });
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(1));
    stop();
    const seen = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.length).toBe(seen);
  });
});

describe('services that read a program', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchProgramState reads the control state', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('{"type":"tv"}', { status: 200 }));
    expect(await fetchProgramState('p9')).toEqual({ type: 'tv' });
    expect(calls(fetchMock)[0].url).toMatch(/\/program\/p9\/control\/state$/);
  });

  it('fetchProgramAudioBusSettings reads the control audio bus', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('{"mixerSettings":{}}', { status: 200 }));
    expect(await fetchProgramAudioBusSettings('p9')).toEqual({ mixerSettings: {} });
    expect(calls(fetchMock)[0].url).toMatch(/\/program\/p9\/control\/audio-bus$/);
  });
});

describe('openProgramEvents error and abort paths', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('logs a message that is not JSON and keeps streaming, including a data line with no colon', async () => {
    const fetchMock = vi.mocked(fetch);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(streamOf('data: not-json\n\ndata\n\ndata: {"ok":1}\n\n'));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const messages: unknown[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: (data) => messages.push(data),
      onOpen: () => {}
    });
    await vi.waitFor(() => expect(messages).toEqual([{ ok: 1 }]));
    stop();
    expect(logged).toHaveBeenCalledWith('Failed to parse program event:', expect.any(SyntaxError));
  });

  it('stops quietly when the stream is aborted while it is being read', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              (init?.signal as AbortSignal).addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError'))
              );
            }
          }),
          { status: 200 }
        )
    );
    const errors: string[] = [];
    const opens: boolean[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: () => {},
      onOpen: ({ reconnect }) => opens.push(reconnect),
      onError: (error) => errors.push(error.message)
    });
    await vi.waitFor(() => expect(opens).toEqual([false]));
    stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failure that is not an Error as its text, and keeps trying until stopped', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue('network said no');
    const errors: string[] = [];
    const stop = openProgramEvents({
      programId: 'p1',
      onMessage: () => {},
      onOpen: () => {},
      onError: (error) => errors.push(error.message),
      initialBackoffMs: 1,
      maxBackoffMs: 2
    });
    await vi.waitFor(() => expect(errors[0]).toBe('network said no'));
    stop();
  });
});
