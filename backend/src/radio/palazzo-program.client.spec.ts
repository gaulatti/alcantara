import {
  PalazzoProgramClient,
  type PalazzoProgramClientCallbacks,
} from './palazzo-program.client';
import { RadioMetricsService } from './radio-metrics.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import type {
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
} from './palazzo-contract';

function snapshotEvent(
  instanceId: string,
  bootId: string,
  sequence: number,
  state: PalazzoPlaybackState,
): PalazzoPlaybackEvent {
  return {
    schemaVersion: 1,
    id: `${bootId}:${sequence}`,
    instanceId,
    bootId,
    sequence,
    type: 'snapshot',
    occurredAt: new Date().toISOString(),
    data: { state },
  };
}

function lifecycleEvent(
  instanceId: string,
  bootId: string,
  sequence: number,
  type: 'track.started' | 'track.ended',
  playbackRequestId: string,
): PalazzoPlaybackEvent {
  return {
    schemaVersion: 1,
    id: `${bootId}:${sequence}`,
    instanceId,
    bootId,
    sequence,
    type,
    occurredAt: new Date().toISOString(),
    data: { playbackRequestId, url: 'https://example.test/song.mp3' },
  };
}

function idleState(
  instanceId: string,
  bootId: string,
  sequence: number,
): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId,
    bootId,
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

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      // Keep the stream open; the client stays connected.
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function frame(event: PalazzoPlaybackEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function createClient(
  fetchImpl: jest.Mock,
  callbacks: Partial<PalazzoProgramClientCallbacks> = {},
) {
  const metrics = new RadioMetricsService();
  const fullCallbacks: PalazzoProgramClientCallbacks = {
    onSnapshot: jest.fn(),
    onEvent: jest.fn(),
    onStatus: jest.fn(),
    validateInstance: jest.fn().mockReturnValue('ok'),
    ...callbacks,
  };
  const config = {
    get: (key: string) =>
      ({
        NODE_ENV: 'test',
        PALAZZO_CONTROL_TOKEN: 'palazzo-test-control-token',
        PALAZZO_ALLOWED_URLS: 'http://palazzo:3100',
      })[key],
  } as any;
  const machineClient = new PalazzoMachineClient(
    config,
    metrics,
    fetchImpl as unknown as typeof fetch,
  );
  const client = new PalazzoProgramClient({
    programId: 'radio-1',
    programType: 'radio',
    palazzoUrl: 'http://palazzo:3100',
    metrics,
    callbacks: fullCallbacks,
    machineClient,
    pollIntervalMs: 5,
  });
  return { client, metrics, callbacks: fullCallbacks };
}

describe('PalazzoProgramClient', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('accepts the initial snapshot and forwards lifecycle events', async () => {
    const snapshot = idleState('palazzo-a', 'boot-1', 1);
    const started = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      2,
      'track.started',
      'req-1',
    );
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 1, snapshot)),
          frame(started),
        ]),
      );
    const { client, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((r) => setTimeout(r, 20));
    client.stop();

    expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', snapshot);
    expect(callbacks.onEvent).toHaveBeenCalledWith('radio-1', started);
  });

  it('ignores duplicate and stale sequences within the same boot', async () => {
    const snapshot = idleState('palazzo-a', 'boot-1', 5);
    const duplicate = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      5,
      'track.ended',
      'req-1',
    );
    const stale = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      3,
      'track.ended',
      'req-1',
    );
    const fresh = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      6,
      'track.ended',
      'req-1',
    );
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 5, snapshot)),
          frame(duplicate),
          frame(stale),
          frame(fresh),
        ]),
      );
    const { client, callbacks, metrics } = createClient(fetchImpl);

    client.start();
    await new Promise((r) => setTimeout(r, 20));
    client.stop();

    expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvent).toHaveBeenCalledWith('radio-1', fresh);
    expect(metrics.snapshot().eventsIgnored).toEqual({
      duplicate: 1,
      'stale-sequence': 1,
    });
  });

  it('ignores events from a superseded boot until a newer snapshot arrives', async () => {
    const first = idleState('palazzo-a', 'boot-1', 5);
    const second = idleState('palazzo-a', 'boot-2', 1);
    const oldBootEvent = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      6,
      'track.ended',
      'req-1',
    );
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 5, first)),
          frame(snapshotEvent('palazzo-a', 'boot-2', 1, second)),
          frame(oldBootEvent),
        ]),
      );
    const { client, callbacks, metrics } = createClient(fetchImpl);

    client.start();
    await new Promise((r) => setTimeout(r, 20));
    client.stop();

    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(2);
    expect(metrics.snapshot().eventsIgnored['superseded-boot']).toBe(1);
  });

  it('rejects an instance identity mismatch and stops consuming', async () => {
    const first = idleState('palazzo-a', 'boot-1', 1);
    const second = idleState('palazzo-b', 'boot-1', 2);
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 1, first)),
          frame(snapshotEvent('palazzo-b', 'boot-1', 2, second)),
        ]),
      );
    const { client, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((r) => setTimeout(r, 20));
    client.stop();

    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(client.getStatus().connection).toBe('instance-mismatch');
  });

  it('falls back to polling the state endpoint when SSE fails', async () => {
    const state = idleState('palazzo-a', 'boot-1', 3);
    const sseFailure = jest
      .fn()
      .mockRejectedValue(new Error('connection refused'));
    const stateFetch = jest
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify(state), { status: 200 }),
      );
    const fetchImpl = jest.fn((url: string) =>
      url.includes('/playback/events') ? sseFailure() : stateFetch(),
    );
    const { client, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((r) => setTimeout(r, 30));
    client.stop();

    expect(stateFetch).toHaveBeenCalled();
    expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', state);
    expect(client.getStatus().connection).toBe('polling');
  });

  it('marks the program unavailable when SSE and the state endpoint both fail', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('down'));
    const { client, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((r) => setTimeout(r, 30));
    client.stop();

    expect(callbacks.onSnapshot).not.toHaveBeenCalled();
    expect(client.getStatus().connection).toBe('unavailable');
    expect(client.getStatus().degraded).toBe(true);
  });

  it('reconciles an SSE sequence gap through authenticated state without applying the gap event', async () => {
    const snapshot = idleState('palazzo-a', 'boot-1', 1);
    const gap = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      3,
      'track.ended',
      'req-1',
    );
    const fetchImpl = jest.fn((url: string) =>
      url.includes('/playback/events')
        ? Promise.resolve(
            sseResponse([
              frame(snapshotEvent('palazzo-a', 'boot-1', 1, snapshot)),
              frame(gap),
            ]),
          )
        : Promise.resolve(Response.json(idleState('palazzo-a', 'boot-1', 3))),
    );
    const { client, callbacks, metrics } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.stop();

    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.onSnapshot).toHaveBeenLastCalledWith(
      'radio-1',
      expect.objectContaining({ sequence: 3 }),
    );
    expect(metrics.snapshot().eventsIgnored['sequence-gap']).toBe(1);
  });

  it('rejects a cross-program event before it reaches the engine', async () => {
    const snapshot = idleState('palazzo-a', 'boot-1', 1);
    const event = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      2,
      'track.started',
      'req-1',
    );
    event.data.programId = 'another-program';
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 1, snapshot)),
          frame(event),
        ]),
      );
    const { client, callbacks, metrics } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.stop();

    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(metrics.snapshot().eventsIgnored['cross-program']).toBe(1);
  });
});
