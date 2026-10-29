import { SongExecutionEngine } from './song-execution.engine';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { RadioMetricsService } from './radio-metrics.service';
import { Logger } from '@nestjs/common';
import type { PalazzoPlaybackState } from './palazzo-contract';

const playlist = {
  mode: 'autoplay',
  loop: true,
  intervalMs: 500,
  items: [1, 2].map((id) => ({
    id: `song-${id}`,
    kind: 'preset',
    title: `Song ${id}`,
    artist: 'Artist',
    audioUrl: `https://media.example/song-${id}.mp3`,
    durationMs: 1000,
  })),
};
function snapshot(
  request?: string,
  url = playlist.items[0].audioUrl,
): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: 'instance',
    bootId: 'boot',
    sequence: 1,
    availability: 'available',
    status: request ? 'playing' : 'idle',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: null,
    },
    icecast: { connected: true },
    track: request
      ? {
          playbackRequestId: request,
          title: null,
          artist: null,
          coverUrl: null,
          url,
          startedAt: new Date().toISOString(),
        }
      : null,
    intro: null,
    positionSeconds: 0,
    remainingSeconds: null,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
  };
}
async function flush() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('SongExecutionEngine remaining public boundary coverage', () => {
  const engines: SongExecutionEngine[] = [];
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')),
  );
  afterEach(() => {
    engines.splice(0).forEach((engine) => engine.onModuleDestroy());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  function fixture(radio = true) {
    let persisted = {
      programId: radio ? 'radio' : 'tv',
      type: radio ? 'radio' : 'tv',
      songSequence: playlist as unknown,
      songQueue: [] as unknown[],
      songRotation: null as unknown,
    };
    const prisma = {
      radioSettings: { findMany: jest.fn().mockResolvedValue([]) },
      songIntro: { findUnique: jest.fn().mockResolvedValue(null) },
      instant: { findUnique: jest.fn().mockResolvedValue(null) },
      programState: {
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(persisted)),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Partial<typeof persisted> }) =>
            Promise.resolve((persisted = { ...persisted, ...data })),
          ),
      },
    };
    const radioService = {
      playSong: jest
        .fn<
          Promise<Record<string, unknown>>,
          [string, string, string?, string?, string?, string?, unknown?]
        >()
        .mockResolvedValue({ ok: true }),
      playInstant: jest.fn().mockResolvedValue(undefined),
      getRadioSettings: jest.fn().mockResolvedValue(null),
    };
    const flight = {
      isClockedLogRunning: jest.fn().mockReturnValue(false),
      handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
    };
    const publisher = {
      publishPlayback: jest.fn().mockResolvedValue(undefined),
      publishStopped: jest.fn().mockResolvedValue(undefined),
    };
    const metrics = {
      recordTrackTransition: jest.fn(),
      recordIntroTransition: jest.fn(),
      recordEventIgnored: jest.fn(),
      recordDegradedPrograms: jest.fn(),
      recordStaleTelemetryPrograms: jest.fn(),
      recordSnapshotReconciliation: jest.fn(),
      recordConnectionState: jest.fn(),
      recordReconnectAttempt: jest.fn(),
      recordReconnectFailure: jest.fn(),
      recordSongQueueAction: jest.fn(),
      recordSongQueueDepth: jest.fn(),
      recordHighRotationAction: jest.fn(),
      recordHighRotationFavorites: jest.fn(),
    };
    // Only dependency construction crosses the mocked service boundary; every
    // engine transition below enters through its actual public API.
    const engine = new SongExecutionEngine(
      radioService as unknown as RadioService,
      flight as unknown as FlightService,
      prisma as unknown as PrismaService,
      publisher as unknown as NowPlayingPublisherService,
      metrics as unknown as RadioMetricsService,
    );
    engines.push(engine);
    engine.setPalazzoTelemetry({ isReconciled: () => true });
    if (radio) engine.registerRadioProgram('radio');
    return {
      engine,
      prisma,
      radioService,
      flight,
      publisher,
      metrics,
      persisted: () => persisted,
      store: (data: Partial<typeof persisted>) => {
        persisted = { ...persisted, ...data };
      },
    };
  }
  async function started() {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio', playlist);
    f.engine.handlePalazzoSnapshot('radio', snapshot());
    await flush();
    return f;
  }
  function end(f: ReturnType<typeof fixture>) {
    f.engine.handlePalazzoEvent('radio', {
      type: 'track.ended',
      data: {
        playbackRequestId: f.radioService.playSong.mock.calls.at(
          -1,
        )![4] as string,
      },
    });
  }

  function malformed(
    base: PalazzoPlaybackState,
    track: Record<string, unknown>,
  ): PalazzoPlaybackState {
    return {
      ...base,
      track: { ...base.track!, ...track },
    } as unknown as PalazzoPlaybackState;
  }

  it('persists an unresolved cursor unchanged when rotation resume has no playable leaf', async () => {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio', { ...playlist, items: [] });
    await f.engine.prepareContinuousRotationResume('radio');
    expect(f.prisma.programState.update).toHaveBeenCalledWith({
      where: { programId: 'radio' },
      data: {
        songSequence: expect.objectContaining({ items: [] }) as unknown,
      },
    });
    expect(f.radioService.playSong).not.toHaveBeenCalled();
  });

  it('ignores a rotation resume for a program the engine has never seen', () => {
    const f = fixture();
    expect(() => f.engine.resumeContinuousRotation('unknown')).not.toThrow();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    expect(f.engine.getPlaybackState('unknown')).toBeNull();
  });

  it('holds a shuffled Play Next queue while frozen and plays it once Palazzo recovers', async () => {
    const f = fixture();
    const queue = [{ id: 'queued', itemId: 'song-2', enqueuedAt: Date.now() }];
    f.store({ songQueue: queue });
    f.engine.handlePalazzoStatus('radio', {
      connection: 'unavailable',
    } as never);
    f.engine.handleSequenceUpdated('radio', { ...playlist, mode: 'shuffle' });
    f.engine.handleQueueUpdated('radio', queue);
    await flush();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    f.engine.handlePalazzoSnapshot('radio', snapshot());
    await flush();
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(f.radioService.playSong.mock.calls[0][1]).toBe(
      playlist.items[1].audioUrl,
    );
  });

  it('reports queue depth with registered radio programs that have no state yet', () => {
    const f = fixture();
    f.engine.registerRadioProgram('idle-radio');
    f.engine.handleQueueUpdated('radio', [
      { id: 'queued', itemId: 'song-2', enqueuedAt: Date.now() },
    ]);
    expect(f.metrics.recordSongQueueDepth).toHaveBeenLastCalledWith(1);
  });

  it('keeps automation running when a healthy connection status arrives while not frozen', async () => {
    const f = await started();
    const events: unknown[] = [];
    f.engine.setBroadcastHandler((event) => events.push(event));
    const status = { connection: 'connected' } as never;
    f.engine.handlePalazzoStatus('radio', status);
    expect(events).toEqual([
      { type: 'radio_leg_status', programId: 'radio', status },
    ]);
    end(f);
    await flush();
    expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
  });

  it('ignores a track.ended event that carries no playback request id', async () => {
    const f = await started();
    f.engine.handlePalazzoEvent('radio', {
      type: 'track.ended',
      data: {},
    } as never);
    await flush();
    expect(f.metrics.recordTrackTransition).toHaveBeenCalledWith(
      'ignored-mismatch',
    );
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('treats a playing snapshot without a request id as foreign playback', async () => {
    const f = await started();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const before = f.engine.getPlaybackState('radio');
    f.engine.handlePalazzoSnapshot(
      'radio',
      malformed(snapshot('x'), { playbackRequestId: undefined }),
    );
    expect(f.engine.getPlaybackState('radio')).toEqual(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('foreign track'));
  });

  it('keeps the commanded start time when a matching snapshot has no start time', async () => {
    const f = await started();
    const request = f.radioService.playSong.mock.calls[0][4];
    const exact = new Date('2026-01-01T00:00:00.500Z');
    f.engine.handlePalazzoSnapshot('radio', {
      ...snapshot(request),
      track: { ...snapshot(request).track!, startedAt: exact.toISOString() },
    });
    expect(f.engine.getPlaybackState('radio')?.startedAt).toBe(
      exact.toISOString(),
    );
    f.engine.handlePalazzoSnapshot(
      'radio',
      malformed(snapshot(request), { startedAt: undefined }),
    );
    expect(f.engine.getPlaybackState('radio')?.startedAt).toBe(
      exact.toISOString(),
    );
    f.engine.handlePalazzoSnapshot(
      'radio',
      malformed(snapshot(request), { startedAt: 'not-a-date' }),
    );
    expect(f.engine.getPlaybackState('radio')?.startedAt).toBe(
      exact.toISOString(),
    );
  });

  it('derives the start time from position when an inherited snapshot has none', async () => {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio', { ...playlist, mode: 'manual' });
    const inherited = malformed(snapshot('inherited'), {
      startedAt: undefined,
    });
    inherited.positionSeconds = 7;
    f.engine.handlePalazzoSnapshot('radio', inherited);
    await flush();
    expect(f.engine.getPlaybackState('radio')).toMatchObject({
      startedAt: new Date(Date.now() - 7000).toISOString(),
    });
  });

  it('withholds commands for a playing snapshot without a media url and warns only once', async () => {
    const f = fixture();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const foreign = malformed(snapshot('foreign'), { url: undefined });
    f.engine.handlePalazzoSnapshot('radio', foreign);
    f.engine.handlePalazzoSnapshot('radio', { ...foreign, sequence: 2 });
    f.engine.handleSequenceUpdated('radio', playlist);
    await flush();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('foreign track'),
      ),
    ).toHaveLength(1);
  });

  it('stops without playing when an automatic sequence has no active cursor', async () => {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio', {
      ...playlist,
      loop: false,
      activeItemId: null,
    });
    f.engine.handlePalazzoSnapshot('radio', snapshot());
    await flush();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    expect(f.engine.getPlaybackState('radio')).toBeNull();
  });

  it('stops safely when the playlist is cleared while a Play Next claim is persisting', async () => {
    const f = fixture();
    const queue = [{ id: 'queued', itemId: 'song-2', enqueuedAt: Date.now() }];
    f.store({ songQueue: queue });
    f.engine.handleQueueUpdated('radio', queue);
    const claim = deferred<ReturnType<typeof f.persisted>>();
    f.prisma.programState.update.mockImplementationOnce(() => claim.promise);
    f.engine.handleSequenceUpdated('radio', playlist);
    f.engine.handlePalazzoSnapshot('radio', snapshot());
    await flush();
    f.engine.handleSequenceUpdated('radio', null);
    claim.resolve(f.persisted());
    await flush();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    expect(f.publisher.publishStopped).toHaveBeenCalledWith('radio');
    expect(f.engine.getPlaybackState('radio')).toBeNull();
  });

  it('stops without playing the queue when persistence failed while an end continuation was pending', async () => {
    const f = await started();
    const queue = [{ id: 'queued', itemId: 'song-2', enqueuedAt: Date.now() }];
    f.store({ songQueue: queue });
    f.engine.handleQueueUpdated('radio', queue);
    const settings = deferred<null>();
    f.radioService.getRadioSettings.mockReturnValueOnce(settings.promise);
    end(f);
    await flush();
    f.prisma.programState.update.mockRejectedValueOnce(
      new Error('claim write unavailable'),
    );
    f.engine.resumeContinuousRotation('radio');
    await flush();
    expect(f.metrics.recordSongQueueAction).toHaveBeenCalledWith(
      'persistence-failed',
    );
    settings.resolve(null);
    await flush();
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(f.persisted().songQueue).toEqual(queue);
    expect(f.engine.getPlaybackState('radio')).toBeNull();
    expect(f.publisher.publishStopped).toHaveBeenCalledWith('radio');
  });

  describe('command acknowledgements', () => {
    const introSequence = {
      ...playlist,
      items: playlist.items.map((item, index) => ({
        ...item,
        songId: 101 + index,
      })),
    };

    it('keeps the engine request id when Palazzo echoes it for a song without an intro', async () => {
      const f = fixture();
      f.radioService.playSong.mockImplementation((_p, _u, _t, _a, requestId) =>
        Promise.resolve({ ok: true, playbackRequestId: requestId }),
      );
      f.engine.handleSequenceUpdated('radio', playlist);
      f.engine.handlePalazzoSnapshot('radio', snapshot());
      await flush();
      expect(f.engine.getPlaybackState('radio')).toMatchObject({
        introStatus: 'none',
      });
      expect(f.metrics.recordIntroTransition).not.toHaveBeenCalled();
    });

    it('accepts the Palazzo-assigned request id after the song was stopped mid-command', async () => {
      const f = fixture();
      f.prisma.songIntro.findUnique.mockResolvedValue({
        programId: 'radio',
        instant: {
          audioUrl: 'https://media.example/intro.mp3',
          volume: 1,
          enabled: true,
        },
      });
      const command = deferred<Record<string, unknown>>();
      f.radioService.playSong.mockImplementationOnce(() => command.promise);
      f.engine.handleSequenceUpdated('radio', introSequence);
      f.engine.handlePalazzoSnapshot('radio', snapshot());
      await flush();
      expect(f.metrics.recordIntroTransition).toHaveBeenCalledWith('submitted');
      f.engine.handleStopSong('radio');
      command.resolve({
        ok: true,
        playbackRequestId: 'palazzo-assigned',
        introPlaybackId: 'palazzo-intro',
      });
      await flush();
      expect(f.metrics.recordIntroTransition).not.toHaveBeenCalledWith(
        'accepted',
      );
      expect(f.engine.getPlaybackState('radio')).toBeNull();
      f.engine.handlePalazzoEvent('radio', {
        type: 'track.started',
        data: { playbackRequestId: 'palazzo-assigned' },
      });
      expect(f.metrics.recordTrackTransition).toHaveBeenLastCalledWith(
        'adopted',
      );
    });
  });

  describe('estimated TV timer completion', () => {
    it('does not publish stopped when a new song became active during the bumper lookup', async () => {
      const f = fixture(false);
      f.engine.handleManualSong('tv', playlist.items[0].audioUrl, 'One');
      await flush();
      const settings = deferred<null>();
      f.radioService.getRadioSettings.mockReturnValueOnce(settings.promise);
      await jest.advanceTimersByTimeAsync(300000);
      f.engine.handleManualSong('tv', playlist.items[1].audioUrl, 'Two');
      settings.resolve(null);
      await flush();
      expect(f.publisher.publishStopped).not.toHaveBeenCalled();
      expect(f.engine.getPlaybackState('tv')?.title).toBe('Two');
    });

    it('publishes stopped when a shuffled successor cannot be started', async () => {
      const f = fixture(false);
      f.engine.handleSequenceUpdated('tv', { ...playlist, mode: 'shuffle' });
      await flush();
      expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
      f.flight.isClockedLogRunning.mockReturnValue(true);
      await jest.advanceTimersByTimeAsync(1000);
      await flush();
      expect(f.flight.handleSongEnded).toHaveBeenCalledWith('tv');
      expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
      expect(f.publisher.publishStopped).toHaveBeenCalledWith('tv');
    });
  });
});
