import { Logger } from '@nestjs/common';
import {
  COMMAND_RETRY_BASE_MS,
  COMMAND_RETRY_MAX_MS,
  INHERITED_LOOKUP_ATTEMPTS,
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

// A catalogue song that is NOT a leaf of the program sequence (a catalog pick,
// or the successor an earlier process chose).
const CATALOGUE_SONG = {
  id: 77,
  title: 'Catalogue Song',
  artist: 'Catalogue Artist',
  audioUrl: 'https://example.test/catalogue.mp3',
  coverUrl: 'https://example.test/catalogue.jpg',
  durationMs: 215_000,
};

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

function setup(songs: Array<Record<string, unknown>> = [CATALOGUE_SONG]) {
  const store: { current: Record<string, unknown> | null } = {
    current: {
      programId: 'radio-1',
      type: 'radio',
      songSequence: AUTO,
      songQueue: [],
      songRotation: null,
      updatedAt: new Date('2026-11-20T21:13:00.000Z'),
    },
  };
  const prisma = {
    radioSettings: { findMany: jest.fn().mockResolvedValue([]) },
    songIntro: { findUnique: jest.fn().mockResolvedValue(null) },
    instant: { findUnique: jest.fn().mockResolvedValue(null) },
    song: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { audioUrl: string } }) =>
          Promise.resolve(songs.filter((s) => s.audioUrl === where.audioUrl)),
        ),
    },
    programState: {
      updateMany: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          store.current = { ...(store.current ?? {}), ...data };
          return Promise.resolve({ count: 1 });
        }),
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
    announceNext: jest.fn().mockResolvedValue('accepted'),
    withdrawNext: jest.fn().mockResolvedValue(undefined),
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
    recordShufflePick: jest.fn(),
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
  const trackEvents: Array<Record<string, unknown>> = [];
  engine.trackEvents$.subscribe((event) =>
    trackEvents.push(event as unknown as Record<string, unknown>),
  );
  const palazzo: { state: PalazzoPlaybackState | null } = { state: null };
  const currentState = jest.fn((_programId: string) =>
    Promise.resolve(palazzo.state),
  );
  engine.setPalazzoTelemetry({ isReconciled: () => true, currentState });
  engine.registerRadioProgram('radio-1');
  return {
    engine,
    prisma,
    radioService,
    publisher,
    metrics,
    events,
    trackEvents,
    palazzo,
    store,
  };
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function playedUrls(ctx: ReturnType<typeof setup>): string[] {
  return ctx.radioService.playSong.mock.calls.map(
    (call: unknown[]) => (call[1] as string) ?? '',
  );
}

function end(ctx: ReturnType<typeof setup>, requestId: string) {
  ctx.engine.handlePalazzoEvent('radio-1', {
    type: 'track.ended',
    data: { playbackRequestId: requestId },
  });
}

