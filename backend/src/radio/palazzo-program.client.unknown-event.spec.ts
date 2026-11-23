import { PalazzoProgramClient } from './palazzo-program.client';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';
import type { ConfigService } from '@nestjs/config';
import type {
  PalazzoEventEnvelope,
  PalazzoPlaybackState,
} from './palazzo-contract';

/** The private cursor state these tests drive directly. */
interface ClientInternals {
  instanceId: string | null;
  currentBootId: string | null;
  lastSequence: number;
  skipUnknownEvent(envelope: PalazzoEventEnvelope): void;
}

// gaulatti/ariston#217: a Palazzo event of a type Alcantara does not know is
// skipped and counted; it never tears down the event stream.

const PROGRAM = 'radio-1';

function envelope(sequence: number, type: string, data = {}) {
  return {
    schemaVersion: 1,
    id: `boot-1:${sequence}`,
    instanceId: 'palazzo-a',
    bootId: 'boot-1',
    sequence,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

function idleState(sequence: number): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: 'palazzo-a',
    bootId: 'boot-1',
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

function frame(value: { id: string; type: string }): string {
  return `id: ${value.id}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of frames) controller.enqueue(encoder.encode(text));
      // Left open: the client stays connected.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createClient(fetchImpl: jest.Mock) {
  const metrics = new RadioMetricsService();
  const callbacks = {
    onSnapshot: jest.fn(),
    onEvent: jest.fn(),
    onStatus: jest.fn(),
    validateInstance: jest.fn().mockReturnValue('ok'),
  };
  const config = {
    get: (key: string) =>
      ({
        NODE_ENV: 'test',
        PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      })[key],
  } as unknown as ConfigService;
  const machineClient = new PalazzoMachineClient(
    config,
    metrics,
    fetchImpl as unknown as typeof fetch,
  );
  const client = new PalazzoProgramClient({
    programId: PROGRAM,
    programType: 'radio',
    palazzoUrl: 'http://palazzo:3100',
    metrics,
    callbacks,
    machineClient,
    pollIntervalMs: 5,
  });
  return { client, metrics, callbacks };
}

function ignored(metrics: RadioMetricsService, reason: string): number {
  const line = metrics
    .render()
    .split('\n')
    .find((entry) =>
      entry.startsWith(
        `alcantara_palazzo_events_ignored_total{reason="${reason}"} `,
      ),
    );
  return Number(line?.split(' ').pop());
}

describe('PalazzoProgramClient: unknown event types', () => {
  it('skips an unknown event, keeps the stream and handles the next known event', async () => {
    const snapshot = envelope(1, 'snapshot', { state: idleState(1) });
    const unknown = envelope(2, 'playout.something_new', { detail: 'x' });
    const started = envelope(3, 'track.started', {
      playbackRequestId: 'req-1',
      url: 'https://example.test/song.mp3',
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([frame(snapshot), frame(unknown), frame(started)]),
      );
    const { client, metrics, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = client.getStatus();
    client.stop();

    expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvent).toHaveBeenCalledWith(PROGRAM, started);
    expect(ignored(metrics, 'unknown-type')).toBe(1);
    expect(ignored(metrics, 'malformed')).toBe(0);
    // The unknown event advanced the cursor: the next known one is no gap.
    expect(ignored(metrics, 'sequence-gap')).toBe(0);
    expect(status.connection).toBe('connected');
    // One events connection only: the stream was never torn down.
    expect(
      fetchImpl.mock.calls.filter(([url]) =>
        String(url).includes('/playback/events'),
      ),
    ).toHaveLength(1);
  });

  it('labels the counter with the fixed reason, never the raw type', async () => {
    const snapshot = envelope(1, 'snapshot', { state: idleState(1) });
    const unknown = envelope(2, 'secret.type-name', {});
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(sseResponse([frame(snapshot), frame(unknown)]));
    const { client, metrics } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.stop();

    const rendered = metrics.render();
    expect(rendered).not.toContain('secret.type-name');
    expect(ignored(metrics, 'unknown-type')).toBe(1);
  });

  it('still tears the stream down for a malformed known event', async () => {
    const snapshot = envelope(1, 'snapshot', { state: idleState(1) });
    const malformed = envelope(2, 'track.started', {});
    const fetchImpl = jest.fn((url: string) =>
      url.includes('/playback/events')
        ? Promise.resolve(sseResponse([frame(snapshot), frame(malformed)]))
        : Promise.resolve(Response.json(idleState(1))),
    );
    const { client, metrics, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.stop();

    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(ignored(metrics, 'malformed')).toBeGreaterThanOrEqual(1);
    expect(ignored(metrics, 'unknown-type')).toBe(0);
  });
});

describe('PalazzoProgramClient.skipUnknownEvent cursor rules', () => {
  const unknownAt = (
    sequence: number,
    overrides: Partial<PalazzoEventEnvelope> = {},
  ): PalazzoEventEnvelope => ({
    id: `boot-1:${sequence}`,
    instanceId: 'palazzo-a',
    bootId: 'boot-1',
    sequence,
    occurredAt: new Date().toISOString(),
    ...overrides,
  });
  const primed = () => {
    const ctx = createClient(jest.fn());
    const c = ctx.client as unknown as ClientInternals;
    c.instanceId = 'palazzo-a';
    c.currentBootId = 'boot-1';
    c.lastSequence = 5;
    return { ...ctx, c };
  };

  it('advances the cursor for the next event of the accepted boot', () => {
    const { c } = primed();
    c.skipUnknownEvent(unknownAt(6));
    expect(c.lastSequence).toBe(6);
  });

  it.each<[string, Partial<ClientInternals>, PalazzoEventEnvelope]>([
    ['before any snapshot', { currentBootId: null }, unknownAt(6)],
    ['of another boot', {}, unknownAt(6, { bootId: 'boot-2' })],
    ['of another instance', {}, unknownAt(6, { instanceId: 'palazzo-b' })],
    ['that is not newer', {}, unknownAt(5)],
  ])('leaves the cursor alone for an event %s', (_name, state, value) => {
    const { c, metrics } = primed();
    Object.assign(c, state);
    const before = c.lastSequence;
    c.skipUnknownEvent(value);
    expect(c.lastSequence).toBe(before);
    expect(ignored(metrics, 'unknown-type')).toBe(1);
  });

  it('accepts an unknown event before the instance is known', () => {
    const { c } = primed();
    c.instanceId = null;
    c.skipUnknownEvent(unknownAt(6));
    expect(c.lastSequence).toBe(6);
  });
});
