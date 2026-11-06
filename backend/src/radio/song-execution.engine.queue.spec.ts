import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
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

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  logSpy = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('SongExecutionEngine module lifecycle', () => {
  it('boots only enabled radio programs with a Palazzo URL and restores their state', async () => {
    const { engine, prisma, metrics } = setup();
    const programState = (overrides: Record<string, unknown>) => ({
      programId: 'p',
      type: 'radio',
      songSequence: AUTO,
      songQueue: [{ id: 'q1', itemId: 'song-a', enqueuedAt: 5 }],
      songRotation: null,
      ...overrides,
    });
    prisma.radioSettings.findMany.mockResolvedValue([
      { palazzoUrl: '', programState: programState({ programId: 'no-url' }) },
      {
        palazzoUrl: 'http://palazzo',
        programState: programState({ programId: 'tv-prog', type: 'tv' }),
      },
      {
        palazzoUrl: 'http://palazzo',
        programState: programState({
          programId: 'null-seq',
          songSequence: null,
        }),
      },
      {
        palazzoUrl: 'http://palazzo',
        programState: programState({
          programId: 'manual',
          songSequence: sequenceOf([SONG_A], 'manual'),
        }),
      },
      {
        palazzoUrl: 'http://palazzo',
        programState: programState({
          programId: 'empty',
          songSequence: sequenceOf([]),
        }),
      },
      {
        palazzoUrl: 'http://palazzo',
        programState: programState({
          programId: 'auto',
          songSequence: sequenceOf([{ ...SONG_A, highRotation: true }]),
        }),
      },
    ]);
    await engine.onModuleInit();

    expect(prisma.radioSettings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true } }),
    );
    // The four accepted programs each hold one queued entry.
    expect(metrics.recordSongQueueDepth).toHaveBeenLastCalledWith(4);
    expect(metrics.recordHighRotationFavorites).toHaveBeenLastCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Booting auto, mode=autoplay'),
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    // Programs rejected by the filters never become radio capable.
    expect(engine.getPlaybackState('no-url')).toBeNull();
    engine.handlePalazzoSnapshot('tv-prog', idle());
    engine.handlePalazzoSnapshot('no-url', idle());
    expect(engine.getPlaybackState('tv-prog')).toBeNull();
  });

  it('clears timers and progress intervals on destroy', () => {
    const { engine, events } = setup();
    engine.handleManualSong('radio-1', 'https://example.test/x.mp3');
    engine.handleManualSong('tv-1', 'https://example.test/y.mp3');
    engine.onModuleDestroy();
    events.length = 0;
    jest.advanceTimersByTime(1_000_000);
    expect(events).toEqual([]);
    expect(engine.getPlaybackState('tv-1')).not.toBeNull();
  });
});

