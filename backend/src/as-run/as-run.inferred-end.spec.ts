import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AsRunService } from './as-run.service';
import type { AsRunTrackEvent } from './as-run.types';
import { SongExecutionEngine } from '../radio/song-execution.engine';
import type { PrismaService } from '../prisma.service';
import type { RadioService } from '../radio/radio.service';
import type { FlightService } from '../program/flight.service';
import type { NowPlayingPublisherService } from '../radio/now-playing-publisher.service';
import type { RadioMetricsService } from '../radio/radio-metrics.service';
import type { PalazzoPlaybackState } from '../radio/palazzo-contract';

type Row = {
  id: number;
  programId: string;
  songId: number | null;
  assetId: string | null;
  state: string;
  at: Date;
  createdAt: Date;
  playbackRequestId: string | null;
  inferred: boolean;
  reviewFlag: string | null;
};

type CatalogSong = {
  id: number;
  title: string;
  artist: string;
  audioUrl: string;
  assetId: string | null;
};

type Where = Record<string, unknown> & { at?: { gte?: Date; lte?: Date } };

const SX_HEADER =
  'Transmission Category Code,Featured Artist Name,Sound Recording Title,ISRC,Album Title,Marketing Label,Actual Total Performances';

/**
 * An in-memory stand-in for the AsRunRecord table that enforces the same
 * unique key as the migration: (programId, playbackRequestId, state), with
 * NULL request IDs never conflicting.
 */
function memoryStore(songs: CatalogSong[]) {
  const rows: Row[] = [];
  const matches = (row: Row, where: Where) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'at') {
        const range = value as { gte?: Date; lte?: Date };
        return (
          (!range.gte || row.at >= range.gte) &&
          (!range.lte || row.at <= range.lte)
        );
      }
      return row[key as keyof Row] === value;
    });
  const prisma = {
    asRunRecord: {
      create: jest.fn(({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
        if (
          data.playbackRequestId !== null &&
          rows.some(
            (row) =>
              row.programId === data.programId &&
              row.playbackRequestId === data.playbackRequestId &&
              row.state === data.state,
          )
        ) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              { code: 'P2002', clientVersion: 'test' },
            ),
          );
        }
        const row: Row = { ...data, id: rows.length + 1, createdAt: data.at };
        rows.push(row);
        return Promise.resolve(row);
      }),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          rows
            .filter((row) => matches(row, where))
            .sort((a, b) => a.at.getTime() - b.at.getTime()),
        ),
      ),
    },
    song: {
      findFirst: jest.fn(
        ({
          where,
        }: {
          where: { audioUrl?: string; title?: string; artist?: string };
        }) => {
          const song = songs.find((s) =>
            where.audioUrl !== undefined
              ? s.audioUrl === where.audioUrl
              : s.title === where.title && s.artist === where.artist,
          );
          return Promise.resolve(
            song ? { id: song.id, assetId: song.assetId } : null,
          );
        },
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          songs
            .filter((s) => where.id.in.includes(s.id))
            .map((s) => ({ id: s.id, title: s.title, artist: s.artist })),
        ),
      ),
    },
    mediaAsset: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return { rows, prisma };
}

const CATALOG: CatalogSong[] = [
  {
    id: 1,
    title: 'Dropped Connection',
    artist: 'Artist A',
    audioUrl: 'https://audio.test/a.mp3',
    assetId: null,
  },
  {
    id: 2,
    title: 'Normal Play',
    artist: 'Artist B',
    audioUrl: 'https://audio.test/b.mp3',
    assetId: null,
  },
];

function event(
  type: AsRunTrackEvent['type'],
  playbackRequestId: string,
  url: string,
  at: string,
  inferred?: boolean,
): AsRunTrackEvent {
  return {
    programId: 'radio-1',
    type,
    playbackRequestId,
    title: null,
    artist: null,
    url,
    at: new Date(at),
    ...(inferred === undefined ? {} : { inferred }),
  };
}

