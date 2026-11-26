import {
  PalazzoProgramClient,
  type PalazzoProgramClientCallbacks,
} from './palazzo-program.client';
import { PALAZZO_EVENT_IDLE_MS } from './palazzo-program.client';
import { RadioMetricsService } from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import type {
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
  PalazzoProgramStatus,
} from './palazzo-contract';

// Palazzo's live input (gaulatti/palazzo#48): the status carries its snapshot's `live.onAir` as an optional field. A
// Palazzo that does not report it leaves the field absent, and a consumer ignores what it does not know.

const BASE = 'http://palazzo:3100';
const BOOT = 'boot-1';
const INSTANCE = 'palazzo-a';

function state(
  sequence: number,
  liquidsoapConnected: boolean,
  live?: { onAir: boolean },
): PalazzoPlaybackState {
  return {
    ...(live ? { live } : {}),
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

describe('PalazzoProgramClient live input', () => {
  it('is absent from the status until a snapshot says whether live input is on the air', async () => {
    const h = harness(true);
    expect(h.client.getStatus()).not.toHaveProperty('live');
    // With no reading there is nothing to be fresh.
    expect(h.client.liveFresh()).toBe(false);
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true) }));
    await settle();
    expect(h.client.getStatus()).not.toHaveProperty('live');
    h.client.stop();
  });

  it('passes live.onAir through as an optional field, on and off', async () => {
    for (const onAir of [true, false]) {
      const h = harness(true);
      h.client.start();
      await settle();
      h.push(event(1, 'snapshot', { state: state(1, true, { onAir }) }));
      await settle();
      expect(h.client.getStatus()).toMatchObject({ connection: 'connected', live: { onAir } });
      h.client.stop();
    }
  });

  it('reports a change of live input as a status, and not an unchanged snapshot', async () => {
    const h = harness(true);
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true, { onAir: false }) }));
    await settle();
    expect(h.statuses).toHaveLength(1);
    h.push(event(2, 'snapshot', { state: state(2, true, { onAir: false }) }));
    await settle();
    expect(h.statuses).toHaveLength(1);
    h.push(event(3, 'snapshot', { state: state(3, true, { onAir: true }) }));
    await settle();
    expect(h.statuses).toHaveLength(2);
    expect(h.statuses[1]).toMatchObject({ live: { onAir: true } });
    h.client.stop();
  });

  it('shows the reading only while it is fresh: a stale "off" is absent, not silence', async () => {
    const h = harness(true);
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true, { onAir: false }) }));
    await settle();
    expect(h.client.getStatus()).toMatchObject({ live: { onAir: false } });
    const now = Date.now();
    const window = PALAZZO_EVENT_IDLE_MS + 15_000;
    const later = jest.spyOn(Date, 'now').mockReturnValue(now + window + 1);
    try {
      expect(h.client.getStatus()).not.toHaveProperty('live');
      expect(h.client.liveFresh()).toBe(false);
    } finally {
      later.mockRestore();
    }
    h.client.stop();
  });

  it('keeps a fresh reading while the client has fallen back to polling', async () => {
    const h = harness(true);
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true, { onAir: true }) }));
    await settle();
    // Polling still hears Palazzo; set the state directly, as the client does when the stream drops to polls.
    (h.client as unknown as { connection: string }).connection = 'polling';
    expect(h.client.getStatus()).toMatchObject({ live: { onAir: true } });
    h.client.stop();
  });

  it('treats a reading as not fresh when the stream is no longer heard', async () => {
    const h = harness(true);
    h.client.start();
    await settle();
    h.push(event(1, 'snapshot', { state: state(1, true, { onAir: true }) }));
    await settle();
    // A client that no longer hears Palazzo (the connection is no longer connected or polling) cannot vouch for a
    // reading it took earlier; set the state directly, as the client does on a lost stream.
    (h.client as unknown as { connection: string }).connection = 'unavailable';
    expect(h.client.getStatus()).not.toHaveProperty('live');
    h.client.stop();
  });
});
