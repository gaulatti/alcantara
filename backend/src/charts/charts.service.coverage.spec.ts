/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/no-redundant-type-constituents -- Jest mocks are intentionally loosely typed. */
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
    const service = new ChartsService(metrics as never);

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
    const service = new ChartsService();
    // entries stay empty, so each call retries the refresh
    const result = await service.getSanremoRealtime();
    expect(result.entries).toEqual([]);
    expect(result.sources.earoneUpdatedAt).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('handles an empty earone payload object', async () => {
    mockFetch((url) => (url.includes(EARONE) ? ok(null) : ok([])));
    const service = new ChartsService();
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
    const service = new ChartsService();
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
    const service = new ChartsService(metrics as never);
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
    const service = new ChartsService(metrics as never);
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
    const service = new ChartsService(metrics as never);
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
    const service = new ChartsService();
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
    const service = new ChartsService();
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
    const service = new ChartsService();
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
    expect(() => new ChartsService().onModuleDestroy()).not.toThrow();
  });
});