describe('AsRunService inferred ends', () => {
  let store: ReturnType<typeof memoryStore>;
  let radioMetrics: { recordRadioLogResult: jest.Mock };
  let service: AsRunService;

  beforeEach(() => {
    store = memoryStore(CATALOG);
    radioMetrics = { recordRadioLogResult: jest.fn() };
    service = new AsRunService(
      store.prisma as unknown as PrismaService,
      undefined,
      radioMetrics as unknown as RadioMetricsService,
    );
  });

  it('counts a play once when the real end arrives after an inferred end', async () => {
    const url = CATALOG[0].audioUrl;
    await service.handleTrackEvent(
      event('track.started', 'req-a', url, '2026-11-17T10:00:00.000Z'),
    );
    await service.handleTrackEvent(
      event('track.ended', 'req-a', url, '2026-11-17T10:03:10.000Z', true),
    );
    // The real end arrives late, after the engine already advanced.
    expect(
      await service.handleTrackEvent(
        event('track.ended', 'req-a', url, '2026-11-17T10:03:20.000Z'),
      ),
    ).toBeNull();

    const ended = store.rows.filter((row) => row.state === 'ended');
    expect(ended).toEqual([
      expect.objectContaining({
        playbackRequestId: 'req-a',
        inferred: true,
        reviewFlag: null,
        at: new Date('2026-11-17T10:03:10.000Z'),
      }),
    ]);
    expect(radioMetrics.recordRadioLogResult).toHaveBeenCalledTimes(1);

    const sx = await service.export('radio-1', { format: 'soundexchange' });
    expect(sx).toBe(
      [SX_HEADER, 'E,Artist A,Dropped Connection,,,,1'].join('\n'),
    );
  });

  it('counts a play once when the inferred and real ends race each other', async () => {
    const url = CATALOG[0].audioUrl;
    await service.handleTrackEvent(
      event('track.started', 'req-a', url, '2026-11-17T10:00:00.000Z'),
    );
    const results = await Promise.all([
      service.handleTrackEvent(
        event('track.ended', 'req-a', url, '2026-11-17T10:03:10.000Z', true),
      ),
      service.handleTrackEvent(
        event('track.ended', 'req-a', url, '2026-11-17T10:03:11.000Z'),
      ),
    ]);

    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(store.rows.filter((row) => row.state === 'ended')).toHaveLength(1);
    expect(radioMetrics.recordRadioLogResult).toHaveBeenCalledTimes(1);
    const sx = await service.export('radio-1', { format: 'soundexchange' });
    expect(sx.split('\n')[1]).toBe('E,Artist A,Dropped Connection,,,,1');
  });

  it('rethrows a write failure that is not a duplicate', async () => {
    store.prisma.asRunRecord.create.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      service.handleTrackEvent(
        event(
          'track.started',
          'req-a',
          CATALOG[0].audioUrl,
          '2026-11-17T10:00:00.000Z',
        ),
      ),
    ).rejects.toThrow('database unavailable');
  });

  it('still counts a normal accepted end exactly once, and marks it as reported', async () => {
    const url = CATALOG[1].audioUrl;
    await service.handleTrackEvent(
      event('track.started', 'req-b', url, '2026-11-17T11:00:00.000Z'),
    );
    await service.handleTrackEvent(
      event('track.ended', 'req-b', url, '2026-11-17T11:04:00.000Z'),
    );

    expect(store.rows.filter((row) => row.state === 'ended')).toEqual([
      expect.objectContaining({ inferred: false, reviewFlag: null }),
    ]);
    const sx = await service.export('radio-1', { format: 'soundexchange' });
    expect(sx).toBe([SX_HEADER, 'E,Artist B,Normal Play,,,,1'].join('\n'));
  });

  it('distinguishes inferred ends in the CSV and lists them separately in the SoundExchange export', async () => {
    const [a, b] = CATALOG;
    await service.handleTrackEvent(
      event('track.started', 'req-a', a.audioUrl, '2026-11-17T10:00:00.000Z'),
    );
    await service.handleTrackEvent(
      event(
        'track.ended',
        'req-a',
        a.audioUrl,
        '2026-11-17T10:03:10.000Z',
        true,
      ),
    );
    await service.handleTrackEvent(
      event('track.started', 'req-b', b.audioUrl, '2026-11-17T10:03:10.000Z'),
    );
    await service.handleTrackEvent(
      event('track.ended', 'req-b', b.audioUrl, '2026-11-17T10:07:10.000Z'),
    );

    const csv = await service.export('radio-1', {});
    expect(csv.split('\n')).toEqual([
      'id,programId,songId,assetId,title,artist,state,at,createdAt,inferred,reviewFlag',
      '1,radio-1,1,,Dropped Connection,Artist A,started,2026-11-17T10:00:00.000Z,2026-11-17T10:00:00.000Z,false,',
      '2,radio-1,1,,Dropped Connection,Artist A,ended,2026-11-17T10:03:10.000Z,2026-11-17T10:03:10.000Z,true,',
      '3,radio-1,2,,Normal Play,Artist B,started,2026-11-17T10:03:10.000Z,2026-11-17T10:03:10.000Z,false,',
      '4,radio-1,2,,Normal Play,Artist B,ended,2026-11-17T10:07:10.000Z,2026-11-17T10:07:10.000Z,false,',
    ]);

    expect(await service.export('radio-1', { format: 'soundexchange' })).toBe(
      [
        SX_HEADER,
        'E,Artist A,Dropped Connection,,,,1',
        'E,Artist B,Normal Play,,,,1',
      ].join('\n'),
    );
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'ONLY',
      }),
    ).toBe([SX_HEADER, 'E,Artist A,Dropped Connection,,,,1'].join('\n'));
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'exclude',
      }),
    ).toBe([SX_HEADER, 'E,Artist B,Normal Play,,,,1'].join('\n'));
  });

  it('flags short and start-less inferred ends for review but still counts them', async () => {
    const [a, b] = CATALOG;
    // 12 seconds after its start: below the 30-second review threshold.
    await service.handleTrackEvent(
      event('track.started', 'req-a', a.audioUrl, '2026-11-17T10:00:00.000Z'),
    );
    await service.handleTrackEvent(
      event(
        'track.ended',
        'req-a',
        a.audioUrl,
        '2026-11-17T10:00:12.000Z',
        true,
      ),
    );
    // No start was recorded for this play.
    await service.handleTrackEvent(
      event(
        'track.ended',
        'req-b',
        b.audioUrl,
        '2026-11-17T10:05:00.000Z',
        true,
      ),
    );
    // No request ID at all.
    await service.handleTrackEvent(
      event('track.ended', '', b.audioUrl, '2026-11-17T10:09:00.000Z', true),
    );

    expect(
      store.rows
        .filter((row) => row.state === 'ended')
        .map((row) => [row.playbackRequestId, row.inferred, row.reviewFlag]),
    ).toEqual([
      ['req-a', true, 'short'],
      ['req-b', true, 'no-start'],
      [null, true, 'no-start'],
    ]);
    const csv = await service.export('radio-1', {});
    expect(csv).toContain(',ended,2026-11-17T10:00:12.000Z,');
    expect(csv).toContain('2026-11-17T10:00:12.000Z,true,short');
    expect(csv).toContain('2026-11-17T10:05:00.000Z,true,no-start');
    expect(await service.export('radio-1', { format: 'soundexchange' })).toBe(
      [
        SX_HEADER,
        'E,Artist A,Dropped Connection,,,,1',
        'E,Artist B,Normal Play,,,,2',
      ].join('\n'),
    );
  });

  it('ignores the inferred marker on a start', async () => {
    await service.handleTrackEvent(
      event(
        'track.started',
        'req-a',
        CATALOG[0].audioUrl,
        '2026-11-17T10:00:00.000Z',
        true,
      ),
    );
    expect(store.rows).toEqual([
      expect.objectContaining({
        state: 'started',
        inferred: false,
        reviewFlag: null,
      }),
    ]);
  });

  it('rejects an unknown inferred filter and the filter on the CSV export', async () => {
    await expect(
      service.export('radio-1', { format: 'soundexchange', inferred: 'some' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.export('radio-1', { format: 'csv', inferred: 'only' }),
    ).rejects.toThrow('inferred applies only to format=soundexchange');
  });
});

