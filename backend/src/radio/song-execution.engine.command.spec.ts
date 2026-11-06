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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  errorSpy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const VOICE = {
  instantId: 5,
  duckGain: 0.4,
  fadeInSeconds: 1,
  fadeOutSeconds: 2,
};

interface PushCommandCall {
  (
    programId: string,
    requestId: string,
    audioUrl: string,
    title?: string,
    artist?: string,
    coverUrl?: string,
    songId?: number,
  ): Promise<void>;
}

function lastIntro(ctx: ReturnType<typeof setup>): unknown {
  const calls = ctx.radioService.playSong.mock.calls;
  return calls[calls.length - 1][6];
}

function manual(
  ctx: ReturnType<typeof setup>,
  options: { songId?: number; voice?: typeof VOICE; programId?: string } = {},
) {
  ctx.engine.handleManualSong(
    options.programId ?? 'radio-1',
    'https://example.test/m.mp3',
    'Title',
    'Artist',
    5000,
    '',
    options.songId,
    options.voice,
  );
  return activeRequestId(ctx.engine, options.programId ?? 'radio-1');
}

function introOf(ctx: ReturnType<typeof setup>) {
  const playback = ctx.engine.getPlaybackState('radio-1');
  return {
    status: playback?.introStatus,
    reason: playback?.introFailureReason,
  };
}

