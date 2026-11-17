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

// Plays that end by an operator Stop, a manual cut or a superseding snapshot
// (gaulatti/alcantara#171). The end reason comes from what the engine itself
// did, never from Palazzo's stop-reason label.

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
  endReason: string | null;
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
const CSV_HEADER =
  'id,programId,songId,assetId,title,artist,state,at,createdAt,inferred,reviewFlag,endReason';

/** In-memory AsRunRecord table with the migration's unique key. */
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
      create: jest.fn(
        ({
          data,
        }: {
          data: Omit<Row, 'id' | 'createdAt' | 'endReason'> & {
            endReason?: string | null;
          };
        }) => {
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
          // The column defaults to NULL, as in the migration.
          const row: Row = {
            endReason: null,
            ...data,
            id: rows.length + 1,
            createdAt: data.at,
          };
          rows.push(row);
          return Promise.resolve(row);
        },
      ),
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

const SONGS: CatalogSong[] = [
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
const MANUAL = SONGS[12];

function baseSnapshot(sequence: number): PalazzoPlaybackState {
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

function playingSnapshot(
  sequence: number,
  playbackRequestId: string,
  url: string,
): PalazzoPlaybackState {
  return {
    ...baseSnapshot(sequence),
    status: 'playing',
    track: {
      playbackRequestId,
      title: null,
      artist: null,
      coverUrl: null,
      url,
      startedAt: new Date().toISOString(),
    },
    positionSeconds: 1,
  };
}

function session() {
  let programState = {
    programId: 'radio-1',
    type: 'radio',
    songSequence: {
      mode: 'autoplay',
      loop: false,
      intervalMs: 500,
      items: SONGS.slice(0, 12).map((song) => ({
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

  const store = memoryStore(SONGS);
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
  const started = (command: { url: string; requestId: string }) =>
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: command.requestId, url: command.url },
    });
  const ended = (command: { url?: string; requestId: string }) =>
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: command.requestId, url: command.url },
    });
  let sequence = 1;
  const idle = () =>
    engine.handlePalazzoSnapshot('radio-1', baseSnapshot(++sequence));
  const playing = (requestId: string, url: string) =>
    engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(++sequence, requestId, url),
    );
  const manual = () =>
    engine.handleManualSong(
      'radio-1',
      MANUAL.audioUrl,
      MANUAL.title,
      MANUAL.artist,
      180_000,
    );
  const urlOf = (songId: number | null) =>
    SONGS.find((song) => song.id === songId)?.audioUrl;

  return {
    engine,
    asRun,
    store,
    radioService,
    prisma,
    persistedSequence: () =>
      programState.songSequence as Record<string, unknown>,
    lastCommand,
    started,
    ended,
    idle,
    playing,
    manual,
    urlOf,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(1_000);
    for (let j = 0; j < 12; j++) await Promise.resolve();
  }
}

const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);

