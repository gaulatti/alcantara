import { ConfigService } from '@nestjs/config';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import { RadioController } from './radio.controller';
import type { PrismaService } from '../prisma.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { SongPlaybackData } from './song-execution.engine';

// gaulatti/alcantara#206: outside production a now-playing update never
// leaves the machine, visibly; production keeps publishing.

const playback = {
  token: '1',
  audioUrl: 'https://example.test/song.mp3',
  title: 'Fictional song',
  artist: 'Fictional artist',
  coverUrl: 'https://example.test/cover.jpg',
  durationMs: 180_000,
  isPlaying: true,
  positionMs: 0,
  progress: 0,
  startedAt: '2026-11-17T20:00:00.000Z',
  updatedAt: '2026-11-17T20:00:00.000Z',
  telemetryStale: false,
} as unknown as SongPlaybackData;

function build(nodeEnv: string | undefined) {
  const prisma = {
    nowPlayingConsumer: {
      findMany: jest.fn().mockResolvedValue([
        {
          name: 'fictional-consumer',
          url: 'https://now-playing.example.test/update',
          method: 'POST',
          headers: {},
        },
      ]),
    },
  };
  const metrics = { recordDependency: jest.fn() };
  const service = new NowPlayingPublisherService(
    prisma as unknown as PrismaService,
    metrics as unknown as ManagedMetricsService,
    new ConfigService(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
  );
  return { service, metrics };
}

describe('NowPlayingPublisherService outside production', () => {
  afterEach(() => jest.restoreAllMocks());

  it('contacts no consumer, records a skipped publish and says why', async () => {
    const { service, metrics } = build('development');
    const fetchSpy = jest.spyOn(global, 'fetch');
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
    jest.spyOn(service['logger'], 'log').mockImplementation();

    await service.publishPlayback('main', playback);
    await service.publishStopped('main');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.outboundPublishing()).toBe('blocked-local');
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'now-playing',
      'publish',
      'skipped',
      expect.any(Number),
    );
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Now-playing publish blocked for main: outbound publishing is off outside production (1 consumer(s) not contacted)',
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain(
      'now-playing.example.test',
    );
  });

  it('treats a missing NODE_ENV as outside production', () => {
    expect(build(undefined).service.outboundPublishing()).toBe('blocked-local');
  });

  it('publishes unchanged in production', async () => {
    const { service, metrics } = build('production');
    jest.spyOn(service['logger'], 'log').mockImplementation();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await service.publishPlayback('main', playback);

    expect(service.outboundPublishing()).toBe('enabled');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://now-playing.example.test/update',
    );
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'now-playing',
      'publish',
      'success',
      expect.any(Number),
    );
  });

  it('reports the publishing state to the settings page', () => {
    const controller = new RadioController(
      ...([
        undefined,
        undefined,
        build('development').service,
      ] as unknown as ConstructorParameters<typeof RadioController>),
    );
    expect(controller.nowPlayingPublishing()).toEqual({
      publishing: 'blocked-local',
    });
  });
});