describe('SongExecutionEngine manual song normalisation', () => {
  it('defaults an invalid duration and drops an invalid catalog id', () => {
    const ctx = setup();
    ctx.engine.handleManualSong(
      'radio-1',
      'https://example.test/m.mp3',
      undefined,
      undefined,
      -5,
      undefined,
      1.5,
    );
    expect(ctx.engine.getPlaybackState('radio-1')).toMatchObject({
      durationMs: 300000,
      title: '',
      artist: '',
      coverUrl: '',
    });
    expect(ctx.prisma.songIntro.findUnique).not.toHaveBeenCalled();
    ctx.engine.handleManualSong(
      'radio-1',
      'https://example.test/n.mp3',
      'T',
      'A',
      'x' as unknown as number,
      undefined,
      0,
    );
    expect(ctx.engine.getPlaybackState('radio-1')?.durationMs).toBe(300000);
    expect(ctx.prisma.songIntro.findUnique).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine voice track commands', () => {
  it.each([
    ['a missing clip', null],
    [
      'a disabled clip',
      { audioUrl: 'https://example.test/v.webm', volume: 1, enabled: false },
    ],
    ['a clip without audio', { audioUrl: '   ', volume: 1, enabled: true }],
  ])(
    'degrades the intro for %s and still plays the song',
    async (_name, clip) => {
      const ctx = setup();
      ctx.prisma.instant.findUnique.mockResolvedValue(clip);
      manual(ctx, { voice: VOICE });
      await flush(20);
      expect(introOf(ctx)).toEqual({
        status: 'degraded',
        reason: 'Voice track is unavailable',
      });
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
      expect(lastIntro(ctx)).toBeUndefined();
      expect(ctx.metrics.recordIntroTransition).toHaveBeenCalledWith('failed');
    },
  );

  it('degrades the intro when the clip lookup fails', async () => {
    const ctx = setup();
    ctx.prisma.instant.findUnique.mockRejectedValue(new Error('db down'));
    manual(ctx, { voice: VOICE });
    await flush(20);
    expect(introOf(ctx).reason).toBe('Voice track is unavailable');
    expect(lastIntro(ctx)).toBeUndefined();
  });

  it('degrades the intro when Palazzo does not echo the intro id', async () => {
    const ctx = setup();
    ctx.prisma.instant.findUnique.mockResolvedValue({
      audioUrl: 'https://example.test/v.webm',
      volume: 0.7,
      enabled: true,
    });
    ctx.radioService.playSong.mockImplementation((...args: unknown[]) =>
      Promise.resolve({
        ok: true,
        playbackRequestId: args[4],
        introPlaybackId: 'wrong',
      }),
    );
    const requestId = manual(ctx, { voice: VOICE });
    await flush(20);
    expect(lastIntro(ctx)).toEqual({
      playbackId: `${requestId}:intro`,
      url: 'https://example.test/v.webm',
      gain: 0.7,
      duckGain: 0.4,
      fadeInSeconds: 1,
      fadeOutSeconds: 2,
    });
    expect(introOf(ctx)).toEqual({
      status: 'degraded',
      reason: 'Palazzo did not accept the assigned intro',
    });
  });

  it('accepts an echoed intro id', async () => {
    const ctx = setup();
    ctx.prisma.instant.findUnique.mockResolvedValue({
      audioUrl: 'https://example.test/v.webm',
      volume: 0.7,
      enabled: true,
    });
    ctx.radioService.playSong.mockImplementation((...args: unknown[]) =>
      Promise.resolve({
        ok: true,
        playbackRequestId: args[4],
        introPlaybackId: `${args[4]}:intro`,
      }),
    );
    manual(ctx, { voice: VOICE });
    await flush(20);
    expect(introOf(ctx).status).toBe('pending');
    expect(ctx.metrics.recordIntroTransition).toHaveBeenCalledWith('accepted');
  });

  it('abandons a command that was superseded while its intro was loading', async () => {
    const ctx = setup();
    const clip = deferred<unknown>();
    ctx.prisma.instant.findUnique.mockReturnValueOnce(clip.promise);
    manual(ctx, { voice: VOICE });
    const secondId = manual(ctx);
    clip.resolve({
      audioUrl: 'https://example.test/v.webm',
      volume: 1,
      enabled: true,
    });
    await flush(20);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(ctx.radioService.playSong.mock.calls[0][4]).toBe(secondId);
  });
});

describe('SongExecutionEngine assigned song intros', () => {
  const assignment = (overrides: Record<string, unknown> = {}) => ({
    songId: 11,
    programId: 'radio-1',
    instant: {
      audioUrl: 'https://example.test/intro.mp3',
      volume: 0.6,
      enabled: true,
    },
    ...overrides,
  });

  it('submits an assigned intro for a catalog song', async () => {
    const ctx = setup();
    ctx.prisma.songIntro.findUnique.mockResolvedValue(assignment());
    const requestId = manual(ctx, { songId: 11 });
    await flush(20);
    expect(ctx.prisma.songIntro.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { songId: 11 } }),
    );
    expect(lastIntro(ctx)).toEqual({
      playbackId: `${requestId}:intro`,
      url: 'https://example.test/intro.mp3',
      gain: 0.6,
    });
    expect(introOf(ctx)).toEqual({ status: 'pending', reason: null });
  });

  it('plays without an intro when nothing is assigned', async () => {
    const ctx = setup();
    manual(ctx, { songId: 11 });
    await flush(20);
    expect(lastIntro(ctx)).toBeUndefined();
    expect(introOf(ctx)).toEqual({ status: 'none', reason: null });
  });

  it.each([
    [
      'a disabled intro',
      { instant: { audioUrl: 'u', volume: 1, enabled: false } },
    ],
    [
      'an intro without audio',
      { instant: { audioUrl: ' ', volume: 1, enabled: true } },
    ],
  ])('degrades for %s', async (_name, overrides) => {
    const ctx = setup();
    ctx.prisma.songIntro.findUnique.mockResolvedValue(assignment(overrides));
    manual(ctx, { songId: 11 });
    await flush(20);
    expect(introOf(ctx)).toEqual({
      status: 'degraded',
      reason: 'Assigned intro is unavailable',
    });
    expect(lastIntro(ctx)).toBeUndefined();
  });

  it('degrades for an intro owned by another program', async () => {
    const ctx = setup();
    ctx.prisma.songIntro.findUnique.mockResolvedValue(
      assignment({ programId: 'radio-2' }),
    );
    manual(ctx, { songId: 11 });
    await flush(20);
    expect(introOf(ctx).reason).toBe(
      'Assigned intro belongs to another program',
    );
  });

  it('degrades when the assignment lookup fails', async () => {
    const ctx = setup();
    ctx.prisma.songIntro.findUnique.mockRejectedValue(new Error('db down'));
    manual(ctx, { songId: 11 });
    await flush(20);
    expect(introOf(ctx).reason).toBe('Intro assignment lookup failed');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Intro lookup failed on radio-1'),
    );
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('does not look up intros for non-positive catalog ids', async () => {
    const ctx = setup();
    const requestId = manual(ctx);
    await (
      ctx.engine as unknown as { pushCommand: PushCommandCall }
    ).pushCommand(
      'radio-1',
      requestId,
      'https://example.test/m.mp3',
      'T',
      'A',
      '',
      0,
    );
    expect(ctx.prisma.songIntro.findUnique).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine command results', () => {
  it('adopts the request id chosen by Palazzo', async () => {
    const ctx = setup();
    ctx.radioService.playSong.mockResolvedValue({
      ok: true,
      playbackRequestId: 'palazzo-id',
    });
    const original = manual(ctx);
    await flush(20);
    expect(activeRequestId(ctx.engine)).toBe('palazzo-id');
    const pending = stateOf(ctx.engine).pendingRequestIds;
    expect(pending.has(original)).toBe(false);
    expect(pending.has('palazzo-id')).toBe(true);
  });

  it('keeps a newer active song when Palazzo answers for an older command', async () => {
    const ctx = setup();
    const answer = deferred<unknown>();
    ctx.radioService.playSong.mockReturnValueOnce(answer.promise);
    manual(ctx);
    await flush(20);
    const second = manual(ctx);
    answer.resolve({ ok: true, playbackRequestId: 'palazzo-old' });
    await flush(20);
    expect(activeRequestId(ctx.engine)).toBe(second);
    expect(stateOf(ctx.engine).pendingRequestIds.has('palazzo-old')).toBe(true);
  });

  it('treats a successful answer without a request id as no change', async () => {
    const ctx = setup();
    ctx.radioService.playSong.mockResolvedValue({ ok: true });
    const requestId = manual(ctx);
    await flush(20);
    expect(activeRequestId(ctx.engine)).toBe(requestId);
    expect(stateOf(ctx.engine).pendingRequestIds.has(requestId)).toBe(true);
  });

  it('clears playback and publishes stopped when the command is rejected', async () => {
    const ctx = setup();
    ctx.radioService.playSong.mockResolvedValue({ ok: false });
    manual(ctx);
    await flush(20);
    expect(ctx.engine.getPlaybackState('radio-1')).toBeNull();
    expect(ctx.metrics.recordTrackTransition).toHaveBeenCalledWith(
      'command-failed',
    );
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
    expect(ctx.events.map((e) => e.type)).toContain('song_off_air');
  });

  it('treats a thrown command error as a failure', async () => {
    const ctx = setup();
    ctx.radioService.playSong.mockRejectedValue(new Error('offline'));
    manual(ctx);
    await flush(20);
    expect(ctx.engine.getPlaybackState('radio-1')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Palazzo command errored on radio-1'),
    );
  });

  it('releases the queue claim when a queued command fails', async () => {
    const ctx = setup();
    ctx.radioService.playSong.mockResolvedValue({ ok: false });
    ctx.store.current!.songQueue = [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ];
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handleQueueUpdated('radio-1', ctx.store.current!.songQueue);
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(80);
    expect(ctx.store.current?.songQueue).toEqual([
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ]);
  });

  it('ignores a late failure when the program state is gone', async () => {
    const ctx = setup();
    const answer = deferred<unknown>();
    ctx.radioService.playSong.mockReturnValueOnce(answer.promise);
    manual(ctx);
    await flush(20);
    internals(ctx.engine).states.delete('radio-1');
    answer.reject(new Error('offline'));
    await flush(20);
    expect(ctx.metrics.recordTrackTransition).not.toHaveBeenCalledWith(
      'command-failed',
    );
  });

  it('keeps a newer song when an older command fails', async () => {
    const ctx = setup();
    const answer = deferred<unknown>();
    ctx.radioService.playSong.mockReturnValueOnce(answer.promise);
    manual(ctx);
    await flush(20);
    const second = manual(ctx);
    answer.resolve({ ok: false });
    await flush(20);
    expect(activeRequestId(ctx.engine)).toBe(second);
    expect(ctx.metrics.recordTrackTransition).not.toHaveBeenCalledWith(
      'command-failed',
    );
  });

  it('keeps a TV song active when its command fails', async () => {
    const ctx = setup();
    ctx.radioService.playSong.mockResolvedValue({ ok: false });
    manual(ctx, { programId: 'tv-1' });
    await flush(20);
    expect(ctx.engine.getPlaybackState('tv-1')).not.toBeNull();
    expect(ctx.metrics.recordTrackTransition).not.toHaveBeenCalledWith(
      'command-failed',
    );
  });
});

describe('SongExecutionEngine progress and queue application', () => {
  it('ignores progress requests for unknown programs', () => {
    const ctx = setup();
    (
      ctx.engine as unknown as { startProgress(programId: string): void }
    ).startProgress('ghost');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('accepts a remaining time before any position is known', () => {
    const ctx = setup();
    manual(ctx);
    ctx.engine.handlePalazzoEvent('radio-1', {
      type: 'playback.position',
      data: { remainingSeconds: 5 },
    });
    expect(ctx.engine.getPlaybackState('radio-1')?.durationMs).toBe(5000);
  });

  it('starts from the queue in shuffle mode too', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated(
      'radio-1',
      sequenceOf([SONG_A, SONG_B], 'shuffle'),
    );
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(40);
    const first = ctx.radioService.playSong.mock.calls.length;
    ctx.engine.handleStopSong('radio-1');
    await flush(10);
    await ctx.engine.enqueueSong('radio-1', 'song-b');
    await flush(80);
    expect(ctx.radioService.playSong.mock.calls.length).toBeGreaterThan(first);
    ctx.engine.handleQueueUpdated('radio-1', [
      { id: 'q9', itemId: 'song-b', enqueuedAt: 9 },
    ]);
    expect(stateOf(ctx.engine).queue).toHaveLength(1);
  });

  it('adopts an inherited track whose snapshot start time is missing', () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playing('ext-9', { startedAt: undefined as never }),
    );
    expect(ctx.engine.getPlaybackState('radio-1')?.startedAt).toBe(
      new Date(Date.now() - 3000).toISOString(),
    );
  });

  it('logs a missing cursor when the successor cannot be resolved', async () => {
    const ctx = setup();
    const requestId = await startAutomatic(ctx);
    const settings = deferred<unknown>();
    ctx.radioService.getRadioSettings.mockReturnValueOnce(settings.promise);
    ctx.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();
    ctx.engine.handleSequenceUpdated('radio-1', {
      ...AUTO,
      activeItemId: null,
    });
    settings.resolve(null);
    await flush(40);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Successor could not be resolved on radio-1: cursor=none',
      ),
    );
  });

  it('does not continue after a claim when the state vanished during application', async () => {
    const ctx = setup();
    ctx.store.current!.songQueue = [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ];
    ctx.engine.setBroadcastHandler((event) => {
      if (event.type === 'song_queue_update') {
        internals(ctx.engine).states.delete('radio-1');
      }
    });
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handleQueueUpdated('radio-1', ctx.store.current!.songQueue);
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(80);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });
});
