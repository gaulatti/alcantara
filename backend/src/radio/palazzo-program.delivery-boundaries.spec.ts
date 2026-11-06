import { ConfigService } from '@nestjs/config';
import { PalazzoMachineClient } from './palazzo-machine.client';
import {
  PalazzoProgramClient,
  type PalazzoProgramClientCallbacks,
} from './palazzo-program.client';
import type { PalazzoPlaybackState } from './palazzo-contract';
import { RadioMetricsService } from './radio-metrics.service';

const state = (instanceId = 'instance'): PalazzoPlaybackState => ({
  schemaVersion: 1,
  instanceId,
  bootId: 'boot',
  sequence: 1,
  availability: 'available',
  status: 'idle',
  track: null,
  intro: null,
  liquidsoap: {
    running: true,
    connected: true,
    staleSince: null,
    lastSampleAt: null,
  },
  icecast: { connected: true },
  positionSeconds: 0,
  remainingSeconds: null,
  levels: {
    song: { rms: 0, peak: 0 },
    instant: { rms: 0, peak: 0 },
    output: { rms: 0, peak: 0 },
  },
});

function snapshotStream(): Response {
  const snapshot = state();
  const event = {
    schemaVersion: 1,
    id: 'boot:1',
    instanceId: snapshot.instanceId,
    bootId: 'boot',
    sequence: 1,
    type: 'snapshot',
    occurredAt: new Date().toISOString(),
    data: { state: snapshot },
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function fixture(
  transport: jest.Mock,
  callbacks: Partial<PalazzoProgramClientCallbacks> = {},
  pollIntervalMs = 5000,
) {
  const metrics = new RadioMetricsService();
  const observers: PalazzoProgramClientCallbacks = {
    onSnapshot: jest.fn(),
    onEvent: jest.fn(),
    onStatus: jest.fn(),
    validateInstance: jest.fn().mockReturnValue('ok'),
    ...callbacks,
  };
  const machineClient = new PalazzoMachineClient(
    new ConfigService({
      NODE_ENV: 'test',
      PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
    }),
    metrics,
    transport as unknown as typeof fetch,
  );
  const client = new PalazzoProgramClient({
    programId: 'radio',
    programType: 'radio',
    palazzoUrl: 'http://palazzo:3100',
    metrics,
    machineClient,
    callbacks: observers,
    pollIntervalMs,
  });
  return { client, metrics, observers };
}

describe('public Palazzo reconnect, polling and shutdown boundaries', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-10-24T12:00:00Z') }),
  );
  afterEach(() => jest.useRealTimers());

  it('retries unavailable SSE without duplicating an already running polling timer', async () => {
    const transport = jest
      .fn()
      .mockRejectedValue(new Error('local transport unavailable'));
    const { client, observers, metrics } = fixture(transport);
    try {
      client.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getStatus().connection).toBe('unavailable');
      await jest.advanceTimersByTimeAsync(1000);
      expect(
        transport.mock.calls.filter(([url]) => url.endsWith('/events')),
      ).toHaveLength(2);
      expect(
        transport.mock.calls.filter(([url]) => url.endsWith('/state')),
      ).toHaveLength(1);
      expect(metrics.snapshot().reconnectFailures).toBe(2);
      expect(observers.onSnapshot).not.toHaveBeenCalled();
    } finally {
      client.stop();
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  it('honors shutdown requested by a status observer before starting fallback polling', async () => {
    const transport = jest
      .fn()
      .mockRejectedValue(new Error('local SSE unavailable'));
    const { client, observers } = fixture(transport, {
      onStatus: (_program, status) => {
        if (status.detail === 'sse connect failed') client.stop();
      },
    });
    try {
      client.start();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(5000);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][0]).toContain('/playback/events');
      expect(observers.onSnapshot).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      client.stop();
    }
  });

  it('keeps an SSE ownership conflict when an older pending poll subsequently fails', async () => {
    let rejectPoll!: (error: Error) => void;
    let eventRequests = 0;
    const transport = jest.fn((url: string) => {
      if (url.endsWith('/state'))
        return new Promise<Response>((_resolve, reject) => {
          rejectPoll = reject;
        });
      eventRequests += 1;
      return eventRequests === 1
        ? Promise.reject(new Error('first SSE unavailable'))
        : Promise.resolve(snapshotStream());
    });
    const { client, observers } = fixture(transport, {
      validateInstance: jest.fn().mockReturnValue('conflict'),
    });
    try {
      client.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(rejectPoll).toEqual(expect.any(Function));
      await jest.advanceTimersByTimeAsync(1000);
      expect(client.getStatus().connection).toBe('instance-conflict');
      rejectPoll(new Error('old polling connection closed'));
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getStatus().connection).toBe('instance-conflict');
      expect(observers.onSnapshot).not.toHaveBeenCalled();
    } finally {
      client.stop();
    }
  });

  it('rejects a changed instance discovered by polling instead of forwarding its snapshot', async () => {
    let reads = 0;
    const transport = jest.fn((url: string) =>
      url.endsWith('/events')
        ? Promise.reject(new Error('SSE unavailable'))
        : Promise.resolve(
            Response.json(state(++reads === 1 ? 'original' : 'replacement')),
          ),
    );
    const { client, observers } = fixture(transport, {}, 50);
    try {
      client.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(observers.onSnapshot).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(50);
      expect(client.getStatus().connection).toBe('instance-mismatch');
      expect(observers.onSnapshot).toHaveBeenCalledTimes(1);
      expect(client.knownInstanceId).toBe('original');
    } finally {
      client.stop();
    }
  });

  it('retains terminal ownership rejection even when its status observer fails', async () => {
    const transport = jest.fn((url: string) =>
      url.endsWith('/events')
        ? Promise.reject(new Error('SSE unavailable'))
        : Promise.resolve(Response.json(state())),
    );
    const { client, observers } = fixture(transport, {
      validateInstance: jest.fn().mockReturnValue('conflict'),
      onStatus: (_program, status) => {
        if (status.connection === 'instance-conflict')
          throw new Error('local observer failed');
      },
    });
    try {
      client.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getStatus()).toMatchObject({
        connection: 'instance-conflict',
        degraded: true,
      });
      expect(observers.onSnapshot).not.toHaveBeenCalled();
    } finally {
      client.stop();
    }
  });
});
