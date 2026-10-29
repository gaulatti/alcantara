import { PalazzoProgramClient } from './palazzo-program.client';
import type {
  PalazzoPlaybackEvent,
  PalazzoPlaybackEventType,
  PalazzoPlaybackState,
} from './palazzo-contract';

const PROGRAM = 'radio-1';
const URL = 'http://palazzo:3100';
const NOW = Date.parse('2026-10-02T10:00:00.000Z');

function state(
  overrides: Partial<PalazzoPlaybackState> = {},
): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: 'inst-a',
    bootId: 'boot-a',
    sequence: 5,
    availability: 'available',
    status: 'idle',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: null,
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

function event(
  type: PalazzoPlaybackEventType,
  sequence: number,
  overrides: Partial<PalazzoPlaybackEvent> = {},
): PalazzoPlaybackEvent {
  return {
    schemaVersion: 1,
    id: `boot-a:${sequence}`,
    instanceId: 'inst-a',
    bootId: 'boot-a',
    sequence,
    type,
    occurredAt: new Date(NOW).toISOString(),
    data: {},
    ...overrides,
  };
}

function build(options: Record<string, unknown> = {}) {
  const metrics = {
    recordReconnectAttempt: jest.fn(),
    recordReconnectFailure: jest.fn(),
    recordEventIgnored: jest.fn(),
    recordSnapshotReconciliation: jest.fn(),
    recordConnectionState: jest.fn(),
  };
  const callbacks = {
    onSnapshot: jest.fn(),
    onEvent: jest.fn(),
    onStatus: jest.fn(),
    validateInstance: jest.fn().mockReturnValue('ok'),
  };
  const machineClient = {
    connectEvents: jest.fn(),
    getPlaybackState: jest.fn(),
  };
  const client = new PalazzoProgramClient({
    programId: PROGRAM,
    programType: 'radio',
    palazzoUrl: URL,
    metrics: metrics as any,
    callbacks,
    machineClient: machineClient as any,
    ...options,
  });
  return { client, metrics, callbacks, machineClient };
}

/** Cursor as if a snapshot for boot-a/inst-a at sequence 5 was accepted. */
function primed(options: Record<string, unknown> = {}) {
  const ctx = build(options);
  const c = ctx.client as any;
  c.instanceId = 'inst-a';
  c.currentBootId = 'boot-a';
  c.lastSequence = 5;
  return ctx;
}

const sse = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

