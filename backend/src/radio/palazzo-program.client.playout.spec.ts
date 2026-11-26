import {
  PalazzoProgramClient,
  type PalazzoProgramClientCallbacks,
} from './palazzo-program.client';
import { RadioMetricsService } from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import type {
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
  PalazzoProgramStatus,
} from './palazzo-contract';

// Playout down (the #734 follow-up): Palazzo can answer while its playout (Liquidsoap) is down. The status says so
// from Palazzo's own state and telemetry events, so the desk can show it; automation still follows `connection`.

const BASE = 'http://palazzo:3100';
const BOOT = 'boot-1';
const INSTANCE = 'palazzo-a';

function state(
  sequence: number,
  liquidsoapConnected: boolean,
): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: INSTANCE,
    bootId: BOOT,
    sequence,
    availability: 'available',
    status: 'idle',
    liquidsoap: {
      running: true,
      connected: liquidsoapConnected,
      staleSince: liquidsoapConnected ? null : '2026-11-26T15:00:00.000Z',
      lastSampleAt: '2026-11-26T15:00:00.000Z',
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

function event(
  sequence: number,
  type: PalazzoPlaybackEvent['type'],
  data: Record<string, unknown>,
): string {
  const body = {
    schemaVersion: 1,
    id: `${BOOT}:${sequence}`,
    instanceId: INSTANCE,
    bootId: BOOT,
    sequence,
    type,
    occurredAt: new Date().toISOString(),
    data,
  };
  return `id: ${body.id}\nevent: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
}

function harness(liquidsoapConnected: boolean) {
  let push: (text: string) => void = () => undefined;
  const fetchImpl = jest.fn((url: string) => {
    if (url.endsWith('/playback/events')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    }
    return Promise.resolve(Response.json(state(1, liquidsoapConnected)));
  });
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
  const client = new PalazzoProgramClient({
    programId: 'radio-1',
    programType: 'radio',
    palazzoUrl: BASE,
    metrics,
    callbacks,
    machineClient: new PalazzoMachineClient(
      config,
      metrics,
      fetchImpl as unknown as typeof fetch,
    ),
  });
  return { client, statuses, push: (text: string) => push(text) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('PalazzoProgramClient playout state', () => {
  it('is unknown until Palazzo has said', () => {
    expect(harness(true).client.getStatus().playout).toBeNull();
  });

  it('reads up or down from the snapshot, and stays connected either way', async () => {
    for (const [connected, playout] of [
      [true, 'up'],
      [false, 'down'],
    ] as const) {
      const h = harness(connected);
      h.client.start();
      await settle();
      h.push(event(1, 'snapshot', { state: state(1, connected) }));
      await settle();
      expect(h.client.getStatus()).toMatchObject({
        connection: 'connected',
        playout,
      });
      h.client.stop();
    }
  });

  it('reports one status per change: the first snapshot, and a later one that changes playout', async () => {
    const h = harness(true);
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true) }));
    await settle();
    // Connected and playout up arrive together, not as two statuses.
    expect(h.statuses).toEqual([
      expect.objectContaining({ connection: 'connected', playout: 'up' }),
    ]);
    h.push(event(2, 'snapshot', { state: state(2, true) }));
    await settle();
    expect(h.statuses).toHaveLength(1);
    // Already connected: only playout changes, and it is still reported.
    h.push(event(3, 'snapshot', { state: state(3, false) }));
    await settle();
    expect(h.statuses).toHaveLength(2);
    expect(h.statuses[1]).toMatchObject({
      connection: 'connected',
      playout: 'down',
    });
    h.client.stop();
  });

  it('follows telemetry.disconnected and telemetry.connected, and reports each change once', async () => {
    const h = harness(true);
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true) }));
    await settle();
    h.push(
      event(2, 'telemetry.disconnected', {
        staleSince: '2026-11-26T15:00:00.000Z',
      }),
    );
    await settle();
    expect(h.client.getStatus()).toMatchObject({
      connection: 'connected',
      playout: 'down',
    });
    const downReports = h.statuses.filter((s) => s.playout === 'down').length;
    h.push(event(3, 'audio.levels', { song: { rms: 0, peak: 0 } }));
    await settle();
    // Nothing changed: no new report.
    expect(h.statuses.filter((s) => s.playout === 'down')).toHaveLength(
      downReports,
    );
    h.push(event(4, 'telemetry.connected', {}));
    await settle();
    expect(h.statuses.at(-1)).toMatchObject({
      connection: 'connected',
      playout: 'up',
    });
    // Automation still follows the connection alone: it never left connected.
    expect(h.statuses.map((s) => s.connection)).not.toContain('unavailable');
    h.client.stop();
  });
});
