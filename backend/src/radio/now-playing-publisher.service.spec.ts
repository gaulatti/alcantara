import { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { PrismaService } from '../prisma.service';
import type { SongPlaybackData } from './song-execution.engine';

describe('NowPlayingPublisherService logging', () => {
  const playback: SongPlaybackData = {
    token: 1,
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
    jest
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
});