// ---------------------------------------------------------------------------
// A scripted on-air session driven through the real song engine.
// ---------------------------------------------------------------------------

function idleSnapshot(sequence: number): PalazzoPlaybackState {
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

const SESSION_SONGS: CatalogSong[] = [
  ...Array.from({ length: 12 }, (_, i) => ({
    id: 100 + i,
    title: `Track ${String(i + 1).padStart(2, '0')}`,
    artist: `Artist ${i + 1}`,
    audioUrl: `https://audio.test/track-${i + 1}.mp3`,
    assetId: null,
  })),
  {
    id: 200,
    title: 'Manual Pick',
    artist: 'Operator',
    audioUrl: 'https://audio.test/manual.mp3',
    assetId: null,
  },
];

function sessionEngine() {
  let programState = {
    programId: 'radio-1',
    type: 'radio',
    songSequence: {
      mode: 'autoplay',
      loop: false,
      intervalMs: 500,
      items: SESSION_SONGS.slice(0, 12).map((song) => ({
        id: `item-${song.id}`,
        kind: 'preset',
        title: song.title,
        artist: song.artist,
        coverUrl: '',
        audioUrl: song.audioUrl,
        durationMs: 180_000,
        songId: song.id,
      })),
    } as unknown,
    songQueue: [] as unknown[],
    songRotation: null as unknown,
  };
  const prisma = {
    songIntro: { findUnique: jest.fn().mockResolvedValue(null) },
    instant: { findUnique: jest.fn().mockResolvedValue(null) },
    programState: {
      findUnique: jest.fn(() => Promise.resolve(programState)),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        programState = { ...programState, ...data };
        return Promise.resolve(programState);
      }),
    },
  };
  const radioService = {
    playSong: jest.fn().mockResolvedValue({ ok: true }),
    playInstant: jest.fn().mockResolvedValue(undefined),
    getRadioSettings: jest.fn().mockResolvedValue(null),
  };
  const metrics = new Proxy(
    {},
    { get: () => jest.fn() },
  ) as unknown as RadioMetricsService;
  const engine = new SongExecutionEngine(
    radioService as unknown as RadioService,
    {
      isClockedLogRunning: jest.fn().mockReturnValue(false),
      handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as FlightService,
    prisma as unknown as PrismaService,
    {
      publishPlayback: jest.fn().mockResolvedValue(undefined),
      publishStopped: jest.fn().mockResolvedValue(undefined),
    } as unknown as NowPlayingPublisherService,
    metrics,
  );
  engine.setPalazzoTelemetry({ isReconciled: () => true });
  engine.registerRadioProgram('radio-1');
  engine.handleSequenceUpdated('radio-1', programState.songSequence);
  return { engine, radioService };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(1_000);
    for (let j = 0; j < 12; j++) await Promise.resolve();
  }
}

