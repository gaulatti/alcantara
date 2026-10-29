import { Logger } from '@nestjs/common';
import {
  SongExecutionEngine,
  type SongEngineEvent,
} from './song-execution.engine';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { RadioMetricsService } from './radio-metrics.service';
import type { PalazzoPlaybackState } from './palazzo-contract';

const SONG_A = {
  id: 'song-a',
  kind: 'preset',
  title: 'Song A',
  artist: 'Artist A',
  coverUrl: 'https://example.test/a.jpg',
  audioUrl: 'https://example.test/a.mp3',
  durationMs: 1000,
  songId: 11,
};
const SONG_B = {
  id: 'song-b',
  kind: 'preset',
  title: 'Song B',
  artist: 'Artist B',
  coverUrl: '',
  audioUrl: 'https://example.test/b.mp3',
  durationMs: 2000,
};

function sequenceOf(items: unknown[], mode = 'autoplay', loop = true) {
  return { mode, loop, intervalMs: 500, items };
}

const AUTO = sequenceOf([SONG_A, SONG_B]);

function idle(sequence = 1): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: 'instance',
    bootId: 'boot',
    sequence,
    availability: 'available',
    status: 'idle',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: new Date().toISOString(),
    },
    track: null,
    intro: null,
    icecast: { connected: true },
    positionSeconds: 0,
    remainingSeconds: null,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
  };
}

function setup(
  persisted: {
    type?: string;
    songSequence?: unknown;
    songQueue?: unknown;
    songRotation?: unknown;
  } | null = {},
) {
  const store: { current: Record<string, unknown> | null } = {
    current: persisted
      ? {
          programId: 'radio-1',
          type: 'radio',
          songSequence: AUTO,
          songQueue: [],
          songRotation: null,
          ...persisted,
        }
      : null,
  };
  const prisma = {
    radioSettings: { findMany: jest.fn().mockResolvedValue([]) },
    songIntro: { findUnique: jest.fn().mockResolvedValue(null) },
    instant: { findUnique: jest.fn().mockResolvedValue(null) },
    programState: {
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(store.current)),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          store.current = { ...(store.current ?? {}), ...data };
          return Promise.resolve(store.current);
        }),
    },
  };
  const radioService = {
    playSong: jest.fn().mockResolvedValue({ ok: true }),
    playInstant: jest.fn().mockResolvedValue(undefined),
    getRadioSettings: jest.fn().mockResolvedValue(null),
  };
  const flightService = {
    isClockedLogRunning: jest.fn().mockReturnValue(false),
    handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
  };
  const publisher = {
    publishPlayback: jest.fn().mockResolvedValue(undefined),
    publishStopped: jest.fn().mockResolvedValue(undefined),
  };
  const metrics = {
    recordTrackTransition: jest.fn(),
    recordIntroTransition: jest.fn(),
    recordSongQueueAction: jest.fn(),
    recordSongQueueDepth: jest.fn(),
    recordHighRotationAction: jest.fn(),
    recordHighRotationFavorites: jest.fn(),
  };
  const engine = new SongExecutionEngine(
    radioService as unknown as RadioService,
    flightService as unknown as FlightService,
    prisma as unknown as PrismaService,
    publisher as unknown as NowPlayingPublisherService,
    metrics as unknown as RadioMetricsService,
  );
  const events: SongEngineEvent[] = [];
  engine.setBroadcastHandler((event) => events.push(event));
  let reconciled = true;
  engine.setPalazzoTelemetry({ isReconciled: () => reconciled });
  engine.registerRadioProgram('radio-1');
  return {
    engine,
    prisma,
    radioService,
    flightService,
    publisher,
    metrics,
    events,
    store,
    setTelemetryReconciled: (value: boolean) => {
      reconciled = value;
    },
  };
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

interface EngineActiveSong {
  playbackRequestId: string;
  queueEntryId: string | null;
  coverUrl: string;
  [key: string]: unknown;
}

interface EngineState {
  sequence: { activeItemId: string | null; items: unknown[] } | null;
  queue: Array<Record<string, unknown>>;
  rotation: { history: Array<Record<string, unknown>> };
  rotationHistoryHealthy: boolean;
  activeSong: EngineActiveSong | null;
  pendingRequestIds: Set<string>;
  endedRequestIds: string[];
  frozen: boolean;
  reconciled: boolean;
  busyWithForeignTrack: boolean;
  transitioning: boolean;
  queueBlocked: boolean;
  songCount: number;
  nextBumperIdx: number;
}

