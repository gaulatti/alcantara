import {
  PalazzoProgramClient,
  type PalazzoProgramClientCallbacks,
  type PalazzoProgramClientOptions,
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

function playingState(
  instanceId: string,
  bootId: string,
  sequence: number,
): PalazzoPlaybackState {
  return {
    ...idleState(instanceId, bootId, sequence),
    status: 'playing',
    track: {
      playbackRequestId: 'req-1',
      title: 'Song one',
      artist: 'Artist one',
      coverUrl: 'https://example.test/cover.jpg',
      url: 'https://example.test/song.mp3',
      startedAt: new Date().toISOString(),
    },
    positionSeconds: 12,
    remainingSeconds: 88,
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
  options: Partial<PalazzoProgramClientOptions> = {},
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
    ...options,
  });
  return { client, metrics, machineClient, callbacks: fullCallbacks };
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

  it('hydrates Palazzo redacted SSE snapshots from authenticated state and accepts URL-free lifecycle events', async () => {
    const state = playingState('palazzo-a', 'boot-1', 2);
    const redactedSnapshot = snapshotEvent(
      'palazzo-a',
      'boot-1',
      1,
      structuredClone(state),
    );
    const redactedState = redactedSnapshot.data.state as Record<
      string,
      unknown
    >;
    const redactedTrack = redactedState.track as Record<string, unknown>;
    delete redactedTrack.url;
    delete redactedTrack.coverUrl;
    const ended = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      3,
      'track.ended',
      'req-1',
    );
    delete ended.data.url;

    const fetchImpl = jest.fn((url: string) =>
      url.includes('/playback/events')
        ? Promise.resolve(sseResponse([frame(redactedSnapshot), frame(ended)]))
        : Promise.resolve(Response.json(state)),
    );
    const { client, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.stop();

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/playback/state'),
      expect.any(Object),
    );
    expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', state);
    expect(callbacks.onEvent).toHaveBeenCalledWith('radio-1', ended);
  });

  it('accepts CRLF-delimited Palazzo SSE frames', async () => {
    const snapshot = idleState('palazzo-a', 'boot-1', 1);
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 1, snapshot)).replace(
            /\n/g,
            '\r\n',
          ),
        ]),
      );
    const { client, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.stop();

    expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', snapshot);
  });

  it('advances across Palazzo preflight events without forwarding them as track ends', async () => {
    const snapshot = idleState('palazzo-a', 'boot-1', 1);
    const preflight: PalazzoPlaybackEvent = {
      schemaVersion: 1,
      id: 'boot-1:2',
      instanceId: 'palazzo-a',
      bootId: 'boot-1',
      sequence: 2,
      type: 'preflight.ready',
      occurredAt: new Date().toISOString(),
      data: { playbackId: 'req-1', kind: 'song' },
    };
    const ended = lifecycleEvent(
      'palazzo-a',
      'boot-1',
      3,
      'track.ended',
      'req-1',
    );
    delete ended.data.url;
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 1, snapshot)),
          frame(preflight),
          frame(ended),
        ]),
      );
    const { client, callbacks } = createClient(fetchImpl);

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.stop();

    expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvent).toHaveBeenCalledWith('radio-1', ended);
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

  async function settle() {
    await jest.advanceTimersByTimeAsync(0);
  }

  function introState(programId: string): PalazzoPlaybackState {
    return {
      ...playingState('palazzo-a', 'boot-1', 3),
      intro: {
        playbackId: 'intro-1',
        parentPlaybackId: 'song-1',
        programId,
        playbackRequestId: 'req-1',
        url: 'https://example.test/intro.mp3',
        startedAt: new Date().toISOString(),
        status: 'playing',
      },
    };
  }

  it('exposes identity and initial status, and never restarts after stop', () => {
    const request = jest.fn();
    const { client } = createClient(
      request,
      {},
      { pollIntervalMs: undefined, stalenessMs: undefined },
    );
    expect(client.programId).toBe('radio-1');
    expect(client.knownInstanceId).toBeNull();
    expect(client.getStatus()).toMatchObject({
      connection: 'connecting',
      degraded: false,
      lastEventAt: null,
      lastSnapshotAt: null,
    });
    client.stop();
    client.start();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['conflict', 'mismatch'] as const)(
    'refuses a snapshot when the owning engine reports %s',
    async (verdict) => {
      jest.useFakeTimers();
      const state = idleState('palazzo-a', 'boot-1', 1);
      const { client, callbacks } = createClient(
        jest
          .fn()
          .mockResolvedValue(
            sseResponse([
              frame(snapshotEvent('palazzo-a', 'boot-1', 1, state)),
            ]),
          ),
        {
          validateInstance: jest.fn().mockReturnValue(verdict),
        },
      );
      client.start();
      await settle();
      expect(callbacks.onSnapshot).not.toHaveBeenCalled();
      expect(client.knownInstanceId).toBeNull();
      expect(client.getStatus()).toMatchObject({
        connection: `instance-${verdict}`,
        degraded: true,
      });
      client.stop();
    },
  );

  it('reuses one SSE loop, resumes from the accepted cursor, and detects stale telemetry', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 4);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              frame(snapshotEvent('palazzo-a', 'boot-1', 4, state)),
            ),
          );
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    const request = jest
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValue(sseResponse([]));
    const { client, callbacks } = createClient(
      request,
      {},
      { stalenessMs: 500 },
    );
    client.start();
    client.start();
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(client.knownInstanceId).toBe('palazzo-a');
    expect(client.getStatus().degraded).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe(
      'http://palazzo:3100/v1/programs/radio-1/playback/events',
    );
    expect(request.mock.calls[1][1].headers).toMatchObject({
      'Last-Event-ID': 'boot-1:4',
    });
    expect(client.getStatus().degraded).toBe(true);
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('does not send a cursor for an accepted zero sequence', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 0);
    const request = jest
      .fn()
      .mockResolvedValue(
        sseResponse([frame(snapshotEvent('palazzo-a', 'boot-1', 0, state))]),
      );
    const { client, machineClient } = createClient(request);
    const connect = jest.spyOn(machineClient, 'connectEvents');
    connect.mockResolvedValueOnce(
      new Response(frame(snapshotEvent('palazzo-a', 'boot-1', 0, state))),
    );
    client.start();
    await settle();
    await jest.advanceTimersByTimeAsync(1000);
    expect(connect.mock.calls[1][2]).toBeNull();
    client.stop();
  });

  it('recovers SSE after failed connections and cancels polling after successful reconnect', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 1);
    const request = jest.fn((url: string) =>
      Promise.resolve(
        url.includes('/state') ? Response.json(state) : sseResponse([]),
      ),
    );
    const { client, machineClient, callbacks } = createClient(
      request,
      {},
      { pollIntervalMs: 100 },
    );
    const connect = jest
      .spyOn(machineClient, 'connectEvents')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(''));
    client.start();
    await settle();
    expect(client.getStatus().connection).toBe('polling');
    await jest.advanceTimersByTimeAsync(1000);
    expect(client.getStatus().connection).toBe('connected');
    const accepted = (callbacks.onSnapshot as jest.Mock).mock.calls.length;
    await jest.advanceTimersByTimeAsync(100);
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(accepted);
    expect(connect).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it.each([
    'data: {invalid}\n\n',
    'data: {}\n\n',
    'data: {"schemaVersion":1}\n\n',
  ])(
    'rejects malformed SSE and reconciles from the private state route: %s',
    async (badFrame) => {
      jest.useFakeTimers();
      const state = idleState('palazzo-a', 'boot-1', 2);
      const request = jest.fn((url: string) =>
        Promise.resolve(
          url.includes('/events')
            ? sseResponse([badFrame])
            : Response.json(state),
        ),
      );
      const { client, callbacks, metrics } = createClient(request);
      client.start();
      await settle();
      expect(metrics.snapshot().eventsIgnored.malformed).toBe(1);
      expect(callbacks.onEvent).not.toHaveBeenCalled();
      expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', state);
      expect(client.getStatus().connection).toBe('polling');
      client.stop();
    },
  );

  it('does not accept a malformed snapshot when private-state hydration also fails', async () => {
    jest.useFakeTimers();
    const malformed = snapshotEvent(
      'palazzo-a',
      'boot-1',
      1,
      {} as PalazzoPlaybackState,
    );
    const request = jest.fn((url: string) =>
      url.includes('/events')
        ? Promise.resolve(sseResponse([frame(malformed)]))
        : Promise.reject(new Error('offline')),
    );
    const { client, callbacks, metrics } = createClient(request);
    client.start();
    await settle();
    expect(metrics.snapshot().eventsIgnored.malformed).toBe(1);
    expect(callbacks.onSnapshot).not.toHaveBeenCalled();
    expect(client.getStatus().connection).toBe('unavailable');
    client.stop();
  });

  it('ignores comments, empty frames, unknown fields and frames without data while accepting multiline JSON', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 1);
    const event = snapshotEvent('palazzo-a', 'boot-1', 1, state);
    const multiline = JSON.stringify(event, null, 2)
      .split('\n')
      .map((line) => `data:${line}`)
      .join('\n');
    const request = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          ': keepalive\nretry:1000\nignored\n\n',
          `id\nevent:snapshot\n${multiline}\n\n`,
        ]),
      );
    const { client, callbacks } = createClient(request);
    client.start();
    await settle();
    expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', state);
    client.stop();
  });

  it('ignores lifecycle telemetry until a snapshot establishes the matching identity', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 1);
    const request = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(
            lifecycleEvent('palazzo-a', 'boot-1', 1, 'track.started', 'req-1'),
          ),
          frame(snapshotEvent('palazzo-a', 'boot-1', 1, state)),
          frame(
            lifecycleEvent('palazzo-b', 'boot-1', 2, 'track.ended', 'req-1'),
          ),
        ]),
      );
    const { client, callbacks, metrics } = createClient(request);
    client.start();
    await settle();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(metrics.snapshot().eventsIgnored['superseded-boot']).toBe(2);
    client.stop();
  });

  it('refuses snapshots carrying an intro owned by another program', async () => {
    jest.useFakeTimers();
    const state = introState('other-program');
    const { client, callbacks, metrics } = createClient(
      jest
        .fn()
        .mockResolvedValue(
          sseResponse([frame(snapshotEvent('palazzo-a', 'boot-1', 3, state))]),
        ),
    );
    client.start();
    await settle();
    expect(callbacks.onSnapshot).not.toHaveBeenCalled();
    expect(metrics.snapshot().eventsIgnored['cross-program']).toBe(1);
    client.stop();
  });

  it.each(['cross-program', 'mismatch'])(
    'refuses a gap reconciliation with %s state',
    async (reason) => {
      jest.useFakeTimers();
      const first = idleState('palazzo-a', 'boot-1', 1);
      const next =
        reason === 'cross-program'
          ? introState('other-program')
          : idleState('palazzo-b', 'boot-1', 3);
      const request = jest.fn((url: string) =>
        Promise.resolve(
          url.includes('/events')
            ? sseResponse([
                frame(snapshotEvent('palazzo-a', 'boot-1', 1, first)),
                frame(
                  lifecycleEvent(
                    'palazzo-a',
                    'boot-1',
                    3,
                    'track.ended',
                    'req-1',
                  ),
                ),
              ])
            : Response.json(next),
        ),
      );
      const { client, callbacks, metrics } = createClient(request);
      client.start();
      await settle();
      expect(callbacks.onEvent).not.toHaveBeenCalled();
      expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
      if (reason === 'mismatch')
        expect(client.getStatus().connection).toBe('instance-mismatch');
      else expect(client.getStatus().connection).toBe('unavailable');
      client.stop();
    },
  );

  it('forwards all playback lifecycle and level events while advancing over non-lifecycle gaps', async () => {
    jest.useFakeTimers();
    const state = introState('radio-1');
    state.sequence = 1;
    const kinds = [
      'intro.started',
      'intro.ended',
      'intro.failed',
      'playback.position',
      'audio.levels',
      'heartbeat',
    ] as const;
    const events = kinds.map(
      (type, index): PalazzoPlaybackEvent => ({
        ...lifecycleEvent(
          'palazzo-a',
          'boot-1',
          index + 3,
          'track.started',
          'req-1',
        ),
        type,
        data: {
          programId: 'radio-1',
          playbackId: 'intro-1',
          parentPlaybackId: 'song-1',
          positionSeconds: 10,
        },
      }),
    );
    // A missing heartbeat before a position update is safe: no track transition is inferred.
    events[0] = { ...events[0], sequence: 2 };
    events[1] = { ...events[1], sequence: 3 };
    events[2] = { ...events[2], sequence: 4 };
    events[3] = { ...events[3], sequence: 6 };
    const request = jest
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame(snapshotEvent('palazzo-a', 'boot-1', 1, state)),
          ...events.map(frame),
        ]),
      );
    const { client, callbacks, metrics } = createClient(request);
    client.start();
    await settle();
    expect(callbacks.onEvent).toHaveBeenCalledTimes(5);
    for (const event of events.slice(0, 5))
      expect(callbacks.onEvent).toHaveBeenCalledWith('radio-1', event);
    expect(metrics.snapshot().eventsIgnored['sequence-gap']).toBe(1);
    client.stop();
  });

  it('cancels the stream immediately when the snapshot consumer stops the client', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 1);
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame(snapshotEvent('palazzo-a', 'boot-1', 1, state)),
          ),
        );
      },
      cancel,
    });
    const request = jest
      .fn()
      .mockResolvedValue(
        new Response(body, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    const { client, callbacks } = createClient(request, {
      onSnapshot: () => client.stop(),
    });
    client.start();
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvent).not.toHaveBeenCalled();
  });

  it('waits for a pending state read instead of overlapping interval polls', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 1);
    let finishState!: (response: Response) => void;
    const request = jest.fn((url: string) =>
      url.includes('/events')
        ? Promise.reject(new Error('offline'))
        : new Promise<Response>((resolve) => {
            finishState = resolve;
          }),
    );
    const { client, callbacks } = createClient(
      request,
      {},
      { pollIntervalMs: 100 },
    );
    client.start();
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    expect(
      request.mock.calls.filter(([url]) => url.includes('/state')),
    ).toHaveLength(1);
    finishState(Response.json(state));
    await settle();
    expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', state);
    expect(client.getStatus().connection).toBe('polling');
    client.stop();
  });

  it('contains state-consumer failures and reports the unavailable radio leg', async () => {
    jest.useFakeTimers();
    const state = idleState('palazzo-a', 'boot-1', 1);
    const request = jest.fn((url: string) =>
      url.includes('/events')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(Response.json(state)),
    );
    const { client, callbacks } = createClient(request, {
      onSnapshot: jest.fn(() => {
        throw new Error('engine rejected state');
      }),
    });
    client.start();
    await settle();
    expect(callbacks.onSnapshot).toHaveBeenCalledWith('radio-1', state);
    expect(client.getStatus()).toMatchObject({
      connection: 'unavailable',
      degraded: true,
    });
    client.stop();
  });

  it('stops reconnecting when shutdown occurs before the pending SSE request finishes', async () => {
    jest.useFakeTimers();
    let complete!: (response: Response) => void;
    const request = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const { client } = createClient(request);
    client.start();
    client.stop();
    complete(
      new Response('', { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    await settle();
    await jest.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
