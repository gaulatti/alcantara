import { Logger } from '@nestjs/common';
import {
  COMMAND_RETRY_BASE_MS,
  COMMAND_RETRY_MAX_MS,
  NO_PLAYBACK_BOUND_MS,
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
    live: { onAir: false },
  };
}

function playing(
  requestId: string,
  url: string,
  sequence = 2,
): PalazzoPlaybackState {
  return {
    ...idle(sequence),
    status: 'playing',
    track: {
      playbackRequestId: requestId,
      url,
      title: 'Fictional',
      artist: 'Fictional',
      coverUrl: null,
      startedAt: new Date().toISOString(),
    } as unknown as PalazzoPlaybackState['track'],
    positionSeconds: 30,
    remainingSeconds: 60,
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
    recordCursorWrite: jest.fn(),
    recordInheritedAdoption: jest.fn(),
    recordIntroTransition: jest.fn(),
    recordSongQueueAction: jest.fn(),
    recordSongQueueDepth: jest.fn(),
    recordHighRotationAction: jest.fn(),
    recordHighRotationFavorites: jest.fn(),
    recordAutomaticPrograms: jest.fn(),
    recordEngineResync: jest.fn(),
    recordEngineDegraded: jest.fn(),
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
  // What Palazzo reports when the engine asks for its state (#230).
  const palazzo: { state: PalazzoPlaybackState | null } = { state: null };
  const currentState = jest.fn((_programId: string) =>
    Promise.resolve(palazzo.state),
  );
  engine.setPalazzoTelemetry({
    isReconciled: () => reconciled,
    currentState,
  });
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
    palazzo,
    currentState,
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
  noPlaybackSince: number | null;
  commandRetryTimer: ReturnType<typeof setTimeout> | null;
  commandRetries: number;
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
    (
      engine as unknown as {
        playNext(programId: string, state: unknown): boolean;
      }
    ).playNext(
      'radio-1',
      (
        engine as unknown as { ensureState(programId: string): unknown }
      ).ensureState('radio-1'),
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
  // gaulatti/alcantara#230: the backend restarted while Palazzo played a track
  // the new engine could not adopt (here an announced song outside the
  // sequence), so it withheld commands. When that track ended, it waited for an
  // idle snapshot that Palazzo only sends on a new SSE connection: the radio
  // played no programmed song for ten hours. The end must end the wait.
  it('resumes the rotation when a foreign track that a restart found on air ends', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playing('inherited-intro-song', 'https://example.test/announced.mp3'),
    );
    await flush(40);
    expect(stateOf(ctx.engine).busyWithForeignTrack).toBe(true);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();

    // The foreign track ends; the connection stays up, so no snapshot comes by
    // itself. Asked for its state, Palazzo reports idle.
    ctx.palazzo.state = idle(3);
    end(ctx, 'inherited-intro-song');
    await flush(80);

    expect(ctx.currentState).toHaveBeenCalledWith('radio-1');
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'foreign_ended',
      'resumed',
    );
    expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
  });

  // 2026-11-21 00:28Z: a deploy restarted the backend mid-song. The track was
  // foreign at boot (no sequence loaded yet) and ended 12 s later. The state
  // read for the foreign end still named the ended track; the engine adopted
  // it, and every watchdog resume after that ignored it as an already-ended
  // song, so the filler held the air for five minutes.
  it('never adopts a track whose end it accepted, even when the state read after the end still names it', async () => {
    const ctx = setup();
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playing('inherited', 'https://example.test/b.mp3'),
    );
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    await flush(40);
    expect(stateOf(ctx.engine).busyWithForeignTrack).toBe(true);
    // The end arrives; Palazzo's state read still names the ended track.
    ctx.palazzo.state = playing('inherited', 'https://example.test/b.mp3', 3);
    end(ctx, 'inherited');
    await flush(80);
    expect((ctx.engine.getPlaybackState('radio-1') as { playbackRequestId?: string } | null)?.playbackRequestId).not.toBe(
      'inherited',
    );
    expect(playedUrls(ctx)).toHaveLength(1);
  });

  it('drops an ended song held as active and commands one when Palazzo is idle past the watchdog bound', async () => {
    const ctx = setup();
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playing('inherited', 'https://example.test/b.mp3'),
    );
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    await flush(40);
    // Simulates the state before the fix: the ended track was adopted, so the
    // engine holds an active song whose id it has already seen end.
    ctx.palazzo.state = playing('inherited', 'https://example.test/b.mp3', 3);
    end(ctx, 'inherited');
    await flush(80);
    const held = stateOf(ctx.engine);
    held.activeSong = {
      ...(held.activeSong ?? {}),
      playbackRequestId: 'inherited',
      audioUrl: 'https://example.test/b.mp3',
    } as never;
    ctx.radioService.playSong.mockClear();
    // Palazzo idle (no live input) for longer than the bound.
    ctx.palazzo.state = { ...idle(4), live: { onAir: false } };
    await ctx.engine.checkPlayback();
    jest.setSystemTime(Date.now() + 46_000);
    await ctx.engine.checkPlayback();
    await flush(80);
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'watchdog',
      'resumed',
    );
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    expect((ctx.engine.getPlaybackState('radio-1') as { playbackRequestId?: string } | null)?.playbackRequestId).not.toBe(
      'inherited',
    );
  });

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