interface EngineInternals {
  states: Map<string, EngineState>;
  claimQueueHead(
    programId: string,
    entryId: string,
    requestId: string,
  ): Promise<boolean>;
  releaseQueueClaim(programId: string, entryId: string): Promise<void>;
  resolveNextPlaylistSong(
    programId: string,
    state: Partial<EngineState>,
  ): unknown;
  setTimer(programId: string, durationMs: number): void;
}

function internals(engine: SongExecutionEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

function stateOf(engine: SongExecutionEngine, programId = 'radio-1') {
  const state = internals(engine).states.get(programId);
  if (!state) throw new Error(`no engine state for ${programId}`);
  return state;
}

function activeRequestId(engine: SongExecutionEngine, programId = 'radio-1') {
  const song = stateOf(engine, programId).activeSong;
  if (!song) throw new Error('no active song');
  return song.playbackRequestId;
}

function playing(
  requestId: string,
  overrides: Partial<PalazzoPlaybackState['track'] & object> = {},
  extra: Partial<PalazzoPlaybackState> = {},
): PalazzoPlaybackState {
  return {
    ...idle(2),
    status: 'playing',
    track: {
      playbackRequestId: requestId,
      title: 'Snapshot title',
      artist: 'Snapshot artist',
      coverUrl: null,
      url: 'https://example.test/a.mp3',
      startedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
    positionSeconds: 3,
    remainingSeconds: 10,
    ...extra,
  };
}

/** Starts the first automatic song and returns its playback request id. */
async function startAutomatic(
  ctx: ReturnType<typeof setup>,
  sequence: unknown = AUTO,
): Promise<string> {
  ctx.engine.handleSequenceUpdated('radio-1', sequence);
  ctx.engine.handlePalazzoSnapshot('radio-1', idle());
  await flush(60);
  return activeRequestId(ctx.engine);
}

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
  logSpy = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  errorSpy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const FAVORITES = sequenceOf([
  { ...SONG_A, id: 'fav', songId: 7, highRotation: true },
  SONG_B,
]);
const NODUR = {
  id: 'nodur',
  kind: 'preset',
  title: 'No duration',
  artist: 'Nobody',
  coverUrl: 'https://example.test/nodur.jpg',
  audioUrl: 'https://example.test/nodur.mp3',
};

describe('SongExecutionEngine constructor metadata', () => {
  it('falls back to Object metadata when circular imports leave providers undefined', () => {
    jest.isolateModules(() => {
      jest.doMock('./radio.service', () => ({}));
      jest.doMock('../program/flight.service', () => ({}));
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('./now-playing-publisher.service', () => ({}));
      jest.doMock('./radio-metrics.service', () => ({}));
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const isolated = require('./song-execution.engine') as {
          SongExecutionEngine: new (...args: never[]) => unknown;
        };
        expect(
          Reflect.getMetadata(
            'design:paramtypes',
            isolated.SongExecutionEngine,
          ),
        ).toEqual([Object, Object, Object, Object, Object]);
      } finally {
        jest.dontMock('./radio.service');
        jest.dontMock('../program/flight.service');
        jest.dontMock('../prisma.service');
        jest.dontMock('./now-playing-publisher.service');
        jest.dontMock('./radio-metrics.service');
      }
    });
  });
});

describe('SongExecutionEngine stop and status handling', () => {
  it('publishes a stop for a program the engine has never seen', () => {
    const { engine, publisher, events } = setup();
    engine.handleStopSong('never-seen');
    expect(publisher.publishStopped).toHaveBeenCalledWith('never-seen');
    expect(events).toEqual([]);
  });

  it('ignores Palazzo status for programs that are not radio capable', () => {
    const { engine, events } = setup();
    engine.handlePalazzoStatus('tv-1', {
      programId: 'tv-1',
      connection: 'unavailable',
    } as never);
    expect(events).toEqual([]);
  });

  it('freezes on each unavailable connection state and unfreezes when connected', () => {
    const { engine, events } = setup();
    const status = (connection: string) =>
      ({ programId: 'radio-1', connection }) as never;
    engine.handlePalazzoStatus('radio-1', status('instance-mismatch'));
    expect(stateOf(engine).frozen).toBe(true);
    engine.handlePalazzoStatus('radio-1', status('instance-conflict'));
    expect(stateOf(engine).frozen).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    stateOf(engine).reconciled = true;
    engine.handlePalazzoStatus('radio-1', status('connected'));
    expect(stateOf(engine).frozen).toBe(false);
    expect(stateOf(engine).reconciled).toBe(false);
    engine.handlePalazzoStatus('radio-1', status('connected'));
    expect(events.filter((e) => e.type === 'radio_leg_status')).toHaveLength(4);
  });

  it('does not start a sequence while frozen', async () => {
    const { engine, radioService } = setup();
    engine.handlePalazzoSnapshot('radio-1', idle());
    stateOf(engine).frozen = true;
    engine.handleSequenceUpdated('radio-1', AUTO);
    await flush();
    expect(radioService.playSong).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine Palazzo events', () => {
  it('ignores events for non-radio programs and programs without state', () => {
    const { engine, events, metrics } = setup();
    engine.handlePalazzoEvent('tv-1', {
      type: 'audio.levels',
      data: idle().levels,
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'x' },
    });
    expect(events).toEqual([]);
    expect(metrics.recordTrackTransition).not.toHaveBeenCalled();
  });

  it('broadcasts audio levels with a sample timestamp', () => {
    const { engine, events } = setup();
    engine.handlePalazzoSnapshot('radio-1', idle());
    events.length = 0;
    const levels = idle().levels;
    engine.handlePalazzoEvent('radio-1', {
      type: 'audio.levels',
      data: levels,
    });
    expect(events).toEqual([
      {
        type: 'audio_levels',
        programId: 'radio-1',
        levels,
        sampledAt: '2026-09-15T12:00:00.000Z',
      },
    ]);
  });

  describe('playback.position', () => {
    it('is ignored without an active song or for another request', () => {
      const { engine, events } = setup();
      engine.handlePalazzoSnapshot('radio-1', idle());
      engine.handlePalazzoEvent('radio-1', {
        type: 'playback.position',
        data: { playbackRequestId: 'x', positionSeconds: 5 },
      });
      engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
      events.length = 0;
      engine.handlePalazzoEvent('radio-1', {
        type: 'playback.position',
        data: { playbackRequestId: 'other', positionSeconds: 5 },
      });
      expect(events).toEqual([]);
    });

    it('applies position and remaining time to the matching song', () => {
      const { engine } = setup();
      engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
      const requestId = activeRequestId(engine);
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: requestId },
      });
      engine.handlePalazzoEvent('radio-1', {
        type: 'playback.position',
        data: {
          playbackRequestId: requestId,
          positionSeconds: 12.34,
          remainingSeconds: 50,
        },
      });
      const playback = engine.getPlaybackState('radio-1');
      expect(playback?.positionMs).toBe(12340);
      expect(playback?.durationMs).toBe(62340);
      expect(playback?.telemetryStale).toBe(false);
    });

    it('accepts updates without a request id and ignores invalid numbers', () => {
      const { engine, events } = setup();
      engine.handleManualSong(
        'radio-1',
        'https://example.test/m.mp3',
        'T',
        'A',
        60000,
      );
      events.length = 0;
      engine.handlePalazzoEvent('radio-1', {
        type: 'playback.position',
        data: { positionSeconds: -1, remainingSeconds: -1 },
      });
      engine.handlePalazzoEvent('radio-1', {
        type: 'playback.position',
        data: { playbackRequestId: null },
      });
      expect(events).toHaveLength(2);
      expect(engine.getPlaybackState('radio-1')?.durationMs).toBe(60000);
      expect(engine.getPlaybackState('radio-1')?.telemetryStale).toBe(true);
    });

    it('reports zero progress when authoritative timing yields a zero duration', () => {
      const { engine } = setup();
      engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
      engine.handlePalazzoEvent('radio-1', {
        type: 'playback.position',
        data: { positionSeconds: 0, remainingSeconds: 0 },
      });
      const playback = engine.getPlaybackState('radio-1');
      expect(playback?.durationMs).toBe(0);
      expect(playback?.progress).toBe(0);
    });
  });

  describe('track.started', () => {
    it('adopts the active song, fills a missing cover and starts rotation history', () => {
      const { engine, metrics } = setup();
      engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
      const requestId = activeRequestId(engine);
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: {
          playbackRequestId: requestId,
          coverUrl: 'https://example.test/c.jpg',
        },
      });
      expect(engine.getPlaybackState('radio-1')?.coverUrl).toBe(
        'https://example.test/c.jpg',
      );
      expect(stateOf(engine).pendingRequestIds.has(requestId)).toBe(false);
      expect(metrics.recordTrackTransition).toHaveBeenCalledWith('adopted');
    });

    it('keeps an existing cover and ignores a non-string cover', () => {
      const { engine } = setup();
      engine.handleManualSong(
        'radio-1',
        'https://example.test/m.mp3',
        'T',
        'A',
        1000,
        'https://example.test/original.jpg',
      );
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: {
          playbackRequestId: activeRequestId(engine),
          coverUrl: 'https://example.test/new.jpg',
        },
      });
      expect(engine.getPlaybackState('radio-1')?.coverUrl).toBe(
        'https://example.test/original.jpg',
      );
      engine.handleManualSong('radio-1', 'https://example.test/n.mp3');
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: activeRequestId(engine), coverUrl: null },
      });
      expect(engine.getPlaybackState('radio-1')?.coverUrl).toBe('');
    });

    it('adopts a pending command that is not the active song and ignores unknown ones', () => {
      const { engine, metrics } = setup();
      engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
      stateOf(engine).pendingRequestIds.add('pending-2');
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: 'pending-2' },
      });
      expect(metrics.recordTrackTransition).toHaveBeenLastCalledWith('adopted');
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: 'unknown' },
      });
      expect(metrics.recordTrackTransition).toHaveBeenLastCalledWith(
        'ignored-mismatch',
      );
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: {} as never,
      });
      expect(metrics.recordTrackTransition).toHaveBeenLastCalledWith(
        'ignored-mismatch',
      );
      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: 42 as never },
      });
      expect(metrics.recordTrackTransition).toHaveBeenCalledTimes(4);
    });
  });

  describe('high rotation history', () => {
    it('records a favorite once per request and persists the history', async () => {
      const ctx = setup();
      const requestId = await startAutomatic(ctx, FAVORITES);
      const started = {
        type: 'track.started' as const,
        data: { playbackRequestId: requestId },
      };
      ctx.engine.handlePalazzoEvent('radio-1', started);
      ctx.engine.handlePalazzoEvent('radio-1', started);
      await flush();
      const updates = ctx.prisma.programState.update.mock.calls.filter(
        ([arg]: [{ data: Record<string, unknown> }]) =>
          'songRotation' in arg.data,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0][0].data.songRotation).toMatchObject({
        history: [{ requestId, songKey: 'song:7', itemId: 'fav' }],
      });
      expect(ctx.metrics.recordHighRotationAction).toHaveBeenCalledWith(
        'played',
      );
    });

    it('keys favorites without a catalog id by playlist item', async () => {
      const ctx = setup();
      const requestId = await startAutomatic(
        ctx,
        sequenceOf([{ ...SONG_B, id: 'fav-b', highRotation: true }]),
      );
      ctx.engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: requestId },
      });
      expect(stateOf(ctx.engine).rotation.history).toEqual([
        expect.objectContaining({ songKey: 'item:fav-b', itemId: 'fav-b' }),
      ]);
    });

    it('suspends automatic favorites after a persistence failure', async () => {
      const ctx = setup();
      const requestId = await startAutomatic(ctx, FAVORITES);
      ctx.prisma.programState.update.mockRejectedValueOnce(
        new Error('db down'),
      );
      ctx.engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: requestId },
      });
      await flush();
      expect(stateOf(ctx.engine).rotationHistoryHealthy).toBe(false);
      expect(ctx.metrics.recordHighRotationAction).toHaveBeenCalledWith(
        'history-persistence-failed',
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('automatic favorites are suspended'),
      );
      ctx.engine.handlePalazzoEvent('radio-1', {
        type: 'track.ended',
        data: { playbackRequestId: requestId },
      });
      await flush(60);
      expect(ctx.radioService.playSong.mock.calls[1][1]).toBe(
        'https://example.test/b.mp3',
      );
      expect(
        ctx.metrics.recordHighRotationAction.mock.calls.filter(
          ([name]: [string]) => name === 'selected',
        ),
      ).toHaveLength(1);
    });

    it('skips persistence when the program state disappears before the write', async () => {
      const ctx = setup();
      const requestId = await startAutomatic(ctx, FAVORITES);
      ctx.prisma.programState.update.mockClear();
      ctx.engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: requestId },
      });
      internals(ctx.engine).states.delete('radio-1');
      await flush();
      expect(ctx.prisma.programState.update).not.toHaveBeenCalled();
    });

    it('tolerates the program state disappearing while the write fails', async () => {
      const ctx = setup();
      const requestId = await startAutomatic(ctx, FAVORITES);
      ctx.prisma.programState.update.mockImplementationOnce(() => {
        internals(ctx.engine).states.delete('radio-1');
        return Promise.reject(new Error('gone'));
      });
      ctx.engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: requestId },
      });
      await flush();
      expect(ctx.metrics.recordHighRotationAction).toHaveBeenCalledWith(
        'history-persistence-failed',
      );
    });
  });
});

