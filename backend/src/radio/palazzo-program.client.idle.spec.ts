import {
  PALAZZO_EVENT_IDLE_MS,
  PalazzoProgramClient,
  type PalazzoProgramClientCallbacks,
} from './palazzo-program.client';
import { RadioMetricsService } from './radio-metrics.service';
import {
  PALAZZO_COMMAND_TIMEOUT_MS,
  PalazzoMachineClient,
} from './palazzo-machine.client';
import type {
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
  PalazzoProgramStatus,
} from './palazzo-contract';

// gaulatti/alcantara#734: a Palazzo that hangs (connections accepted, nothing answered) keeps its event stream open
// and silent. After PALAZZO_EVENT_IDLE_MS without a byte the stream is dropped and reconnected; the engine freezes
// only when Palazzo also fails the state poll, so a quiet but healthy Palazzo never freezes it.

const BASE = 'http://palazzo:3100';
const BOOT = 'boot-1';
const INSTANCE = 'palazzo-a';

function state(sequence: number): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: INSTANCE,
    bootId: BOOT,
    sequence,
    availability: 'available',
    status: 'idle',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: new Date().toISOString(),
    },
    icecast: { connected: true },
    track: null,
    intro: null,
    positionSeconds: 0,
    remainingSeconds: null,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
  };
}

function frame(event: PalazzoPlaybackEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function snapshot(sequence: number): string {
  return frame({
    schemaVersion: 1,
    id: `${BOOT}:${sequence}`,
    instanceId: INSTANCE,
    bootId: BOOT,
    sequence,
    type: 'snapshot',
    occurredAt: new Date().toISOString(),
    data: { state: state(sequence) },
  });
}

function heartbeat(sequence: number): string {
  return frame({
    schemaVersion: 1,
    id: `${BOOT}:${sequence}`,
    instanceId: INSTANCE,
    bootId: BOOT,
    sequence,
    type: 'heartbeat',
    occurredAt: new Date().toISOString(),
    data: { liquidsoapSequence: sequence },
  } as PalazzoPlaybackEvent);
}

/** An event stream the test writes to; it ends with an abort, as a real fetch body does. */
function liveStream(signal: AbortSignal) {
  let push: (text: string) => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(new TextEncoder().encode(text));
      signal.addEventListener('abort', () =>
        controller.error(new DOMException('aborted', 'AbortError')),
      );
    },
  });
  return {
    response: new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (text: string) => push(text),
  };
}

/** A request a hung Palazzo never answers: it settles only when its signal aborts. */
function hung(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () =>
      reject(signal.reason ?? new Error('aborted')),
    );
  });
}

type Mode = 'live' | 'hung';

function harness() {
  const streams: ReturnType<typeof liveStream>[] = [];
  let mode: Mode = 'live';
  const fetchImpl = jest.fn(
    (url: string, init: { signal?: AbortSignal }): Promise<Response> => {
      // A real fetch rejects at once on a signal that is already aborted.
      if (init.signal?.aborted) return Promise.reject(init.signal.reason);
      if (mode === 'hung') return hung(init.signal);
      if (url.endsWith('/playback/events')) {
        const stream = liveStream(init.signal!);
        streams.push(stream);
        return Promise.resolve(stream.response);
      }
      return Promise.resolve(Response.json(state(1)));
    },
  );
  const metrics = new RadioMetricsService();
  const statuses: PalazzoProgramStatus[] = [];
  const callbacks: PalazzoProgramClientCallbacks = {
    onSnapshot: jest.fn(),
    onEvent: jest.fn(),
    onStatus: jest.fn((_programId: string, status: PalazzoProgramStatus) => {
      statuses.push(status);
    }),
    validateInstance: jest.fn().mockReturnValue('ok'),
  };
  const config = {
    get: (key: string) =>
      ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: BASE })[key],
  } as never;
  const machineClient = new PalazzoMachineClient(
    config,
    metrics,
    fetchImpl as unknown as typeof fetch,
  );
  const client = new PalazzoProgramClient({
    programId: 'radio-1',
    programType: 'radio',
    palazzoUrl: BASE,
    metrics,
    callbacks,
    machineClient,
    pollIntervalMs: 2_000,
  });
  const eventConnects = () =>
    fetchImpl.mock.calls.filter(([url]) => url.endsWith('/playback/events'))
      .length;
  const connections = () => statuses.map((status) => status.connection);
  return {
    client,
    metrics,
    streams,
    eventConnects,
    connections,
    statuses,
    hang: () => {
      mode = 'hung';
    },
    answer: () => {
      mode = 'live';
    },
  };
}