// gaulatti/alcantara#230: a watchdog on Palazzo's own report of no playback.
describe('SongExecutionEngine playback watchdog', () => {
  const tick = async (ctx: ReturnType<typeof setup>) => {
    await ctx.engine.checkPlayback();
    await flush(80);
  };

  it('starts the sequence when an empty engine and an idle Palazzo stay that way past the bound', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.palazzo.state = idle(5);
    await tick(ctx);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS - 1);
    await tick(ctx);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await tick(ctx);
    expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'watchdog',
      'resumed',
    );
  });

  it('ends a song the engine still believes in when Palazzo reports no playback, and starts the next', async () => {
    const ctx = setup();
    const first = await startAutomatic(ctx);
    ctx.palazzo.state = idle(9);
    await tick(ctx);
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS);
    await tick(ctx);
    expect(activeRequestId(ctx.engine)).not.toBe(first);
    expect(playedUrls(ctx)).toEqual([
      'https://example.test/a.mp3',
      'https://example.test/b.mp3',
    ]);
  });

  it('does nothing while Palazzo reports playback, and restarts the bound when it does', async () => {
    const ctx = setup();
    await startAutomatic(ctx);
    ctx.palazzo.state = idle(9);
    await tick(ctx);
    ctx.palazzo.state = playing(
      activeRequestId(ctx.engine),
      'https://example.test/a.mp3',
      10,
    );
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS);
    await tick(ctx);
    ctx.palazzo.state = idle(11);
    await tick(ctx);
    expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
  });

  it('never acts in manual mode, while a command is pending, frozen, or with a stale stream', async () => {
    const manual = setup();
    manual.engine.handleSequenceUpdated(
      'radio-1',
      sequenceOf([SONG_A], 'manual'),
    );
    manual.palazzo.state = idle(5);
    await tick(manual);
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS);
    await tick(manual);
    expect(manual.radioService.playSong).not.toHaveBeenCalled();

    // A command sent after the first idle read restarts the bound.
    const pending = setup();
    await startAutomatic(pending);
    pending.palazzo.state = idle(5);
    await tick(pending);
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS - 1000);
    stateOf(pending.engine).noPlaybackSince = null; // as a new command does
    jest.advanceTimersByTime(1000);
    await tick(pending);
    expect(pending.radioService.playSong).toHaveBeenCalledTimes(1);

    const frozen = setup();
    frozen.engine.handleSequenceUpdated('radio-1', AUTO);
    stateOf(frozen.engine).frozen = true;
    frozen.palazzo.state = idle(5);
    await tick(frozen);
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS);
    await tick(frozen);
    expect(frozen.radioService.playSong).not.toHaveBeenCalled();

    const stale = setup();
    stale.engine.handleSequenceUpdated('radio-1', AUTO);
    stale.setTelemetryReconciled(false);
    stale.palazzo.state = idle(5);
    await tick(stale);
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS);
    await tick(stale);
    expect(stale.radioService.playSong).not.toHaveBeenCalled();
    expect(stale.currentState).not.toHaveBeenCalled();
  });

  // GM's two conditions on #230: the bound covers a song still being prepared,
  // and nothing on the air (intro, instant, live input) is read as a stall.
  const stays = async (state: PalazzoPlaybackState) => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.palazzo.state = state;
    await tick(ctx);
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS * 3);
    await tick(ctx);
    return ctx;
  };

  it("sits above Palazzo's 29 s song request limit with margin", () => {
    expect(NO_PLAYBACK_BOUND_MS).toBeGreaterThanOrEqual(29_000 + 15_000);
  });

  it('does not act on a song still being prepared within the request limit', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.palazzo.state = idle(5);
    await tick(ctx);
    jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS);
    await tick(ctx);
    // The watchdog sent the first song; Palazzo keeps reporting idle while
    // it loads, up to its 29 s limit. No second command in that time.
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    await tick(ctx);
    jest.advanceTimersByTime(29_000);
    await tick(ctx);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('takes no action while an intro, an instant or the live input is on the air', async () => {
    const intro = await stays({
      ...idle(5),
      intro: {
        playbackId: 'intro-1',
        parentPlaybackId: 'parent-1',
        programId: 'radio-1',
        playbackRequestId: 'intro-request-1',
        url: 'https://example.test/intro.mp3',
        startedAt: new Date().toISOString(),
        status: 'playing',
      },
    });
    expect(intro.radioService.playSong).not.toHaveBeenCalled();

    const instant = await stays({
      ...idle(5),
      levels: { ...idle(5).levels, instant: { rms: 0.2, peak: 0.4 } },
    });
    expect(instant.radioService.playSong).not.toHaveBeenCalled();
    const instantPeakOnly = await stays({
      ...idle(5),
      levels: { ...idle(5).levels, instant: { rms: 0, peak: 0.1 } },
    });
    expect(instantPeakOnly.radioService.playSong).not.toHaveBeenCalled();

    const live = await stays({ ...idle(5), live: { onAir: true } });
    expect(live.radioService.playSong).not.toHaveBeenCalled();
    expect(live.metrics.recordEngineResync).not.toHaveBeenCalledWith(
      'watchdog',
      'undecided',
    );
  });

  it('holds when Palazzo cannot rule a live show out or reports itself degraded', async () => {
    const { live: _omitted, ...older } = idle(5);
    const unknown = await stays(older);
    expect(unknown.radioService.playSong).not.toHaveBeenCalled();
    expect(unknown.metrics.recordEngineResync).toHaveBeenCalledWith(
      'watchdog',
      'undecided',
    );

    const degraded = await stays({ ...idle(5), availability: 'degraded' });
    expect(degraded.radioService.playSong).not.toHaveBeenCalled();
    expect(degraded.metrics.recordEngineResync).toHaveBeenCalledWith(
      'watchdog',
      'undecided',
    );
  });

  it('counts a state it cannot read and acts on nothing', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.palazzo.state = null;
    await tick(ctx);
    ctx.currentState.mockRejectedValueOnce(new Error('unreachable'));
    await tick(ctx);
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'watchdog',
      'unavailable',
    );
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine reads of Palazzo state (#230)', () => {
  const foreignThenEnd = async (ctx: ReturnType<typeof setup>) => {
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playing('announced', 'https://example.test/announced.mp3'),
    );
    await flush(40);
    end(ctx, 'announced');
    await flush(80);
  };

  it('counts a state it cannot read after a foreign end and starts nothing', async () => {
    const ctx = setup();
    ctx.currentState.mockRejectedValueOnce(new Error('unreachable'));
    await foreignThenEnd(ctx);
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'foreign_ended',
      'unavailable',
    );
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('reconciles from a playing state after a foreign end without starting a song', async () => {
    const ctx = setup();
    ctx.palazzo.state = playing('another', 'https://example.test/other.mp3', 9);
    await foreignThenEnd(ctx);
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'foreign_ended',
      'playing',
    );
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('treats a telemetry source that cannot read state as unavailable', async () => {
    const ctx = setup();
    ctx.engine.setPalazzoTelemetry({ isReconciled: () => true });
    await foreignThenEnd(ctx);
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'foreign_ended',
      'unavailable',
    );
    await ctx.engine.checkPlayback();
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'watchdog',
      'unavailable',
    );
  });

  it('skips a registered radio program that has no engine state yet', async () => {
    const ctx = setup();
    ctx.engine.registerRadioProgram('radio-2');
    await expect(ctx.engine.checkPlayback()).resolves.toBeUndefined();
    expect(ctx.currentState).not.toHaveBeenCalled();
  });
});