describe('SongExecutionEngine playing snapshots', () => {
  it('refreshes the active song from a matching snapshot', () => {
    const { engine } = setup();
    engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
    const requestId = activeRequestId(engine);
    stateOf(engine).busyWithForeignTrack = true;
    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(requestId, { coverUrl: 'https://example.test/snap.jpg' }),
    );
    const playback = engine.getPlaybackState('radio-1');
    expect(playback?.coverUrl).toBe('https://example.test/snap.jpg');
    expect(playback?.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(playback?.positionMs).toBe(3000);
    expect(stateOf(engine).busyWithForeignTrack).toBe(false);
  });

  it('keeps cover and start time when the snapshot lacks usable values', () => {
    const { engine } = setup();
    engine.handleManualSong(
      'radio-1',
      'https://example.test/m.mp3',
      'T',
      'A',
      1000,
      'https://example.test/original.jpg',
    );
    const requestId = activeRequestId(engine);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(requestId, {
        coverUrl: 'https://example.test/other.jpg',
        startedAt: 'not a date',
      }),
    );
    expect(engine.getPlaybackState('radio-1')?.coverUrl).toBe(
      'https://example.test/original.jpg',
    );
    engine.handleManualSong('radio-1', 'https://example.test/n.mp3');
    const second = activeRequestId(engine);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(second, { coverUrl: null, startedAt: undefined as never }),
    );
    expect(engine.getPlaybackState('radio-1')?.coverUrl).toBe('');
  });

  it('reconciles intro state from the snapshot for the active song only', () => {
    const { engine } = setup();
    engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
    const requestId = activeRequestId(engine);
    const intro = (overrides: Record<string, unknown>) =>
      ({
        playbackId: 'intro-1',
        parentPlaybackId: requestId,
        programId: 'radio-1',
        playbackRequestId: 'intro-1',
        url: 'https://example.test/intro.mp3',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'playing',
        ...overrides,
      }) as PalazzoPlaybackState['intro'];

    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(requestId, {}, { intro: intro({ parentPlaybackId: 'other' }) }),
    );
    expect(engine.getPlaybackState('radio-1')?.introStatus).toBe('none');

    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(requestId, {}, { intro: intro({}) }),
    );
    expect(engine.getPlaybackState('radio-1')?.introStatus).toBe('playing');

    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(
        requestId,
        {},
        {
          intro: intro({
            status: 'failed',
            failureReason: ` ${'x'.repeat(300)} `,
          }),
        },
      ),
    );
    const degraded = engine.getPlaybackState('radio-1');
    expect(degraded?.introStatus).toBe('degraded');
    expect(degraded?.introFailureReason).toBe('x'.repeat(200));
  });

  it('confirms a pending command from a snapshot', () => {
    const { engine } = setup();
    engine.handlePalazzoSnapshot('radio-1', idle());
    stateOf(engine).pendingRequestIds.add('pending-1');
    engine.handlePalazzoSnapshot('radio-1', playing('pending-1'));
    expect(stateOf(engine).pendingRequestIds.has('pending-1')).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Adopting confirmed Palazzo playback pending-1'),
    );

    engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
    stateOf(engine).pendingRequestIds.add('pending-2');
    logSpy.mockClear();
    engine.handlePalazzoSnapshot('radio-1', playing('pending-2'));
    expect(stateOf(engine).pendingRequestIds.has('pending-2')).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(engine.getPlaybackState('radio-1')?.audioUrl).toBe(
      'https://example.test/m.mp3',
    );
  });

  it('adopts an inherited playlist track with snapshot metadata', () => {
    const { engine, publisher, events, metrics } = setup();
    engine.handleSequenceUpdated('radio-1', AUTO);
    engine.handleQueueUpdated('radio-1', [
      {
        id: 'q1',
        itemId: 'song-a',
        enqueuedAt: 1,
        active: true,
        playbackRequestId: 'ext-1',
      },
    ]);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(
        'ext-1',
        { coverUrl: 'https://example.test/snap.jpg' },
        {
          intro: {
            playbackId: 'intro-1',
            parentPlaybackId: 'ext-1',
            programId: 'radio-1',
            playbackRequestId: 'intro-1',
            url: 'u',
            startedAt: '2026-01-01T00:00:00.000Z',
            status: 'playing',
          },
        },
      ),
    );
    const playback = engine.getPlaybackState('radio-1');
    expect(playback).toMatchObject({
      title: 'Snapshot title',
      artist: 'Snapshot artist',
      coverUrl: 'https://example.test/snap.jpg',
      durationMs: 1000,
      introStatus: 'playing',
      queueEntryId: 'q1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(metrics.recordTrackTransition).toHaveBeenCalledWith('adopted');
    expect(publisher.publishPlayback).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toContain('song_playback_active');
  });

  it('falls back to playlist metadata and computed start time for sparse snapshots', () => {
    const { engine } = setup();
    engine.handleSequenceUpdated('radio-1', sequenceOf([NODUR, SONG_B]));
    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(
        'ext-2',
        {
          title: null,
          artist: null,
          coverUrl: null,
          url: NODUR.audioUrl,
          startedAt: 'garbage',
        },
        { positionSeconds: -5 },
      ),
    );
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      title: 'No duration',
      artist: 'Nobody',
      coverUrl: 'https://example.test/nodur.jpg',
      durationMs: 300000,
      introStatus: 'none',
      introFailureReason: null,
      queueEntryId: null,
      startedAt: '2026-09-15T12:00:00.000Z',
    });
  });

  it('marks failed or mismatched intros on inherited tracks as degraded', () => {
    const { engine } = setup();
    engine.handleSequenceUpdated('radio-1', AUTO);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(
        'ext-3',
        {},
        {
          intro: {
            playbackId: 'intro-3',
            parentPlaybackId: 'ext-3',
            programId: 'radio-1',
            playbackRequestId: 'intro-3',
            url: 'u',
            startedAt: '2026-01-01T00:00:00.000Z',
            status: 'failed',
            failureReason: 'codec',
          },
        },
      ),
    );
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      introStatus: 'degraded',
      introFailureReason: 'codec',
    });
  });

  it('adopts an inherited favorite and records its rotation play', () => {
    const { engine } = setup();
    engine.handleSequenceUpdated('radio-1', FAVORITES);
    engine.handlePalazzoSnapshot('radio-1', playing('ext-4'));
    expect(stateOf(engine).rotation.history).toEqual([
      expect.objectContaining({ requestId: 'ext-4', songKey: 'song:7' }),
    ]);
  });

  it('only warns once about a foreign track and never adopts it', () => {
    const { engine, radioService } = setup();
    engine.handleSequenceUpdated('radio-1', AUTO);
    const foreign = playing('foreign', {
      url: 'https://example.test/unknown.mp3',
    });
    engine.handlePalazzoSnapshot('radio-1', foreign);
    engine.handlePalazzoSnapshot('radio-1', foreign);
    expect(stateOf(engine).busyWithForeignTrack).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(engine.getPlaybackState('radio-1')).toBeNull();
    expect(radioService.playSong).not.toHaveBeenCalled();
  });

  it('treats snapshots without request id or url as foreign', () => {
    const { engine } = setup();
    engine.handleSequenceUpdated('radio-1', AUTO);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playing(undefined as never, { url: undefined as never }),
    );
    expect(stateOf(engine).busyWithForeignTrack).toBe(true);
    expect(engine.getPlaybackState('radio-1')).toBeNull();
  });

  it('does not adopt an inherited track without a playlist', () => {
    const { engine } = setup();
    engine.handlePalazzoSnapshot('radio-1', playing('ext-5'));
    expect(stateOf(engine).busyWithForeignTrack).toBe(true);
  });
});

