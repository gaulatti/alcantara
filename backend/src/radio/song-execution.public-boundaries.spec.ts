import { SongExecutionEngine } from './song-execution.engine';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { RadioMetricsService } from './radio-metrics.service';
import {
  parsePalazzoState,
  type PalazzoPlaybackState,
} from './palazzo-contract';

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

describe('SongExecutionEngine public asynchronous boundaries', () => {
  const engines: SongExecutionEngine[] = [];
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')),
  );
  afterEach(() => {
    engines.splice(0).forEach((engine) => engine.onModuleDestroy());
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
        findUnique: jest.fn().mockImplementation(async () => persisted),
        update: jest
          .fn()
          .mockImplementation(
            async ({ data }: { data: Partial<typeof persisted> }) =>
              (persisted = { ...persisted, ...data }),
          ),
      },
    };
    const radioService = {
      playSong: jest.fn().mockResolvedValue({ ok: true }),
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
  function bumper(f: ReturnType<typeof fixture>) {
    f.radioService.getRadioSettings.mockResolvedValue({
      bumperEnabled: true,
      bumperInterval: 1,
      bumperInstantIds: [11],
      bumperMode: 'sequential',
    });
    f.prisma.instant.findUnique.mockResolvedValue({
      name: 'Station ident',
      audioUrl: 'https://media.example/ident.mp3',
    });
  }
  function end(f: ReturnType<typeof fixture>) {
    f.engine.handlePalazzoEvent('radio', {
      type: 'track.ended',
      data: {
        playbackRequestId: f.radioService.playSong.mock.calls.at(-1)![4],
      },
    });
  }

  it.each(['playing', 'idle'] as const)(
    'reconciles an outstanding old command after a newer command failed: %s',
    async (status) => {
      const f = fixture();
      const old = deferred<{ ok: boolean }>();
      f.radioService.playSong
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValueOnce({ ok: false });
      f.engine.handleManualSong(
        'radio',
        'https://media.example/old.mp3',
        'Old',
      );
      await flush();
      const oldRequest = f.radioService.playSong.mock.calls[0][4];
      f.engine.handleManualSong(
        'radio',
        'https://media.example/new.mp3',
        'New',
      );
      await flush();
      f.engine.handleSequenceUpdated('radio', playlist);
      expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
      f.engine.handlePalazzoSnapshot(
        'radio',
        status === 'playing'
          ? snapshot(oldRequest, 'https://media.example/old.mp3')
          : snapshot(),
      );
      await flush();
      if (status === 'idle') {
        expect(f.radioService.playSong).toHaveBeenCalledTimes(3);
        expect(f.radioService.playSong.mock.calls[2][1]).toBe(
          playlist.items[0].audioUrl,
        );
      } else {
        // Confirmation itself must not issue competing audio. A later real idle
        // snapshot remains the authority for recovery.
        expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
        f.engine.handlePalazzoSnapshot('radio', { ...snapshot(), sequence: 2 });
        await flush();
        expect(f.radioService.playSong).toHaveBeenCalledTimes(3);
      }
      old.resolve({ ok: true });
      await flush();
      expect(f.engine.getPlaybackState('radio')?.audioUrl).toBe(
        playlist.items[0].audioUrl,
      );
    },
  );

  it.each(['empty', 'missing-audio'] as const)(
    'stops after the playlist is replaced during the live station ident: %s',
    async (replacement) => {
      const f = await started();
      bumper(f);
      end(f);
      await flush();
      expect(f.radioService.playInstant).toHaveBeenCalledTimes(1);
      f.engine.handleSequenceUpdated('radio', {
        ...playlist,
        items:
          replacement === 'empty'
            ? []
            : [
                {
                  id: 'offline-catalog-item',
                  kind: 'preset',
                  title: 'Unavailable media',
                },
              ],
      });
      await jest.advanceTimersByTimeAsync(8000);
      await flush();
      expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
      expect(f.publisher.publishStopped).toHaveBeenCalledWith('radio');
      expect(f.engine.getPlaybackState('radio')).toBeNull();
    },
  );

  it.each(['read', 'write'] as const)(
    'fails closed when acquiring a persisted queue claim cannot %s',
    async (operation) => {
      const f = fixture();
      const queue = [
        { id: 'queued', itemId: 'song-2', enqueuedAt: Date.now() },
      ];
      f.store({ songQueue: queue });
      f.engine.handleQueueUpdated('radio', queue);
      if (operation === 'read')
        f.prisma.programState.findUnique.mockRejectedValueOnce(
          new Error('database read unavailable'),
        );
      else
        f.prisma.programState.update.mockRejectedValueOnce(
          new Error('database write unavailable'),
        );
      f.engine.handleSequenceUpdated('radio', playlist);
      f.engine.handlePalazzoSnapshot('radio', snapshot());
      await flush();
      expect(f.radioService.playSong).not.toHaveBeenCalled();
      expect(f.persisted().songQueue).toEqual(queue);
      expect(f.publisher.publishStopped).toHaveBeenCalledWith('radio');
      expect(f.metrics.recordSongQueueAction).toHaveBeenCalledWith(
        'persistence-failed',
      );
    },
  );

  it.each(['manual', 'absent'] as const)(
    'publishes stopped after the real TV estimated timer without an automatic successor: %s',
    async (mode) => {
      const f = fixture(false);
      if (mode === 'manual')
        f.engine.handleSequenceUpdated('tv', { ...playlist, mode });
      f.engine.handleManualSong(
        'tv',
        'https://media.example/manual.mp3',
        'TV choice',
        undefined,
        1000,
      );
      await flush();
      await jest.advanceTimersByTimeAsync(999);
      expect(f.publisher.publishStopped).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await flush();
      expect(f.flight.handleSongEnded).toHaveBeenCalledWith('tv');
      expect(f.publisher.publishStopped).toHaveBeenCalledTimes(1);
      expect(f.engine.getPlaybackState('tv')).toBeNull();
      expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts remaining-only position telemetry and ignores it after explicit stop', async () => {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio', null);
    f.engine.handlePalazzoEvent('radio', {
      type: 'playback.position',
      data: { remainingSeconds: 5 },
    });
    expect(f.engine.getPlaybackState('radio')).toBeNull();
    f.engine.handleManualSong('radio', playlist.items[0].audioUrl, 'Manual');
    await flush();
    f.engine.handlePalazzoEvent('radio', {
      type: 'playback.position',
      data: { remainingSeconds: 0 },
    });
    expect(f.engine.getPlaybackState('radio')).toMatchObject({
      durationMs: 0,
      positionMs: 0,
      progress: 0,
    });
    f.engine.handleStopSong('radio');
    f.engine.handlePalazzoEvent('radio', {
      type: 'playback.position',
      data: { remainingSeconds: 5 },
    });
    expect(f.engine.getPlaybackState('radio')).toBeNull();
  });

  it.each(['playing', 'failed'] as const)(
    'adopts inherited catalog playback with nullable metadata and a %s intro',
    async (status) => {
      const f = fixture();
      f.engine.handleSequenceUpdated('radio', {
        ...playlist,
        items: [
          { ...playlist.items[0], durationMs: undefined, highRotation: true },
        ],
      });
      const inherited = snapshot('inherited');
      inherited.positionSeconds = 7;
      inherited.intro = {
        playbackId: 'intro',
        parentPlaybackId: 'inherited',
        programId: 'radio',
        playbackRequestId: 'intro-request',
        url: 'https://media.example/intro.mp3',
        startedAt: new Date().toISOString(),
        status,
        ...(status === 'failed' ? { failureReason: ' Intro failed ' } : {}),
      };
      expect(parsePalazzoState(inherited)).toEqual(inherited);
      f.engine.handlePalazzoSnapshot('radio', inherited);
      await flush();
      expect(f.engine.getPlaybackState('radio')).toMatchObject({
        title: 'Song 1',
        artist: 'Artist',
        durationMs: 300000,
        positionMs: 7000,
        introStatus: status === 'playing' ? 'playing' : 'degraded',
        introFailureReason: status === 'failed' ? 'Intro failed' : null,
      });
      expect(f.radioService.playSong).not.toHaveBeenCalled();
      expect(f.persisted().songRotation).toMatchObject({
        history: [expect.objectContaining({ songKey: 'item:song-1' })],
      });
    },
  );

  it('retains the remaining shuffled queue entries when the active command is rejected', async () => {
    const f = fixture();
    const queue = [
      { id: 'first', itemId: 'song-1', enqueuedAt: Date.now() },
      { id: 'second', itemId: 'song-2', enqueuedAt: Date.now() },
    ];
    f.store({ songQueue: queue });
    f.engine.handleQueueUpdated('radio', queue);
    f.radioService.playSong.mockResolvedValue({ ok: false });
    f.engine.handleSequenceUpdated('radio', { ...playlist, mode: 'shuffle' });
    f.engine.handlePalazzoSnapshot('radio', snapshot());
    await flush();
    expect(f.persisted().songQueue).toEqual(queue);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(f.metrics.recordSongQueueAction).toHaveBeenCalledWith('released');
  });

  it('serializes overlapping favorite confirmations without dropping either history entry', async () => {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio', {
      ...playlist,
      mode: 'manual',
      items: playlist.items.map((item) => ({ ...item, highRotation: true })),
    });
    const firstWrite = deferred<ReturnType<typeof f.persisted>>();
    f.prisma.programState.update.mockImplementationOnce(
      () => firstWrite.promise,
    );
    for (const item of playlist.items) {
      f.engine.handleManualSong('radio', item.audioUrl, item.title);
      await flush();
      f.engine.handlePalazzoEvent('radio', {
        type: 'track.started',
        data: {
          playbackRequestId: f.radioService.playSong.mock.calls.at(-1)![4],
        },
      });
      await flush();
    }
    expect(f.prisma.programState.update).toHaveBeenCalledTimes(1);
    firstWrite.resolve(f.persisted());
    await flush();
    expect(f.prisma.programState.update).toHaveBeenCalledTimes(2);
    expect(f.persisted().songRotation).toMatchObject({
      history: [
        expect.objectContaining({ songKey: 'item:song-1' }),
        expect.objectContaining({ songKey: 'item:song-2' }),
      ],
    });
  });
});