// gaulatti/alcantara#230 acceptance: a backend restarted mid-song, with an intro
// and without, resumes the rotation within the bound whether the song ends
// while the backend is down or while it is starting.
describe('SongExecutionEngine after a restart mid-song', () => {
  const withIntro = (state: PalazzoPlaybackState): PalazzoPlaybackState => ({
    ...state,
    intro: {
      playbackId: 'intro-1',
      status: 'ended',
      url: 'https://example.test/intro.mp3',
    } as unknown as PalazzoPlaybackState['intro'],
  });

  for (const intro of [false, true]) {
    const label = intro ? 'with an intro' : 'without an intro';

    it(`song ended while the backend was down (${label}): the connect snapshot is idle and the next song starts`, async () => {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      ctx.engine.handlePalazzoSnapshot('radio-1', idle(4));
      await flush(60);
      expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
    });

    it(`song ends while the backend is starting (${label}): an adopted song advances on its end`, async () => {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      const snap = playing('inherited', 'https://example.test/a.mp3');
      ctx.engine.handlePalazzoSnapshot(
        'radio-1',
        intro ? withIntro(snap) : snap,
      );
      await flush(40);
      end(ctx, 'inherited');
      await flush(80);
      expect(playedUrls(ctx)).toEqual(['https://example.test/b.mp3']);
    });

    it(`song ends while the backend is starting (${label}): a song it cannot adopt still lets the rotation resume`, async () => {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      const snap = playing('announced', 'https://example.test/announced.mp3');
      ctx.engine.handlePalazzoSnapshot(
        'radio-1',
        intro ? withIntro(snap) : snap,
      );
      await flush(40);
      ctx.palazzo.state = idle(6);
      end(ctx, 'announced');
      await flush(80);
      expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
    });

    it(`the end event itself is lost (${label}): the watchdog resumes within the bound`, async () => {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      const snap = playing('announced', 'https://example.test/announced.mp3');
      ctx.engine.handlePalazzoSnapshot(
        'radio-1',
        intro ? withIntro(snap) : snap,
      );
      await flush(40);
      // No track.ended arrives; Palazzo goes idle and says so when asked.
      ctx.palazzo.state = idle(7);
      await ctx.engine.checkPlayback();
      jest.advanceTimersByTime(NO_PLAYBACK_BOUND_MS);
      await ctx.engine.checkPlayback();
      await flush(80);
      expect(playedUrls(ctx)).toEqual(['https://example.test/a.mp3']);
    });
  }
});