describe('SongExecutionEngine sequence and queue updates', () => {
  it('keeps the running clock when a sequence update arrives during playback', () => {
    const { engine } = setup();
    engine.handleSequenceUpdated('radio-1', { ...AUTO, startedAt: 111 });
    engine.handleManualSong('radio-1', 'https://example.test/other.mp3');
    engine.handleSequenceUpdated('radio-1', { ...AUTO, startedAt: 999 });
    engine.handleSequenceUpdated('radio-1', null);
    expect(engine.getPlaybackState('radio-1')?.audioUrl).toBe(
      'https://example.test/other.mp3',
    );
  });

  it('does not start playback for manual or empty sequences', () => {
    const { engine, radioService } = setup();
    engine.handlePalazzoSnapshot('radio-1', idle());
    engine.handleSequenceUpdated('radio-1', sequenceOf([SONG_A], 'manual'));
    engine.handleSequenceUpdated('radio-1', sequenceOf([]));
    expect(radioService.playSong).not.toHaveBeenCalled();
  });

  it('starts the automatic sequence when it is updated on an idle reconciled program', async () => {
    const { engine, radioService } = setup();
    engine.handlePalazzoSnapshot('radio-1', idle());
    engine.handleSequenceUpdated('radio-1', AUTO);
    await flush();
    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    // A pending command blocks a second start.
    engine.handleSequenceUpdated('radio-1', AUTO);
    await flush();
    expect(radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('only starts from a queue update for automatic sequences', () => {
    const { engine, radioService } = setup();
    engine.handleQueueUpdated('radio-1', [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ]);
    expect(radioService.playSong).not.toHaveBeenCalled();
    engine.handleSequenceUpdated('radio-1', sequenceOf([SONG_A], 'manual'));
    engine.handleQueueUpdated('radio-1', [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ]);
    expect(radioService.playSong).not.toHaveBeenCalled();
    engine.handleQueueUpdated('radio-1', []);
    expect(radioService.playSong).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine continuous rotation resume', () => {
  it('ignores resume preparation without an automatic sequence', async () => {
    const { engine, prisma } = setup();
    await engine.prepareContinuousRotationResume('unknown');
    engine.handleSequenceUpdated('radio-1', sequenceOf([SONG_A], 'manual'));
    await engine.prepareContinuousRotationResume('radio-1');
    engine.handleSequenceUpdated('radio-1', null);
    await engine.prepareContinuousRotationResume('radio-1');
    expect(prisma.programState.update).not.toHaveBeenCalled();
  });

  it('persists the advanced cursor even when the sequence has no resolvable leaf', async () => {
    const { engine, prisma } = setup();
    engine.handleSequenceUpdated('radio-1', sequenceOf([]));
    await engine.prepareContinuousRotationResume('radio-1');
    expect(prisma.programState.update).toHaveBeenCalledTimes(1);
  });

  it('resumes safely for programs without engine state', () => {
    const { engine, radioService } = setup();
    engine.resumeContinuousRotation('unknown');
    expect(radioService.playSong).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine Play Next mutations', () => {
  it('rejects a blank item id', async () => {
    const { engine, metrics } = setup();
    await expect(engine.enqueueSong('radio-1', '   ')).rejects.toThrow(
      new BadRequestException('itemId is required'),
    );
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith('rejected');
  });

  it('rejects unknown programs and non-radio programs', async () => {
    const missing = setup(null);
    await expect(
      missing.engine.enqueueSong('radio-1', 'song-a'),
    ).rejects.toThrow(NotFoundException);
    const tv = setup({ type: 'tv' });
    await expect(tv.engine.enqueueSong('radio-1', 'song-a')).rejects.toThrow(
      'Play Next is available only for Radio and Simulcast programs',
    );
  });

  it('rejects items that are missing or have no audio', async () => {
    const { engine } = setup({
      songSequence: sequenceOf([NO_AUDIO, SONG_A]),
    });
    await expect(engine.enqueueSong('radio-1', 'nope')).rejects.toThrow(
      'Queued song must reference one playable playlist item',
    );
    await expect(engine.enqueueSong('radio-1', 'no-audio')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a full queue', async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({
      id: `q${index}`,
      itemId: 'song-a',
      enqueuedAt: index + 1,
    }));
    const { engine, prisma } = setup({ songQueue: full });
    await expect(engine.enqueueSong('radio-1', 'song-a')).rejects.toThrow(
      'Play Next queue is limited to 100 entries',
    );
    expect(prisma.programState.update).not.toHaveBeenCalled();
  });

  it('persists, applies and broadcasts an enqueued song', async () => {
    const { engine, prisma, metrics, events } = setup();
    const result = await engine.enqueueSong('radio-1', ' song-a ');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ itemId: 'song-a' });
    expect(prisma.programState.update).toHaveBeenCalledWith({
      where: { programId: 'radio-1' },
      data: { songQueue: result },
    });
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith('enqueued');
    expect(events).toContainEqual({
      type: 'song_queue_update',
      programId: 'radio-1',
      songQueue: result,
    });
  });

  it('classifies unexpected persistence errors', async () => {
    const { engine, prisma, metrics } = setup();
    prisma.programState.update.mockRejectedValueOnce(new Error('db down'));
    await expect(engine.enqueueSong('radio-1', 'song-a')).rejects.toThrow(
      'db down',
    );
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith(
      'persistence-failed',
    );
  });

  it('serialises concurrent queue mutations and releases the lock', async () => {
    const { engine, prisma } = setup();
    const [first, second] = await Promise.all([
      engine.enqueueSong('radio-1', 'song-a'),
      engine.enqueueSong('radio-1', 'song-b'),
    ]);
    expect(first).toHaveLength(1);
    expect(second.map((entry) => entry.itemId)).toEqual(['song-a', 'song-b']);
    expect(prisma.programState.update).toHaveBeenCalledTimes(2);
    const third = await engine.enqueueSong('radio-1', 'song-a');
    expect(third).toHaveLength(3);
  });

  it('removes a queued entry and rejects blank, active and unknown ids', async () => {
    const { engine, store, metrics } = setup({
      songQueue: [
        { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
        { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
      ],
    });
    await expect(engine.removeQueuedSong('radio-1', '  ')).rejects.toThrow(
      'queue entry ID is required',
    );
    await expect(engine.removeQueuedSong('radio-1', 'zzz')).rejects.toThrow(
      new NotFoundException('Queued song not found'),
    );
    const removed = await engine.removeQueuedSong('radio-1', ' q2 ');
    expect(removed).toEqual([{ id: 'q1', itemId: 'song-a', enqueuedAt: 1 }]);
    expect(store.current?.songQueue).toEqual(removed);
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith('removed');

    store.current!.songQueue = [
      {
        id: 'q1',
        itemId: 'song-a',
        enqueuedAt: 1,
        active: true,
        playbackRequestId: 'req',
      },
    ];
    await expect(engine.removeQueuedSong('radio-1', 'q1')).rejects.toThrow(
      'The playing queue entry cannot be removed before it ends',
    );
  });

  it('reorders the queue and validates the requested order', async () => {
    const { engine, store, metrics } = setup({
      songQueue: [
        { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
        { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
      ],
    });
    const invalid = 'entryIds must be an array of queue entry IDs';
    await expect(
      engine.reorderSongQueue('radio-1', 'q1' as unknown as string[]),
    ).rejects.toThrow(invalid);
    await expect(
      engine.reorderSongQueue('radio-1', [1, 'q2'] as unknown as string[]),
    ).rejects.toThrow(invalid);
    const exact = 'entryIds must contain every queued entry exactly once';
    await expect(
      engine.reorderSongQueue('radio-1', ['q1', ' ']),
    ).rejects.toThrow(exact);
    await expect(
      engine.reorderSongQueue('radio-1', ['q1', 'q1']),
    ).rejects.toThrow(exact);
    await expect(engine.reorderSongQueue('radio-1', ['q1'])).rejects.toThrow(
      exact,
    );
    await expect(
      engine.reorderSongQueue('radio-1', ['q1', 'q3']),
    ).rejects.toThrow(exact);
    const reordered = await engine.reorderSongQueue('radio-1', [' q2 ', 'q1']);
    expect(reordered.map((entry) => entry.id)).toEqual(['q2', 'q1']);
    expect(store.current?.songQueue).toEqual(reordered);
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith('reordered');
  });

  it('keeps the playing entry first when reordering', async () => {
    const queue = [
      {
        id: 'q1',
        itemId: 'song-a',
        enqueuedAt: 1,
        active: true,
        playbackRequestId: 'req',
      },
      { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
    ];
    const { engine } = setup({ songQueue: queue });
    await expect(
      engine.reorderSongQueue('radio-1', ['q2', 'q1']),
    ).rejects.toThrow(
      'The playing queue entry must remain first until it ends',
    );
    const same = await engine.reorderSongQueue('radio-1', ['q1', 'q2']);
    expect(same.map((entry) => entry.id)).toEqual(['q1', 'q2']);
  });

  it('uses the engine-tracked active queue entry when the persisted queue lacks a claim', async () => {
    const { engine, store } = setup({
      songQueue: [{ id: 'q1', itemId: 'song-a', enqueuedAt: 1 }],
    });
    engine.handleSequenceUpdated('radio-1', AUTO);
    engine.handleQueueUpdated('radio-1', [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
    ]);
    engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(60);
    expect(engine.getPlaybackState('radio-1')?.queueEntryId).toBe('q1');
    // The claim is persisted by playNext; wipe the persisted claim so only the
    // engine's own active song identifies the playing entry.
    store.current!.songQueue = [
      { id: 'q1', itemId: 'song-a', enqueuedAt: 1 },
      { id: 'q2', itemId: 'song-b', enqueuedAt: 2 },
    ];
    await expect(
      engine.reorderSongQueue('radio-1', ['q2', 'q1']),
    ).rejects.toThrow(
      'The playing queue entry must remain first until it ends',
    );
  });
});
