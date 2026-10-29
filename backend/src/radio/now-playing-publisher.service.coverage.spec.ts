import { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { PrismaService } from '../prisma.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { SongPlaybackData } from './song-execution.engine';

const basePlayback = (
  overrides: Partial<SongPlaybackData> = {},
): SongPlaybackData => ({
  token: '1',
  audioUrl: '',
  title: '',
  artist: '',
  coverUrl: '',
  introStatus: 'none',
  introFailureReason: null,
  queueEntryId: null,
  durationMs: 0,
  isPlaying: true,
  positionMs: 0,
  progress: 0,
  startedAt: '',
  updatedAt: '',
  telemetryStale: false,
  ...overrides,
});

const consumerRow = (overrides: Record<string, unknown> = {}) => ({
  name: 'c1',
  url: 'https://c1.example.test/np',
  method: 'POST',
  headers: {},
  ...overrides,
});

function build(prismaOverrides: Record<string, unknown> = {}, metrics?: any) {
  const prisma: any = {
    nowPlayingConsumer: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockReturnValue('delete-op'),
      create: jest.fn().mockImplementation((arg) => ({ op: 'create', arg })),
    },
    programState: { findUnique: jest.fn() },
    song: { findFirst: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
    ...prismaOverrides,
  };
  const service = new NowPlayingPublisherService(
    prisma as PrismaService,
    metrics as ManagedMetricsService | undefined,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation();
  jest.spyOn(service['logger'], 'warn').mockImplementation();
  jest.spyOn(service['logger'], 'error').mockImplementation();
  return { service, prisma };
}

describe('NowPlayingPublisherService coverage', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('listConsumers', () => {
    it('queries by trimmed program id ordered by position', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([{ id: 1 }]);
      await expect(service.listConsumers('  prog  ')).resolves.toEqual([
        { id: 1 },
      ]);
      expect(prisma.nowPlayingConsumer.findMany).toHaveBeenCalledWith({
        where: { programState: { programId: 'prog' } },
        orderBy: { position: 'asc' },
      });
    });

    it('falls back to main for a blank program id', async () => {
      const { service, prisma } = build();
      await service.listConsumers('   ');
      expect(prisma.nowPlayingConsumer.findMany).toHaveBeenCalledWith({
        where: { programState: { programId: 'main' } },
        orderBy: { position: 'asc' },
      });
    });
  });

  describe('replaceConsumers', () => {
    it('throws when the program state does not exist', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(service.replaceConsumers('x', [])).rejects.toThrow(
        'Program not found',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws when a consumer has no usable url', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({ id: 7 });
      await expect(
        service.replaceConsumers('x', [{ url: '   ' }]),
      ).rejects.toThrow('Consumer 1 requires url');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('replaces consumers atomically with normalized records', async () => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({ id: 7 });
      prisma.nowPlayingConsumer.findMany.mockResolvedValue(['listed']);
      const result = await service.replaceConsumers(' main ', [
        {
          name: ' Named ',
          url: ' https://a.test/np ',
          method: 'PUT',
          headers: { ' X-A ': ' v ', Empty: '  ', '': 'z', Num: 4 },
          enabled: false,
        },
        { url: 'https://b.test/np' },
      ]);
      expect(prisma.programState.findUnique).toHaveBeenCalledWith({
        where: { programId: 'main' },
        select: { id: true },
      });
      expect(prisma.nowPlayingConsumer.deleteMany).toHaveBeenCalledWith({
        where: { programStateId: 7 },
      });
      const ops = prisma.$transaction.mock.calls[0][0];
      expect(ops[0]).toBe('delete-op');
      expect(ops[1].arg.data).toEqual({
        programStateId: 7,
        name: 'Named',
        url: 'https://a.test/np',
        method: 'PUT',
        headers: { 'X-A': 'v' },
        enabled: false,
        position: 0,
      });
      expect(ops[2].arg.data).toEqual({
        programStateId: 7,
        name: 'consumer-2',
        url: 'https://b.test/np',
        method: 'POST',
        headers: {},
        enabled: true,
        position: 1,
      });
      expect(result).toEqual(['listed']);
    });
  });

  describe('publishPlayback', () => {
    it('skips publishing and warns when there are no enabled consumers', async () => {
      const { service, prisma } = build();
      const fetchSpy = jest.spyOn(global, 'fetch');
      await service.publishPlayback('main', basePlayback());
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service['logger'].warn).toHaveBeenCalledWith(
        'Now-playing publish skipped for main: no enabled consumers',
      );
      expect(prisma.nowPlayingConsumer.findMany).toHaveBeenCalledWith({
        where: { enabled: true, programState: { programId: 'main' } },
        orderBy: { position: 'asc' },
      });
    });

    it('sends only the populated fields when playback is empty', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([
        consumerRow({ method: 'PATCH', headers: { Authorization: 'tok' } }),
      ]);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await service.publishPlayback('main', basePlayback());
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://c1.example.test/np');
      expect(init?.method).toBe('PATCH');
      expect(init?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'tok',
      });
      expect(JSON.parse(String(init?.body))).toEqual({});
      expect(prisma.song.findFirst).not.toHaveBeenCalled();
    });

    it('sends all fields and rounds the duration to seconds', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await service.publishPlayback(
        'main',
        basePlayback({
          title: 'T',
          artist: 'A',
          coverUrl: ' https://cover.test/c.jpg ',
          startedAt: '2026-01-01T00:00:00.000Z',
          durationMs: 1500,
        }),
      );
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
        title: 'T',
        artist: 'A',
        artworkUrl: 'https://cover.test/c.jpg',
        startedAt: '2026-01-01T00:00:00.000Z',
        durationSeconds: 2,
      });
    });

    it('omits artwork when the catalog song has no cover', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      prisma.song.findFirst.mockResolvedValue({ coverUrl: '  ' });
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await service.publishPlayback(
        'main',
        basePlayback({ audioUrl: ' https://a.test/s.mp3 ' }),
      );
      expect(prisma.song.findFirst).toHaveBeenCalledWith({
        where: { audioUrl: 'https://a.test/s.mp3' },
        select: { coverUrl: true },
      });
      expect(
        JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)),
      ).not.toHaveProperty('artworkUrl');
    });

    it('omits artwork when the catalog has no matching song', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      prisma.song.findFirst.mockResolvedValue(null);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await service.publishPlayback(
        'main',
        basePlayback({ audioUrl: 'https://a.test/s.mp3' }),
      );
      expect(
        JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)),
      ).not.toHaveProperty('artworkUrl');
    });

    it('warns and continues when the artwork lookup fails (with title)', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      prisma.song.findFirst.mockRejectedValue(new Error('db down'));
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await service.publishPlayback(
        'main',
        basePlayback({ audioUrl: 'https://a.test/s.mp3', title: 'Named' }),
      );
      expect(service['logger'].warn).toHaveBeenCalledWith(
        'Now-playing artwork lookup failed for Named: Error: db down',
      );
    });

    it('warns with an unknown track label when the title is empty', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      prisma.song.findFirst.mockRejectedValue(new Error('db down'));
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await service.publishPlayback(
        'main',
        basePlayback({ audioUrl: 'https://a.test/s.mp3' }),
      );
      expect(service['logger'].warn).toHaveBeenCalledWith(
        'Now-playing artwork lookup failed for unknown track: Error: db down',
      );
    });
  });

  describe('publishStopped', () => {
    it('skips when there are no enabled consumers', async () => {
      const { service } = build();
      const fetchSpy = jest.spyOn(global, 'fetch');
      await service.publishStopped('main');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service['logger'].warn).toHaveBeenCalledWith(
        'Now-playing publish skipped for main: no enabled consumers',
      );
    });

    it('posts the stopped payload to every consumer', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([
        consumerRow({ name: 'a', url: 'https://a.test', headers: [] }),
        consumerRow({ name: 'b', url: 'https://b.test', headers: null }),
      ]);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
      await service.publishStopped('main');
      expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
        'https://a.test',
        'https://b.test',
      ]);
      for (const call of fetchSpy.mock.calls) {
        expect(JSON.parse(String(call[1]?.body))).toEqual({
          status: 'stopped',
        });
        expect(call[1]?.headers).toEqual({
          'Content-Type': 'application/json',
        });
      }
    });
  });

  describe('delivery results and metrics', () => {
    const run = async (
      fetchImpl: () => Promise<Response>,
      metrics?: { recordDependency: jest.Mock },
    ) => {
      const { service, prisma } = build({}, metrics);
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      jest.spyOn(global, 'fetch').mockImplementation(fetchImpl);
      await service.publishStopped('main');
      return service;
    };

    it('records success metrics when metrics are provided', async () => {
      const metrics = { recordDependency: jest.fn() };
      await run(async () => new Response(null, { status: 200 }), metrics);
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'now-playing',
        'publish',
        'success',
        expect.any(Number),
      );
    });

    it('records unavailable and logs when fetch throws', async () => {
      const metrics = { recordDependency: jest.fn() };
      const service = await run(async () => {
        throw new Error('ECONNRESET');
      }, metrics);
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'now-playing',
        'publish',
        'unavailable',
        expect.any(Number),
      );
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Now-playing publish failed for main/c1: Error: ECONNRESET',
      );
    });

    it('records http-error and logs the response body on non-ok status', async () => {
      const metrics = { recordDependency: jest.fn() };
      const service = await run(
        async () =>
          new Response('nope', { status: 500, statusText: 'Server Error' }),
        metrics,
      );
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'now-playing',
        'publish',
        'http-error',
        expect.any(Number),
      );
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Now-playing publish failed for main/c1: 500 Server Error nope',
      );
    });

    it('logs a placeholder when the error body cannot be read', async () => {
      const response = {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: jest.fn().mockRejectedValue(new Error('boom')),
      } as unknown as Response;
      const service = await run(async () => response);
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Now-playing publish failed for main/c1: 502 Bad Gateway <failed to read response body>',
      );
    });
  });
});
