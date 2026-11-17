/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/unbound-method -- Jest mocks are intentionally loosely typed. */
import { Logger } from '@nestjs/common';
import { ChartsService } from './charts.service';

const EARONE = 'api6.xdevel.com';
const ESCPLUS = 'escplus.es';

type Responder = (url: string) => Promise<unknown> | unknown;

function mockFetch(responder: Responder) {
  const fn = jest.fn(async (url: string) => {
    const out = await responder(url);
    return out as Response;
  });
  (global as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function prismaStub() {
  return {
    songChartIdentity: {
      findMany: jest.fn(async () => []),
      update: jest.fn(),
    },
  } as never;
}

const originalFetch = global.fetch;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function earonePayload(songs: unknown, modifiedOn?: unknown) {
  return { result: { modifiedOn, postTypeData: { songs } } };
}

describe('ChartsService merging', () => {
  it('merges earone and escplus data, normalizing keys and sorting by artist', async () => {
    const metrics = { recordJob: jest.fn(), recordDependency: jest.fn() };
    mockFetch((url) =>
      url.includes(EARONE)
        ? ok(
            earonePayload(
              [
                {
                  curPos: 2,
                  spins: 40,
                  song: {
                    earoneSongId: 99,
                    title: ' Très Bien & Co ',
                    tracks: [
                      { artists: [{ name: ' Zed ' }, { name: 'Amy' }, {}] },
                    ],
                  },
                },
                {
                  song: {
                    earoneSongId: 'abc',
                    title: 'Solo',
                    tracks: [{ artists: [{ name: 'Beta' }] }],
                  },
                },
                {
                  song: {
                    earoneSongId: {},
                    title: 'No Id',
                    tracks: [{ artists: [{ name: 'Gamma' }] }],
                  },
                  curPos: Number.NaN,
                },
                { song: { title: 'No artists' } },
                { song: { title: '', tracks: [{ artists: [{ name: 'A' }] }] } },
                { song: { title: 42, tracks: [{ artists: [{ name: 'A' }] }] } },
                {
                  song: {
                    title: '!!!',
                    tracks: [{ artists: [{ name: '??' }] }],
                  },
                },
                {},
              ],
              '2026-02-01T00:00:00Z',
            ),
          )
        : ok([
            {
              artist: 'zed & amy',
              song: 'Tres bien and co',
              spotifyplays: 1000,
              youtube: { views: 5, likes: 'x' },
            },
            {
              artist: 'Delta',
              song: 'Fresh',
              spotifyplays: 7,
              youtube: { views: 8, likes: 9 },
            },
            { artist: 'Epsilon', song: 'Bare' },
            { artist: 'NoSong' },
            { song: 'NoArtist' },
            { artist: '??', song: '!!' },
          ]),
    );
    const service = new ChartsService(prismaStub(), metrics as never);

    const result = await service.getSanremoRealtime();

    expect(result.sources.earoneUpdatedAt).toBe('2026-02-01T00:00:00Z');
    expect(typeof result.sources.escplusUpdatedAt).toBe('string');
    expect(result.entries.map((e) => e.artist)).toEqual([
      'Beta',
      'Delta',
      'Epsilon',
      'Gamma',
      'Zed & Amy',
    ]);
    const zed = result.entries.find((e) => e.artist === 'Zed & Amy');
    expect(zed).toEqual({
      normalizedKey: 'zed and amy tres bien and co',
      earoneSongId: '99',
      artist: 'Zed & Amy',
      title: 'Très Bien & Co',
      ranking: '2',
      radioSpinsToday: '40',
      spotifyPlays: '1000',
      youtubeViews: '5',
      youtubeLikes: null,
      sourceKeys: {
        earone: 'zed and amy tres bien and co',
        escplus: 'zed and amy tres bien and co',
      },
    });
    expect(result.entries.find((e) => e.artist === 'Beta')).toMatchObject({
      earoneSongId: 'abc',
      ranking: null,
      radioSpinsToday: null,
      spotifyPlays: null,
    });
    expect(result.entries.find((e) => e.artist === 'Gamma')).toMatchObject({
      earoneSongId: null,
      ranking: null,
    });
    expect(result.entries.find((e) => e.artist === 'Delta')).toEqual({
      normalizedKey: 'delta fresh',
      earoneSongId: null,
      artist: 'Delta',
      title: 'Fresh',
      ranking: null,
      radioSpinsToday: null,
      spotifyPlays: '7',
      youtubeViews: '8',
      youtubeLikes: '9',
      sourceKeys: { earone: null, escplus: 'delta fresh' },
    });
    expect(result.entries.find((e) => e.artist === 'Epsilon')).toMatchObject({
      spotifyPlays: null,
      youtubeViews: null,
      youtubeLikes: null,
    });
    expect(metrics.recordJob).toHaveBeenCalledWith('charts-refresh', 'success');
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'earone',
      'fetch',
      'success',
      expect.any(Number),
    );
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'escplus',
      'fetch',
      'success',
      expect.any(Number),
    );
  });

  it('tolerates malformed payload shapes and works without metrics', async () => {
    mockFetch((url) =>
      url.includes(EARONE) ? ok({ result: { modifiedOn: 5 } }) : ok({ a: 1 }),
    );
    const service = new ChartsService(prismaStub());
    // entries stay empty, so each call retries the refresh
    const result = await service.getSanremoRealtime();
    expect(result.entries).toEqual([]);
    expect(result.sources.earoneUpdatedAt).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('handles an empty earone payload object', async () => {
    mockFetch((url) => (url.includes(EARONE) ? ok(null) : ok([])));
    const service = new ChartsService(prismaStub());
    const result = await service.getSanremoRealtime();
    expect(result.entries).toEqual([]);
    expect(result.sources.earoneUpdatedAt).toBeNull();
  });

  it('serves the cache without refetching once populated', async () => {
    const fetchMock = mockFetch((url) =>
      url.includes(EARONE)
        ? ok(
            earonePayload([
              { song: { title: 'T', tracks: [{ artists: [{ name: 'A' }] }] } },
            ]),
          )
        : ok([]),
    );
    const service = new ChartsService(prismaStub());
    const first = await service.getSanremoRealtime();
    const second = await service.getSanremoRealtime();
    expect(second).toBe(first);
    expect(first.entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ChartsService failures', () => {
  it('records http errors without double-counting them as unavailable', async () => {
    const metrics = { recordJob: jest.fn(), recordDependency: jest.fn() };
    mockFetch((url) =>
      url.includes(ESCPLUS)
        ? ok([])
        : { ok: false, status: 503, json: async () => ({}) },
    );
    const service = new ChartsService(prismaStub(), metrics as never);
    const result = await service.getSanremoRealtime();
    expect(result.entries).toEqual([]);
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'earone',
      'fetch',
      'http-error',
      expect.any(Number),
    );
    expect(
      metrics.recordDependency.mock.calls.filter((c) => c[2] === 'unavailable'),
    ).toHaveLength(0);
    expect(metrics.recordJob).toHaveBeenCalledWith('charts-refresh', 'failure');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('responded with 503'),
    );
  });

  it('records unavailable for network errors, including non-Error rejections', async () => {
    const metrics = { recordJob: jest.fn(), recordDependency: jest.fn() };
    mockFetch((url) => {
      if (url.includes(EARONE)) throw new Error('network down');
      return Promise.reject('plain string');
    });
    const service = new ChartsService(prismaStub(), metrics as never);
    await service.getSanremoRealtime();
    const unavailable = metrics.recordDependency.mock.calls.filter(
      (c) => c[2] === 'unavailable',
    );
    expect(unavailable.map((c) => c[0]).sort()).toEqual(['earone', 'escplus']);
    expect(metrics.recordJob).toHaveBeenCalledWith('charts-refresh', 'failure');
  });

  it('records unavailable for an Error whose message is unrelated to an http status', async () => {
    const metrics = { recordJob: jest.fn(), recordDependency: jest.fn() };
    mockFetch((url) =>
      url.includes(EARONE)
        ? {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('bad json');
            },
          }
        : ok([]),
    );
    const service = new ChartsService(prismaStub(), metrics as never);
    await service.getSanremoRealtime();
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'earone',
      'fetch',
      'unavailable',
      expect.any(Number),
    );
  });

  it('failure without metrics only logs', async () => {
    mockFetch(() => {
      throw new Error('x');
    });
    const service = new ChartsService(prismaStub());
    await expect(service.getSanremoRealtime()).resolves.toMatchObject({
      entries: [],
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('shares an in-flight refresh between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = mockFetch(async (url) => {
      await gate;
      return url.includes(EARONE) ? ok(earonePayload([])) : ok([]);
    });
    const service = new ChartsService(prismaStub());
    const a = service.getSanremoRealtime();
    const b = service.getSanremoRealtime();
    release();
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ChartsService lifecycle', () => {
  it('refreshes on init and every 15s until destroyed', async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetch((url) =>
      url.includes(EARONE) ? ok(earonePayload([])) : ok([]),
    );
    const service = new ChartsService(prismaStub());
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(15000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('destroying before init is a no-op', () => {
    expect(() =>
      new ChartsService(prismaStub()).onModuleDestroy(),
    ).not.toThrow();
  });
});

const UPSTREAM_EARONE = {
  result: {
    modifiedOn: '2026-11-17T08:00:00Z',
    postTypeData: {
      songs: [
        {
          curPos: 1,
          spins: 310,
          song: {
            earoneSongId: 501,
            title: 'Cuore',
            tracks: [{ artists: [{ name: 'Alba' }] }],
          },
        },
        {
          curPos: 7,
          spins: 120,
          song: {
            earoneSongId: 502,
            title: 'Notte',
            tracks: [{ artists: [{ name: 'Bruno' }] }],
          },
        },
        {
          song: {
            earoneSongId: 503,
            title: 'Senza',
            tracks: [{ artists: [{ name: 'Carla' }] }],
          },
        },
      ],
    },
  },
};

const UPSTREAM_ESCPLUS = [
  { artist: 'Alba', song: 'Cuore', spotifyplays: 9000 },
  { artist: 'Dario', song: 'Solo', spotifyplays: 10 },
];

function upstream(earone: unknown = UPSTREAM_EARONE) {
  const fetchMock = jest.fn(async (url: string) =>
    url.includes(EARONE)
      ? (ok(earone) as Response)
      : (ok(UPSTREAM_ESCPLUS) as Response),
  );
  global.fetch = fetchMock as never;
  return fetchMock;
}

function prismaWith(rows: Array<Record<string, unknown>>) {
  return {
    songChartIdentity: {
      findMany: jest.fn(async () => rows),
      update: jest.fn(async () => ({})),
    },
  };
}

describe('ChartsService rank refresh into SongChartIdentity', () => {
  it('writes the upstream rank and spins into matching rows after one cycle, with one upstream call each', async () => {
    const fetchMock = upstream();
    const prisma = prismaWith([
      { id: 11, externalId: '501', rank: '4', spins: '200' },
      { id: 12, externalId: '502', rank: '7', spins: '90' },
    ]);
    const metrics = { recordJob: jest.fn(), recordDependency: jest.fn() };
    const service = new ChartsService(prisma as never, metrics as never);

    await service.getSanremoRealtime();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.filter(([url]) => url.includes(EARONE)),
    ).toHaveLength(1);
    expect(prisma.songChartIdentity.findMany).toHaveBeenCalledWith({
      where: { provider: 'earone', externalId: { in: ['501', '502'] } },
      select: { id: true, externalId: true, rank: true, spins: true },
    });
    expect(prisma.songChartIdentity.update.mock.calls).toEqual([
      [{ where: { id: 11 }, data: { rank: '1', spins: '310' } }],
      [{ where: { id: 12 }, data: { spins: '120' } }],
    ]);
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'postgres',
      'write',
      'success',
      expect.any(Number),
    );
  });

  it('leaves a row alone when it already holds the upstream values', async () => {
    upstream();
    const prisma = prismaWith([
      { id: 11, externalId: '501', rank: '1', spins: '310' },
    ]);
    await new ChartsService(prisma as never).getSanremoRealtime();
    expect(prisma.songChartIdentity.update).not.toHaveBeenCalled();
  });

  it('skips the database when no upstream entry has an id and a value', async () => {
    upstream({ result: { postTypeData: { songs: [] } } });
    const prisma = prismaWith([]);
    await new ChartsService(prisma as never).getSanremoRealtime();
    expect(prisma.songChartIdentity.findMany).not.toHaveBeenCalled();
  });

  it('keeps the refreshed cache when storing ranks fails, and counts the failure', async () => {
    upstream();
    const prisma = prismaWith([]);
    prisma.songChartIdentity.findMany.mockRejectedValueOnce(
      new Error('db down'),
    );
    const metrics = { recordJob: jest.fn(), recordDependency: jest.fn() };
    const service = new ChartsService(prisma as never, metrics as never);

    const feed = await service.getRealtimeFeed();

    expect(feed).toHaveLength(4);
    expect(metrics.recordJob).toHaveBeenCalledWith('charts-refresh', 'success');
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'postgres',
      'write',
      'failure',
      expect.any(Number),
    );
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to store chart ranks: Error: db down',
    );
  });

  it('never clears ranks or feed values when the upstream fails', async () => {
    jest.useFakeTimers();
    upstream();
    const prisma = prismaWith([
      { id: 11, externalId: '501', rank: '4', spins: '200' },
    ]);
    const service = new ChartsService(prisma as never);
    const first = await service.getRealtimeFeed();
    expect(prisma.songChartIdentity.update).toHaveBeenCalledTimes(1);

    global.fetch = jest.fn(async () => {
      throw new Error('upstream down');
    }) as never;
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    service.onModuleDestroy();

    expect(await service.getRealtimeFeed()).toEqual(first);
    expect(first[0].updatedAt).toEqual(expect.any(String));
    expect(prisma.songChartIdentity.update).toHaveBeenCalledTimes(1);
  });
});

describe('ChartsService provider-neutral feed', () => {
  it('returns the same entries as the branded proxy, field for field apart from naming', async () => {
    upstream();
    const service = new ChartsService(prismaWith([]) as never);

    const proxy = await service.getSanremoRealtime();
    const feed = await service.getRealtimeFeed();

    expect(feed).toEqual(
      proxy.entries.map((entry) => ({
        provider: entry.sourceKeys.earone ? 'earone' : 'escplus',
        externalId: entry.earoneSongId,
        title: entry.title,
        artist: entry.artist,
        rank: entry.ranking,
        spins: entry.radioSpinsToday,
        updatedAt: proxy.updatedAt,
      })),
    );
    expect(feed).toEqual([
      {
        provider: 'earone',
        externalId: '501',
        title: 'Cuore',
        artist: 'Alba',
        rank: '1',
        spins: '310',
        updatedAt: proxy.updatedAt,
      },
      {
        provider: 'earone',
        externalId: '502',
        title: 'Notte',
        artist: 'Bruno',
        rank: '7',
        spins: '120',
        updatedAt: proxy.updatedAt,
      },
      {
        provider: 'earone',
        externalId: '503',
        title: 'Senza',
        artist: 'Carla',
        rank: null,
        spins: null,
        updatedAt: proxy.updatedAt,
      },
      {
        provider: 'escplus',
        externalId: null,
        title: 'Solo',
        artist: 'Dario',
        rank: null,
        spins: null,
        updatedAt: proxy.updatedAt,
      },
    ]);
    expect(JSON.stringify(feed)).not.toMatch(
      /spotify|youtube|ranking|radioSpins/i,
    );
  });
});