function playingAt(
  requestId: string,
  url: string,
  startedAt: string,
  position = 90,
): PalazzoPlaybackState {
  const state = playing(requestId, url, 5);
  return {
    ...state,
    track: { ...state.track, startedAt } as PalazzoPlaybackState['track'],
    positionSeconds: position,
  };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-22T11:10:00.000Z'));
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const STARTED = '2026-11-22T11:07:06.040Z';

// gaulatti/alcantara#272: the backend restarted while Palazzo handed off alone
// to the successor the old process had announced. The new engine met a playing
// track it had not commanded and recorded nothing for 3 min 35 s.
describe('SongExecutionEngine recognises its own earlier announcement after a restart', () => {
  it('records the song Palazzo started alone as inferred, publishes it and commands nothing over it', async () => {
    // The old process plays song A and announces its successor.
    const old = setup();
    old.engine.handleSequenceUpdated('radio-1', AUTO);
    old.engine.handlePalazzoSnapshot('radio-1', idle());
    await flush(60);
    const oldRequestId = (
      old.engine as unknown as {
        states: Map<string, { activeSong: { playbackRequestId: string } }>;
      }
    ).states.get('radio-1')!.activeSong.playbackRequestId;
    old.engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: oldRequestId },
    });
    await flush(80);
    expect(old.radioService.announceNext).toHaveBeenCalled();
    // The process stops; Palazzo hands off alone. A fresh engine starts; its
    // own announcements are refused, so the end of the song is a commanded one.
    const ctx = setup();
    ctx.radioService.announceNext.mockResolvedValue('rejected');
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt(
        'announced-by-the-old-process',
        CATALOGUE_SONG.audioUrl,
        STARTED,
      ),
    );
    await flush(60);

    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    expect(ctx.trackEvents).toEqual([
      expect.objectContaining({
        type: 'track.started',
        playbackRequestId: 'announced-by-the-old-process',
        inferred: true,
        at: new Date(STARTED),
        title: 'Fictional',
        url: CATALOGUE_SONG.audioUrl,
      }),
    ]);
    expect(ctx.publisher.publishPlayback).toHaveBeenCalled();
    expect(ctx.metrics.recordTrackTransition).toHaveBeenCalledWith('adopted');
    expect(ctx.metrics.recordTrackTransition).not.toHaveBeenCalledWith(
      'unidentified',
    );
    const song = (
      ctx.engine as unknown as {
        states: Map<
          string,
          {
            activeSong: {
              songId: number;
              itemId: string;
              durationMs: number;
            } | null;
            busyWithForeignTrack: boolean;
          }
        >;
      }
    ).states.get('radio-1')!;
    expect(song.activeSong).toMatchObject({
      songId: 77,
      // A song from outside the playlist: its end does not move the cursor.
      itemId: 'catalog:77',
      durationMs: 215_000,
    });
    expect(song.busyWithForeignTrack).toBe(false);

    // Following it to its end: the as-run row is closed, and only then is the
    // next song commanded.
    ctx.palazzo.state = idle(6);
    end(ctx, 'announced-by-the-old-process');
    await flush(80);
    jest.advanceTimersByTime(2000);
    await flush(80);
    expect(ctx.trackEvents.map((e) => e.type)).toEqual([
      'track.started',
      'track.ended',
    ]);
    expect(ctx.trackEvents[1]).toMatchObject({
      playbackRequestId: 'announced-by-the-old-process',
    });
    // Only now, after its end, is the next song commanded, and it is the one
    // the cursor already pointed at: no playlist song is skipped.
    expect(playedUrls(ctx)).toEqual([SONG_A.audioUrl]);
  });

  it('announces the successor of the recognised song, as for any started song', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt(
        'announced-by-the-old-process',
        CATALOGUE_SONG.audioUrl,
        STARTED,
      ),
    );
    await flush(80);
    expect(ctx.radioService.announceNext).toHaveBeenCalled();
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('also adopts a track that is a unique leaf of the sequence, as before', async () => {
    const ctx = setup([]);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('leaf-track', SONG_B.audioUrl, STARTED),
    );
    await flush(60);
    expect(ctx.prisma.song.findMany).not.toHaveBeenCalled();
    expect(ctx.trackEvents).toEqual([
      expect.objectContaining({ type: 'track.started', inferred: true }),
    ]);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('records the start once however many snapshots name the track', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const snapshot = playingAt('twice', CATALOGUE_SONG.audioUrl, STARTED);
    ctx.engine.handlePalazzoSnapshot('radio-1', snapshot);
    ctx.engine.handlePalazzoSnapshot('radio-1', { ...snapshot, sequence: 6 });
    await flush(60);
    ctx.engine.handlePalazzoSnapshot('radio-1', { ...snapshot, sequence: 7 });
    await flush(20);
    expect(
      ctx.trackEvents.filter((e) => e.type === 'track.started'),
    ).toHaveLength(1);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(1);
  });

  it('uses the time Palazzo reports for the start, else the position', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const snapshot = playingAt(
      'no-start',
      CATALOGUE_SONG.audioUrl,
      'not-a-date',
      40,
    );
    ctx.engine.handlePalazzoSnapshot('radio-1', snapshot);
    await flush(60);
    expect(ctx.trackEvents[0]).toMatchObject({
      type: 'track.started',
      inferred: true,
    });
  });

  it('withholds, reports once and records nothing for a track it cannot identify', async () => {
    const ctx = setup([]);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const snapshot = playingAt(
      'mystery',
      'https://example.test/unknown.mp3',
      STARTED,
    );
    ctx.engine.handlePalazzoSnapshot('radio-1', snapshot);
    ctx.engine.handlePalazzoSnapshot('radio-1', { ...snapshot, sequence: 6 });
    await flush(60);
    expect(ctx.trackEvents).toEqual([]);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    expect(ctx.metrics.recordTrackTransition).toHaveBeenCalledWith(
      'unidentified',
    );
    expect(
      ctx.metrics.recordTrackTransition.mock.calls.filter(
        ([r]: [string]) => r === 'unidentified',
      ),
    ).toHaveLength(1);
    const reports = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('cannot identify'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('"requestId":"mystery"');
    expect(reports[0]).toContain('"url":"https://example.test/unknown.mp3"');
    expect(reports[0]).toContain('"startedAt":"2026-11-22T11:07:06.040Z"');
    expect(reports[0]).toContain('"positionSeconds":90');
    expect(reports[0]).toContain('"catalogueMatches":0');
  });

  it('keeps an ambiguous catalogue match withheld rather than guessing', async () => {
    const ctx = setup([
      CATALOGUE_SONG,
      { ...CATALOGUE_SONG, id: 78, title: 'Duplicate' },
    ]);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('ambiguous', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(60);
    expect(ctx.trackEvents).toEqual([]);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    expect(ctx.metrics.recordTrackTransition).toHaveBeenCalledWith(
      'unidentified',
    );
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '"catalogueMatches":2',
    );
  });

  it('withholds, retries a failed lookup and reports once after the last failure, bounding long text', async () => {
    const ctx = setup();
    ctx.prisma.song.findMany.mockRejectedValue(new Error('db down'));
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const snapshot = playingAt('db-down', CATALOGUE_SONG.audioUrl, STARTED);
    (snapshot.track as unknown as { title: string }).title = 'x'.repeat(500);
    ctx.engine.handlePalazzoSnapshot('radio-1', snapshot);
    await flush(60);
    // Withheld and not yet reported while retries remain.
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(1);
    expect(
      warnSpy.mock.calls.map((c) => String(c[0])).join('\n'),
    ).not.toContain('cannot identify');
    // 2, 4, 8, 16, 30, 30 and 30 s apart: eight attempts in all.
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
      await jest.advanceTimersByTimeAsync(delay);
    }
    await flush(60);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(
      INHERITED_LOOKUP_ATTEMPTS,
    );
    expect(ctx.trackEvents).toEqual([]);
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    const reports = messages.filter((m) => m.includes('cannot identify'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('"catalogueLookup":"failed"');
    expect(reports[0]).not.toContain('x'.repeat(201));
    expect(
      ctx.metrics.recordTrackTransition.mock.calls.filter(
        ([r]: [string]) => r === 'unidentified',
      ),
    ).toHaveLength(1);
    // The same track named again starts no new series.
    ctx.engine.handlePalazzoSnapshot('radio-1', { ...snapshot, sequence: 9 });
    await jest.advanceTimersByTimeAsync(60000);
    await flush(60);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(
      INHERITED_LOOKUP_ATTEMPTS,
    );
  });

  it('adopts the song when a retry succeeds after the database returns, with nothing reported', async () => {
    const ctx = setup();
    ctx.prisma.song.findMany
      .mockRejectedValueOnce(new Error('P1001'))
      .mockRejectedValueOnce(new Error('P1001'))
      .mockResolvedValue([CATALOGUE_SONG]);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('db-returns', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(60);
    expect(ctx.trackEvents).toEqual([]);
    await jest.advanceTimersByTimeAsync(2000);
    await flush(60);
    expect(ctx.trackEvents).toEqual([]);
    await jest.advanceTimersByTimeAsync(4000);
    await flush(60);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(3);
    expect(ctx.trackEvents).toEqual([
      expect.objectContaining({
        type: 'track.started',
        playbackRequestId: 'db-returns',
        inferred: true,
        at: new Date(STARTED),
      }),
    ]);
    expect(ctx.metrics.recordTrackTransition).toHaveBeenCalledWith('adopted');
    expect(ctx.metrics.recordTrackTransition).not.toHaveBeenCalledWith(
      'unidentified',
    );
    expect(
      warnSpy.mock.calls.map((c) => String(c[0])).join('\n'),
    ).not.toContain('cannot identify');
    expect(ctx.radioService.playSong).not.toHaveBeenCalled();
  });

  it('does not retry when the track ends during a retry delay, and clears the timer', async () => {
    const ctx = setup();
    ctx.prisma.song.findMany.mockRejectedValue(new Error('db down'));
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('ends-early', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(60);
    const retry = (
      ctx.engine as unknown as {
        states: Map<string, { inheritedRetryTimer: unknown }>;
      }
    ).states.get('radio-1')!;
    expect(retry.inheritedRetryTimer).not.toBeNull();
    ctx.palazzo.state = idle(6);
    end(ctx, 'ends-early');
    expect(retry.inheritedRetryTimer).toBeNull();
    await flush(80);
    ctx.prisma.song.findMany.mockResolvedValue([CATALOGUE_SONG]);
    await jest.advanceTimersByTimeAsync(120000);
    await flush(60);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(1);
    expect(ctx.trackEvents).toEqual([]);
    expect(
      warnSpy.mock.calls.map((c) => String(c[0])).join('\n'),
    ).not.toContain('cannot identify');
  });

  it('does not look up again when the withheld track was replaced before the retry fires', async () => {
    const ctx = setup();
    ctx.prisma.song.findMany.mockRejectedValue(new Error('db down'));
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('replaced', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(60);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(1);
    (
      ctx.engine as unknown as {
        states: Map<string, { withheldRequestId: string }>;
      }
    ).states.get('radio-1')!.withheldRequestId = 'someone-else';
    await jest.advanceTimersByTimeAsync(120000);
    await flush(60);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(1);
  });

  it('stops the retry timer when the engine shuts down', async () => {
    const ctx = setup();
    ctx.prisma.song.findMany.mockRejectedValue(new Error('db down'));
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('shutdown', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(60);
    const pending = (
      ctx.engine as unknown as {
        states: Map<string, { inheritedRetryTimer: unknown }>;
      }
    ).states.get('radio-1')!;
    expect(pending.inheritedRetryTimer).not.toBeNull();
    ctx.engine.onModuleDestroy();
    expect(pending.inheritedRetryTimer).toBeNull();
    await jest.advanceTimersByTimeAsync(120000);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps no-match and two-match answers final: no retry', async () => {
    const none = setup([]);
    none.engine.handleSequenceUpdated('radio-1', AUTO);
    none.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('no-match', 'https://example.test/none.mp3', STARTED),
    );
    await flush(60);
    await jest.advanceTimersByTimeAsync(120000);
    expect(none.prisma.song.findMany).toHaveBeenCalledTimes(1);
  });

  it('drops a late lookup for a track that ended while another uncommanded track now plays', async () => {
    const ctx = setup();
    let releaseA!: (rows: unknown[]) => void;
    ctx.prisma.song.findMany
      .mockReturnValueOnce(new Promise((resolve) => (releaseA = resolve)))
      .mockResolvedValue([]);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('track-a', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(10);
    // A ends (the flag clears) and Palazzo already plays another uncommanded
    // track B: the engine's resync reads it and withholds again.
    ctx.palazzo.state = playingAt(
      'track-b',
      'https://example.test/b-unknown.mp3',
      STARTED,
      10,
    );
    end(ctx, 'track-a');
    await flush(120);
    // A's slow answer arrives while B plays.
    releaseA([CATALOGUE_SONG]);
    await flush(60);
    expect(ctx.trackEvents.filter((e) => e.type === 'track.started')).toEqual(
      [],
    );
    const state = (
      ctx.engine as unknown as {
        states: Map<
          string,
          { activeSong: unknown; busyWithForeignTrack: boolean }
        >;
      }
    ).states.get('radio-1')!;
    expect(state.activeSong).toBeNull();
    expect(state.busyWithForeignTrack).toBe(true);
    // B is looked up on its own and reported as unidentified.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '"requestId":"track-b"',
    );
  });

  it('derives the adopted position from the reported start after a slow lookup', async () => {
    const ctx = setup();
    let release!: (rows: unknown[]) => void;
    ctx.prisma.song.findMany.mockReturnValue(
      new Promise((resolve) => (release = resolve)),
    );
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('slow-started', CATALOGUE_SONG.audioUrl, startedAt, 90),
    );
    await flush(10);
    jest.setSystemTime(Date.now() + 45_000);
    release([CATALOGUE_SONG]);
    await flush(60);
    const active = (
      ctx.engine as unknown as {
        states: Map<
          string,
          { activeSong: { authoritativePositionMs: number } }
        >;
      }
    ).states.get('radio-1')!.activeSong;
    // 90 s at the snapshot plus the 45 s the lookup took.
    expect(active.authoritativePositionMs).toBe(135_000);
  });

  it('adds the lookup time to the reported position when the start is not reported', async () => {
    const ctx = setup();
    let release!: (rows: unknown[]) => void;
    ctx.prisma.song.findMany.mockReturnValue(
      new Promise((resolve) => (release = resolve)),
    );
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('slow-unstamped', CATALOGUE_SONG.audioUrl, 'not-a-date', 40),
    );
    await flush(10);
    jest.setSystemTime(Date.now() + 30_000);
    release([CATALOGUE_SONG]);
    await flush(60);
    const active = (
      ctx.engine as unknown as {
        states: Map<
          string,
          { activeSong: { authoritativePositionMs: number } }
        >;
      }
    ).states.get('radio-1')!.activeSong;
    expect(active.authoritativePositionMs).toBe(70_000);
  });

  it('drops the lookup when the track ends before it answers', async () => {
    const ctx = setup();
    let release!: (rows: unknown[]) => void;
    ctx.prisma.song.findMany.mockReturnValue(
      new Promise((resolve) => (release = resolve)),
    );
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('late', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(10);
    ctx.palazzo.state = idle(6);
    end(ctx, 'late');
    await flush(80);
    release([CATALOGUE_SONG]);
    await flush(40);
    expect(ctx.trackEvents).toEqual([]);
  });

  it('records no catalogue match for a track without a url, and reports it', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const snapshot = playingAt('no-url', '', STARTED);
    ctx.engine.handlePalazzoSnapshot('radio-1', snapshot);
    await flush(60);
    expect(ctx.prisma.song.findMany).not.toHaveBeenCalled();
    expect(ctx.metrics.recordTrackTransition).toHaveBeenCalledWith(
      'unidentified',
    );
  });

  it('forgets the oldest lookups so the set stays bounded', async () => {
    const ctx = setup([]);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    for (let i = 0; i < 140; i++) {
      ctx.engine.handlePalazzoSnapshot(
        'radio-1',
        playingAt(`t-${i}`, `https://example.test/u${i}.mp3`, STARTED),
      );
      await flush(10);
      (
        ctx.engine as unknown as {
          states: Map<string, { busyWithForeignTrack: boolean }>;
        }
      ).states.get('radio-1')!.busyWithForeignTrack = true;
    }
    const lookups = (
      ctx.engine as unknown as {
        states: Map<string, { inheritedLookups: Set<string> }>;
      }
    ).states.get('radio-1')!.inheritedLookups;
    expect(lookups.size).toBe(128);
    expect(lookups.has('t-0')).toBe(false);
    expect(lookups.has('t-139')).toBe(true);
  });

  it('records a catalogue song that has no cover and no duration with the defaults', async () => {
    const ctx = setup([
      { ...CATALOGUE_SONG, coverUrl: null, durationMs: null },
    ]);
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('bare-song', CATALOGUE_SONG.audioUrl, STARTED),
    );
    await flush(60);
    expect(ctx.trackEvents[0]).toMatchObject({
      type: 'track.started',
      inferred: true,
    });
    const active = (
      ctx.engine as unknown as {
        states: Map<
          string,
          { activeSong: { coverUrl: string; durationMs: number } }
        >;
      }
    ).states.get('radio-1')!.activeSong;
    expect(active.coverUrl).toBe('');
    expect(active.durationMs).toBe(300000);
    expect(playedUrls(ctx)).toEqual([]);
  });

  it('reports a playing track that names nothing about itself, with null fields', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const base = playing('bare-track', '');
    ctx.engine.handlePalazzoSnapshot('radio-1', {
      ...base,
      track: {
        playbackRequestId: 'bare-track',
      } as unknown as PalazzoPlaybackState['track'],
    });
    await flush(60);
    expect(ctx.prisma.song.findMany).not.toHaveBeenCalled();
    expect(ctx.metrics.recordTrackTransition).toHaveBeenCalledWith(
      'unidentified',
    );
    const report = String(
      warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('cannot identify')),
    );
    expect(report).toContain('"title":null');
    expect(report).toContain('"url":null');
    expect(report).toContain('"startedAt":null');
    expect(ctx.trackEvents).toEqual([]);
  });

  it('never records a spot, bumper or instant as a song play', async () => {
    // Palazzo's state has a track only for a song: a spot, bumper or instant
    // playing alone is an idle state with instant level, so it is never looked
    // up in the catalogue, counted or recorded.
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const base = idle(6);
    ctx.engine.handlePalazzoSnapshot('radio-1', {
      ...base,
      levels: { ...base.levels, instant: { rms: 0.2, peak: 0.5 } },
    });
    await flush(60);
    expect(ctx.prisma.song.findMany).not.toHaveBeenCalled();
    expect(ctx.metrics.recordTrackTransition).not.toHaveBeenCalledWith(
      'unidentified',
    );
    expect(ctx.trackEvents).toEqual([]);
  });

  it('records the inherited song once and treats its intro as the intro, not as a second song', async () => {
    const ctx = setup();
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const base = playingAt('with-intro', CATALOGUE_SONG.audioUrl, STARTED);
    ctx.engine.handlePalazzoSnapshot('radio-1', {
      ...base,
      intro: {
        playbackId: 'with-intro:intro',
        parentPlaybackId: 'with-intro',
        programId: 'radio-1',
        playbackRequestId: 'with-intro:intro',
        url: 'https://example.test/some-voice-track.mp3',
        startedAt: STARTED,
        status: 'playing',
      },
    });
    await flush(60);
    const starts = ctx.trackEvents.filter((e) => e.type === 'track.started');
    expect(starts).toHaveLength(1);
    expect(ctx.prisma.song.findMany).toHaveBeenCalledTimes(1);
    expect(ctx.prisma.song.findMany.mock.calls[0][0]).toMatchObject({
      where: { audioUrl: CATALOGUE_SONG.audioUrl },
    });
    const active = (
      ctx.engine as unknown as {
        states: Map<string, { activeSong: { introStatus: string } }>;
      }
    ).states.get('radio-1')!.activeSong;
    expect(active.introStatus).toBe('playing');
    expect(playedUrls(ctx)).toEqual([]);
  });
});