// gaulatti/alcantara#230, 2026-11-20 20:13Z: every Palazzo restart unfroze
// automation before Palazzo could play; the first command failed and nothing
// followed it until a person restarted the backend.
describe('SongExecutionEngine after a failed song command', () => {
  const failFirst = async (failures: number) => {
    const ctx = setup();
    for (let i = 0; i < failures; i++)
      ctx.radioService.playSong.mockResolvedValueOnce({ ok: false });
    ctx.palazzo.state = idle(5);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(80);
    return ctx;
  };

  it("resumes from Palazzo's state after the base delay", async () => {
    const ctx = await failFirst(1);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS - 1);
    await flush(60);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush(80);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(2);
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'command_failed',
      'resumed',
    );
  });

  it('backs off while commands keep failing, up to the cap', async () => {
    const ctx = await failFirst(5);
    let expected = 1;
    for (const delay of [2_000, 4_000, 8_000, 16_000, COMMAND_RETRY_MAX_MS]) {
      jest.advanceTimersByTime(delay - 1);
      await flush(60);
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(expected);
      jest.advanceTimersByTime(1);
      await flush(80);
      expected += 1;
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(expected);
    }
    // The sixth command (the fifth retry) succeeded; no retry is pending.
    expect(stateOf(ctx.engine).commandRetryTimer).toBeNull();
    expect(stateOf(ctx.engine).activeSong).not.toBeNull();
  });

  it('starts the backoff over once a song is on the air', async () => {
    const ctx = await failFirst(1);
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS);
    await flush(80);
    const second = activeRequestId(ctx.engine);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playing(second, 'https://example.test/b.mp3', 6),
    );
    await flush(40);
    expect(stateOf(ctx.engine).commandRetries).toBe(0);
  });

  it('stands down when something else has taken over, and in manual mode', async () => {
    const taken = await failFirst(1);
    taken.engine.handlePalazzoSnapshot('radio-1', idle(6));
    await flush(80);
    const calls = taken.radioService.playSong.mock.calls.length;
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS);
    await flush(80);
    expect(taken.radioService.playSong).toHaveBeenCalledTimes(calls);

    const frozen = await failFirst(1);
    stateOf(frozen.engine).frozen = true;
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS);
    await flush(80);
    expect(frozen.radioService.playSong).toHaveBeenCalledTimes(1);

    const stale = await failFirst(1);
    stale.setTelemetryReconciled(false);
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS);
    await flush(80);
    expect(stale.radioService.playSong).toHaveBeenCalledTimes(1);

    const manual = setup();
    manual.radioService.playSong.mockResolvedValueOnce({ ok: false });
    manual.engine.handleSequenceUpdated(
      'radio-1',
      sequenceOf([SONG_A, SONG_B], 'manual'),
    );
    manual.engine.handlePalazzoSnapshot('radio-1', idle());
    await manual.engine.checkPlayback();
    await flush(80);
    // Manual mode stands down: the automatic check must not start a song.
    expect(manual.radioService.playSong).not.toHaveBeenCalled();
    jest.advanceTimersByTime(COMMAND_RETRY_MAX_MS);
    await flush(80);
    expect(stateOf(manual.engine).commandRetryTimer).toBeNull();
  });

  it('retries in shuffle too, keeps one retry pending, and needs a sequence', async () => {
    const shuffle = setup();
    shuffle.radioService.playSong.mockResolvedValueOnce({ ok: false });
    shuffle.palazzo.state = idle(5);
    shuffle.engine.handleSequenceUpdated(
      'radio-1',
      sequenceOf([SONG_A, SONG_B], 'shuffle'),
    );
    shuffle.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(80);
    const timer = stateOf(shuffle.engine).commandRetryTimer;
    expect(timer).not.toBeNull();
    // A second failure while the retry waits schedules no second one.
    const engine = shuffle.engine as unknown as {
      scheduleCommandRetry(id: string, state: unknown): void;
    };
    engine.scheduleCommandRetry('radio-1', stateOf(shuffle.engine));
    expect(stateOf(shuffle.engine).commandRetryTimer).toBe(timer);
    expect(stateOf(shuffle.engine).commandRetries).toBe(1);

    const none = setup();
    const bare = {
      sequence: null,
      commandRetryTimer: null,
      commandRetries: 0,
    };
    engine.scheduleCommandRetry.call(none.engine, 'radio-1', bare);
    expect(bare.commandRetryTimer).toBeNull();
    expect(bare.commandRetries).toBe(0);
  });

  // Tonight's case end to end: Palazzo restarts under a playing song, the
  // engine freezes and unfreezes, its first commands land before Palazzo can
  // play and fail, and the retries bring a song on the air with nobody acting.
  const status = (connection: string) =>
    ({ programId: 'radio-1', connection }) as never;

  it('recovers a Palazzo restart: commands fail, freeze, unfreeze, song', async () => {
    const ctx = setup();
    const first = await startAutomatic(ctx);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playing(first, 'https://example.test/a.mp3', 3),
    );
    await flush(40);

    ctx.engine.handlePalazzoStatus('radio-1', status('unavailable'));
    expect(stateOf(ctx.engine).frozen).toBe(true);
    ctx.engine.handlePalazzoStatus('radio-1', status('connected'));
    ctx.radioService.playSong
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });
    ctx.palazzo.state = { ...idle(1), bootId: 'boot-2' };
    ctx.engine.handlePalazzoSnapshot('radio-1', {
      ...idle(1),
      bootId: 'boot-2',
    });
    await flush(80);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(2);
    expect(stateOf(ctx.engine).activeSong).toBeNull();

    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS);
    await flush(80);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS * 2);
    await flush(80);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(4);
    const onAir = activeRequestId(ctx.engine);
    ctx.engine.handlePalazzoSnapshot('radio-1', {
      ...playing(onAir, playedUrls(ctx)[3], 2),
      bootId: 'boot-2',
    });
    await flush(40);
    expect(stateOf(ctx.engine).commandRetries).toBe(0);
    expect(stateOf(ctx.engine).commandRetryTimer).toBeNull();
  });

  it('a retry that meets a freeze stands down, and the unfreeze path resumes', async () => {
    const ctx = await failFirst(1);
    ctx.engine.handlePalazzoStatus('radio-1', status('unavailable'));
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS);
    await flush(80);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(stateOf(ctx.engine).commandRetryTimer).toBeNull();
    // Nothing re-arms the retry; the unfreeze and its snapshot start the song.
    ctx.engine.handlePalazzoStatus('radio-1', status('connected'));
    ctx.engine.handlePalazzoSnapshot('radio-1', idle(9));
    await flush(80);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(2);
    expect(stateOf(ctx.engine).activeSong).not.toBeNull();
  });

  it('clears a pending retry when the module stops', async () => {
    const ctx = await failFirst(1);
    expect(stateOf(ctx.engine).commandRetryTimer).not.toBeNull();
    ctx.engine.onModuleDestroy();
    expect(stateOf(ctx.engine).commandRetryTimer).toBeNull();
    jest.advanceTimersByTime(COMMAND_RETRY_BASE_MS);
    await flush(80);
    expect(ctx.radioService.playSong).toHaveBeenCalledTimes(1);
  });
});

