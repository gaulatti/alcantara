import type { ConfigService } from '@nestjs/config';
import { PalazzoProgramClient } from './palazzo-program.client';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';
import type { PalazzoPlaybackState } from './palazzo-contract';

// gaulatti/ariston#217 slice 3: Palazzo values Alcantara does not know degrade
// safely instead of dropping the state or the stream, and an event of another
// schema major is skipped and counted.

const PROGRAM = 'radio-1';
const PALAZZO = 'http://palazzo:3100';

function wireState(
  sequence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...overrides,
  };
}

function envelope(
  sequence: number,
  type: string,
  data: Record<string, unknown> = {},
  schemaVersion = 1,
) {
  return {
    schemaVersion,
    id: `boot-1:${sequence}`,
    instanceId: 'palazzo-a',
    bootId: 'boot-1',
    sequence,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
}

function frame(value: { id: string; type: string }): string {
  return `id: ${value.id}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of frames) controller.enqueue(encoder.encode(text));
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function setup(fetchImpl: jest.Mock) {
  const metrics = new RadioMetricsService();
  const callbacks = {
    onSnapshot: jest.fn(),
    onEvent: jest.fn(),
    onStatus: jest.fn(),
    validateInstance: jest.fn().mockReturnValue('ok'),
  };
  const config = {
    get: (key: string) =>
      ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: PALAZZO })[key],
  } as unknown as ConfigService;
  const machineClient = new PalazzoMachineClient(
    config,
    metrics,
    fetchImpl as unknown as typeof fetch,
  );
  const client = new PalazzoProgramClient({
    programId: PROGRAM,
    programType: 'radio',
    palazzoUrl: PALAZZO,
    metrics,
    callbacks,
    machineClient,
    pollIntervalMs: 5,
  });
  return { client, metrics, callbacks, machineClient };
}

function counter(metrics: RadioMetricsService, prefix: string): number {
  const line = metrics
    .render()
    .split('\n')
    .find((entry) => entry.startsWith(`${prefix} `));
  return Number(line?.split(' ').pop());
}

const unknownValue = (field: string) =>
  `alcantara_palazzo_unknown_values_total{field="${field}"}`;
const ignoredEvent = (reason: string) =>
  `alcantara_palazzo_events_ignored_total{reason="${reason}"}`;

async function run(frames: string[]) {
  const fetchImpl = jest.fn().mockResolvedValue(sseResponse(frames));
  const ctx = setup(fetchImpl);
  ctx.client.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = ctx.client.getStatus();
  ctx.client.stop();
  const eventConnections = fetchImpl.mock.calls.filter(([url]) =>
    String(url).includes('/playback/events'),
  ).length;
  return { ...ctx, status, eventConnections };
}

describe('PalazzoProgramClient: unknown Palazzo values', () => {
  it('keeps a snapshot with an unknown availability, status and intro status', async () => {
    const playing = wireState(1, {
      status: 'playing',
      track: {
        playbackRequestId: 'req-1',
        title: null,
        artist: null,
        coverUrl: null,
        url: 'https://example.test/song.mp3',
        startedAt: new Date().toISOString(),
      },
    });
    const odd = wireState(2, {
      availability: 'novel-availability',
      status: 'novel-status',
      intro: {
        playbackId: 'intro-1',
        parentPlaybackId: 'req-1',
        programId: PROGRAM,
        playbackRequestId: 'req-1',
        url: 'https://example.test/intro.mp3',
        startedAt: new Date().toISOString(),
        status: 'novel-intro-status',
      },
    });
    const { callbacks, metrics, status, eventConnections } = await run([
      frame(envelope(1, 'snapshot', { state: playing })),
      frame(envelope(2, 'snapshot', { state: odd })),
    ]);

    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(2);
    const second = (
      callbacks.onSnapshot.mock.calls[1] as [string, PalazzoPlaybackState]
    )[1];
    expect(second.availability).toBe('degraded');
    // The unknown status keeps the last known one.
    expect(second.status).toBe('playing');
    expect(second.intro).toBeNull();
    expect(counter(metrics, unknownValue('availability'))).toBe(1);
    expect(counter(metrics, unknownValue('status'))).toBe(1);
    expect(counter(metrics, unknownValue('intro-status'))).toBe(1);
    expect(counter(metrics, ignoredEvent('malformed'))).toBe(0);
    expect(status.connection).toBe('connected');
    expect(eventConnections).toBe(1);
    expect(metrics.render()).not.toMatch(/novel-/);
  });

  it('forwards a withdrawn event with an unknown reason as other', async () => {
    const withdrawn = envelope(2, 'playout.next_withdrawn', {
      programId: PROGRAM,
      playbackId: 'next-1',
      reason: 'a_reason_from_the_future',
    });
    const { callbacks, metrics, eventConnections } = await run([
      frame(envelope(1, 'snapshot', { state: wireState(1) })),
      frame(withdrawn),
    ]);

    expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
    const [programId, forwarded] = callbacks.onEvent.mock.calls[0] as [
      string,
      { type: string; data: { playbackId: string; reason: string } },
    ];
    expect(programId).toBe(PROGRAM);
    expect(forwarded.type).toBe('playout.next_withdrawn');
    expect(forwarded.data).toMatchObject({
      playbackId: 'next-1',
      reason: 'other',
    });
    expect(counter(metrics, unknownValue('withdrawn-reason'))).toBe(1);
    expect(eventConnections).toBe(1);
  });

  it('skips an event of another schema major and still handles the next known one', async () => {
    const position = envelope(3, 'playback.position', {
      positionSeconds: 4,
    });
    const { callbacks, metrics, status, eventConnections } = await run([
      frame(envelope(1, 'snapshot', { state: wireState(1) })),
      frame(envelope(2, 'track.started', { playbackRequestId: 'r' }, 2)),
      frame(position),
    ]);

    expect(counter(metrics, ignoredEvent('unsupported-version'))).toBe(1);
    expect(counter(metrics, ignoredEvent('malformed'))).toBe(0);
    expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvent).toHaveBeenCalledWith(PROGRAM, position);
    expect(status.connection).toBe('connected');
    expect(eventConnections).toBe(1);
  });

  it('still reconnects for a fractional schema version (not an integer major)', async () => {
    const { metrics, callbacks } = await run([
      frame(envelope(1, 'snapshot', { state: wireState(1) })),
      frame(envelope(2, 'heartbeat', {}, 1.5)),
    ]);
    expect(counter(metrics, ignoredEvent('malformed'))).toBeGreaterThanOrEqual(
      1,
    );
    expect(counter(metrics, ignoredEvent('unsupported-version'))).toBe(0);
    expect(callbacks.onEvent).not.toHaveBeenCalled();
  });
});

describe('PalazzoMachineClient.getPlaybackState: unknown values', () => {
  it('reads unknown values safely, keeps the given previous status and counts each', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        Response.json(wireState(4, { availability: 'x', status: 'y' })),
      );
    const { machineClient, metrics } = setup(fetchImpl);

    const state = await machineClient.getPlaybackState(
      PALAZZO,
      PROGRAM,
      undefined,
      'playing',
    );
    expect(state.availability).toBe('degraded');
    expect(state.status).toBe('playing');
    expect(counter(metrics, unknownValue('availability'))).toBe(1);
    expect(counter(metrics, unknownValue('status'))).toBe(1);
  });

  it('defaults an unknown status to idle without a previous status', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(Response.json(wireState(4, { status: 'y' })));
    const { machineClient } = setup(fetchImpl);
    expect(
      (await machineClient.getPlaybackState(PALAZZO, PROGRAM)).status,
    ).toBe('idle');
  });
});

describe('RadioMetricsService unknown values', () => {
  it('exposes every field from 0', () => {
    const rendered = new RadioMetricsService().render();
    for (const field of [
      'availability',
      'status',
      'intro-status',
      'withdrawn-reason',
    ]) {
      expect(rendered).toContain(`${unknownValue(field)} 0`);
    }
    expect(rendered).toContain(`${ignoredEvent('unsupported-version')} 0`);
  });
});