// gaulatti/alcantara#277: every restart of 2026-11-22 replayed the song the
// stored cursor pointed at (song_475, stored 40 h earlier), because the cursor
// advanced only in memory and the song on air at the restart was recorded as a
// catalogue song, whose end moves nothing.
describe('SongExecutionEngine after a restart keeps the rotation where it was (#277)', () => {
  const leaf = (id: string, url: string, songId?: number) => ({
    id,
    kind: 'preset',
    title: id,
    artist: 'Fictional',
    coverUrl: '',
    audioUrl: url,
    durationMs: 200_000,
    ...(songId === undefined ? {} : { songId }),
  });
  const L1 = leaf('l1', 'https://example.test/old-1.mp3', 11);
  const L2 = leaf('l2', 'https://example.test/two.mp3', 12);
  const L3 = leaf('l3', 'https://example.test/three.mp3', 13);
  const stale = (activeItemId: string, items: unknown[]) => ({
    ...sequenceOf(items, 'shuffle'),
    activeItemId,
    startedAt: Date.now(),
  });
  // The catalogue's current URL of song 11; the leaf kept the old one.
  const CAT_11 = {
    id: 11,
    title: 'Eleven',
    artist: 'Fictional',
    audioUrl: 'https://example.test/new-1.mp3',
    coverUrl: null,
    durationMs: 190_000,
  };
  const activeItem = (ctx: ReturnType<typeof setup>) =>
    (
      ctx.engine as unknown as {
        states: Map<string, { activeSong: { itemId: string } | null }>;
      }
    ).states.get('radio-1')!.activeSong?.itemId;

  async function adopt(
    ctx: ReturnType<typeof setup>,
    sequence: unknown,
    url: string,
  ) {
    ctx.engine.handleSequenceUpdated('radio-1', sequence);
    ctx.engine.handlePalazzoSnapshot(
      'radio-1',
      playingAt('inherited', url, STARTED),
    );
    await flush(80);
  }

  it('adopts the song on air by its song id when the leaf kept an old URL, and its end plays the leaf after it, not the stale cursor', async () => {
    const ctx = setup([CAT_11]);
    ctx.radioService.announceNext.mockResolvedValue('rejected');
    // The cursor is stale at l3; l1 is the song on air (its URL drifted).
    await adopt(ctx, stale('l3', [L1, L2, L3]), CAT_11.audioUrl);
    expect(activeItem(ctx)).toBe('l1');
    expect(ctx.metrics.recordInheritedAdoption).toHaveBeenCalledWith('leaf');
    expect(warnSpy).not.toHaveBeenCalled();
    ctx.palazzo.state = idle(6);
    end(ctx, 'inherited');
    await flush(80);
    jest.advanceTimersByTime(2000);
    await flush(80);
    expect(playedUrls(ctx)).toEqual([L2.audioUrl]);
  });

  it('prefers the leaf the cursor points at when the audio is on two leaves', async () => {
    const ctx = setup([]);
    ctx.radioService.announceNext.mockResolvedValue('rejected');
    const twin = leaf('l1b', L2.audioUrl, 12);
    await adopt(ctx, stale('l1b', [L1, L2, twin, L3]), L2.audioUrl);
    expect(activeItem(ctx)).toBe('l1b');
    expect(ctx.metrics.recordInheritedAdoption).toHaveBeenCalledWith(
      'cursor_leaf',
    );
    ctx.palazzo.state = idle(6);
    end(ctx, 'inherited');
    await flush(80);
    jest.advanceTimersByTime(2000);
    await flush(80);
    expect(playedUrls(ctx)).toEqual([L3.audioUrl]);
  });

  it('matches the cursor leaf by song id through the catalogue when its URL drifted and the song is on two leaves', async () => {
    const ctx = setup([CAT_11]);
    const twin = leaf('l1b', 'https://example.test/old-1b.mp3', 11);
    await adopt(ctx, stale('l1b', [L1, twin, L2]), CAT_11.audioUrl);
    expect(activeItem(ctx)).toBe('l1b');
    expect(ctx.metrics.recordInheritedAdoption).toHaveBeenCalledWith(
      'cursor_leaf',
    );
  });

  it('keeps a catalogue song for a song id on two leaves when neither is the cursor', async () => {
    const ctx = setup([CAT_11]);
    const twin = leaf('l1b', 'https://example.test/old-1b.mp3', 11);
    await adopt(ctx, stale('l2', [L1, twin, L2]), CAT_11.audioUrl);
    expect(activeItem(ctx)).toBe('catalog:11');
    expect(ctx.metrics.recordInheritedAdoption).toHaveBeenCalledWith(
      'catalogue',
    );
  });

  it('adopts by the cursor leaf with the default duration when the catalogue has none, and keeps a catalogue song when the cursor leaf has no audio', async () => {
    const noDuration = { ...CAT_11, durationMs: null };
    const withDefault = setup([noDuration]);
    await adopt(withDefault, stale('l1', [L1, L2]), CAT_11.audioUrl);
    const active = (
      withDefault.engine as unknown as {
        states: Map<
          string,
          { activeSong: { itemId: string; durationMs: number } | null }
        >;
      }
    ).states.get('radio-1')!.activeSong;
    expect(active).toMatchObject({ itemId: 'l1', durationMs: 300_000 });

    const silent = setup([CAT_11]);
    await adopt(silent, stale('no-audio', [NO_AUDIO]), CAT_11.audioUrl);
    expect(activeItem(silent)).toBe('catalog:11');
  });

  it('logs how the song on air was recognised and how many leaves matched', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log');
    const ctx = setup([CAT_11]);
    await adopt(ctx, stale('l3', [L1, L2, L3]), CAT_11.audioUrl);
    expect(
      logSpy.mock.calls.some((call) =>
        /Adopted inherited Palazzo playback inherited on radio-1 \(path=leaf urlMatches=0 songIdMatches=1\)/.test(
          String(call[0]),
        ),
      ),
    ).toBe(true);
  });

  describe('the cursor write after an advance', () => {
    async function playTwoSongs(ctx: ReturnType<typeof setup>) {
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      ctx.engine.handlePalazzoSnapshot('radio-1', idle());
      await flush(60);
      const requestId = (
        ctx.engine as unknown as {
          states: Map<string, { activeSong: { playbackRequestId: string } }>;
        }
      ).states.get('radio-1')!.activeSong.playbackRequestId;
      ctx.engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: requestId },
      });
      await flush(40);
      ctx.palazzo.state = idle(6);
      end(ctx, requestId);
      await flush(120);
      jest.advanceTimersByTime(2000);
      await flush(120);
    }

    it('stores the advanced cursor, after the successor command, with the row it read', async () => {
      const ctx = setup();
      ctx.radioService.announceNext.mockResolvedValue('rejected');
      await playTwoSongs(ctx);
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(2);
      expect(ctx.prisma.programState.updateMany).toHaveBeenCalledTimes(1);
      const [args] = ctx.prisma.programState.updateMany.mock.calls[0] as [
        {
          where: { programId: string; updatedAt: Date };
          data: { songSequence: { activeItemId: string } };
        },
      ];
      expect(args.where).toEqual({
        programId: 'radio-1',
        updatedAt: new Date('2026-11-20T21:13:00.000Z'),
      });
      expect(args.data.songSequence.activeItemId).toBe('song-b');
      expect(
        ctx.radioService.playSong.mock.invocationCallOrder[1],
      ).toBeLessThan(
        ctx.prisma.programState.updateMany.mock.invocationCallOrder[0],
      );
      expect(ctx.metrics.recordCursorWrite).toHaveBeenCalledWith('succeeded');
    });

    it('writes nothing when an operator changed the sequence meanwhile', async () => {
      const ctx = setup();
      ctx.radioService.announceNext.mockResolvedValue('rejected');
      ctx.store.current = {
        ...(ctx.store.current ?? {}),
        songSequence: sequenceOf([SONG_A, SONG_B, NO_AUDIO]),
      };
      await playTwoSongs(ctx);
      expect(ctx.prisma.programState.updateMany).not.toHaveBeenCalled();
      expect(ctx.metrics.recordCursorWrite).toHaveBeenCalledWith('conflict');
    });

    it('counts a conflict when the row changed between the read and the write', async () => {
      const ctx = setup();
      ctx.radioService.announceNext.mockResolvedValue('rejected');
      ctx.prisma.programState.updateMany.mockResolvedValueOnce({ count: 0 });
      await playTwoSongs(ctx);
      expect(ctx.metrics.recordCursorWrite).toHaveBeenCalledWith('conflict');
    });

    it('warns with the cause class when the write fails and the song change is not delayed', async () => {
      const ctx = setup();
      ctx.radioService.announceNext.mockResolvedValue('rejected');
      ctx.prisma.programState.updateMany.mockRejectedValueOnce(
        new TypeError('connection reset'),
      );
      await playTwoSongs(ctx);
      expect(ctx.radioService.playSong).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        'Cursor not stored on radio-1; the next song stores it (TypeError)',
      );
      expect(ctx.metrics.recordCursorWrite).toHaveBeenCalledWith('failed');
    });

    it('does not write after a queue entry or a catalogue song ends: they never moved the cursor', async () => {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      ctx.engine.handlePalazzoSnapshot(
        'radio-1',
        playingAt('catalogue-track', CATALOGUE_SONG.audioUrl, STARTED),
      );
      await flush(80);
      ctx.palazzo.state = idle(6);
      end(ctx, 'catalogue-track');
      await flush(120);
      jest.advanceTimersByTime(2000);
      await flush(120);
      expect(ctx.prisma.programState.updateMany).not.toHaveBeenCalled();
    });

    it('writes nothing for a manual sequence and skips a write while one is in flight', async () => {
      const ctx = setup();
      const engine = ctx.engine as unknown as {
        persistCursorBestEffort: (programId: string) => Promise<void>;
        states: Map<
          string,
          { sequence: unknown; cursorWriteInFlight?: boolean }
        >;
      };
      ctx.engine.handleSequenceUpdated(
        'radio-1',
        sequenceOf([SONG_A], 'manual'),
      );
      await engine.persistCursorBestEffort('radio-1');
      await engine.persistCursorBestEffort('unknown-program');
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      engine.states.get('radio-1')!.cursorWriteInFlight = true;
      await engine.persistCursorBestEffort('radio-1');
      expect(ctx.prisma.programState.findUnique).not.toHaveBeenCalled();
      expect(ctx.metrics.recordCursorWrite).not.toHaveBeenCalled();
    });

    it('reacts to nothing of its own write: no sequence reload, no event to consoles or overlays', async () => {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      const states = (
        ctx.engine as unknown as {
          states: Map<string, { sequence: unknown }>;
        }
      ).states;
      const held = states.get('radio-1')!.sequence;
      const reload = jest.spyOn(ctx.engine, 'handleSequenceUpdated');
      const eventsBefore = ctx.events.length;
      await (
        ctx.engine as unknown as {
          persistCursorBestEffort: (programId: string) => Promise<void>;
        }
      ).persistCursorBestEffort('radio-1');
      expect(ctx.prisma.programState.updateMany).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      expect(ctx.events).toHaveLength(eventsBefore);
      expect(states.get('radio-1')!.sequence).toBe(held);
    });

    it('counts a conflict when the program row is gone', async () => {
      const ctx = setup();
      ctx.engine.handleSequenceUpdated('radio-1', AUTO);
      ctx.prisma.programState.findUnique.mockResolvedValueOnce(null);
      await (
        ctx.engine as unknown as {
          persistCursorBestEffort: (programId: string) => Promise<void>;
        }
      ).persistCursorBestEffort('radio-1');
      expect(ctx.metrics.recordCursorWrite).toHaveBeenCalledWith('conflict');
    });
  });
});