describe('as-run records for plays the engine ends itself', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function onAir(s: ReturnType<typeof session>) {
    s.idle();
    await settle();
    const command = s.lastCommand();
    s.started(command);
    await settle();
    advance(60_000);
    return command;
  }

  it('closes a started song at the operator stop time with end reason stopped, once', async () => {
    const s = session();
    const command = await onAir(s);
    const stopAt = new Date(Date.now());

    s.engine.handleStopSong('radio-1');
    await settle();
    // Palazzo's own end for the stopped track arrives late, then idle.
    s.ended(command);
    await settle();
    s.idle();
    await settle();

    const ended = s.store.rows.filter(
      (row) =>
        row.state === 'ended' && row.playbackRequestId === command.requestId,
    );
    expect(ended).toEqual([
      expect.objectContaining({
        at: stopAt,
        endReason: 'stopped',
        inferred: false,
        reviewFlag: null,
      }),
    ]);
    expect(s.urlOf(ended[0].songId)).toBe(command.url);
  });

  it('closes a song a manual pick cuts with end reason replaced, and the manual song gets its own record', async () => {
    const s = session();
    const cut = await onAir(s);
    const cutAt = new Date(Date.now());

    s.manual();
    await settle();
    const manualCommand = s.lastCommand();
    expect(manualCommand.url).toBe(MANUAL.audioUrl);
    // The cut track's real end arrives after the cut.
    s.ended(cut);
    s.started(manualCommand);
    await settle();
    advance(180_000);
    s.ended(manualCommand);
    await settle();

    const cutRows = s.store.rows.filter(
      (row) => row.playbackRequestId === cut.requestId,
    );
    expect(cutRows.map((row) => row.state)).toEqual(['started', 'ended']);
    expect(cutRows[1]).toEqual(
      expect.objectContaining({
        at: cutAt,
        endReason: 'replaced',
        inferred: false,
        reviewFlag: null,
      }),
    );
    const manualRows = s.store.rows.filter(
      (row) => row.playbackRequestId === manualCommand.requestId,
    );
    expect(manualRows).toEqual([
      expect.objectContaining({ state: 'started', songId: MANUAL.id }),
      expect.objectContaining({
        state: 'ended',
        songId: MANUAL.id,
        endReason: null,
        inferred: false,
      }),
    ]);
  });

  it('closes a song a different track supersedes at the snapshot time, inferred, once', async () => {
    const s = session();
    const superseded = await onAir(s);
    const snapshotAt = new Date(Date.now());

    s.playing('foreign-request', 'https://audio.test/elsewhere.mp3');
    await settle();
    advance(5_000);
    // The same foreign track is reported again, then the real end and an
    // idle snapshot arrive late.
    s.playing('foreign-request', 'https://audio.test/elsewhere.mp3');
    s.ended(superseded);
    await settle();
    s.idle();
    await settle();

    const ended = s.store.rows.filter(
      (row) =>
        row.state === 'ended' && row.playbackRequestId === superseded.requestId,
    );
    expect(ended).toEqual([
      expect.objectContaining({
        at: snapshotAt,
        endReason: 'superseded',
        inferred: true,
        reviewFlag: null,
      }),
    ]);
  });

  it('records nothing for a song that never started, however it ends', async () => {
    const s = session();
    s.idle();
    await settle();
    const neverStarted = s.lastCommand();

    s.engine.handleStopSong('radio-1');
    s.idle();
    await settle();
    // Stop halts the sequence (#173); the operator presses play.
    s.engine.handleSequenceUpdated('radio-1', {
      ...s.persistedSequence(),
      mode: 'autoplay',
    });
    await settle();
    const replacedBeforeStart = s.lastCommand();
    s.manual();
    await settle();
    s.playing('foreign-request', 'https://audio.test/elsewhere.mp3');
    await settle();

    expect(s.store.rows).toEqual([]);
    expect(neverStarted.requestId).not.toBe(replacedBeforeStart.requestId);
  });

  it('flags a stop shortly after the start for review but still records it', async () => {
    const s = session();
    s.idle();
    await settle();
    const command = s.lastCommand();
    s.started(command);
    await settle();
    advance(5_000);

    s.engine.handleStopSong('radio-1');
    await settle();

    expect(s.store.rows.filter((row) => row.state === 'ended')).toEqual([
      expect.objectContaining({
        endReason: 'stopped',
        inferred: false,
        reviewFlag: 'short',
      }),
    ]);
  });

  it('lists exactly the 12 tracks that were on air through a stop, a manual cut and a superseding snapshot', async () => {
    const s = session();
    s.idle();
    await settle();

    const onAirUrls: string[] = [];
    while (onAirUrls.length < 12) {
      const command = s.lastCommand();
      s.started(command);
      await settle();
      onAirUrls.push(command.url);
      advance(60_000);
      const n = onAirUrls.length;

      if (n === 3) {
        // Operator Stop halts the sequence; the operator then presses play
        // (gaulatti/alcantara#173), and the next track goes on air.
        s.engine.handleStopSong('radio-1');
        await settle();
        s.ended(command);
        s.idle();
        await settle();
        s.engine.handleSequenceUpdated('radio-1', {
          ...s.persistedSequence(),
          mode: 'autoplay',
        });
        await settle();
      } else if (n === 6) {
        // A manual pick cuts the playing song; the manual song is on air.
        s.manual();
        await settle();
        s.ended(command);
        await settle();
      } else if (n === 9) {
        // Palazzo reports another track on air; it then ends and goes idle.
        s.playing('foreign-request', 'https://audio.test/elsewhere.mp3');
        await settle();
        s.ended(command);
        s.idle();
        await settle();
      } else {
        advance(120_000);
        s.ended(command);
        await settle();
      }
    }
    s.asRun.onModuleDestroy();

    expect(onAirUrls).toContain(MANUAL.audioUrl);
    const ended = s.store.rows.filter((row) => row.state === 'ended');
    expect(ended.map((row) => s.urlOf(row.songId))).toEqual(onAirUrls);
    expect(ended.map((row) => row.endReason)).toEqual(
      onAirUrls.map((_, i) =>
        i === 2
          ? 'stopped'
          : i === 5
            ? 'replaced'
            : i === 8
              ? 'superseded'
              : null,
      ),
    );

    // Each track is on air, and in the as-run log, exactly once (#173).
    expect(new Set(onAirUrls).size).toBe(12);
    const counts = new Map<string, number>();
    for (const url of onAirUrls) counts.set(url, (counts.get(url) ?? 0) + 1);
    const expected = [...counts.entries()].map(([url, count]) => {
      const song = SONGS.find((candidate) => candidate.audioUrl === url)!;
      return `E,${song.artist},${song.title},,,,${count}`;
    });
    const sx = await s.asRun.export('radio-1', { format: 'soundexchange' });
    expect(sx).toBe([SX_HEADER, ...expected].join('\n'));
    expect(
      [...counts.values()].reduce((total, count) => total + count, 0),
    ).toBe(12);
  });
});

