import { Logger } from '@nestjs/common';
import { ChartsService } from './charts.service';

const earone = (
  songs: unknown[],
  modifiedOn: unknown = '2026-01-01T12:00:00Z',
) => ({
  result: { modifiedOn, postTypeData: { songs } },
});
const radioSong = (artist = 'Måneskin', title = 'Zitti & buoni') => ({
  curPos: 2,
  spins: 42,
  song: { earoneSongId: 123, title, tracks: [{ artists: [{ name: artist }] }] },
});

describe('ChartsService upstream/cache boundary', () => {
  let fetchMock: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function fixture(
    radio: unknown,
    streaming: unknown,
    metrics: boolean = true,
  ) {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => radio } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => streaming,
      } as Response);
    const counters = { recordDependency: jest.fn(), recordJob: jest.fn() };
    const service = new ChartsService(metrics ? (counters as any) : undefined);
    return { service, counters };
  }

  it('merges normalized song identities, keeps station values and orders artists', async () => {
    const f = fixture(earone([radioSong(), radioSong(' Alpha ', ' First ')]), [
      {
        artist: 'Maneskin',
        song: 'Zitti and buoni',
        spotifyplays: 12,
        youtube: { views: 20, likes: 3 },
      },
      { artist: 'Zeta', song: 'New song', spotifyplays: 2 },
    ]);
    const result = await f.service.getSanremoRealtime();
    expect(result.entries.map((entry) => entry.artist)).toEqual([
      'Alpha',
      'Måneskin',
      'Zeta',
    ]);
    expect(result.entries[1]).toEqual({
      normalizedKey: 'maneskin zitti and buoni',
      earoneSongId: '123',
      artist: 'Måneskin',
      title: 'Zitti & buoni',
      ranking: '2',
      radioSpinsToday: '42',
      spotifyPlays: '12',
      youtubeViews: '20',
      youtubeLikes: '3',
      sourceKeys: {
        earone: 'maneskin zitti and buoni',
        escplus: 'maneskin zitti and buoni',
      },
    });
    expect(result.entries[2]).toEqual(
      expect.objectContaining({
        earoneSongId: null,
        ranking: null,
        radioSpinsToday: null,
        youtubeViews: null,
        youtubeLikes: null,
        sourceKeys: { earone: null, escplus: 'zeta new song' },
      }),
    );
    expect(result.sources.earoneUpdatedAt).toBe('2026-01-01T12:00:00Z');
    expect(f.counters.recordDependency).toHaveBeenCalledWith(
      'earone',
      'fetch',
      'success',
      expect.any(Number),
    );
    expect(f.counters.recordDependency).toHaveBeenCalledWith(
      'escplus',
      'fetch',
      'success',
      expect.any(Number),
    );
    expect(f.counters.recordJob).toHaveBeenCalledWith(
      'charts-refresh',
      'success',
    );
    expect(await f.service.getSanremoRealtime()).toBe(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips incomplete songs and nonfinite counters without fabricating chart values', async () => {
    const song = radioSong();
    const f = fixture(
      earone(
        [
          {},
          { song: {} },
          { song: { title: 'Missing artist' } },
          radioSong('', 'Empty artist'),
          radioSong('A', ''),
          {
            song: {
              title: 'Duet',
              tracks: [{ artists: [{ name: ' A ' }, {}, { name: 'B' }] }],
            },
            curPos: Infinity,
            spins: '4',
          },
          { ...song, song: { ...song.song, earoneSongId: 'external-id' } },
        ],
        100,
      ),
      [
        {},
        { artist: '', song: 'Empty artist' },
        { artist: 'A', song: '' },
        {
          artist: 'Z',
          song: 'Only streaming',
          spotifyplays: NaN,
          youtube: { views: '12', likes: Infinity },
        },
      ],
    );
    const result = await f.service.getSanremoRealtime();
    expect(result.entries).toHaveLength(3);
    expect(result.entries.find((entry) => entry.title === 'Duet')).toEqual(
      expect.objectContaining({
        artist: 'A & B',
        earoneSongId: null,
        ranking: null,
        radioSpinsToday: null,
      }),
    );
    expect(
      result.entries.find((entry) => entry.title === 'Zitti & buoni')
        ?.earoneSongId,
    ).toBe('external-id');
    expect(result.entries.find((entry) => entry.artist === 'Z')).toEqual(
      expect.objectContaining({
        spotifyPlays: null,
        youtubeViews: null,
        youtubeLikes: null,
      }),
    );
    expect(result.sources.earoneUpdatedAt).toBeNull();
  });

  it.each([
    [{}, {}],
    [null, null],
    [earone([]), []],
  ])(
    'accepts an empty or malformed upstream shape as an empty chart',
    async (radio, streaming) => {
      const f = fixture(radio, streaming, false);
      expect((await f.service.getSanremoRealtime()).entries).toEqual([]);
      expect(f.counters.recordDependency).not.toHaveBeenCalled();
    },
  );

  it('coalesces concurrent initial requests instead of issuing duplicate upstream fetches', async () => {
    let release!: (payload: unknown) => void;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any);
    const service = new ChartsService();
    const first = service.getSanremoRealtime();
    const second = service.getSanremoRealtime();
    await Promise.resolve();
    release(earone([radioSong()]));
    const results = await Promise.all([first, second]);
    expect(results[0]).toBe(results[1]);
    expect(results[0].entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records an HTTP failure once and leaves the previous successful cache available', async () => {
    jest.useFakeTimers();
    const f = fixture(earone([radioSong()]), []);
    f.service.onModuleInit();
    await f.service.getSanremoRealtime();
    const original = await f.service.getSanremoRealtime();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any);
    await jest.advanceTimersByTimeAsync(15000);
    expect(await f.service.getSanremoRealtime()).toBe(original);
    expect(
      f.counters.recordDependency.mock.calls.filter(
        (entry) => entry[2] === 'http-error',
      ),
    ).toHaveLength(1);
    expect(
      f.counters.recordDependency.mock.calls.filter(
        (entry) => entry[2] === 'unavailable',
      ),
    ).toHaveLength(0);
    expect(f.counters.recordJob).toHaveBeenLastCalledWith(
      'charts-refresh',
      'failure',
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('responded with 503'),
    );
    f.service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([new Error('network unavailable'), 'transport rejected'])(
    'records transport failures and retries a later empty-cache request: %p',
    async (failure) => {
      fetchMock
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ ok: true, json: async () => [] } as any);
      const counters = { recordDependency: jest.fn(), recordJob: jest.fn() };
      const service = new ChartsService(counters as any);
      expect((await service.getSanremoRealtime()).entries).toEqual([]);
      expect(counters.recordDependency).toHaveBeenCalledWith(
        'earone',
        'fetch',
        'unavailable',
        expect.any(Number),
      );
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => earone([radioSong()]),
        } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => [] } as any);
      expect((await service.getSanremoRealtime()).entries).toHaveLength(1);
      service.onModuleDestroy();
    },
  );

  it('handles invalid JSON as unavailable upstream data and optional telemetry safely', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('bad JSON');
        },
      } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as any);
    expect((await new ChartsService().getSanremoRealtime()).entries).toEqual(
      [],
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad JSON'));
  });
});
