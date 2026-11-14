import { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { PrismaService } from '../prisma.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { SongPlaybackData } from './song-execution.engine';

describe('NowPlayingPublisherService logging', () => {
  const playback: SongPlaybackData = {
    token: '1',
    audioUrl: 'https://example.test/song.mp3',
    title: 'Test song',
    artist: 'Test artist',
    coverUrl: 'https://example.test/cover.jpg',
    durationMs: 180_000,
    isPlaying: true,
    positionMs: 0,
    progress: 0,
    startedAt: '2026-08-22T03:00:00.000Z',
    updatedAt: '2026-08-22T03:00:00.000Z',
    telemetryStale: false,
    introStatus: 'none',
    introFailureReason: null,
    queueEntryId: null,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs the event, dispatch attempt, and successful response without headers', async () => {
    const prisma = {
      nowPlayingConsumer: {
        findMany: jest.fn().mockResolvedValue([
          {
            name: 'spritz',
            url: 'https://spritz.example.test/now-playing',
            method: 'POST',
            headers: { 'X-Spritz-Now-Playing-Token': 'secret-token' },
          },
        ]),
      },
    };
    const service = new NowPlayingPublisherService(
      prisma as unknown as PrismaService,
    );
    const log = jest.spyOn(service['logger'], 'log').mockImplementation();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 204, statusText: 'No Content' }),
      );

    await service.publishPlayback('main', playback);

    const messages = log.mock.calls.flat().join('\n');
    expect(messages).toContain('Now-playing playback event for main');
    expect(messages).toContain('Now-playing publish attempt for main/spritz');
    expect(messages).toContain('Now-playing publish succeeded for main/spritz');
    expect(messages).toContain('Test song');
    expect(messages).not.toContain('secret-token');
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      artworkUrl: 'https://example.test/cover.jpg',
    });
  });

  it('restores missing artwork from the song catalog by audio URL', async () => {
    const prisma = {
      nowPlayingConsumer: {
        findMany: jest.fn().mockResolvedValue([
          {
            name: 'spritz',
            url: 'https://spritz.example.test/now-playing',
            method: 'POST',
            headers: {},
          },
        ]),
      },
      song: {
        findFirst: jest.fn().mockResolvedValue({
          coverUrl: 'https://example.test/catalog-cover.jpg',
        }),
      },
    };
    const service = new NowPlayingPublisherService(
      prisma as unknown as PrismaService,
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await service.publishPlayback('main', { ...playback, coverUrl: '' });

    expect(prisma.song.findFirst).toHaveBeenCalledWith({
      where: { audioUrl: playback.audioUrl },
      select: { coverUrl: true },
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      artworkUrl: 'https://example.test/catalog-cover.jpg',
    });
  });

  it('logs when an event has no enabled consumers', async () => {
    const prisma = {
      nowPlayingConsumer: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new NowPlayingPublisherService(
      prisma as unknown as PrismaService,
    );
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();

    await service.publishPlayback('main', playback);

    expect(warn).toHaveBeenCalledWith(
      'Now-playing publish skipped for main: no enabled consumers',
    );
  });

  function publisher(consumers: unknown[] = []) {
    const prisma = {
      programState: {
        findUnique: jest.fn().mockResolvedValue({ id: 'state-1' }),
      },
      nowPlayingConsumer: {
        findMany: jest.fn().mockResolvedValue(consumers),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      song: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const metrics = { recordDependency: jest.fn() };
    const service = new NowPlayingPublisherService(
      prisma as unknown as PrismaService,
      metrics as unknown as ManagedMetricsService,
    );
    return { service, prisma, metrics };
  }

  it('replaces consumers in order using normalized configuration and program identity', async () => {
    const { service, prisma } = publisher();
    await service.replaceConsumers('  ', [
      { url: ' https://example.test/first ', headers: ['invalid'] },
      {
        name: ' second ',
        url: 'https://example.test/second',
        method: 'PUT',
        headers: {
          ' Authorization ': ' fixture ',
          ' ': 'discard',
          empty: ' ',
          invalid: 2,
        },
        enabled: false,
      },
      {
        name: '',
        url: 'https://example.test/third',
        method: 'PATCH',
        headers: null,
      },
      {
        url: 'https://example.test/fourth',
        method: 'DELETE',
        headers: 'invalid',
      },
    ]);
    expect(prisma.programState.findUnique).toHaveBeenCalledWith({
      where: { programId: 'main' },
      select: { id: true },
    });
    expect(prisma.nowPlayingConsumer.deleteMany).toHaveBeenCalledWith({
      where: { programStateId: 'state-1' },
    });
    expect(
      prisma.nowPlayingConsumer.create.mock.calls.map(([args]) => args.data),
    ).toEqual([
      {
        programStateId: 'state-1',
        name: 'consumer-1',
        url: 'https://example.test/first',
        method: 'POST',
        headers: {},
        enabled: true,
        position: 0,
      },
      {
        programStateId: 'state-1',
        name: 'second',
        url: 'https://example.test/second',
        method: 'PUT',
        headers: { Authorization: 'fixture' },
        enabled: false,
        position: 1,
      },
      {
        programStateId: 'state-1',
        name: 'consumer-3',
        url: 'https://example.test/third',
        method: 'PATCH',
        headers: {},
        enabled: true,
        position: 2,
      },
      {
        programStateId: 'state-1',
        name: 'consumer-4',
        url: 'https://example.test/fourth',
        method: 'POST',
        headers: {},
        enabled: true,
        position: 3,
      },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array));
    expect(prisma.nowPlayingConsumer.findMany).toHaveBeenCalledWith({
      where: { programState: { programId: 'main' } },
      orderBy: { position: 'asc' },
    });
  });

  it('rejects unknown programs and empty destination URLs before replacing consumers', async () => {
    const { service, prisma } = publisher();
    prisma.programState.findUnique.mockResolvedValueOnce(null as any);
    await expect(service.replaceConsumers('missing', [])).rejects.toThrow(
      'Program not found',
    );
    await expect(
      service.replaceConsumers('main', [{ url: ' ' }]),
    ).rejects.toThrow('Consumer 1 requires url');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.nowPlayingConsumer.deleteMany).not.toHaveBeenCalled();
  });

  it('publishes stopped state with each configured method and authentication header', async () => {
    const { service, prisma, metrics } = publisher([
      {
        name: 'first',
        url: 'https://example.test/one',
        method: 'PUT',
        headers: { 'X-Fixture': ' scoped ' },
      },
      {
        name: 'second',
        url: 'https://example.test/two',
        method: 'PATCH',
        headers: undefined,
      },
    ]);
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await service.publishStopped(' radio ');
    expect(prisma.nowPlayingConsumer.findMany).toHaveBeenCalledWith({
      where: { enabled: true, programState: { programId: 'radio' } },
      orderBy: { position: 'asc' },
    });
    expect(request).toHaveBeenNthCalledWith(1, 'https://example.test/one', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Fixture': 'scoped' },
      body: '{"status":"stopped"}',
    });
    expect(request).toHaveBeenNthCalledWith(2, 'https://example.test/two', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"status":"stopped"}',
    });
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'now-playing',
      'publish',
      'success',
      expect.any(Number),
    );
  });

  it('skips a stopped publication without enabled consumers', async () => {
    const { service } = publisher();
    const request = jest.spyOn(global, 'fetch');
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
    await service.publishStopped('main');
    expect(request).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Now-playing publish skipped for main: no enabled consumers',
    );
  });

  it.each([
    {
      audioUrl: '',
      coverUrl: '',
      title: '',
      artist: '',
      startedAt: '',
      durationMs: 0,
    },
    {
      audioUrl: 'https://example.test/unknown.mp3',
      coverUrl: '',
      title: '',
      artist: '',
      startedAt: '',
      durationMs: -1,
    },
  ])('omits absent metadata without inventing artwork: %j', async (empty) => {
    const { service } = publisher([
      { name: 'sink', url: 'https://example.test/sink' },
    ]);
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await service.publishPlayback('main', { ...playback, ...empty });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({});
  });

  it.each(['named', ''])(
    'continues publication after catalog lookup failure for %s track',
    async (title) => {
      const { service, prisma } = publisher([
        { name: 'sink', url: 'https://example.test/sink' },
      ]);
      prisma.song.findFirst.mockRejectedValueOnce(
        new Error('catalog unavailable'),
      );
      const request = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
      await service.publishPlayback('main', {
        ...playback,
        title,
        coverUrl: '',
      });
      expect(
        JSON.parse(String(request.mock.calls[0][1]?.body)),
      ).not.toHaveProperty('artworkUrl');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `artwork lookup failed for ${title || 'unknown track'}`,
        ),
      );
    },
  );

  it.each(['network', 'http', 'unreadable'])(
    'records and contains %s delivery failures',
    async (failure) => {
      const { service, metrics } = publisher([
        { name: 'sink', url: 'https://example.test/sink' },
      ]);
      const request = jest.spyOn(global, 'fetch');
      if (failure === 'network')
        request.mockRejectedValueOnce(new Error('offline'));
      else if (failure === 'http')
        request.mockResolvedValueOnce(
          new Response('rejected fixture', { status: 503 }),
        );
      else
        request.mockResolvedValueOnce({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          text: jest.fn().mockRejectedValue(new Error('read failed')),
        } as unknown as Response);
      const error = jest.spyOn(service['logger'], 'error').mockImplementation();
      await expect(service.publishStopped('main')).resolves.toBeUndefined();
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'now-playing',
        'publish',
        failure === 'network' ? 'unavailable' : 'http-error',
        expect.any(Number),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          failure === 'network'
            ? 'offline'
            : failure === 'http'
              ? 'rejected fixture'
              : '<failed to read response body>',
        ),
      );
    },
  );
});
