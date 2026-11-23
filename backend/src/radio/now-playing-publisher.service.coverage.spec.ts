import { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { PrismaService } from '../prisma.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { SongPlaybackData } from './song-execution.engine';
import {
  scriptedTransport,
  type ScriptedResponse,
} from '../outbound/safe-fetch.testing';

const PUBLIC = ['93.184.216.34'];
const names = {
  'c1.example.test': PUBLIC,
  'a.test': PUBLIC,
  'b.test': PUBLIC,
};

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
  const answer = (script: Record<string, ScriptedResponse>) => {
    const transport = scriptedTransport(names, script);
    service.outboundDeps = transport;
    return transport;
  };
  // Every consumer in these tests answers 200 unless a test scripts it.
  const transport = answer({
    'c1.example.test/np': { status: 200 },
    'a.test/': { status: 200 },
    'b.test/': { status: 200 },
  });
  return { service, prisma, transport, answer };
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
    const save = async (
      consumers: Array<{ url: string }>,
      stored: string[] = [],
    ) => {
      const { service, prisma } = build();
      prisma.programState.findUnique.mockResolvedValue({ id: 7 });
      prisma.nowPlayingConsumer.findMany.mockResolvedValue(
        stored.map((url) => ({ url })),
      );
      const outcome = await service.replaceConsumers('main', consumers).then(
        () => 'saved',
        (error: Error) => error.message,
      );
      return { outcome, prisma };
    };

    it('refuses a new consumer whose URL is plain http', async () => {
      const { outcome, prisma } = await save([
        { url: 'https://ok.example.test/np' },
        { url: 'http://new.example.test/np' },
      ]);
      expect(outcome).toBe('Consumer 2: the URL must use https.');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses an update that changes a stored http URL to another http URL', async () => {
      const { outcome } = await save(
        [{ url: 'http://legacy.example.test/other' }],
        ['http://legacy.example.test/np'],
      );
      expect(outcome).toBe('Consumer 1: the URL must use https.');
    });

    it('refuses any other scheme', async () => {
      const { outcome } = await save([{ url: 'ftp://files.example.test/np' }]);
      expect(outcome).toBe('Consumer 1: the URL must use https.');
    });

    it('refuses a URL that is not absolute', async () => {
      const { outcome } = await save([{ url: 'now-playing/update' }]);
      expect(outcome).toBe('Consumer 1: the URL is not a valid absolute URL.');
    });

    it('refuses a URL that carries a user name or password', async () => {
      const { outcome } = await save([
        { url: 'https://user:pass@hook.example.test/np' },
      ]);
      expect(outcome).toBe(
        'Consumer 1: the URL must not include a user name or password.',
      );
      expect(
        (await save([{ url: 'https://:pass@hook.example.test/np' }])).outcome,
      ).toBe('Consumer 1: the URL must not include a user name or password.');
    });

    it('keeps a stored http consumer that is submitted again unchanged', async () => {
      const { outcome, prisma } = await save(
        [{ url: 'http://legacy.example.test/np' }],
        ['http://legacy.example.test/np'],
      );
      expect(outcome).toBe('saved');
      expect(prisma.nowPlayingConsumer.findMany).toHaveBeenCalledWith({
        where: { programStateId: 7 },
        select: { url: true },
      });
      expect(prisma.$transaction.mock.calls[0][0][1].arg.data.url).toBe(
        'http://legacy.example.test/np',
      );
    });

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
      const { service, prisma, transport } = build();
      await service.publishPlayback('main', basePlayback());
      expect(transport.sent).toEqual([]);
      expect(service['logger'].warn).toHaveBeenCalledWith(
        'Now-playing publish skipped for main: no enabled consumers',
      );
      expect(prisma.nowPlayingConsumer.findMany).toHaveBeenCalledWith({
        where: { enabled: true, programState: { programId: 'main' } },
        orderBy: { position: 'asc' },
      });
    });

    it('sends only the populated fields when playback is empty', async () => {
      const { service, prisma, transport } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([
        consumerRow({ method: 'PATCH', headers: { Authorization: 'tok' } }),
      ]);
      await service.publishPlayback('main', basePlayback());
      const [sent] = transport.sent;
      expect(sent).toMatchObject({
        scheme: 'https:',
        hostname: 'c1.example.test',
        path: '/np',
        method: 'PATCH',
        connectedTo: '93.184.216.34',
      });
      expect(sent.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'tok',
        host: 'c1.example.test',
        'content-length': 2,
      });
      expect(JSON.parse(sent.body)).toEqual({});
      expect(prisma.song.findFirst).not.toHaveBeenCalled();
    });

    it('sends all fields and rounds the duration to seconds', async () => {
      const { service, prisma, transport } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
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
      expect(JSON.parse(transport.sent[0].body)).toEqual({
        title: 'T',
        artist: 'A',
        artworkUrl: 'https://cover.test/c.jpg',
        startedAt: '2026-01-01T00:00:00.000Z',
        durationSeconds: 2,
      });
    });

    it('omits artwork when the catalog song has no cover', async () => {
      const { service, prisma, transport } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      prisma.song.findFirst.mockResolvedValue({ coverUrl: '  ' });
      await service.publishPlayback(
        'main',
        basePlayback({ audioUrl: ' https://a.test/s.mp3 ' }),
      );
      expect(prisma.song.findFirst).toHaveBeenCalledWith({
        where: { audioUrl: 'https://a.test/s.mp3' },
        select: { coverUrl: true },
      });
      expect(JSON.parse(transport.sent[0].body)).not.toHaveProperty(
        'artworkUrl',
      );
    });

    it('omits artwork when the catalog has no matching song', async () => {
      const { service, prisma, transport } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      prisma.song.findFirst.mockResolvedValue(null);
      await service.publishPlayback(
        'main',
        basePlayback({ audioUrl: 'https://a.test/s.mp3' }),
      );
      expect(JSON.parse(transport.sent[0].body)).not.toHaveProperty(
        'artworkUrl',
      );
    });

    it('warns and continues when the artwork lookup fails (with title)', async () => {
      const { service, prisma } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      prisma.song.findFirst.mockRejectedValue(new Error('db down'));
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
      const { service, transport } = build();
      await service.publishStopped('main');
      expect(transport.sent).toEqual([]);
      expect(service['logger'].warn).toHaveBeenCalledWith(
        'Now-playing publish skipped for main: no enabled consumers',
      );
    });

    it('posts the stopped payload to every consumer', async () => {
      const { service, prisma, transport } = build();
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([
        consumerRow({ name: 'a', url: 'https://a.test', headers: [] }),
        consumerRow({ name: 'b', url: 'https://b.test', headers: null }),
      ]);
      await service.publishStopped('main');
      expect(transport.sent.map((sent) => sent.hostname).sort()).toEqual([
        'a.test',
        'b.test',
      ]);
      for (const sent of transport.sent) {
        expect(sent.method).toBe('POST');
        expect(JSON.parse(sent.body)).toEqual({ status: 'stopped' });
        expect(sent.headers['Content-Type']).toBe('application/json');
      }
    });
  });

  describe('delivery results and metrics', () => {
    const run = async (
      response: ScriptedResponse | undefined,
      metrics?: { recordDependency: jest.Mock; recordOutboundFetch: jest.Mock },
    ) => {
      const { service, prisma, answer } = build({}, metrics);
      prisma.nowPlayingConsumer.findMany.mockResolvedValue([consumerRow()]);
      answer(response ? { 'c1.example.test/np': response } : {});
      await service.publishStopped('main');
      return service;
    };
    const metricsMock = () => ({
      recordDependency: jest.fn(),
      recordOutboundFetch: jest.fn(),
    });

    it('records success metrics when metrics are provided', async () => {
      const metrics = metricsMock();
      const service = await run({ status: 200 }, metrics);
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'now-playing',
        'publish',
        'success',
        expect.any(Number),
      );
      expect(metrics.recordOutboundFetch).toHaveBeenCalledWith(
        'now_playing',
        'ok',
      );
      expect(service['logger'].log).toHaveBeenCalledWith(
        'Now-playing publish succeeded for main/c1: 200',
      );
    });

    it('records unavailable and logs the reason when the consumer cannot be reached', async () => {
      const metrics = metricsMock();
      const service = await run(undefined, metrics);
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'now-playing',
        'publish',
        'unavailable',
        expect.any(Number),
      );
      expect(metrics.recordOutboundFetch).toHaveBeenCalledWith(
        'now_playing',
        'network',
      );
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Now-playing publish failed for main/c1: network',
      );
    });

    it('records http-error and logs only the status on a non-2xx answer', async () => {
      const metrics = metricsMock();
      const service = await run(
        { status: 500, body: Buffer.from('upstream detail') },
        metrics,
      );
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'now-playing',
        'publish',
        'http-error',
        expect.any(Number),
      );
      expect(metrics.recordOutboundFetch).toHaveBeenCalledWith(
        'now_playing',
        'http_status',
      );
      expect(service['logger'].error).toHaveBeenCalledWith(
        'Now-playing publish failed for main/c1: http_status 500',
      );
    });

    it('delivers without metrics configured', async () => {
      const service = await run({ status: 204 });
      expect(service['logger'].log).toHaveBeenCalledWith(
        'Now-playing publish succeeded for main/c1: 204',
      );
    });
  });
});