describe('as-run export of each end reason', () => {
  let store: ReturnType<typeof memoryStore>;
  let service: AsRunService;

  function event(
    type: AsRunTrackEvent['type'],
    playbackRequestId: string,
    song: CatalogSong,
    at: string,
    extra: Partial<AsRunTrackEvent> = {},
  ): AsRunTrackEvent {
    return {
      programId: 'radio-1',
      type,
      playbackRequestId,
      title: null,
      artist: null,
      url: song.audioUrl,
      at: new Date(at),
      ...extra,
    };
  }

  async function play(
    requestId: string,
    song: CatalogSong,
    start: string,
    end: string,
    extra: Partial<AsRunTrackEvent> = {},
  ) {
    await service.handleTrackEvent(
      event('track.started', requestId, song, start),
    );
    await service.handleTrackEvent(
      event('track.ended', requestId, song, end, extra),
    );
  }

  beforeEach(async () => {
    store = memoryStore(SONGS);
    service = new AsRunService(store.prisma as unknown as PrismaService);
    await play(
      'req-natural',
      SONGS[0],
      '2026-11-17T10:00:00.000Z',
      '2026-11-17T10:03:00.000Z',
    );
    await play(
      'req-stopped',
      SONGS[1],
      '2026-11-17T10:03:00.000Z',
      '2026-11-17T10:04:00.000Z',
      { endReason: 'stopped' },
    );
    await play(
      'req-replaced',
      SONGS[2],
      '2026-11-17T10:04:00.000Z',
      '2026-11-17T10:05:00.000Z',
      { endReason: 'replaced' },
    );
    await play(
      'req-superseded',
      SONGS[3],
      '2026-11-17T10:05:00.000Z',
      '2026-11-17T10:06:00.000Z',
      { endReason: 'superseded', inferred: true },
    );
  });

  it('appends the end reason as the last CSV column', async () => {
    const csv = (await service.export('radio-1', {})).split('\n');
    expect(csv[0]).toBe(CSV_HEADER);
    expect(
      csv
        .filter((line) => line.includes(',ended,'))
        .map((line) => {
          const fields = line.split(',');
          return fields.slice(-3).join(',');
        }),
    ).toEqual([
      'false,,',
      'false,,stopped',
      'false,,replaced',
      'true,,superseded',
    ]);
    // A start never carries an end reason.
    expect(
      csv
        .filter((line) => line.includes(',started,'))
        .map((line) => {
          const fields = line.split(',');
          return fields.at(-1);
        }),
    ).toEqual(['', '', '', '']);
  });

  it('counts a stopped play as a performance in every inferred filter but only', async () => {
    const row = 'E,Artist 2,Track 02,,,,1';
    expect(
      await service.export('radio-1', { format: 'soundexchange' }),
    ).toContain(row);
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'exclude',
      }),
    ).toContain(row);
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'only',
      }),
    ).not.toContain(row);
  });

  it('counts a replaced play as a performance in every inferred filter but only', async () => {
    const row = 'E,Artist 3,Track 03,,,,1';
    expect(
      await service.export('radio-1', { format: 'soundexchange' }),
    ).toContain(row);
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'exclude',
      }),
    ).toContain(row);
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'only',
      }),
    ).not.toContain(row);
  });

  it('counts a superseded play as an inferred performance', async () => {
    const row = 'E,Artist 4,Track 04,,,,1';
    expect(
      await service.export('radio-1', { format: 'soundexchange' }),
    ).toContain(row);
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'only',
      }),
    ).toBe([SX_HEADER, row].join('\n'));
    expect(
      await service.export('radio-1', {
        format: 'soundexchange',
        inferred: 'exclude',
      }),
    ).not.toContain(row);
  });

  it('raises the default total only by the three plays', async () => {
    const sx = (
      await service.export('radio-1', { format: 'soundexchange' })
    ).split('\n');
    expect(sx).toEqual([
      SX_HEADER,
      'E,Artist 1,Track 01,,,,1',
      'E,Artist 2,Track 02,,,,1',
      'E,Artist 3,Track 03,,,,1',
      'E,Artist 4,Track 04,,,,1',
    ]);
  });

  it('ignores an end reason on a start, and an unknown end reason', async () => {
    await service.handleTrackEvent(
      event('track.started', 'req-odd', SONGS[4], '2026-11-17T11:00:00.000Z', {
        endReason: 'stopped',
      }),
    );
    await service.handleTrackEvent(
      event('track.ended', 'req-odd', SONGS[4], '2026-11-17T11:03:00.000Z', {
        endReason: 'something-else' as never,
      }),
    );
    expect(
      store.rows
        .filter((row) => row.playbackRequestId === 'req-odd')
        .map((row) => [row.state, row.endReason, row.reviewFlag]),
    ).toEqual([
      ['started', null, null],
      ['ended', null, null],
    ]);
  });
});