describe('SongExecutionEngine idle snapshots', () => {
  it('drops commands that never started and records the idle sequence', () => {
    const { engine } = setup();
    engine.handlePalazzoSnapshot('radio-1', idle(1));
    stateOf(engine).pendingRequestIds.add('never-started');
    stateOf(engine).busyWithForeignTrack = true;
    engine.handlePalazzoSnapshot('radio-1', idle(5));
    expect(stateOf(engine).pendingRequestIds.size).toBe(0);
    expect(stateOf(engine).busyWithForeignTrack).toBe(false);
  });
});

describe('SongExecutionEngine intro events', () => {
  function introEvent(
    type: 'intro.started' | 'intro.ended' | 'intro.failed',
    data: Record<string, unknown>,
  ) {
    return {
      type,
      data: {
        programId: 'radio-1',
        playbackId: 'intro-1',
        parentPlaybackId: 'parent',
        ...data,
      },
    } as never;
  }

  function withActiveSong() {
    const ctx = setup();
    ctx.engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
    const requestId = activeRequestId(ctx.engine);
    return { ...ctx, requestId };
  }

  it('ignores events without a matching active song, program or intro id', () => {
    const { engine, metrics, requestId } = withActiveSong();
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.started', {
        programId: 'other',
        parentPlaybackId: requestId,
      }),
    );
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.started', { parentPlaybackId: 'wrong' }),
    );
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.started', { parentPlaybackId: requestId }),
    );
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.ended', {
        parentPlaybackId: requestId,
        playbackId: 'intro-2',
      }),
    );
    expect(metrics.recordIntroTransition).toHaveBeenCalledWith(
      'ignored-mismatch',
    );
    expect(
      metrics.recordIntroTransition.mock.calls.filter(
        ([name]: [string]) => name === 'ignored-mismatch',
      ),
    ).toHaveLength(3);
    expect(engine.getPlaybackState('radio-1')?.introStatus).toBe('playing');
    engine.handleStopSong('radio-1');
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.started', { parentPlaybackId: requestId }),
    );
    expect(
      metrics.recordIntroTransition.mock.calls.filter(
        ([name]: [string]) => name === 'ignored-mismatch',
      ),
    ).toHaveLength(4);
  });

  it('tracks started, ended and failed transitions', () => {
    const { engine, metrics, requestId } = withActiveSong();
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.started', { parentPlaybackId: requestId }),
    );
    expect(engine.getPlaybackState('radio-1')?.introStatus).toBe('playing');
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.ended', { parentPlaybackId: requestId }),
    );
    expect(engine.getPlaybackState('radio-1')?.introStatus).toBe('completed');
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.failed', {
        parentPlaybackId: requestId,
        failureReason: 'bad codec',
      }),
    );
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      introStatus: 'degraded',
      introFailureReason: 'bad codec',
    });
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.failed', {
        parentPlaybackId: requestId,
        reason: 'timeout',
      }),
    );
    expect(engine.getPlaybackState('radio-1')?.introFailureReason).toBe(
      'timeout',
    );
    engine.handlePalazzoEvent(
      'radio-1',
      introEvent('intro.failed', { parentPlaybackId: requestId }),
    );
    expect(engine.getPlaybackState('radio-1')?.introFailureReason).toBe(
      'Intro playback failed',
    );
    expect(
      metrics.recordIntroTransition.mock.calls.map(([name]: [string]) => name),
    ).toEqual(['started', 'ended', 'failed', 'failed', 'failed']);
  });
});

describe('SongExecutionEngine broadcasting', () => {
  it('logs and survives a failing broadcast handler', () => {
    const { engine } = setup();
    engine.setBroadcastHandler(() => {
      throw new Error('socket closed');
    });
    expect(() =>
      engine.handleManualSong('radio-1', 'https://example.test/m.mp3'),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Broadcast error: Error: socket closed'),
    );
  });

  it('emits periodic progress while a song is active and stops after it clears', () => {
    const { engine, events } = setup();
    engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
    events.length = 0;
    jest.advanceTimersByTime(500);
    expect(events.filter((e) => e.type === 'playback_update')).toHaveLength(2);
    stateOf(engine).activeSong = null;
    events.length = 0;
    jest.advanceTimersByTime(500);
    expect(events).toEqual([]);
  });
});