describe('as-run log for a scripted engine session', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists exactly the 10 tracks that were on air, each once, through a dropped end and a replaced command', async () => {
    const store = memoryStore(SESSION_SONGS);
    const { engine, radioService } = sessionEngine();
    const asRun = new AsRunService(
      store.prisma as unknown as PrismaService,
      engine,
    );
    asRun.onModuleInit();

    const lastCommand = () => {
      const call = radioService.playSong.mock.calls.at(-1) as Parameters<
        RadioService['playSong']
      >;
      return { url: call[1], requestId: call[4] as string };
    };
    const play = (ms: number) => jest.setSystemTime(Date.now() + ms);

    let snapshotSequence = 1;
    engine.handlePalazzoSnapshot('radio-1', idleSnapshot(snapshotSequence));
    await settle();

    const onAir: string[] = [];
    let droppedRequestId = '';
    let replacedUrl = '';
    for (let track = 1; onAir.length < 10; track++) {
      const command = lastCommand();

      if (track === 7) {
        // The operator picks a manual song before Palazzo confirms the
        // automatic command; Palazzo then confirms the replaced command.
        replacedUrl = command.url;
        engine.handleManualSong(
          'radio-1',
          'https://audio.test/manual.mp3',
          'Manual Pick',
          'Operator',
          180_000,
        );
        await settle();
        engine.handlePalazzoEvent('radio-1', {
          type: 'track.started',
          data: { playbackRequestId: command.requestId, url: command.url },
        });
        await settle();
        continue;
      }

      engine.handlePalazzoEvent('radio-1', {
        type: 'track.started',
        data: { playbackRequestId: command.requestId, url: command.url },
      });
      await settle();
      onAir.push(command.url);
      play(180_000);

      if (track === 4) {
        // The end event is lost; Palazzo later reports idle.
        droppedRequestId = command.requestId;
        snapshotSequence += 1;
        engine.handlePalazzoSnapshot('radio-1', idleSnapshot(snapshotSequence));
      } else {
        engine.handlePalazzoEvent('radio-1', {
          type: 'track.ended',
          data: { playbackRequestId: command.requestId, url: command.url },
        });
      }
      await settle();

      if (track === 5) {
        // The lost end of track 4 finally arrives.
        engine.handlePalazzoEvent('radio-1', {
          type: 'track.ended',
          data: { playbackRequestId: droppedRequestId },
        });
        await settle();
      }
    }
    asRun.onModuleDestroy();

    expect(onAir).toContain('https://audio.test/manual.mp3');
    expect(onAir).not.toContain(replacedUrl);
    expect(new Set(onAir).size).toBe(10);

    const started = store.rows.filter((row) => row.state === 'started');
    const ended = store.rows.filter((row) => row.state === 'ended');
    const urlOf = (songId: number | null) =>
      SESSION_SONGS.find((song) => song.id === songId)?.audioUrl;
    expect(started.map((row) => urlOf(row.songId))).toEqual(onAir);
    expect(ended.map((row) => urlOf(row.songId))).toEqual(onAir);
    expect(
      ended.filter((row) => row.inferred).map((row) => row.playbackRequestId),
    ).toEqual([droppedRequestId]);

    const titleOf = (url: string) =>
      SESSION_SONGS.find((song) => song.audioUrl === url)!;
    const expectedExport = [
      SX_HEADER,
      ...onAir.map((url) => {
        const song = titleOf(url);
        return `E,${song.artist},${song.title},,,,1`;
      }),
    ].join('\n');
    const sx = await asRun.export('radio-1', { format: 'soundexchange' });
    expect(sx).toBe(expectedExport);
    const dropped = titleOf(onAir[3]);
    expect(
      await asRun.export('radio-1', {
        format: 'soundexchange',
        inferred: 'only',
      }),
    ).toBe([SX_HEADER, `E,${dropped.artist},${dropped.title},,,,1`].join('\n'));
  });
});