// gaulatti/alcantara#237: every engine path that degrades instead of failing
// says so once at warn, with the program and the error class only, and counts.
describe('degraded engine paths are logged and counted', () => {
  const degraded = (ctx: ReturnType<typeof setup>) => {
    const warn = jest
      .spyOn(ctx.engine['logger'], 'warn')
      .mockImplementation(() => undefined);
    return warn;
  };

  it('an unreadable Palazzo state at resync', async () => {
    const ctx = setup();
    const warn = degraded(ctx);
    ctx.currentState.mockRejectedValueOnce(new TypeError('secret detail'));
    await ctx.engine['resync']('radio-1', 'watchdog');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Resync could not read Palazzo state for radio-1 (TypeError)',
    );
    expect(ctx.metrics.recordEngineDegraded).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.recordEngineDegraded).toHaveBeenCalledWith(
      'telemetry_state',
    );
    expect(ctx.metrics.recordEngineResync).toHaveBeenCalledWith(
      'watchdog',
      'unavailable',
    );
  });

  it('unreadable radio settings when an announced bumper ends', async () => {
    const ctx = setup();
    const state = ctx.engine['ensureState']('radio-1');
    state.announcement = {
      status: 'accepted',
      forRequestId: 'ended-1',
      bumper: { index: 0, name: 'Spot' },
    } as never;
    state.nextBumperIdx = 4;
    const warn = degraded(ctx);
    ctx.radioService.getRadioSettings.mockRejectedValueOnce(
      new Error('secret detail'),
    );
    await ctx.engine['bumperAtEnd']('radio-1', 'ended-1');
    expect(state.nextBumperIdx).toBe(4);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('radio settings unreadable'),
      ),
    ).toEqual([
      [
        'Bumper sequence not advanced on radio-1: radio settings unreadable (Error)',
      ],
    ]);
    expect(ctx.metrics.recordEngineDegraded).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.recordEngineDegraded).toHaveBeenCalledWith(
      'bumper_settings',
    );
  });

  it('a bumper attempt that fails before its send', async () => {
    const ctx = setup();
    const warn = degraded(ctx);
    ctx.radioService.getRadioSettings.mockRejectedValueOnce(
      new RangeError('secret detail'),
    );
    await ctx.engine['maybeBumper']('radio-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Bumper attempt failed before its send on radio-1 (RangeError)',
    );
    expect(ctx.metrics.recordEngineDegraded).toHaveBeenCalledTimes(1);
    expect(ctx.metrics.recordEngineDegraded).toHaveBeenCalledWith(
      'bumper_attempt',
    );
    expect(ctx.radioService.playInstant).not.toHaveBeenCalled();
  });

  it('names an Error without a name as Error', async () => {
    const ctx = setup();
    const warn = degraded(ctx);
    const nameless = new Error('secret detail');
    nameless.name = '';
    ctx.currentState.mockRejectedValueOnce(nameless);
    await ctx.engine['resync']('radio-1', 'watchdog');
    expect(warn).toHaveBeenCalledWith(
      'Resync could not read Palazzo state for radio-1 (Error)',
    );
  });

  it('never logs the error message', async () => {
    const ctx = setup();
    const warn = degraded(ctx);
    ctx.currentState.mockRejectedValueOnce('a thrown string');
    await ctx.engine['resync']('radio-1', 'watchdog');
    expect(warn).toHaveBeenCalledWith(
      'Resync could not read Palazzo state for radio-1 (string)',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});