// gaulatti/alcantara#173: an operator Stop halts the sequence until the
// operator acts; idle snapshots and a restart start nothing by themselves.
describe('operator Stop halts the radio sequence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function stoppedOnTrackOne(s: ReturnType<typeof session>) {
    s.idle();
    await settle();
    const command = s.lastCommand();
    s.started(command);
    await settle();
    advance(60_000);
    s.engine.handleStopSong('radio-1');
    await settle();
    s.ended(command);
    await settle();
    return command;
  }

  it('sends no song command on three idle snapshots after a Stop', async () => {
    const s = session();
    const command = await stoppedOnTrackOne(s);
    expect(command.url).toBe(SONGS[0].audioUrl);
    const sent = s.radioService.playSong.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      s.idle();
      await settle();
    }
    expect(s.radioService.playSong.mock.calls.length).toBe(sent);
    s.asRun.onModuleDestroy();
  });

  it('keeps the halt across a restart: the persisted sequence is manual, cued at the next track', async () => {
    const s = session();
    await stoppedOnTrackOne(s);
    expect(s.persistedSequence()).toMatchObject({
      mode: 'manual',
      activeItemId: `item-${SONGS[1].id}`,
    });
    s.asRun.onModuleDestroy();
  });

  it('resumes on the operator play with exactly one command, for the next track', async () => {
    const s = session();
    await stoppedOnTrackOne(s);
    const sent = s.radioService.playSong.mock.calls.length;
    s.idle();
    await settle();
    s.engine.handleSequenceUpdated('radio-1', {
      ...s.persistedSequence(),
      mode: 'autoplay',
    });
    await settle();
    expect(s.radioService.playSong.mock.calls.length).toBe(sent + 1);
    expect(s.lastCommand().url).toBe(SONGS[1].audioUrl);
    s.asRun.onModuleDestroy();
  });

  it('resumes on an operator manual pick with exactly one command, for that song', async () => {
    const s = session();
    await stoppedOnTrackOne(s);
    const sent = s.radioService.playSong.mock.calls.length;
    s.idle();
    await settle();
    s.manual();
    await settle();
    expect(s.radioService.playSong.mock.calls.length).toBe(sent + 1);
    expect(s.lastCommand().url).toBe(MANUAL.audioUrl);
    s.asRun.onModuleDestroy();
  });

  it('does not move the cursor when the stopped song was a manual pick', async () => {
    const s = session();
    s.idle();
    await settle();
    s.manual();
    await settle();
    const command = s.lastCommand();
    s.started(command);
    await settle();
    s.engine.handleStopSong('radio-1');
    await settle();
    expect(s.persistedSequence()).toMatchObject({ mode: 'manual' });
    s.asRun.onModuleDestroy();
  });

  it('halts a shuffle rotation too, even with no song on air', async () => {
    const s = session();
    s.engine.handleSequenceUpdated('radio-1', {
      ...s.persistedSequence(),
      mode: 'shuffle',
    });
    s.engine.handleStopSong('radio-1');
    await settle();
    // Nothing was on air, so the cursor stays where it was.
    expect(s.persistedSequence()).toMatchObject({
      mode: 'manual',
      activeItemId: `item-${SONGS[0].id}`,
    });
    s.idle();
    await settle();
    expect(s.radioService.playSong).not.toHaveBeenCalled();
    s.asRun.onModuleDestroy();
  });

  it('stays halted and logs when the stopped rotation cannot be persisted', async () => {
    const s = session();
    await stoppedOnTrackOne(s);
    s.prisma.programState.update.mockRejectedValueOnce(new Error('db down'));
    const logged = jest
      .spyOn(
        (s.engine as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    s.engine.handleSequenceUpdated('radio-1', {
      ...s.persistedSequence(),
      mode: 'autoplay',
    });
    await settle();
    const command = s.lastCommand();
    s.started(command);
    await settle();
    s.engine.handleStopSong('radio-1');
    await settle();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(
        'Could not persist the stopped sequence on radio-1',
      ),
    );
    const sent = s.radioService.playSong.mock.calls.length;
    s.ended(command);
    s.idle();
    await settle();
    expect(s.radioService.playSong.mock.calls.length).toBe(sent);
    s.asRun.onModuleDestroy();
  });

  it('keeps the mode on a flight-driven stop and moves on: the next track plays once, no replay', async () => {
    const s = session();
    s.idle();
    await settle();
    const command = s.lastCommand();
    s.started(command);
    await settle();
    s.engine.handleStopSong('radio-1', { keepMode: true });
    await settle();
    expect(s.persistedSequence()).toMatchObject({
      mode: 'autoplay',
      activeItemId: `item-${SONGS[1].id}`,
    });
    const sent = s.radioService.playSong.mock.calls.length;
    s.ended(command);
    s.idle();
    await settle();
    expect(s.radioService.playSong.mock.calls.length).toBe(sent + 1);
    expect(s.lastCommand().url).toBe(SONGS[1].audioUrl);
    s.asRun.onModuleDestroy();
  });

  it('keeps the rotation when a timed block stops the song', async () => {
    const s = session();
    s.idle();
    await settle();
    s.started(s.lastCommand());
    await settle();
    s.engine.handleStopSong('radio-1', { keepSequence: true });
    await settle();
    expect(s.persistedSequence()).toMatchObject({ mode: 'autoplay' });
    s.asRun.onModuleDestroy();
  });
});

