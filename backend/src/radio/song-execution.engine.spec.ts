import { SongExecutionEngine } from './song-execution.engine';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';

describe('SongExecutionEngine now-playing transitions', () => {
  let engine: SongExecutionEngine;
  let nowPlayingPublisher: {
    publishPlayback: jest.Mock;
    publishStopped: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    nowPlayingPublisher = {
      publishPlayback: jest.fn().mockResolvedValue(undefined),
      publishStopped: jest.fn().mockResolvedValue(undefined),
    };
    const radioService = {
      playSong: jest.fn().mockResolvedValue(undefined),
      getRadioSettings: jest.fn().mockResolvedValue(null),
    };
    const flightService = {
      handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
    };

    engine = new SongExecutionEngine(
      radioService as unknown as RadioService,
      flightService as unknown as FlightService,
      {} as PrismaService,
      nowPlayingPublisher as unknown as NowPlayingPublisherService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not publish stopped between autoplay songs', async () => {
    engine.handleSequenceUpdated('palazzo', {
      mode: 'autoplay',
      loop: true,
      intervalMs: 500,
      items: [
        {
          id: 'song-1',
          kind: 'preset',
          title: 'Song one',
          artist: 'Artist one',
          audioUrl: 'https://example.test/song-1.mp3',
          durationMs: 1000,
        },
      ],
    });

    expect(nowPlayingPublisher.publishPlayback).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);

    expect(nowPlayingPublisher.publishPlayback).toHaveBeenCalledTimes(2);
    expect(nowPlayingPublisher.publishStopped).not.toHaveBeenCalled();
  });

  it('publishes stopped when a manual song ends without a successor', async () => {
    engine.handleManualSong(
      'palazzo',
      'https://example.test/manual.mp3',
      'Manual song',
      'Manual artist',
      1000,
    );

    await jest.advanceTimersByTimeAsync(1000);

    expect(nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(1);
  });
});
