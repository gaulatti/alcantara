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
      itemId: '',
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
    // Only now, after its end, is the next song commanded.
    expect(playedUrls(ctx)).toHaveLength(1);
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

  it('withholds and reports when the catalogue lookup fails, and bounds long text', async () => {
    const ctx = setup();
    ctx.prisma.song.findMany.mockRejectedValue(new Error('db down'));
    ctx.engine.handleSequenceUpdated('radio-1', AUTO);
    const snapshot = playingAt('db-down', CATALOGUE_SONG.audioUrl, STARTED);
    (snapshot.track as unknown as { title: string }).title = 'x'.repeat(500);
    ctx.engine.handlePalazzoSnapshot('radio-1', snapshot);
    await flush(60);
    expect(ctx.trackEvents).toEqual([]);
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('"catalogueLookup":"failed"'))).toBe(
      true,
    );
    const report = messages.find((m) => m.includes('cannot identify'))!;
    expect(report).not.toContain('x'.repeat(201));
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
});
