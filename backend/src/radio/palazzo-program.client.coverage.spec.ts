import { PalazzoMachineClient } from './palazzo-machine.client';
import {
  PalazzoProgramClient,
  type PalazzoProgramClientCallbacks,
} from './palazzo-program.client';
import { RadioMetricsService } from './radio-metrics.service';
import type {
  PalazzoPlaybackEvent,
  PalazzoPlaybackState,
} from './palazzo-contract';

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

function event(
  sequence: number,
  type: PalazzoPlaybackEvent['type'],
  data: PalazzoPlaybackEvent['data'],
  occurredAt = new Date().toISOString(),
): PalazzoPlaybackEvent {
  return {
    schemaVersion: 1,
    id: `boot-1:${sequence}`,
    instanceId: 'palazzo-a',
    bootId: 'boot-1',
    sequence,
    type,
    occurredAt,
    data,
  };
}

function sse(events: PalazzoPlaybackEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of events) {
          controller.enqueue(
            encoder.encode(
              `id: ${item.id}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`,
            ),
          );
        }
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function create(fetchImpl: jest.Mock, pollIntervalMs = 100) {
  const metrics = new RadioMetricsService();
  const callbacks: PalazzoProgramClientCallbacks = {
    onSnapshot: jest.fn(),
    onEvent: jest.fn(),
    onStatus: jest.fn(),
    validateInstance: jest.fn().mockReturnValue('ok'),
  };
  const machineClient = new PalazzoMachineClient(
    {
      get: (key: string) =>
        ({ NODE_ENV: 'test', PALAZZO_ALLOWED_URLS: 'http://palazzo:3100' })[
          key
        ],
    } as any,
    metrics,
    fetchImpl as unknown as typeof fetch,
  );
  const client = new PalazzoProgramClient({
    programId: 'radio-1',
    programType: 'radio',
    palazzoUrl: 'http://palazzo:3100',
    metrics,
    callbacks,
    machineClient,
    pollIntervalMs,
  });
  return { client, metrics, callbacks, machineClient };
}

describe('PalazzoProgramClient coverage boundaries', () => {
  afterEach(() => jest.useRealTimers());

  it('refuses a gap reconciliation whose state carries another program intro', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn(async () =>
      sse([
        event(1, 'snapshot', { state: idleState(1) }),
        event(3, 'track.ended', {
          playbackRequestId: 'req-1',
          url: 'https://example.test/song.mp3',
        }),
      ]),
    );
    const { client, callbacks, metrics, machineClient } = create(fetchImpl);
    jest.spyOn(machineClient, 'getPlaybackState').mockResolvedValueOnce({
      ...idleState(3),
      status: 'playing',
      intro: {
        playbackId: 'intro-1',
        parentPlaybackId: 'song-1',
        programId: 'other-program',
        playbackRequestId: 'req-1',
        url: 'https://example.test/intro.mp3',
        startedAt: new Date().toISOString(),
        status: 'playing',
      },
    });
    (machineClient.getPlaybackState as jest.Mock).mockRejectedValue(
      new Error('state unavailable'),
    );
    client.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(client.getStatus().connection).toBe('unavailable');
    expect(metrics.snapshot().eventsIgnored['cross-program']).toBe(1);
    client.stop();
  });

  it('does not poll state while the SSE stream is connected', async () => {
    jest.useFakeTimers();
    const state = idleState(1);
    const fetchImpl = jest.fn(async (url: string) =>
      url.includes('/state')
        ? Response.json(state)
        : sse([event(1, 'snapshot', { state })]),
    );
    const { client, machineClient } = create(fetchImpl);
    jest
      .spyOn(machineClient, 'connectEvents')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => sse([event(1, 'snapshot', { state })]));
    client.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.getStatus().connection).toBe('polling');
    const stateReads = () =>
      fetchImpl.mock.calls.filter(([url]) => url.includes('/state')).length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(client.getStatus().connection).toBe('connected');
    const before = stateReads();
    await jest.advanceTimersByTimeAsync(500);
    expect(client.getStatus().connection).toBe('connected');
    expect(stateReads()).toBe(before);
    client.stop();
  });
});