const idleCount = (metrics: RadioMetricsService) =>
  Number(
    /alcantara_palazzo_event_stream_idle_disconnects_total (\d+)/.exec(
      metrics.render(),
    )?.[1],
  );

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  // AbortSignal.timeout runs on a native timer the fake clock does not drive; route it through the faked one.
  jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PalazzoProgramClient idle watchdog (#734)', () => {
  it('drops a stream after 30 s without a byte, which is three Palazzo heartbeats', () => {
    expect(PALAZZO_EVENT_IDLE_MS).toBe(30_000);
  });

  it('never drops or freezes on a 25 s gap that a heartbeat ends', async () => {
    const h = harness();
    h.client.start();
    await jest.advanceTimersByTimeAsync(0);
    h.streams[0].push(snapshot(1));
    await jest.advanceTimersByTimeAsync(25_000);
    h.streams[0].push(heartbeat(2));
    await jest.advanceTimersByTimeAsync(25_000);
    h.streams[0].push(heartbeat(3));
    await jest.advanceTimersByTimeAsync(25_000);

    expect(h.eventConnects()).toBe(1);
    expect(idleCount(h.metrics)).toBe(0);
    expect(h.connections()).toEqual(['connected']);
    h.client.stop();
  });

  it('counts a partial frame as a sign of life', async () => {
    const h = harness();
    h.client.start();
    await jest.advanceTimersByTimeAsync(0);
    h.streams[0].push(snapshot(1));
    await jest.advanceTimersByTimeAsync(29_000);
    h.streams[0].push('id: boot-1:2\n');
    await jest.advanceTimersByTimeAsync(29_000);
    expect(h.eventConnects()).toBe(1);
    expect(idleCount(h.metrics)).toBe(0);
    h.client.stop();
  });

  it('drops a silent stream at 30 s, reconnects, and never freezes when Palazzo answers again', async () => {
    const h = harness();
    h.client.start();
    await jest.advanceTimersByTimeAsync(0);
    h.streams[0].push(snapshot(1));
    await jest.advanceTimersByTimeAsync(PALAZZO_EVENT_IDLE_MS - 1);
    expect(h.eventConnects()).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(idleCount(h.metrics)).toBe(1);
    expect(h.statuses).toContainEqual(
      expect.objectContaining({
        connection: 'connecting',
        detail: 'sse idle: no event for 30 s',
      }),
    );
    // The state poll answers at once: polling, never unavailable.
    expect(h.statuses.at(-1)?.connection).toBe('polling');

    // The reconnect gets the initial snapshot at once.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.eventConnects()).toBe(2);
    h.streams[1].push(snapshot(2));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.statuses.at(-1)?.connection).toBe('connected');
    expect(h.connections()).not.toContain('unavailable');
    h.client.stop();
  });

  it('reads unavailable when Palazzo is hung: the handshake and the state poll both give up', async () => {
    const h = harness();
    h.client.start();
    await jest.advanceTimersByTimeAsync(0);
    h.streams[0].push(snapshot(1));
    h.hang();
    await jest.advanceTimersByTimeAsync(PALAZZO_EVENT_IDLE_MS);
    expect(idleCount(h.metrics)).toBe(1);
    expect(h.statuses.at(-1)?.connection).toBe('connecting');

    // The state poll (one attempt, bounded at 10 s) fails: the program reads unavailable and the engine freezes.
    await jest.advanceTimersByTimeAsync(PALAZZO_COMMAND_TIMEOUT_MS);
    expect(h.statuses.at(-1)).toMatchObject({
      connection: 'unavailable',
      detail: 'sse and state endpoint unreachable',
    });

    // The reconnect's handshake gives up after 10 s instead of waiting forever.
    const before = h.eventConnects();
    await jest.advanceTimersByTimeAsync(1_000 + PALAZZO_COMMAND_TIMEOUT_MS);
    expect(h.eventConnects()).toBeGreaterThan(before);
    expect(h.metrics.render()).toMatch(
      /alcantara_palazzo_machine_requests_total\{operation="event-connect",result="unavailable"\} [1-9]/,
    );

    // Palazzo answers again: the next reconnect connects and unfreezes.
    h.answer();
    await jest.advanceTimersByTimeAsync(10_000);
    h.streams.at(-1)!.push(snapshot(5));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.statuses.at(-1)?.connection).toBe('connected');
    h.client.stop();
  });

  it('stops the watchdog with the client', async () => {
    const h = harness();
    h.client.start();
    await jest.advanceTimersByTimeAsync(0);
    h.streams[0].push(snapshot(1));
    h.client.stop();
    await jest.advanceTimersByTimeAsync(PALAZZO_EVENT_IDLE_MS * 2);
    expect(idleCount(h.metrics)).toBe(0);
  });
});