// gaulatti/alcantara#174: a song the engine adopts from a Palazzo snapshot
// (for example after a restart mid-song) gets one inferred start.
describe('as-run start for a song adopted from a snapshot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const PALAZZO_START = '2026-11-17T11:58:30.000Z';
  const adopt = (
    s: ReturnType<typeof session>,
    startedAt: string | null,
    requestId = 'adopted-1',
  ) =>
    s.engine.handlePalazzoSnapshot('radio-1', {
      ...playingSnapshot(50, requestId, SONGS[0].audioUrl),
      track: {
        playbackRequestId: requestId,
        title: null,
        artist: null,
        coverUrl: null,
        url: SONGS[0].audioUrl,
        startedAt,
      },
      positionSeconds: 90,
    } as PalazzoPlaybackState);
  const startedRows = (s: ReturnType<typeof session>) =>
    s.store.rows.filter((row) => row.state === 'started');

  it("writes one inferred start at Palazzo's reported start time", async () => {
    const s = session();
    adopt(s, PALAZZO_START);
    await settle();
    expect(startedRows(s)).toEqual([
      expect.objectContaining({
        playbackRequestId: 'adopted-1',
        songId: SONGS[0].id,
        inferred: true,
        reviewFlag: null,
        at: new Date(PALAZZO_START),
      }),
    ]);
    s.asRun.onModuleDestroy();
  });

  it('uses the snapshot time when Palazzo reports no start time', async () => {
    const s = session();
    adopt(s, null);
    await settle();
    expect(startedRows(s)).toEqual([
      expect.objectContaining({
        inferred: true,
        at: new Date('2026-11-17T12:00:00.000Z'),
      }),
    ]);
    s.asRun.onModuleDestroy();
  });

  it('keeps one start when the real track.started also arrives, after or before', async () => {
    const after = session();
    adopt(after, PALAZZO_START);
    await settle();
    after.started({ requestId: 'adopted-1', url: SONGS[0].audioUrl });
    await settle();
    expect(startedRows(after)).toHaveLength(1);
    after.asRun.onModuleDestroy();

    const before = session();
    before.started({ requestId: 'adopted-2', url: SONGS[0].audioUrl });
    await settle();
    adopt(before, PALAZZO_START, 'adopted-2');
    await settle();
    expect(startedRows(before)).toHaveLength(1);
    before.asRun.onModuleDestroy();
  });

  it('no longer flags the end of an adopted play no-start', async () => {
    const s = session();
    adopt(s, PALAZZO_START);
    await settle();
    s.idle();
    await settle();
    expect(s.store.rows.filter((row) => row.state === 'ended')).toEqual([
      expect.objectContaining({
        playbackRequestId: 'adopted-1',
        inferred: true,
        reviewFlag: null,
      }),
    ]);
    s.asRun.onModuleDestroy();
  });
});
