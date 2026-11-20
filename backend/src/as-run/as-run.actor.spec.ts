import { Prisma } from '@prisma/client';
import { ActorContext } from '../auth/actor-context';
import { McpActorAttribution } from '../auth/mcp-actor-attribution';
import { AsRunService } from './as-run.service';
import {
  SongExecutionEngine,
  type SongEngineEvent,
} from '../radio/song-execution.engine';
import type { PrismaService } from '../prisma.service';
import type { RadioService } from '../radio/radio.service';
import type { FlightService } from '../program/flight.service';
import type { NowPlayingPublisherService } from '../radio/now-playing-publisher.service';
import type { RadioMetricsService } from '../radio/radio-metrics.service';
import type { PalazzoPlaybackState } from '../radio/palazzo-contract';

// Attribution on air (gaulatti/alcantara#213): the same engine and as-run
// service as the end-reason spec, driven through the console interceptor-style
// ActorContext and the MCP attribution provider.

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
  actorPrincipalId: string | null;
  actorVia: string | null;
  actorClient: string | null;
};

type CatalogSong = {
  id: number;
  title: string;
  artist: string;
  audioUrl: string;
  assetId: string | null;
};

type Where = Record<string, unknown> & { at?: { gte?: Date; lte?: Date } };

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
          data: Omit<
            Row,
            | 'id'
            | 'createdAt'
            | 'endReason'
            | 'actorPrincipalId'
            | 'actorVia'
            | 'actorClient'
          > &
            Partial<
              Pick<
                Row,
                'endReason' | 'actorPrincipalId' | 'actorVia' | 'actorClient'
              >
            >;
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
            actorPrincipalId: null,
            actorVia: null,
            actorClient: null,
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

