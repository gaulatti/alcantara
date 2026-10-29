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
const NO_AUDIO = {
  id: 'no-audio',
  kind: 'preset',
  title: 'Silent',
  artist: 'Nobody',
  coverUrl: '',
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

const INTERVAL = 30 * 60 * 1000;
const NODUR = {
  id: 'nodur',
  kind: 'preset',
  title: 'No duration',
  artist: 'Nobody',
  coverUrl: '',
  audioUrl: 'https://example.test/nodur.mp3',
};
const NORMAL = {
  id: 'normal',
  kind: 'preset',
  title: 'Normal',
  artist: 'Artist',
  coverUrl: '',
  audioUrl: 'https://example.test/normal.mp3',
  durationMs: 1000,
};
const FAV_1 = {
  id: 'f1',
  kind: 'preset',
  songId: 1,
  highRotation: true,
  title: 'Favorite 1',
  artist: 'Artist',
  coverUrl: '',
  audioUrl: 'https://example.test/f1.mp3',
  durationMs: 1000,
};
const FAV_2 = {
  ...FAV_1,
  id: 'f2',
  songId: 2,
  title: 'Favorite 2',
  audioUrl: 'https://example.test/f2.mp3',
};

function played(songId: number, ago: number) {
  return {
    requestId: `req-${songId}-${ago}`,
    songKey: `song:${songId}`,
    itemId: `f${songId}`,
    playedAt: Date.now() - ago,
  };
}

function playedUrls(ctx: ReturnType<typeof setup>): string[] {
  return ctx.radioService.playSong.mock.calls.map(
    (call: unknown[]) => call[1] as string,
  );
}

function highRotationActions(ctx: ReturnType<typeof setup>): string[] {
  return ctx.metrics.recordHighRotationAction.mock.calls.map(
    (call: unknown[]) => call[0] as string,
  );
}

async function startWithRotation(
  ctx: ReturnType<typeof setup>,
  sequence: unknown,
  history: Array<Record<string, unknown>>,
  healthy = true,
) {
  ctx.engine.handleSequenceUpdated('radio-1', sequence);
  const state = stateOf(ctx.engine);
  state.rotation = { history };
  state.rotationHistoryHealthy = healthy;
  ctx.engine.handlePalazzoSnapshot('radio-1', idle());
  await flush(60);
}

async function startQueued(
  ctx: ReturnType<typeof setup>,
  queue: Array<Record<string, unknown>> = [
    { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
  ],
  sequence: unknown = AUTO,
) {
  ctx.store.current!.songQueue = queue;
  ctx.engine.handleSequenceUpdated('radio-1', sequence);
  ctx.engine.handleQueueUpdated('radio-1', queue);
  ctx.engine.handlePalazzoSnapshot('radio-1', idle());
  await flush(80);
}

function end(ctx: ReturnType<typeof setup>, requestId: string) {
  ctx.engine.handlePalazzoEvent('radio-1', {
    type: 'track.ended',
    data: { playbackRequestId: requestId },
  });
}

describe('SongExecutionEngine Play Next claims', () => {
  it('claims the queue head, plays it and consumes it on end', async () => {
    const ctx = setup();
    await startQueued(ctx);
    expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
    expect(ctx.store.current?.songQueue).toEqual([
      expect.objectContaining({ id: 'q1', active: true }),
      { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
    ]);
    end(ctx, activeRequestId(ctx.engine));
    await flush(80);
    expect(playedUrls(ctx)).toEqual([
      'https://example.test/a.mp3',
      'https://example.test/b.mp3',
    ]);
    expect(ctx.store.current?.songQueue).toEqual([
      expect.objectContaining({ id: 'q2', active: true }),
    ]);
  });

  it('reports the claim result from the persisted queue head', async () => {
    const ctx = setup({
      songQueue: [
        {
          id: 'q1',
          itemId: 'song-a',
          enqueuedAt: 1,
          active: true,
          playbackRequestId: 'req-1',
        },
        { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
      ],
    });
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const engine = internals(ctx.engine);
    await expect(engine.claimQueueHead('radio-1', 'q1', 'req-1')).resolves.toBe(
      true,
    );
    await expect(engine.claimQueueHead('radio-1', 'q1', 'other')).resolves.toBe(
      false,
    );
    await expect(engine.claimQueueHead('radio-1', 'q2', 'req-2')).resolves.toBe(
      false,
    );
    ctx.store.current!.songQueue = [];
    await expect(engine.claimQueueHead('radio-1', 'q1', 'req-1')).resolves.toBe(
      false,
    );
    expect(stateOf(ctx.engine).queue).toEqual([]);
  });

  it('releases only the claimed entry and refreshes the queue otherwise', async () => {
    const ctx = setup({
      songQueue: [
        {
          id: 'q1',
          itemId: 'song-a',
          enqueuedAt: 1,
          active: true,
          playbackRequestId: 'req-1',
        },
        { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
      ],
    });
    const engine = internals(ctx.engine);
    await engine.releaseQueueClaim('radio-1', 'q2');
    expect(ctx.prisma.programState.update).not.toHaveBeenCalled();
    await engine.releaseQueueClaim('radio-1', 'q1');
    expect(ctx.store.current?.songQueue).toEqual([
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
      { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
    ]);
    expect(ctx.metrics.recordSongQueueAction).toHaveBeenCalledWith('released');
  });

  it('releases the claim when playback is stopped', async () => {
    const ctx = setup();
    await startQueued(ctx);
    ctx.engine.handleStopSong('radio-1');
    expect(stateOf(ctx.engine).transitioning).toBe(true);
    await flush(40);
    expect(stateOf(ctx.engine).transitioning).toBe(false);
    expect(stateOf(ctx.engine).queueBlocked).toBe(false);
    expect(ctx.store.current?.songQueue).toEqual([
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
      { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
    ]);
  });

  it('blocks the queue without a second stop publication when the release fails', async () => {
    const ctx = setup();
    await startQueued(ctx);
    ctx.prisma.programState.findUnique.mockRejectedValue(new Error('db down'));
    ctx.engine.handleStopSong('radio-1');
    await flush(40);
    expect(stateOf(ctx.engine).queueBlocked).toBe(true);
    expect(stateOf(ctx.engine).transitioning).toBe(false);
    expect(ctx.publisher.publishStopped).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.recordSongQueueAction).toHaveBeenCalledWith(
      'persistence-failed',
    );
  });

  it('falls back to the playlist when the persisted queue no longer has the head', async () => {
    const ctx = setup();
    ctx.store.current!.songQueue = [];
    ctx.engine.handleSequenceUpdated('radio-1', {
      ...AUTO,
      activeItemId: 'song-b',
    });
    ctx.engine.handleQueueUpdated('radio-1', [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ]);
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(80);
    expect(playedUrls(ctx)).toEqual(['https://example.test/b.mp3']);
    expect(stateOf(ctx.engine).queue).toEqual([]);
  });

  it('stops and releases when the claimed item cannot be resolved', async () => {
    const ctx = setup();
    ctx.store.current!.songQueue = [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ];
    ctx.prisma.programState.update.mockImplementationOnce(
      ({ data }: { data: Record<string, unknown> }) => {
        ctx.engine.handleSequenceUpdated('radio-1', null);
        ctx.store.current = { ...ctx.store.current, ...data };
        return Promise.resolve(ctx.store.current);
      },
    );
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handleQueueUpdated('radio-1', ctx.store.current!.songQueue);
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(80);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
    expect(stateOf(ctx.engine).queueBlocked).toBe(true);
    expect(ctx.store.current?.songQueue).toEqual([
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Claimed Play Next item could not be resolved'),
    );
  });

  it('does not play after claiming when a clocked log took ownership', async () => {
    const ctx = setup();
    ctx.prisma.programState.update.mockImplementationOnce(
      ({ data }: { data: Record<string, unknown> }) => {
        ctx.flightService.isClockedLogRunning.mockReturnValue(true);
        ctx.store.current = { ...ctx.store.current, ...data };
        return Promise.resolve(ctx.store.current);
      },
    );
    await startQueued(ctx);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    expect(ctx.publisher.publishStopped).not.toHaveBeenCalled();
  });

  it('blocks the queue when claiming fails', async () => {
    const ctx = setup();
    ctx.prisma.programState.update.mockRejectedValueOnce(new Error('db down'));
    await startQueued(ctx);
    expect(stateOf(ctx.engine).queueBlocked).toBe(true);
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine playNext guards', () => {
  const playNext = (engine: SongExecutionEngine) =>
    (engine as unknown as { playNext(programId: string): boolean }).playNext(
      'radio-1',
    );

  it('reports success without commanding while a clocked log owns the program', () => {
    const ctx = setup();
    ctx.flightService.isClockedLogRunning.mockReturnValue(true);
    expect(playNext(ctx.engine)).toBe(true);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('refuses without a sequence or while the queue is blocked', () => {
    const ctx = setup();
    expect(playNext(ctx.engine)).toBe(false);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    stateOf(ctx.engine).queueBlocked = true;
    expect(playNext(ctx.engine)).toBe(false);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('returns no song when the program has no sequence', () => {
    const ctx = setup();
    expect(
      internals(ctx.engine).resolveNextPlaylistSong('radio-1', {
        sequence: null,
      }),
    ).toBeNull();
  });

  it('does not command a playlist item without audio', async () => {
    const ctx = setup();
    await startAutomatic(ctx, sequenceOf([NO_AUDIO])).catch(() => undefined);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).not.toContain('song_playback_active');
  });

  it('defaults a missing song duration to five minutes', async () => {
    const ctx = setup();
    await startAutomatic(ctx, sequenceOf([NODUR]));
    expect(ctx.engine.getPlaybackState('radio-1')?.durationMs).toBe(300000);
  });

  it('stays idle while the telemetry source has not reconciled the program', async () => {
    const ctx = setup();
    ctx.setTelemetryReconciled(false);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush();
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('stays idle when no telemetry source was registered', async () => {
    const ctx = setup();
    const engine = new SongExecutionEngine(
      ctx.radioService as unknown as RadioService,
      ctx.flightService as unknown as FlightService,
      ctx.prisma as unknown as PrismaService,
      ctx.publisher as unknown as NowPlayingPublisherService,
      ctx.metrics as unknown as RadioMetricsService,
    );
    engine.registerRadioProgram('radio-1');
    engine.handleSequenceUpdated('radio-1', AUTO);
    engine.handlePalazzoSnapshot('radio-1', idle());
    await flush();
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine high rotation selection', () => {
  const HR = (
    active: string,
    loop = true,
    items: unknown[] = [NORMAL, FAV_1, FAV_2],
  ) => ({
    ...sequenceOf(items, 'autoplay', loop),
    activeItemId: active,
  });

  it('skips favorites that are cooling down and reports the unmet quota', async () => {
    const ctx = setup();
    await startWithRotation(ctx, HR('f1'), [
      played(1, 1.5 * INTERVAL),
      played(2, 1.5 * INTERVAL),
    ]);
    expect(playedUrls(ctx)).toEqual(['https://example.test/normal.mp3']);
    expect(highRotationActions(ctx)).toEqual([
      'quota-unmet',
      'cooldown-skipped',
      'cooldown-skipped',
    ]);
  });

  it('steps over an eligible favorite that is not due yet', async () => {
    const ctx = setup();
    await startWithRotation(ctx, HR('f1'), [played(2, 10 * 60 * 1000)]);
    expect(playedUrls(ctx)).toEqual(['https://example.test/normal.mp3']);
    expect(highRotationActions(ctx)).toEqual(['cooldown-skipped']);
  });

  it('ignores rotation history while it is unhealthy', async () => {
    const ctx = setup();
    await startWithRotation(ctx, HR('f1'), [], false);
    expect(playedUrls(ctx)).toEqual(['https://example.test/normal.mp3']);
    expect(highRotationActions(ctx)).toEqual([]);
  });

  it('plays nothing when the sequence cursor was cleared', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', {
      ...sequenceOf([NORMAL, SONG_B]),
      activeItemId: null,
    });
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(40);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('plays nothing when a non-looping playlist ends on a cooling favorite', async () => {
    const ctx = setup();
    await startWithRotation(ctx, HR('f2', false, [FAV_1, FAV_2]), [
      played(1, 1.5 * INTERVAL),
      played(2, 1.5 * INTERVAL),
    ]);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('reports when no legally playable song remains in a looping playlist', async () => {
    const ctx = setup();
    await startWithRotation(ctx, HR('f1', true, [FAV_1, FAV_2]), [
      played(1, 1.5 * INTERVAL),
      played(2, 1.5 * INTERVAL),
    ]);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No legally playable playlist song remains'),
    );
  });
});

describe('SongExecutionEngine authoritative track end', () => {
  it('ignores an end event without a request id', async () => {
    const ctx = setup();
    await startAutomatic(ctx);
    end(ctx, '');
    expect(ctx.metrics.recordTrackTransition).toHaveBeenLastCalledWith(
      'ignored-mismatch',
    );
    expect(ctx.engine.getPlaybackState('radio-1')).not.toBeNull();
  });

  it('remembers a bounded window of ended request ids', () => {
    const ctx = setup();
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    for (let index = 0; index < 130; index += 1) end(ctx, `id-${index}`);
    expect(stateOf(ctx.engine).endedRequestIds).toHaveLength(128);
    end(ctx, 'id-0');
    expect(ctx.metrics.recordTrackTransition).toHaveBeenLastCalledWith(
      'ignored-no-active',
    );
    end(ctx, 'id-129');
    expect(ctx.metrics.recordTrackTransition).toHaveBeenLastCalledWith(
      'ignored-duplicate',
    );
  });

  it('clears the foreign-track guard when the foreign track ends', () => {
    const ctx = setup();
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    stateOf(ctx.engine).busyWithForeignTrack = true;
    end(ctx, 'foreign');
    expect(stateOf(ctx.engine).busyWithForeignTrack).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Foreign track ended'),
    );
    warnSpy.mockClear();
    end(ctx, 'another');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps the foreign-track guard when another song is active', async () => {
    const ctx = setup();
    await startAutomatic(ctx);
    stateOf(ctx.engine).busyWithForeignTrack = true;
    end(ctx, 'unrelated');
    expect(stateOf(ctx.engine).busyWithForeignTrack).toBe(true);
  });

  it('logs a missing sequence and publishes stopped when nothing can follow', async () => {
    const ctx = setup();
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    ctx.engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
    end(ctx, activeRequestId(ctx.engine));
    await flush(40);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'source=playlist mode=none loop=false cursor=none successor=false',
      ),
    );
    expect(ctx.flightService.handleSongEnded).toHaveBeenCalledWith('radio-1');
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
    expect(ctx.events.map((e) => e.type)).toContain('song_off_air');
  });

  it('describes the queue source and cursor of a queue-driven end', async () => {
    const ctx = setup();
    await startQueued(ctx, [{ id: 'q1', itemId: 'song-a', enqueuedAt: 1 }]);
    end(ctx, activeRequestId(ctx.engine));
    await flush(80);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'source=queue mode=autoplay loop=true cursor=song-a successor=true',
      ),
    );
    expect(playedUrls(ctx)).toEqual([
      'https://example.test/a.mp3',
      'https://example.test/a.mp3',
    ]);
  });

  it('does not continue a manual-mode playlist after a song ends', async () => {
    const ctx = setup();
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    ctx.engine.handleSequenceUpdated('radio-1', sequenceOf([SONG_A], 'manual'));
    ctx.engine.handleManualSong('radio-1', SONG_A.audioUrl);
    end(ctx, activeRequestId(ctx.engine));
    await flush(40);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
  });

  it('stops safely when the successor cannot be resolved', async () => {
    const ctx = setup();
    const requestId = await startAutomatic(ctx, sequenceOf([SONG_A, NO_AUDIO]));
    end(ctx, requestId);
    await flush(40);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Successor could not be resolved'),
    );
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
  });

  describe('while the bumper settings load', () => {
    async function endWithPendingSettings() {
      const ctx = setup();
      const requestId = await startAutomatic(ctx);
      const settings = deferred<unknown>();
      ctx.radioService.getRadioSettings.mockReturnValueOnce(settings.promise);
      end(ctx, requestId);
      await flush();
      return { ctx, settings };
    }

    it('does not publish stopped when the program froze meanwhile', async () => {
      const { ctx, settings } = await endWithPendingSettings();
      ctx.engine.handlePalazzoStatus('radio-1', {
        programId: 'radio-1',
        connection: 'unavailable',
      } as never);
      settings.resolve(null);
      await flush(40);
      expect(ctx.publisher.publishStopped).not.toHaveBeenCalled();
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    });

    it('does not publish stopped when another song became active', async () => {
      const { ctx, settings } = await endWithPendingSettings();
      ctx.engine.handleManualSong('radio-1', 'https://example.test/m.mp3');
      settings.resolve(null);
      await flush(40);
      expect(ctx.publisher.publishStopped).not.toHaveBeenCalled();
      expect(ctx.engine.getPlaybackState('radio-1')?.audioUrl).toBe(
        'https://example.test/m.mp3',
      );
    });

    it('persists the playlist cursor for a queue that arrived meanwhile and claims it', async () => {
      const { ctx, settings } = await endWithPendingSettings();
      ctx.store.current!.songQueue = [
        { id: 'q1', itemId: 'song-b', enqueuedAt: 1 },
      ];
      ctx.engine.handleQueueUpdated('radio-1', ctx.store.current!.songQueue);
      ctx.prisma.programState.update.mockClear();
      settings.resolve(null);
      await flush(80);
      expect(
        ctx.prisma.programState.update.mock.calls[0][0].data,
      ).toHaveProperty('songSequence');
      expect(playedUrls(ctx)).toEqual([
        'https://example.test/a.mp3',
        'https://example.test/b.mp3',
      ]);
    });

    it('blocks the queue when that late cursor persistence fails', async () => {
      const { ctx, settings } = await endWithPendingSettings();
      ctx.engine.handleQueueUpdated('radio-1', [
        { id: 'q1', itemId: 'song-b', enqueuedAt: 1 },
      ]);
      ctx.prisma.programState.update.mockRejectedValueOnce(
        new Error('db down'),
      );
      settings.resolve(null);
      await flush(80);
      expect(stateOf(ctx.engine).queueBlocked).toBe(true);
      expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    });

    it('stops without falling through when the queue head cannot be resolved', async () => {
      const { ctx, settings } = await endWithPendingSettings();
      ctx.engine.handleQueueUpdated('radio-1', [
        {
          id: 'q9',
          itemId: 'ghost',
          enqueuedAt: 1,
          active: true,
          playbackRequestId: 'ghost-request',
        },
      ]);
      settings.resolve(null);
      await flush(80);
      expect(stateOf(ctx.engine).queueBlocked).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Queued playlist item could not be resolved'),
      );
      expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('radio-1');
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    });
  });
});

describe('SongExecutionEngine bumpers', () => {
  const bumperSettings = (overrides: Record<string, unknown> = {}) => ({
    bumperEnabled: true,
    bumperInterval: 1,
    bumperInstantIds: [10, 11],
    bumperMode: 'sequential',
    ...overrides,
  });

  async function endFirstSong(ctx: ReturnType<typeof setup>) {
    const requestId = await startAutomatic(ctx);
    end(ctx, requestId);
    await flush(40);
  }

  it.each([
    ['no settings', null],
    ['disabled bumpers', bumperSettings({ bumperEnabled: false })],
    ['zero interval', bumperSettings({ bumperInterval: 0 })],
    ['no instants', bumperSettings({ bumperInstantIds: [] })],
    ['an interval that has not elapsed', bumperSettings({ bumperInterval: 2 })],
  ])('plays no bumper for %s', async (_name, settings) => {
    const ctx = setup();
    ctx.radioService.getRadioSettings.mockResolvedValue(settings);
    await endFirstSong(ctx);
    expect(ctx.radioService.playInstant).not.toHaveBeenCalled();
    expect(ctx.prisma.instant.findUnique).not.toHaveBeenCalled();
    expect(playedUrls(ctx)).toHaveLength(2);
  });

  it('plays a random bumper and waits before the next song', async () => {
    const ctx = setup();
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    ctx.radioService.getRadioSettings.mockResolvedValue(
      bumperSettings({ bumperMode: 'random' }),
    );
    ctx.prisma.instant.findUnique.mockResolvedValue({
      name: 'Jingle',
      audioUrl: 'https://example.test/jingle.mp3',
    });
    await endFirstSong(ctx);
    expect(ctx.prisma.instant.findUnique).toHaveBeenCalledWith({
      where: { id: 11 },
    });
    expect(ctx.radioService.playInstant).toHaveBeenCalledWith(
      'radio-1',
      'https://example.test/jingle.mp3',
      undefined,
      expect.any(String),
    );
    expect(stateOf(ctx.engine).nextBumperIdx).toBe(0);
    expect(playedUrls(ctx)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(8000);
    await flush(40);
    expect(playedUrls(ctx)).toHaveLength(2);
  });

  it('rotates sequentially through the configured instants', async () => {
    const ctx = setup();
    ctx.radioService.getRadioSettings.mockResolvedValue(bumperSettings());
    ctx.prisma.instant.findUnique.mockImplementation(
      ({ where }: { where: { id: number } }) =>
        Promise.resolve({
          name: `i${where.id}`,
          audioUrl: `https://example.test/${where.id}.mp3`,
        }),
    );
    await endFirstSong(ctx);
    await jest.advanceTimersByTimeAsync(8000);
    await flush(40);
    end(ctx, activeRequestId(ctx.engine));
    await flush(40);
    await jest.advanceTimersByTimeAsync(8000);
    expect(
      ctx.prisma.instant.findUnique.mock.calls.map(
        ([arg]: [{ where: { id: number } }]) => arg.where.id,
      ),
    ).toEqual([10, 11]);
  });

  it.each([
    ['a missing instant', null],
    ['an instant without audio', { name: 'Silent', audioUrl: '' }],
  ])('skips the bumper for %s', async (_name, instant) => {
    const ctx = setup();
    ctx.radioService.getRadioSettings.mockResolvedValue(bumperSettings());
    ctx.prisma.instant.findUnique.mockResolvedValue(instant);
    await endFirstSong(ctx);
    expect(ctx.radioService.playInstant).not.toHaveBeenCalled();
    expect(playedUrls(ctx)).toHaveLength(2);
  });

  it('swallows bumper errors and continues with the playlist', async () => {
    const ctx = setup();
    ctx.radioService.getRadioSettings.mockRejectedValue(
      new Error('no settings'),
    );
    await endFirstSong(ctx);
    expect(playedUrls(ctx)).toHaveLength(2);
  });

  it('plays no bumper when the program state vanished while loading settings', async () => {
    const ctx = setup();
    const requestId = await startAutomatic(ctx);
    const settings = deferred<unknown>();
    ctx.radioService.getRadioSettings.mockReturnValueOnce(settings.promise);
    end(ctx, requestId);
    await flush();
    internals(ctx.engine).states.delete('radio-1');
    settings.resolve(bumperSettings());
    await flush(40);
    expect(ctx.radioService.playInstant).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine TV-only duration timer', () => {
  it('advances the playlist from the estimated duration', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('tv-1', AUTO);
    await flush();
    expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
    await jest.advanceTimersByTimeAsync(1000);
    await flush(40);
    expect(ctx.flightService.handleSongEnded).toHaveBeenCalledWith('tv-1');
    expect(playedUrls(ctx)).toEqual([
      'https://example.test/a.mp3',
      'https://example.test/b.mp3',
    ]);
  });

  it('publishes stopped when a manual TV song ends without a sequence', async () => {
    const ctx = setup();
    ctx.engine.handleManualSong(
      'tv-1',
      'https://example.test/m.mp3',
      'T',
      'A',
      500,
    );
    await jest.advanceTimersByTimeAsync(500);
    await flush(40);
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('tv-1');
  });

  it('does not advance a manual-mode TV sequence', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('tv-1', sequenceOf([SONG_A], 'manual'));
    ctx.engine.handleManualSong('tv-1', SONG_A.audioUrl, 'T', 'A', 500);
    await jest.advanceTimersByTimeAsync(500);
    await flush(40);
    expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('tv-1');
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('does nothing when its state disappears before the timer fires', async () => {
    const ctx = setup();
    ctx.engine.handleManualSong(
      'tv-1',
      'https://example.test/m.mp3',
      'T',
      'A',
      500,
    );
    internals(ctx.engine).states.delete('tv-1');
    await jest.advanceTimersByTimeAsync(500);
    expect(ctx.flightService.handleSongEnded).not.toHaveBeenCalled();
  });

  it('ignores a timer request for an unknown program', () => {
    const ctx = setup();
    internals(ctx.engine).setTimer('ghost', 10);
    expect(jest.getTimerCount()).toBe(0);
  });

  describe('while the bumper settings load', () => {
    async function endWithPendingSettings(sequence: unknown) {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('tv-1', sequence);
      await flush();
      const settings = deferred<unknown>();
      ctx.radioService.getRadioSettings.mockReturnValueOnce(settings.promise);
      jest.advanceTimersByTime(1000);
      await flush();
      return { ctx, settings };
    }

    it('keeps a song that became active', async () => {
      const { ctx, settings } = await endWithPendingSettings(AUTO);
      ctx.engine.handleManualSong('tv-1', 'https://example.test/m.mp3');
      settings.resolve(null);
      await flush(40);
      expect(ctx.publisher.publishStopped).not.toHaveBeenCalled();
    });

    it('stops when the sequence stopped being automatic', async () => {
      const { ctx, settings } = await endWithPendingSettings(AUTO);
      ctx.engine.handleSequenceUpdated('tv-1', sequenceOf([SONG_A], 'manual'));
      settings.resolve(null);
      await flush(40);
      expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('tv-1');
    });

    it('stops when the sequence was removed', async () => {
      const { ctx, settings } = await endWithPendingSettings(AUTO);
      ctx.engine.handleSequenceUpdated('tv-1', null);
      settings.resolve(null);
      await flush(40);
      expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('tv-1');
    });

    it('stops when the next song cannot be started', async () => {
      const { ctx, settings } = await endWithPendingSettings(AUTO);
      ctx.flightService.isClockedLogRunning.mockReturnValue(true);
      settings.resolve(null);
      await flush(40);
      expect(ctx.publisher.publishStopped).toHaveBeenCalledWith('tv-1');
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    });

    it('stops when the state vanished', async () => {
      const { ctx, settings } = await endWithPendingSettings(AUTO);
      internals(ctx.engine).states.delete('tv-1');
      settings.resolve(null);
      await flush(40);
      expect(ctx.publisher.publishStopped).not.toHaveBeenCalled();
    });
  });
});

describe('SongExecutionEngine playback reporting', () => {
  it('interpolates authoritative progress and flags stale radio telemetry', async () => {
    const ctx = setup();
    const requestId = await startAutomatic(ctx, sequenceOf([NODUR]));
    ctx.engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: requestId },
    });
    jest.advanceTimersByTime(2000);
    expect(ctx.engine.getPlaybackState('radio-1')).toMatchObject({
      positionMs: 2000,
      telemetryStale: false,
      isPlaying: true,
    });
    jest.advanceTimersByTime(14_000);
    expect(ctx.engine.getPlaybackState('radio-1')?.telemetryStale).toBe(true);
  });

  it('never marks a TV program as stale', () => {
    const ctx = setup();
    ctx.engine.handleManualSong('tv-1', 'https://example.test/m.mp3');
    jest.advanceTimersByTime(60_000);
    expect(ctx.engine.getPlaybackState('tv-1')?.telemetryStale).toBe(false);
  });

  it('reports playlist metadata for a manual song that is in the playlist', () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', FAVORITES_FOR_MANUAL);
    ctx.engine.handleManualSong(
      'radio-1',
      SONG_A.audioUrl,
      'T',
      'A',
      1000,
      '',
      11,
    );
    const song = stateOf(ctx.engine).activeSong as unknown as {
      itemId: string;
      songId: number | null;
      highRotation: boolean;
    };
    expect(song).toMatchObject({
      itemId: 'fav',
      songId: 11,
      highRotation: true,
    });
  });
});

const FAVORITES_FOR_MANUAL = sequenceOf([
  { ...SONG_A, id: 'fav', highRotation: true },
  SONG_B,
]);
