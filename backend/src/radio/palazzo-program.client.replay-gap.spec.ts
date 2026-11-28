import { PalazzoProgramClient } from './palazzo-program.client';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';
import type { ConfigService } from '@nestjs/config';
import type { PalazzoPlaybackState } from './palazzo-contract';
import { Logger } from '@nestjs/common';

/** The private cursor state these tests read directly. */
interface ClientInternals {
  currentBootId: string | null;
  lastSequence: number;
}

// gaulatti/alcantara#240: Palazzo's replay.gap event (palazzo#56) is a known
// type. It is counted under the existing gap counter and logged; it does not
// move the cursor, fetch anything or reach the engine.

const PROGRAM = 'radio-1';

function envelope(
  sequence: number,
  type: string,
  data: unknown = {},
  bootId = 'boot-1',
) {
  return {
    schemaVersion: 1,
    id: `${bootId}:${sequence}`,
    instanceId: 'palazzo-a',
    bootId,
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

async function run(frames: ReturnType<typeof envelope>[]) {
  const fetchImpl = jest.fn().mockResolvedValue(sseResponse(frames.map(frame)));
  const created = createClient(fetchImpl);
  created.client.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const internals = created.client as unknown as ClientInternals;
  const result = {
    ...created,
    fetchImpl,
    sequence: internals.lastSequence,
    boot: internals.currentBootId,
  };
  created.client.stop();
  return result;
}

describe('PalazzoProgramClient: replay.gap', () => {
  let warn: jest.SpyInstance<void, unknown[]>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  const snapshot = () => envelope(5, 'snapshot', { state: idleState(5) });
  const gap = (
    data: unknown = { reason: 'cursor_not_in_replay', replayEvents: 512 },
  ) => envelope(5, 'replay.gap', data);

  it('records one gap, leaves the unknown-type counter alone and keeps the cursor at the snapshot', async () => {
    const started = envelope(6, 'track.started', {
      playbackRequestId: 'req-1',
      url: 'https://example.test/song.mp3',
    });
    const { metrics, callbacks, fetchImpl, sequence, boot } = await run([
      snapshot(),
      gap(),
      started,
    ]);

    expect(ignored(metrics, 'sequence-gap')).toBe(1);
    expect(ignored(metrics, 'unknown-type')).toBe(0);
    expect(ignored(metrics, 'duplicate')).toBe(0);
    expect(ignored(metrics, 'malformed')).toBe(0);
    // The cursor stayed at the snapshot, so the next event (6) is the very
    // next one, not a gap, and reaches the engine; the gap did not.
    expect(sequence).toBe(6);
    expect(boot).toBe('boot-1');
    expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvent).toHaveBeenCalledWith(PROGRAM, started);
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
    // Nothing was fetched for it: only the events connection.
    expect(
      fetchImpl.mock.calls.filter(
        ([url]) => !String(url).includes('/playback/events'),
      ),
    ).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'replay window held 512 events',
    );
  });

  it('is logged once per gap and works without a replay count', async () => {
    const { metrics } = await run([
      snapshot(),
      gap({ reason: 'cursor_not_in_replay' }),
    ]);
    expect(ignored(metrics, 'sequence-gap')).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('replay window held');
  });

  it('accepts a reason or fields it does not know', async () => {
    const { metrics } = await run([
      snapshot(),
      gap({ reason: 'something_new', replayEvents: 'many', extra: true }),
    ]);
    expect(ignored(metrics, 'sequence-gap')).toBe(1);
    expect(ignored(metrics, 'unknown-type')).toBe(0);
    expect(ignored(metrics, 'malformed')).toBe(0);
  });

  it('still rejects a replay.gap whose data is not an object as malformed', async () => {
    for (const data of ['text', 7, null, ['a']]) {
      const { metrics, callbacks } = await run([snapshot(), gap(data)]);
      expect(ignored(metrics, 'malformed')).toBe(1);
      expect(ignored(metrics, 'sequence-gap')).toBe(0);
      expect(ignored(metrics, 'unknown-type')).toBe(0);
      expect(callbacks.onEvent).not.toHaveBeenCalled();
    }
  });

  it('ignores a replay.gap before any snapshot was accepted, or from another boot', async () => {
    const before = await run([gap()]);
    expect(ignored(before.metrics, 'sequence-gap')).toBe(0);
    expect(ignored(before.metrics, 'superseded-boot')).toBe(1);
    const other = await run([
      snapshot(),
      envelope(5, 'replay.gap', { reason: 'cursor_not_in_replay' }, 'boot-2'),
    ]);
    expect(ignored(other.metrics, 'sequence-gap')).toBe(0);
    expect(ignored(other.metrics, 'superseded-boot')).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not change how another unknown type is handled', async () => {
    const { metrics } = await run([
      snapshot(),
      envelope(6, 'playout.something_new'),
    ]);
    expect(ignored(metrics, 'unknown-type')).toBe(1);
    expect(ignored(metrics, 'sequence-gap')).toBe(0);
  });
});