function session(options: { durationMs?: (index: number) => number } = {}) {
  let programState = {
    programId: 'radio-1',
    type: 'radio',
    songSequence: {
      mode: 'autoplay',
      loop: false,
      intervalMs: 500,
      items: SONGS.slice(0, 12).map((song, index) => ({
        id: `item-${song.id}`,
        kind: 'preset',
        title: song.title,
        artist: song.artist,
        coverUrl: '',
        audioUrl: song.audioUrl,
        durationMs: options.durationMs?.(index) ?? 180_000,
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
  const metricFns: Record<string | symbol, jest.Mock> = {};
  const metrics = new Proxy(
    {},
    { get: (_target, key) => (metricFns[key] ??= jest.fn()) },
  ) as unknown as RadioMetricsService & Record<string, jest.Mock>;
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
  const events: SongEngineEvent[] = [];
  engine.setBroadcastHandler((event) => events.push(event));
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
    events,
    asRun,
    store,
    radioService,
    prisma,
    metrics,
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

const CONSOLE = {
  principalId: 'principal-console',
  via: 'console' as const,
  client: null,
};
const MCP = {
  principalId: 'principal-mcp',
  via: 'mcp' as const,
  client: 'claude-desktop',
};

describe('as-run attribution of operator actions', () => {
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

  const endedRow = (s: ReturnType<typeof session>, requestId: string) =>
    s.store.rows.find(
      (row) => row.state === 'ended' && row.playbackRequestId === requestId,
    );

  it('records the console identity on an operator stop, and the event carries it', async () => {
    const s = session();
    const command = await onAir(s);
    s.events.length = 0;

    await ActorContext.run(CONSOLE, () => {
      s.engine.handleStopSong('radio-1');
      return Promise.resolve();
    });
    await settle();

    expect(endedRow(s, command.requestId)).toEqual(
      expect.objectContaining({
        endReason: 'stopped',
        actorPrincipalId: 'principal-console',
        actorVia: 'console',
        actorClient: null,
      }),
    );
    expect(s.events).toContainEqual(
      expect.objectContaining({
        type: 'song_off_air',
        actorPrincipalId: 'principal-console',
        actorVia: 'console',
        actorClient: null,
      }),
    );
  });

  it('records the MCP identity and client on a stop run through the attribution provider', async () => {
    const s = session();
    const command = await onAir(s);
    s.events.length = 0;

    await new McpActorAttribution().run(
      { principalId: MCP.principalId, via: 'mcp', client: MCP.client },
      () => {
        s.engine.handleStopSong('radio-1');
        return Promise.resolve();
      },
    );
    await settle();

    expect(endedRow(s, command.requestId)).toEqual(
      expect.objectContaining({
        endReason: 'stopped',
        actorPrincipalId: 'principal-mcp',
        actorVia: 'mcp',
        actorClient: 'claude-desktop',
      }),
    );
    expect(s.events).toContainEqual(
      expect.objectContaining({
        type: 'song_off_air',
        actorVia: 'mcp',
        actorClient: 'claude-desktop',
      }),
    );
  });

  it('attributes a manual pick to its actor on the cut and on the later start, which Palazzo confirms after the command ended', async () => {
    const s = session();
    const cut = await onAir(s);
    s.events.length = 0;

    await ActorContext.run(MCP, () => {
      s.manual();
      return Promise.resolve();
    });
    await settle();
    const manualCommand = s.lastCommand();
    // Palazzo confirms the pick well after the command, outside any scope.
    expect(ActorContext.current()).toBeNull();
    advance(2_000);
    s.ended(cut);
    s.started(manualCommand);
    await settle();
    advance(180_000);
    s.ended(manualCommand);
    await settle();

    expect(endedRow(s, cut.requestId)).toEqual(
      expect.objectContaining({
        endReason: 'replaced',
        actorPrincipalId: 'principal-mcp',
        actorVia: 'mcp',
        actorClient: 'claude-desktop',
      }),
    );
    const manualRows = s.store.rows.filter(
      (row) => row.playbackRequestId === manualCommand.requestId,
    );
    expect(manualRows).toEqual([
      expect.objectContaining({
        state: 'started',
        actorPrincipalId: 'principal-mcp',
        actorVia: 'mcp',
        actorClient: 'claude-desktop',
      }),
      // The song's own natural end is automatic.
      expect.objectContaining({
        state: 'ended',
        actorPrincipalId: null,
        actorVia: null,
        actorClient: null,
      }),
    ]);
    expect(s.events).toContainEqual(
      expect.objectContaining({
        type: 'song_playback_active',
        actorVia: 'mcp',
        actorClient: 'claude-desktop',
      }),
    );
  });

  it('keeps the actor captured at command time when the write happens in a later timer', async () => {
    const s = session();
    const cut = await onAir(s);
    let confirmed: Promise<void> = Promise.resolve();
    const seenAtFire: Array<unknown> = [];

    await ActorContext.run(CONSOLE, () => {
      s.manual();
      const manualCommand = s.lastCommand();
      // A timer created inside the command inherits Node's store, but the
      // scope is closed by then: a read at fire time would see no actor.
      confirmed = new Promise((resolve) => {
        setTimeout(() => {
          seenAtFire.push(ActorContext.current());
          s.ended(cut);
          s.started(manualCommand);
          resolve();
        }, 5_000);
      });
      return Promise.resolve();
    });
    jest.advanceTimersByTime(5_000);
    await confirmed;
    await settle();
    expect(seenAtFire).toEqual([null]);

    const rows = s.store.rows.filter(
      (row) =>
        row.playbackRequestId === s.lastCommand().requestId &&
        row.state === 'started',
    );
    expect(rows).toEqual([
      expect.objectContaining({
        actorPrincipalId: 'principal-console',
        actorVia: 'console',
        actorClient: null,
      }),
    ]);
  });

  it('keeps all three columns NULL for every automatic end and for a stop with no actor', async () => {
    const s = session();
    const first = await onAir(s);
    // Natural end, then the next song starts and Palazzo's snapshot supersedes it.
    s.ended(first);
    await settle();
    const second = s.lastCommand();
    s.started(second);
    await settle();
    advance(60_000);
    s.playing('foreign-request', 'https://audio.test/elsewhere.mp3');
    await settle();
    s.engine.handleStopSong('radio-1');
    await settle();

    expect(s.store.rows.length).toBeGreaterThanOrEqual(4);
    for (const row of s.store.rows) {
      expect(row).toEqual(
        expect.objectContaining({
          actorPrincipalId: null,
          actorVia: null,
          actorClient: null,
        }),
      );
    }
    expect(endedRow(s, first.requestId)?.endReason).toBeNull();
    expect(endedRow(s, second.requestId)?.endReason).toBe('superseded');
  });

  it('carries the identity on queue mutations and none on automatic queue updates', async () => {
    const s = session();
    s.events.length = 0;
    const queue = await ActorContext.run(CONSOLE, () =>
      s.engine.enqueueSong('radio-1', 'item-100'),
    );
    await ActorContext.run(MCP, () =>
      s.engine.reorderSongQueue('radio-1', [queue[0].id]),
    );
    await ActorContext.run(MCP, () =>
      s.engine.removeQueuedSong('radio-1', queue[0].id),
    );
    await s.engine.enqueueSong('radio-1', 'item-101');

    const updates = s.events.filter(
      (event) => event.type === 'song_queue_update',
    );
    expect(updates.map((event) => [event.actorVia, event.actorClient])).toEqual(
      [
        ['console', null],
        ['mcp', 'claude-desktop'],
        ['mcp', 'claude-desktop'],
        [undefined, undefined],
      ],
    );
    expect(updates[0].actorPrincipalId).toBe('principal-console');
  });

  it('stores nothing for an unknown channel and nothing a record cannot hold', async () => {
    const s = session();
    const row = await s.asRun.handleTrackEvent({
      programId: 'radio-1',
      type: 'track.started',
      playbackRequestId: 'odd-1',
      title: null,
      artist: null,
      url: null,
      at: new Date(),
      actorPrincipalId: 'someone',
      actorVia: 'carrier-pigeon',
      actorClient: 'x',
    });
    expect(row).toEqual(
      expect.objectContaining({
        actorPrincipalId: null,
        actorVia: null,
        actorClient: null,
      }),
    );
    const unresolved = await s.asRun.handleTrackEvent({
      programId: 'radio-1',
      type: 'track.started',
      playbackRequestId: 'odd-2',
      title: null,
      artist: null,
      url: null,
      at: new Date(),
      actorPrincipalId: '',
      actorVia: 'console',
      actorClient: '',
    });
    expect(unresolved).toEqual(
      expect.objectContaining({
        actorPrincipalId: null,
        actorVia: 'console',
        actorClient: null,
      }),
    );
  });

  it('exports the three columns, empty for automatic rows', async () => {
    const s = session();
    const command = await onAir(s);
    await ActorContext.run(MCP, () => {
      s.engine.handleStopSong('radio-1');
      return Promise.resolve();
    });
    await settle();
    s.ended(command);

    const [header, ...lines] = (await s.asRun.export('radio-1', {})).split(
      '\n',
    );
    const columns = header.split(',');
    expect(columns.slice(-3)).toEqual([
      'actorPrincipalId',
      'actorVia',
      'actorClient',
    ]);
    const cells = (line: string) => line.split(',');
    const started = lines.find((line) => line.includes(',started,'))!;
    const ended = lines.find((line) => line.includes(',ended,'))!;
    expect(cells(started).slice(-3)).toEqual(['', '', '']);
    expect(cells(ended).slice(-4)).toEqual([
      'stopped',
      'principal-mcp',
      'mcp',
      'claude-desktop',
    ]);
  });
});