describe('PalazzoProgramClient coverage', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('construction and status', () => {
    it('applies defaults and exposes identity getters', () => {
      const { client } = build();
      expect(client.programId).toBe(PROGRAM);
      expect(client.knownInstanceId).toBeNull();
      expect(client['pollIntervalMs']).toBe(2000);
      expect(client['stalenessMs']).toBe(15000);
      expect(client.getStatus()).toEqual({
        programId: PROGRAM,
        programType: 'radio',
        palazzoUrl: URL,
        instanceId: null,
        connection: 'connecting',
        lastEventAt: null,
        lastSnapshotAt: null,
        degraded: false,
        detail: null,
      });
    });

    it('honours explicit poll and staleness settings and reports timestamps', () => {
      const { client } = build({ pollIntervalMs: 50, stalenessMs: 60 });
      expect(client['pollIntervalMs']).toBe(50);
      expect(client['stalenessMs']).toBe(60);
      client['lastEventAt'] = NOW;
      client['lastSnapshotAt'] = NOW - 1000;
      expect(client.getStatus()).toMatchObject({
        lastEventAt: new Date(NOW).toISOString(),
        lastSnapshotAt: new Date(NOW - 1000).toISOString(),
      });
    });
  });

  describe('start / stop', () => {
    it('does nothing when started after being stopped', () => {
      const { client } = build();
      const loop = jest.spyOn(client as any, 'runSseLoop');
      client.stop();
      client.start();
      expect(loop).not.toHaveBeenCalled();
    });

    it('starts the sse loop', () => {
      const { client } = build();
      const loop = jest
        .spyOn(client as any, 'runSseLoop')
        .mockResolvedValue(undefined);
      client.start();
      expect(loop).toHaveBeenCalledTimes(1);
    });

    it('stop clears timers and aborts the active connection', () => {
      const { client } = build();
      const abort = new AbortController();
      client['abort'] = abort;
      client['reconnectTimer'] = setTimeout(() => undefined, 1000);
      client['pollTimer'] = setInterval(() => undefined, 1000);
      client.stop();
      expect(abort.signal.aborted).toBe(true);
      expect(client['abort']).toBeNull();
      expect(client['reconnectTimer']).toBeNull();
      expect(client['pollTimer']).toBeNull();
      expect(client['stopped']).toBe(true);
    });
  });

  describe('runSseLoop', () => {
    it('is re-entrancy safe', async () => {
      const { client, metrics } = build();
      client['sseLoopRunning'] = true;
      await client['runSseLoop']();
      expect(metrics.recordReconnectAttempt).not.toHaveBeenCalled();
    });

    it('marks connected after a successful stream, resets backoff and clears polling', async () => {
      const { client, metrics } = build();
      client['reconnectDelayMs'] = 8000;
      client['pollTimer'] = setInterval(() => undefined, 1000);
      jest.spyOn(client as any, 'connectOnce').mockResolvedValue(true);
      jest
        .spyOn(client as any, 'waitForReconnect')
        .mockImplementation(async () => {
          client['stopped'] = true;
        });
      await client['runSseLoop']();
      expect(metrics.recordReconnectAttempt).toHaveBeenCalledTimes(1);
      expect(client['pollTimer']).toBeNull();
      expect(client['reconnectDelayMs']).toBe(1000);
      expect(client.getStatus().connection).toBe('connected');
      expect(client['sseLoopRunning']).toBe(false);
    });

    it('exits when stopped while connecting', async () => {
      const { client, metrics } = build();
      jest.spyOn(client as any, 'connectOnce').mockImplementation(async () => {
        client['stopped'] = true;
        return true;
      });
      await client['runSseLoop']();
      expect(client.getStatus().connection).toBe('connecting');
      expect(metrics.recordReconnectFailure).not.toHaveBeenCalled();
    });

    it('records a failure, shows connecting and starts polling on connect failure', async () => {
      const { client, metrics } = build();
      jest.spyOn(client as any, 'connectOnce').mockResolvedValue(false);
      const polling = jest
        .spyOn(client as any, 'startPolling')
        .mockImplementation(() => undefined);
      jest
        .spyOn(client as any, 'waitForReconnect')
        .mockImplementation(async () => {
          client['stopped'] = true;
        });
      await client['runSseLoop']();
      expect(metrics.recordReconnectFailure).toHaveBeenCalledTimes(1);
      expect(client.getStatus()).toMatchObject({
        connection: 'connecting',
        detail: 'sse connect failed',
      });
      expect(polling).toHaveBeenCalled();
    });

    it('keeps an unavailable connection state when sse keeps failing', async () => {
      const { client } = build();
      client['connection'] = 'unavailable';
      jest.spyOn(client as any, 'connectOnce').mockResolvedValue(false);
      jest
        .spyOn(client as any, 'startPolling')
        .mockImplementation(() => undefined);
      jest
        .spyOn(client as any, 'waitForReconnect')
        .mockImplementation(async () => {
          client['stopped'] = true;
        });
      await client['runSseLoop']();
      expect(client.getStatus().connection).toBe('unavailable');
    });

    it('exits after handling a result when stopped by the polling start', async () => {
      const { client } = build();
      jest.spyOn(client as any, 'connectOnce').mockResolvedValue(false);
      jest.spyOn(client as any, 'startPolling').mockImplementation(() => {
        client['stopped'] = true;
      });
      const wait = jest.spyOn(client as any, 'waitForReconnect');
      await client['runSseLoop']();
      expect(wait).not.toHaveBeenCalled();
    });
  });

  describe('connectOnce', () => {
    it('returns false when connecting throws and resumes from the last accepted event', async () => {
      const { client, machineClient } = primed();
      machineClient.connectEvents.mockRejectedValue(new Error('refused'));
      await expect(client['connectOnce']()).resolves.toBe(false);
      expect(machineClient.connectEvents).toHaveBeenCalledWith(
        URL,
        PROGRAM,
        'boot-a:5',
        client['abort']!.signal,
      );
    });

    it('returns false and cancels the body for a non-ok response', async () => {
      const { client, machineClient } = build();
      const cancel = jest.fn().mockResolvedValue(undefined);
      machineClient.connectEvents.mockResolvedValue({
        ok: false,
        body: { cancel },
      });
      await expect(client['connectOnce']()).resolves.toBe(false);
      expect(cancel).toHaveBeenCalled();
    });

    it('tolerates a throwing cancel and a missing body', async () => {
      const { client, machineClient } = build();
      machineClient.connectEvents.mockResolvedValueOnce({
        ok: true,
        body: { cancel: jest.fn().mockRejectedValue(new Error('x')) },
      });
      jest.spyOn(client as any, 'consumeStream').mockResolvedValue(undefined);
      await expect(client['connectOnce']()).resolves.toBe(true);
      machineClient.connectEvents.mockResolvedValueOnce({
        ok: false,
        body: { cancel: jest.fn().mockRejectedValue(new Error('x')) },
      });
      await expect(client['connectOnce']()).resolves.toBe(false);
      machineClient.connectEvents.mockResolvedValueOnce({
        ok: true,
        body: null,
      });
      await expect(client['connectOnce']()).resolves.toBe(false);
    });

    it('returns false when consuming the stream fails', async () => {
      const { client, machineClient } = build();
      const cancel = jest.fn().mockResolvedValue(undefined);
      machineClient.connectEvents.mockResolvedValue({
        ok: true,
        body: { cancel },
      });
      jest
        .spyOn(client as any, 'consumeStream')
        .mockRejectedValue(new Error('broken'));
      await expect(client['connectOnce']()).resolves.toBe(false);
      expect(cancel).toHaveBeenCalled();
    });
  });

  describe('consumeStream / handleFrame', () => {
    it('handles frames split across chunks, CRLF separators and multiple frames', async () => {
      const { client } = build();
      const handled: string[] = [];
      jest.spyOn(client as any, 'handleFrame').mockImplementation(async (f) => {
        handled.push(f as string);
      });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: one\r\n\r\ndata: tw'));
          controller.enqueue(encoder.encode('o\n\ndata: partial'));
          controller.close();
        },
      });
      await client['consumeStream'](body);
      expect(handled).toEqual(['data: one', 'data: two']);
    });

    it('cancels the reader when stopped while handling a frame', async () => {
      const { client } = build();
      jest.spyOn(client as any, 'handleFrame').mockImplementation(async () => {
        client['stopped'] = true;
      });
      const cancelSpy = jest.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: a\n\ndata: b\n\n'),
          );
        },
        cancel: cancelSpy,
      });
      await client['consumeStream'](body);
      expect(cancelSpy).toHaveBeenCalled();
      expect(client['handleFrame']).toHaveBeenCalledTimes(1);
    });

    it('ignores frames without data', async () => {
      const { client, metrics } = build();
      await client['handleFrame'](': keep-alive');
      expect(metrics.recordEventIgnored).not.toHaveBeenCalled();
    });

    it('rejects invalid JSON', async () => {
      const { client, metrics } = build();
      await expect(client['handleFrame']('data: {nope')).rejects.toThrow(
        'malformed Palazzo event',
      );
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('malformed');
    });

    it('rejects JSON that is not a valid event', async () => {
      const { client, metrics } = build();
      await expect(client['handleFrame']('data: {"a":1}')).rejects.toThrow(
        'malformed Palazzo event',
      );
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('malformed');
    });

    it('uses the sse id over the payload id and accepts the event', async () => {
      const { client } = build();
      const accept = jest
        .spyOn(client as any, 'acceptEvent')
        .mockResolvedValue(undefined);
      const payload = JSON.stringify(event('heartbeat', 1));
      await client['handleFrame'](`id: from-frame\ndata: ${payload}`);
      expect(accept.mock.calls[0][0]).toMatchObject({ id: 'from-frame' });
      await client['handleFrame'](`data: ${payload}`);
      expect(accept.mock.calls[1][0]).toMatchObject({ id: 'boot-a:1' });
    });

    it('end to end: a stream with a snapshot connects the program', async () => {
      const { client, callbacks, machineClient } = build();
      const snapshot = event('snapshot', 5, { data: { state: state() } });
      machineClient.connectEvents.mockResolvedValue(
        new Response(sse(`data: ${JSON.stringify(snapshot)}\n\n`)),
      );
      await expect(client['connectOnce']()).resolves.toBe(true);
      expect(callbacks.onSnapshot).toHaveBeenCalledWith(PROGRAM, state());
      expect(client.getStatus().connection).toBe('connected');
    });
  });

  describe('acceptEvent: snapshots', () => {
    it('ignores events addressed to another program', async () => {
      const { client, metrics, callbacks } = primed();
      await client['acceptEvent'](
        event('track.started', 6, { data: { programId: 'other' } }),
      );
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('cross-program');
      expect(callbacks.onEvent).not.toHaveBeenCalled();
    });

    it('accepts events whose data carries this program id or a non-string one', async () => {
      const { client, callbacks } = primed();
      await client['acceptEvent'](
        event('track.started', 6, { data: { programId: PROGRAM } }),
      );
      await client['acceptEvent'](
        event('track.ended', 7, { data: { programId: 5 } }),
      );
      await client['acceptEvent'](
        event('playback.position', 8, { data: undefined as any }),
      );
      expect(callbacks.onEvent).toHaveBeenCalledTimes(3);
    });

    it('accepts a snapshot with an embedded valid state', async () => {
      const { client, callbacks, metrics } = build();
      const s = state({ bootId: 'boot-z', sequence: 9 });
      await client['acceptEvent'](event('snapshot', 9, { data: { state: s } }));
      expect(callbacks.validateInstance).toHaveBeenCalledWith(
        PROGRAM,
        'inst-a',
      );
      expect(client['currentBootId']).toBe('boot-z');
      expect(client['lastSequence']).toBe(9);
      expect(client['lastSnapshotAt']).toBe(NOW);
      expect(client['lastEventAt']).toBe(NOW);
      expect(client.knownInstanceId).toBe('inst-a');
      expect(metrics.recordSnapshotReconciliation).toHaveBeenCalledWith(
        'accepted',
      );
      expect(callbacks.onSnapshot).toHaveBeenCalledWith(PROGRAM, s);
    });

    it('hydrates a redacted snapshot from the state endpoint', async () => {
      const { client, callbacks, machineClient } = build();
      const s = state();
      machineClient.getPlaybackState.mockResolvedValue(s);
      await client['acceptEvent'](
        event('snapshot', 5, { data: { state: {} } }),
      );
      expect(machineClient.getPlaybackState).toHaveBeenCalledWith(
        URL,
        PROGRAM,
        undefined,
      );
      expect(callbacks.onSnapshot).toHaveBeenCalledWith(PROGRAM, s);
    });

    it('rejects a snapshot that cannot be hydrated', async () => {
      const { client, metrics, machineClient } = build();
      machineClient.getPlaybackState.mockRejectedValue(new Error('down'));
      await expect(
        client['acceptEvent'](event('snapshot', 5, { data: undefined as any })),
      ).rejects.toThrow('malformed Palazzo snapshot');
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('malformed');
    });

    it('ignores a snapshot whose intro belongs to another program', async () => {
      const { client, metrics, callbacks } = build();
      const s = state({
        intro: {
          playbackId: 'i',
          parentPlaybackId: 'p',
          programId: 'other',
          playbackRequestId: 'p',
          url: 'u',
          startedAt: new Date(NOW).toISOString(),
          status: 'playing',
        },
      });
      await client['acceptEvent'](event('snapshot', 5, { data: { state: s } }));
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('cross-program');
      expect(callbacks.onSnapshot).not.toHaveBeenCalled();
    });

    it('accepts a snapshot whose intro belongs to this program', async () => {
      const { client, callbacks } = build();
      const s = state({
        intro: {
          playbackId: 'i',
          parentPlaybackId: 'p',
          programId: PROGRAM,
          playbackRequestId: 'p',
          url: 'u',
          startedAt: new Date(NOW).toISOString(),
          status: 'playing',
        },
      });
      await client['acceptEvent'](event('snapshot', 5, { data: { state: s } }));
      expect(callbacks.onSnapshot).toHaveBeenCalledWith(PROGRAM, s);
    });

    it('stops without forwarding when instance validation fails', async () => {
      const { client, callbacks } = build();
      callbacks.validateInstance.mockReturnValue('conflict');
      await client['acceptEvent'](
        event('snapshot', 5, { data: { state: state() } }),
      );
      expect(callbacks.onSnapshot).not.toHaveBeenCalled();
      expect(client.getStatus().connection).toBe('instance-conflict');
    });
  });

  describe('acceptEvent: lifecycle correlation', () => {
    it('ignores events from a different palazzo instance', async () => {
      const { client, metrics } = primed();
      await client['acceptEvent'](
        event('track.started', 6, { instanceId: 'inst-b' }),
      );
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith(
        'superseded-boot',
      );
    });

    it('accepts events with no instance id or when no instance is known', async () => {
      const a = primed();
      await a.client['acceptEvent'](
        event('track.started', 6, { instanceId: '' }),
      );
      expect(a.callbacks.onEvent).toHaveBeenCalledTimes(1);
      const b = primed();
      b.client['instanceId'] = null;
      await b.client['acceptEvent'](event('track.started', 6));
      expect(b.callbacks.onEvent).toHaveBeenCalledTimes(1);
    });

    it('ignores lifecycle events before any snapshot was accepted', async () => {
      const { client, metrics, callbacks } = build();
      await client['acceptEvent'](event('track.started', 1));
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith(
        'superseded-boot',
      );
      expect(callbacks.onEvent).not.toHaveBeenCalled();
    });

    it('ignores events from a superseded boot', async () => {
      const { client, metrics } = primed();
      await client['acceptEvent'](
        event('track.started', 6, { bootId: 'boot-old' }),
      );
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith(
        'superseded-boot',
      );
    });

    it('ignores duplicate and stale sequences', async () => {
      const { client, metrics, callbacks } = primed();
      await client['acceptEvent'](event('track.started', 5));
      await client['acceptEvent'](event('track.started', 4));
      expect(metrics.recordEventIgnored.mock.calls.map((c) => c[0])).toEqual([
        'duplicate',
        'stale-sequence',
      ]);
      expect(callbacks.onEvent).not.toHaveBeenCalled();
    });

    it.each([
      'track.started',
      'track.ended',
      'intro.started',
      'intro.ended',
      'intro.failed',
    ] as const)('reconciles a sequence gap on %s', async (type) => {
      const { client, metrics, callbacks, machineClient } = primed();
      const fresh = state({ bootId: 'boot-b', sequence: 20 });
      machineClient.getPlaybackState.mockResolvedValue(fresh);
      await client['acceptEvent'](event(type, 9));
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('sequence-gap');
      expect(callbacks.onSnapshot).toHaveBeenCalledWith(PROGRAM, fresh);
      expect(callbacks.onEvent).not.toHaveBeenCalled();
      expect(client['currentBootId']).toBe('boot-b');
      expect(client['lastSequence']).toBe(20);
    });

    it('applies a gapped non-lifecycle event directly', async () => {
      const { client, metrics, callbacks, machineClient } = primed();
      await client['acceptEvent'](event('audio.levels', 9));
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('sequence-gap');
      expect(machineClient.getPlaybackState).not.toHaveBeenCalled();
      expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
      expect(client['lastSequence']).toBe(9);
    });

    it.each([
      'track.started',
      'track.ended',
      'intro.started',
      'intro.ended',
      'intro.failed',
      'playback.position',
      'audio.levels',
    ] as const)('forwards %s to the engine', async (type) => {
      const { client, callbacks } = primed();
      await client['acceptEvent'](event(type, 6));
      expect(callbacks.onEvent).toHaveBeenCalledWith(
        PROGRAM,
        expect.objectContaining({ type, sequence: 6 }),
      );
      expect(client['lastSequence']).toBe(6);
    });

    it.each(['heartbeat', 'playout.started', 'telemetry.connected'] as const)(
      'advances but does not forward %s',
      async (type) => {
        const { client, callbacks } = primed();
        await client['acceptEvent'](event(type, 6));
        expect(callbacks.onEvent).not.toHaveBeenCalled();
        expect(client['lastSequence']).toBe(6);
        expect(client['lastEventAt']).toBe(NOW);
      },
    );
  });

  describe('reconcileGap', () => {
    it('uses the active abort signal and stops on instance conflicts', async () => {
      const { client, machineClient, callbacks } = primed();
      const abort = new AbortController();
      client['abort'] = abort;
      client['instanceId'] = null;
      callbacks.validateInstance.mockReturnValue('mismatch');
      machineClient.getPlaybackState.mockResolvedValue(state());
      await client['reconcileGap']();
      expect(machineClient.getPlaybackState).toHaveBeenCalledWith(
        URL,
        PROGRAM,
        abort.signal,
      );
      expect(callbacks.onSnapshot).not.toHaveBeenCalled();
      expect(client.getStatus().connection).toBe('instance-mismatch');
    });

    it('rejects state with an intro from another program', async () => {
      const { client, machineClient, metrics } = primed();
      machineClient.getPlaybackState.mockResolvedValue(
        state({
          intro: {
            playbackId: 'i',
            parentPlaybackId: 'p',
            programId: 'other',
            playbackRequestId: 'p',
            url: 'u',
            startedAt: new Date(NOW).toISOString(),
            status: 'playing',
          },
        }),
      );
      await expect(client['reconcileGap']()).rejects.toThrow(
        'cross-program Palazzo state',
      );
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('cross-program');
    });

    it('accepts state with an intro for this program', async () => {
      const { client, machineClient, callbacks } = primed();
      const s = state({
        intro: {
          playbackId: 'i',
          parentPlaybackId: 'p',
          programId: PROGRAM,
          playbackRequestId: 'p',
          url: 'u',
          startedAt: new Date(NOW).toISOString(),
          status: 'playing',
        },
      });
      machineClient.getPlaybackState.mockResolvedValue(s);
      await client['reconcileGap']();
      expect(callbacks.onSnapshot).toHaveBeenCalledWith(PROGRAM, s);
    });
  });

  describe('validateInstanceId', () => {
    it('records conflicts, mismatches and acceptance for a new instance', () => {
      const conflict = build();
      conflict.callbacks.validateInstance.mockReturnValue('conflict');
      expect(conflict.client['validateInstanceId']('inst-x')).toBe(false);
      expect(
        conflict.metrics.recordSnapshotReconciliation,
      ).toHaveBeenCalledWith('instance-conflict');
      expect(conflict.client.getStatus()).toMatchObject({
        connection: 'instance-conflict',
        detail: 'another program already owns Palazzo instance inst-x',
      });

      const mismatch = build();
      mismatch.callbacks.validateInstance.mockReturnValue('mismatch');
      expect(mismatch.client['validateInstanceId']('inst-x')).toBe(false);
      expect(mismatch.client.getStatus()).toMatchObject({
        connection: 'instance-mismatch',
        detail: 'Palazzo identity changed to inst-x',
      });

      const ok = build();
      expect(ok.client['validateInstanceId']('inst-x')).toBe(true);
      expect(ok.client.knownInstanceId).toBe('inst-x');
    });

    it('rejects a changed identity and accepts a repeated one', () => {
      const { client, metrics } = primed();
      expect(client['validateInstanceId']('inst-a')).toBe(true);
      expect(client['validateInstanceId']('inst-b')).toBe(false);
      expect(client.getStatus()).toMatchObject({
        connection: 'instance-mismatch',
        detail: 'Palazzo identity changed from inst-a to inst-b',
      });
      expect(
        metrics.recordSnapshotReconciliation.mock.calls.map((c) => c[0]),
      ).toEqual(['accepted', 'instance-mismatch']);
    });
  });

  describe('touch', () => {
    it('uses the event time, or now when it is not a date', () => {
      const { client } = build();
      client['touch'](
        event('heartbeat', 1, { occurredAt: '2026-01-01T00:00:00.000Z' }),
      );
      expect(client['lastEventAt']).toBe(
        Date.parse('2026-01-01T00:00:00.000Z'),
      );
      client['touch'](event('heartbeat', 1, { occurredAt: 'garbage' }));
      expect(client['lastEventAt']).toBe(NOW);
    });
  });

  describe('polling', () => {
    it('does not start twice or after stop', () => {
      const { client } = build();
      const poll = jest
        .spyOn(client as any, 'pollOnce')
        .mockResolvedValue(undefined);
      client['startPolling']();
      client['startPolling']();
      expect(poll).toHaveBeenCalledTimes(1);
      client.stop();
      client['pollTimer'] = null;
      client['startPolling']();
      expect(poll).toHaveBeenCalledTimes(1);
    });

    it('polls on the configured interval', () => {
      const { client } = build({ pollIntervalMs: 100 });
      const poll = jest
        .spyOn(client as any, 'pollOnce')
        .mockResolvedValue(undefined);
      client['startPolling']();
      jest.advanceTimersByTime(250);
      expect(poll).toHaveBeenCalledTimes(3);
      client['clearPollTimer']();
      client['clearPollTimer']();
      jest.advanceTimersByTime(500);
      expect(poll).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['stopped', (c: any) => (c.stopped = true)],
      ['in flight', (c: any) => (c.pollInFlight = true)],
      ['connected', (c: any) => (c.connection = 'connected')],
    ])('skips polling when %s', async (_n, arrange) => {
      const { client, machineClient } = build();
      arrange(client);
      await client['pollOnce']();
      expect(machineClient.getPlaybackState).not.toHaveBeenCalled();
    });

    it('moves to polling and forwards state when sse is down', async () => {
      const { client, machineClient, callbacks } = build();
      const s = state({ bootId: 'boot-p', sequence: 3 });
      machineClient.getPlaybackState.mockResolvedValue(s);
      await client['pollOnce']();
      expect(client.getStatus()).toMatchObject({
        connection: 'polling',
        detail: 'sse unavailable; polling state endpoint',
        lastSnapshotAt: new Date(NOW).toISOString(),
        lastEventAt: new Date(NOW).toISOString(),
      });
      expect(callbacks.onSnapshot).toHaveBeenCalledWith(PROGRAM, s);
      expect(client['currentBootId']).toBe('boot-p');
      expect(client['pollInFlight']).toBe(false);
    });

    it('stays in polling on later polls without a status change', async () => {
      const { client, machineClient, callbacks } = build();
      machineClient.getPlaybackState.mockResolvedValue(state());
      await client['pollOnce']();
      callbacks.onStatus.mockClear();
      await client['pollOnce']();
      expect(callbacks.onStatus).not.toHaveBeenCalled();
      expect(callbacks.onSnapshot).toHaveBeenCalledTimes(2);
    });

    it('marks the program unavailable when the state endpoint is unreachable', async () => {
      const { client, machineClient } = build();
      machineClient.getPlaybackState.mockRejectedValue(new Error('down'));
      await client['pollOnce']();
      expect(client.getStatus()).toMatchObject({
        connection: 'unavailable',
        detail: 'sse and state endpoint unreachable',
        degraded: true,
      });
    });

    it('does not override an identity failure when the endpoint is unreachable', async () => {
      const { client, machineClient } = build();
      client['connection'] = 'instance-mismatch';
      machineClient.getPlaybackState.mockRejectedValue(new Error('down'));
      await client['pollOnce']();
      expect(client.getStatus().connection).toBe('instance-mismatch');
    });

    it('does not forward state whose instance fails validation', async () => {
      const { client, machineClient, callbacks } = build();
      callbacks.validateInstance.mockReturnValue('conflict');
      machineClient.getPlaybackState.mockResolvedValue(state());
      await client['pollOnce']();
      expect(callbacks.onSnapshot).not.toHaveBeenCalled();
      expect(client.getStatus().connection).toBe('instance-conflict');
    });

    it('recovers from callback failures and marks unavailable', async () => {
      const { client, machineClient, callbacks } = build();
      machineClient.getPlaybackState.mockResolvedValue(state());
      callbacks.onSnapshot.mockImplementation(() => {
        throw new Error('engine failure');
      });
      await client['pollOnce']();
      expect(client['pollInFlight']).toBe(false);
      client['connection'] = 'instance-conflict';
      callbacks.onSnapshot.mockImplementation(() => {
        throw new Error('engine failure');
      });
      client['instanceId'] = 'inst-a';
      await client['pollOnce']();
      expect(client.getStatus().connection).toBe('instance-conflict');
    });
  });

  describe('connection predicates', () => {
    it.each([
      ['connecting', true, true],
      ['connected', true, false],
      ['polling', true, false],
      ['unavailable', true, true],
      ['instance-mismatch', false, false],
      ['instance-conflict', false, false],
    ] as const)(
      '%s -> terminal=%s transient=%s',
      (connection, terminal, transient) => {
        const { client } = build();
        client['connection'] = connection;
        expect(client['isTerminalConnection']()).toBe(terminal);
        expect(client['isTransientConnection']()).toBe(transient);
      },
    );
  });

  describe('fetchState / lastAcceptedEventId', () => {
    it('returns null on failure and the state on success', async () => {
      const { client, machineClient } = build();
      machineClient.getPlaybackState.mockRejectedValueOnce(new Error('x'));
      await expect(client['fetchState']()).resolves.toBeNull();
      machineClient.getPlaybackState.mockResolvedValueOnce(state());
      client['abort'] = new AbortController();
      await expect(client['fetchState']()).resolves.toEqual(state());
      expect(machineClient.getPlaybackState).toHaveBeenLastCalledWith(
        URL,
        PROGRAM,
        client['abort'].signal,
      );
    });

    it('only resumes once a boot and positive sequence are known', () => {
      const { client } = build();
      expect(client['lastAcceptedEventId']()).toBeNull();
      client['currentBootId'] = 'b';
      client['lastSequence'] = 0;
      expect(client['lastAcceptedEventId']()).toBeNull();
      client['lastSequence'] = 3;
      expect(client['lastAcceptedEventId']()).toBe('b:3');
    });
  });

  describe('reconnect backoff', () => {
    it('doubles the delay up to the cap and replaces a pending timer', async () => {
      const { client } = build();
      const delays: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        delays.push(client['reconnectDelayMs']);
        const waiting = client['waitForReconnect']();
        jest.advanceTimersByTime(client['reconnectDelayMs']);
        jest.advanceTimersByTime(60_000);
        await waiting;
      }
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
      const first = client['waitForReconnect']();
      const second = client['waitForReconnect']();
      jest.advanceTimersByTime(60_000);
      await second;
      expect(client['reconnectTimer']).toBeNull();
      void first;
    });

    it('stopInternal clears timers and aborts without marking stopped', () => {
      const { client } = build();
      const abort = new AbortController();
      client['abort'] = abort;
      client['reconnectTimer'] = setTimeout(() => undefined, 1000);
      client['pollTimer'] = setInterval(() => undefined, 1000);
      client['stopInternal']();
      expect(abort.signal.aborted).toBe(true);
      expect(client['stopped']).toBe(false);
      expect(client['reconnectTimer']).toBeNull();
      expect(client['pollTimer']).toBeNull();
      client['abort'] = null;
      expect(() => client['stopInternal']()).not.toThrow();
    });
  });

  describe('degradation', () => {
    it.each(['unavailable', 'instance-mismatch', 'instance-conflict'] as const)(
      '%s is degraded',
      (connection) => {
        const { client } = build();
        client['connection'] = connection;
        expect(client.getStatus().degraded).toBe(true);
      },
    );

    it('connected is degraded only once events go stale', () => {
      const { client } = build({ stalenessMs: 1000 });
      client['connection'] = 'connected';
      expect(client.getStatus().degraded).toBe(false);
      client['lastEventAt'] = NOW - 500;
      expect(client.getStatus().degraded).toBe(false);
      client['lastEventAt'] = NOW - 1001;
      expect(client.getStatus().degraded).toBe(true);
    });

    it('other states are not degraded', () => {
      const { client } = build();
      client['connection'] = 'polling';
      client['lastEventAt'] = NOW - 10 * 60_000;
      expect(client.getStatus().degraded).toBe(false);
    });
  });

  describe('setConnection', () => {
    it('is a no-op when neither state nor detail changed', () => {
      const { client, callbacks } = build();
      client['setConnection']('connecting', null);
      expect(callbacks.onStatus).not.toHaveBeenCalled();
    });

    it('does not release the connecting bucket, and counts the new one', () => {
      const { client, metrics, callbacks } = build();
      client['setConnection']('connected', null);
      expect(metrics.recordConnectionState).toHaveBeenCalledTimes(1);
      expect(metrics.recordConnectionState).toHaveBeenCalledWith(
        'connected',
        1,
      );
      expect(callbacks.onStatus).toHaveBeenCalledWith(
        PROGRAM,
        expect.objectContaining({ connection: 'connected' }),
      );
    });

    it('moves a counted state to the next one', () => {
      const { client, metrics } = build();
      client['setConnection']('connected', null);
      metrics.recordConnectionState.mockClear();
      client['setConnection']('polling', 'x');
      expect(metrics.recordConnectionState.mock.calls).toEqual([
        ['connected', -1],
        ['polling', 1],
      ]);
    });

    it('updates only the detail without touching counters', () => {
      const { client, metrics, callbacks } = build();
      client['setConnection']('connected', null);
      metrics.recordConnectionState.mockClear();
      callbacks.onStatus.mockClear();
      client['setConnection']('connected', 'new detail');
      expect(metrics.recordConnectionState).not.toHaveBeenCalled();
      expect(callbacks.onStatus).toHaveBeenCalledTimes(1);
      expect(client.getStatus().detail).toBe('new detail');
    });
  });

  describe('parseSseFrame (via handleFrame)', () => {
    const run = async (raw: string) => {
      const { client } = build();
      const accept = jest
        .spyOn(client as any, 'acceptEvent')
        .mockResolvedValue(undefined);
      await client['handleFrame'](raw);
      return accept.mock.calls[0]?.[0];
    };
    const body = JSON.stringify(event('heartbeat', 1));

    it('skips comments, blank lines and unknown fields and joins multi-line data', async () => {
      const dataLines = JSON.stringify(event('heartbeat', 1), null, 1)
        .split('\n')
        .map((line) => `data: ${line}`);
      const accepted = await run(
        [': comment', '', 'retry: 3000', 'event: tick', ...dataLines].join(
          '\r\n',
        ),
      );
      expect(accepted).toMatchObject({ type: 'heartbeat', sequence: 1 });
    });

    it('handles a bare data field name and a data line without a colon', async () => {
      const { client, metrics } = build();
      await expect(client['handleFrame']('data')).rejects.toThrow(
        'malformed Palazzo event',
      );
      expect(metrics.recordEventIgnored).toHaveBeenCalledWith('malformed');
    });

    it('parses id, event and unspaced data fields', async () => {
      const accepted = await run(`id:abc\nevent:message\ndata:${body}`);
      expect(accepted).toMatchObject({ id: 'abc', type: 'heartbeat' });
    });
  });
});
