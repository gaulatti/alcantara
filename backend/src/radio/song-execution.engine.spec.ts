import { config as rxjsConfig } from 'rxjs';
import {
  SongExecutionEngine,
  type SongEngineTrackEvent,
} from './song-execution.engine';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { RadioMetricsService } from './radio-metrics.service';
import type { PalazzoPlaybackState } from './palazzo-contract';
import { SongSimilarityService } from './song-similarity.service';
import { SIMILARITY_MODEL } from './song-similarity.utils';

function idleSnapshot(
  instanceId: string,
  bootId: string,
  sequence: number,
): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId,
    bootId,
    sequence,
    availability: 'available',
    status: 'idle',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: new Date().toISOString(),
    },
    track: null,
    intro: null,
    icecast: { connected: true },
    positionSeconds: 0,
    remainingSeconds: null,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
  };
}

function playingSnapshot(
  instanceId: string,
  bootId: string,
  sequence: number,
  playbackRequestId: string,
  url = 'https://example.test/song-1.mp3',
  title = 'Song one',
  artist = 'Artist one',
): PalazzoPlaybackState {
  return {
    ...idleSnapshot(instanceId, bootId, sequence),
    status: 'playing',
    track: {
      playbackRequestId,
      title,
      artist,
      url,
      startedAt: new Date().toISOString(),
    },
    positionSeconds: 1,
    remainingSeconds: 99,
  };
}

const SEQUENCE = {
  mode: 'autoplay',
  loop: true,
  intervalMs: 500,
  items: [
    {
      id: 'song-1',
      kind: 'preset',
      title: 'Song one',
      artist: 'Artist one',
      coverUrl: 'https://example.test/song-1.jpg',
      audioUrl: 'https://example.test/song-1.mp3',
      durationMs: 1000,
      songId: 101,
    },
  ],
};

const TWO_SONG_SEQUENCE = {
  ...SEQUENCE,
  items: [
    SEQUENCE.items[0],
    {
      id: 'song-2',
      kind: 'preset',
      title: 'Song two',
      artist: 'Artist two',
      coverUrl: 'https://example.test/song-2.jpg',
      audioUrl: 'https://example.test/song-2.mp3',
      durationMs: 1000,
    },
  ],
};

function createEngine(opts: {
  reconciled: boolean;
  radio?: boolean;
  tv?: boolean;
  similarity?: SongSimilarityService;
}) {
  let currentProgramState = {
    programId: opts.tv ? 'tv-1' : 'radio-1',
    type: opts.tv ? 'tv' : 'radio',
    songSequence: TWO_SONG_SEQUENCE as unknown,
    songQueue: [] as unknown[],
    songRotation: null as unknown,
  };
  const prisma = {
    songIntro: { findUnique: jest.fn().mockResolvedValue(null) },
    instant: { findUnique: jest.fn().mockResolvedValue(null) },
    programState: {
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(currentProgramState)),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          currentProgramState = { ...currentProgramState, ...data };
          return Promise.resolve(currentProgramState);
        }),
    },
  };
  const nowPlayingPublisher = {
    publishPlayback: jest.fn().mockResolvedValue(undefined),
    publishStopped: jest.fn().mockResolvedValue(undefined),
  };
  const radioService = {
    playSong: jest.fn().mockResolvedValue({ ok: true }),
    playInstant: jest.fn().mockResolvedValue(undefined),
    getRadioSettings: jest.fn().mockResolvedValue(null),
  };
  const flightService = {
    isClockedLogRunning: jest.fn().mockReturnValue(false),
    handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
  };
  const metrics = {
    recordTrackTransition: jest.fn(),
    recordEngineResync: jest.fn(),
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
    recordSimilarityAction: jest.fn(),
  };
  const engine = new SongExecutionEngine(
    radioService as unknown as RadioService,
    flightService as unknown as FlightService,
    prisma as unknown as PrismaService,
    nowPlayingPublisher as unknown as NowPlayingPublisherService,
    metrics as unknown as RadioMetricsService,
    opts.similarity,
  );
  engine.setPalazzoTelemetry({
    isReconciled: () => opts.reconciled,
  });
  if (opts.radio) engine.registerRadioProgram('radio-1');
  return {
    engine,
    radioService,
    flightService,
    nowPlayingPublisher,
    metrics,
    prisma,
    setPersistedProgramState: (next: Partial<typeof currentProgramState>) => {
      currentProgramState = { ...currentProgramState, ...next };
    },
    getPersistedProgramState: () => currentProgramState,
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('continuous filler restoration', () => {
  afterEach(() => jest.useRealTimers());
  it('persists the next base cursor under block ownership and requests exactly one song after release', async () => {
    jest.useFakeTimers();
    const { engine, radioService, flightService, getPersistedProgramState } =
      createEngine({ reconciled: true, radio: true });
    flightService.isClockedLogRunning.mockReturnValue(true);
    engine.handleSequenceUpdated('radio-1', {
      ...TWO_SONG_SEQUENCE,
      loop: true,
    });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 1),
    );
    expect(radioService.playSong).not.toHaveBeenCalled();
    await engine.prepareContinuousRotationResume('radio-1');
    expect(getPersistedProgramState().songSequence).toMatchObject({
      activeItemId: 'song-2',
      mode: 'autoplay',
      items: TWO_SONG_SEQUENCE.items,
    });
    expect(radioService.playSong).not.toHaveBeenCalled();
    flightService.isClockedLogRunning.mockReturnValue(false);
    engine.resumeContinuousRotation('radio-1');
    engine.resumeContinuousRotation('radio-1');
    await flush(20);
    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    expect(radioService.playSong.mock.calls[0][1]).toBe(
      'https://example.test/song-2.mp3',
    );
    engine.handleStopSong('radio-1');
  });
  it('preserves a manual base without starting it automatically', async () => {
    jest.useFakeTimers();
    const { engine, radioService, getPersistedProgramState } = createEngine({
      reconciled: true,
      radio: true,
    });
    engine.handleSequenceUpdated('radio-1', {
      ...TWO_SONG_SEQUENCE,
      mode: 'manual',
    });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 1),
    );
    await engine.prepareContinuousRotationResume('radio-1');
    engine.resumeContinuousRotation('radio-1');
    expect(radioService.playSong).not.toHaveBeenCalled();
    expect(getPersistedProgramState().songSequence).toMatchObject({
      items: TWO_SONG_SEQUENCE.items,
    });
  });
});

describe('SongExecutionEngine authoritative playback', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses a cue-specific voice track and mix on its song command', async () => {
    const { engine, radioService, prisma } = createEngine({
      reconciled: true,
      radio: true,
    });
    prisma.instant.findUnique.mockResolvedValue({
      audioUrl: 'https://example.test/voice.webm',
      volume: 0.8,
      enabled: true,
    });
    engine.handleManualSong(
      'radio-1',
      'https://example.test/song-1.mp3',
      'Song one',
      'Artist one',
      120_000,
      undefined,
      101,
      { instantId: 77, duckGain: 0.3, fadeInSeconds: 0.2, fadeOutSeconds: 0.4 },
    );
    await flush(12);
    expect(prisma.instant.findUnique).toHaveBeenCalledWith({
      where: { id: 77 },
      select: { audioUrl: true, volume: true, enabled: true },
    });
    expect(radioService.playSong).toHaveBeenCalledWith(
      'radio-1',
      'https://example.test/song-1.mp3',
      'Song one',
      'Artist one',
      expect.any(String),
      undefined,
      expect.objectContaining({
        url: 'https://example.test/voice.webm',
        gain: 0.8,
        duckGain: 0.3,
        fadeInSeconds: 0.2,
        fadeOutSeconds: 0.4,
      }),
    );
    expect(prisma.songIntro.findUnique).not.toHaveBeenCalled();
  });

  it('submits an assigned intro atomically and reconciles its lifecycle without ending the song', async () => {
    const { engine, radioService, flightService, prisma, metrics } =
      createEngine({ reconciled: true, radio: true });
    prisma.songIntro.findUnique.mockResolvedValue({
      programId: 'radio-1',
      instant: {
        audioUrl: 'https://example.test/intro-1.mp3',
        volume: 0.8,
        enabled: true,
      },
    });
    radioService.playSong.mockImplementation(
      async (_programId, _url, _title, _artist, requestId, _cover, intro) => ({
        ok: true,
        playbackRequestId: requestId,
        introPlaybackId: intro?.playbackId,
      }),
    );

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    expect(prisma.songIntro.findUnique).toHaveBeenCalledWith({
      where: { songId: 101 },
      include: {
        instant: { select: { audioUrl: true, volume: true, enabled: true } },
      },
    });
    const requestId = radioService.playSong.mock.calls[0][4];
    expect(radioService.playSong.mock.calls[0][6]).toEqual({
      playbackId: `${requestId}:intro`,
      url: 'https://example.test/intro-1.mp3',
      gain: 0.8,
    });

    engine.handlePalazzoEvent('radio-1', {
      type: 'intro.started',
      data: {
        programId: 'radio-1',
        playbackId: `${requestId}:intro`,
        parentPlaybackId: requestId,
      },
    });
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      introStatus: 'playing',
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'intro.ended',
      data: {
        programId: 'radio-1',
        playbackId: `${requestId}:intro`,
        parentPlaybackId: requestId,
      },
    });
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      isPlaying: true,
      introStatus: 'completed',
    });
    expect(flightService.handleSongEnded).not.toHaveBeenCalled();
    expect(metrics.recordIntroTransition).toHaveBeenCalledWith('submitted');
    expect(metrics.recordIntroTransition).toHaveBeenCalledWith('accepted');
    expect(metrics.recordIntroTransition).toHaveBeenCalledWith('started');
    expect(metrics.recordIntroTransition).toHaveBeenCalledWith('ended');
  });

  it('preserves catalog identity when shuffle resolves a song intro', async () => {
    const { engine, prisma } = createEngine({ reconciled: true, radio: true });
    prisma.songIntro.findUnique.mockResolvedValue({
      programId: 'radio-1',
      instant: {
        audioUrl: 'https://example.test/intro-1.mp3',
        volume: 1,
        enabled: true,
      },
    });

    engine.handleSequenceUpdated('radio-1', {
      ...SEQUENCE,
      mode: 'shuffle',
    });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    expect(prisma.songIntro.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { songId: 101 } }),
    );
  });

  it('plays distinct high rotation songs on a 30-minute cadence and resumes the normal playlist between them', async () => {
    jest.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
    const { engine, radioService, prisma, metrics, getPersistedProgramState } =
      createEngine({ reconciled: true, radio: true });
    const highRotationSequence = {
      mode: 'shuffle',
      loop: true,
      activeItemId: 'normal',
      items: [
        {
          id: 'normal',
          kind: 'preset',
          title: 'Normal song',
          artist: 'Artist',
          coverUrl: '',
          audioUrl: 'https://example.test/normal.mp3',
          durationMs: 1000,
        },
        {
          id: 'favorite-1',
          kind: 'preset',
          songId: 201,
          highRotation: true,
          title: 'Favorite one',
          artist: 'Artist',
          coverUrl: '',
          audioUrl: 'https://example.test/favorite-1.mp3',
          durationMs: 1000,
        },
        {
          id: 'favorite-2',
          kind: 'preset',
          songId: 202,
          highRotation: true,
          title: 'Favorite two',
          artist: 'Artist',
          coverUrl: '',
          audioUrl: 'https://example.test/favorite-2.mp3',
          durationMs: 1000,
        },
      ],
    };

    engine.handleSequenceUpdated('radio-1', highRotationSequence);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    const firstCall = radioService.playSong.mock.calls[0] as Parameters<
      RadioService['playSong']
    >;
    expect(firstCall[1]).toBe('https://example.test/favorite-1.mp3');
    const firstRequestId = firstCall[4];
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: firstRequestId },
    });
    await flush();
    expect(getPersistedProgramState().songRotation).toMatchObject({
      history: [expect.objectContaining({ songKey: 'song:201' })],
    });

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: firstRequestId },
    });
    await flush(12);
    const normalCall = radioService.playSong.mock.calls[1] as Parameters<
      RadioService['playSong']
    >;
    expect(normalCall[1]).toBe('https://example.test/normal.mp3');
    const normalRequestId = normalCall[4];
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: normalRequestId },
    });
    jest.advanceTimersByTime(31 * 60 * 1000);
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: normalRequestId },
    });
    await flush(12);

    const secondCall = radioService.playSong.mock.calls[2] as Parameters<
      RadioService['playSong']
    >;
    expect(secondCall[1]).toBe('https://example.test/favorite-2.mp3');
    const secondRequestId = secondCall[4];
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: secondRequestId },
    });
    await flush();
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: secondRequestId },
    });
    await flush(12);

    const resumedCall = radioService.playSong.mock.calls[3] as Parameters<
      RadioService['playSong']
    >;
    expect(resumedCall[1]).toBe('https://example.test/normal.mp3');
    expect(prisma.programState.update).toHaveBeenCalled();
    expect(metrics.recordHighRotationAction).toHaveBeenCalledWith('selected');
    expect(metrics.recordHighRotationAction).toHaveBeenCalledWith('played');
  });

  it('keeps the song active and exposes a bounded degraded state when an intro fails', async () => {
    const { engine, radioService, flightService, prisma } = createEngine({
      reconciled: true,
      radio: true,
    });
    prisma.songIntro.findUnique.mockResolvedValue({
      programId: 'radio-1',
      instant: {
        audioUrl: 'https://example.test/intro-1.mp3',
        volume: 1,
        enabled: true,
      },
    });
    radioService.playSong.mockImplementation(
      async (_programId, _url, _title, _artist, requestId, _cover, intro) => ({
        ok: true,
        playbackRequestId: requestId,
        introPlaybackId: intro?.playbackId,
      }),
    );
    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'intro.failed',
      data: {
        programId: 'radio-1',
        playbackId: `${requestId}:intro`,
        parentPlaybackId: requestId,
        reason: 'x'.repeat(500),
      },
    });

    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      isPlaying: true,
      introStatus: 'degraded',
    });
    expect(engine.getPlaybackState('radio-1')?.introFailureReason).toHaveLength(
      200,
    );
    expect(flightService.handleSongEnded).not.toHaveBeenCalled();
  });

  it('does not command playback before a Palazzo snapshot is reconciled', async () => {
    const { engine, radioService } = createEngine({
      reconciled: false,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    await flush();

    expect(radioService.playSong).not.toHaveBeenCalled();
  });

  it('starts the sequence after the first reconciled idle snapshot', async () => {
    const { engine, radioService } = createEngine({
      reconciled: false,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.setPalazzoTelemetry({ isReconciled: () => true });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    const [, , , , requestId] = radioService.playSong.mock.calls[0];
    expect(requestId).toEqual(expect.any(String));
    expect(radioService.playSong.mock.calls[0][5]).toBe(
      'https://example.test/song-1.jpg',
    );
  });

  it('adopts an inherited live track and advances to its exact successor', async () => {
    const { engine, radioService, flightService, nowPlayingPublisher } =
      createEngine({
        reconciled: true,
        radio: true,
      });

    // The persisted cursor is still song 1, but Palazzo is already playing
    // song 2 from the previous Alcantara process.
    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(
        'palazzo-a',
        'boot-1',
        1,
        'previous-engine-request',
        'https://example.test/song-2.mp3',
        'Song two',
        'Artist two',
      ),
    );
    await flush();
    expect(radioService.playSong).not.toHaveBeenCalled();
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      audioUrl: 'https://example.test/song-2.mp3',
      title: 'Song two',
    });
    expect(nowPlayingPublisher.publishPlayback).toHaveBeenCalledTimes(1);

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'previous-engine-request' },
    });
    await flush();

    expect(flightService.handleSongEnded).toHaveBeenCalledTimes(1);
    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    expect(radioService.playSong.mock.calls[0][1]).toBe(
      'https://example.test/song-1.mp3',
    );
  });

  it('does not adopt or command an unknown inherited track', async () => {
    const { engine, radioService, flightService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(
        'palazzo-a',
        'boot-1',
        1,
        'foreign-request',
        'https://example.test/unknown.mp3',
      ),
    );
    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'foreign-request' },
    });
    await flush();

    expect(engine.getPlaybackState('radio-1')).toBeNull();
    expect(flightService.handleSongEnded).not.toHaveBeenCalled();
    expect(radioService.playSong).not.toHaveBeenCalled();
  });

  it('does not start an explicit manual sequence from an idle snapshot', async () => {
    const { engine, radioService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', { ...SEQUENCE, mode: 'manual' });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    expect(radioService.playSong).not.toHaveBeenCalled();
  });

  it('advances exactly once on a matching authoritative track end', async () => {
    const { engine, radioService, flightService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: {
        playbackRequestId: requestId,
        url: 'https://example.test/song-1.mp3',
      },
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: {
        playbackRequestId: requestId,
        url: 'https://example.test/song-1.mp3',
      },
    });
    await flush();

    expect(flightService.handleSongEnded).toHaveBeenCalledTimes(1);
    // The looped sequence commands a successor without publishing stopped.
    expect(radioService.playSong).toHaveBeenCalledTimes(2);
  });

  it('commands the next playlist item after Palazzo reports track end', async () => {
    const { engine, radioService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const firstRequestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: firstRequestId },
    });
    await flush();

    expect(radioService.playSong).toHaveBeenCalledTimes(2);
    expect(radioService.playSong.mock.calls[1][1]).toBe(
      'https://example.test/song-2.mp3',
    );
  });

  it('plays a persisted shuffle order once without repeats when loop is off', async () => {
    const { engine, radioService, nowPlayingPublisher } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', {
      ...TWO_SONG_SEQUENCE,
      mode: 'shuffle',
      loop: false,
    });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const firstRequestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: firstRequestId },
    });
    await flush();
    const secondRequestId = radioService.playSong.mock.calls[1][4];
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: secondRequestId },
    });
    await flush();

    expect(radioService.playSong.mock.calls.map((call) => call[1])).toEqual([
      'https://example.test/song-1.mp3',
      'https://example.test/song-2.mp3',
    ]);
    expect(nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh idle shuffle clock instead of skipping the selected first item', async () => {
    const { engine, radioService } = createEngine({
      reconciled: true,
      radio: true,
    });
    const now = new Date('2026-09-11T12:00:00.000Z').getTime();
    jest.setSystemTime(now);

    engine.handleSequenceUpdated('radio-1', {
      ...TWO_SONG_SEQUENCE,
      mode: 'manual',
      loop: false,
      activeItemId: 'song-1',
      startedAt: now - 2_500,
    });
    engine.handleSequenceUpdated('radio-1', {
      ...TWO_SONG_SEQUENCE,
      mode: 'shuffle',
      loop: false,
      activeItemId: 'song-1',
      startedAt: now,
    });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    expect(radioService.playSong.mock.calls[0][1]).toBe(
      'https://example.test/song-1.mp3',
    );
  });

  it('clears optimistic radio playback when Palazzo rejects the command', async () => {
    const { engine, radioService, nowPlayingPublisher, metrics } = createEngine(
      {
        reconciled: true,
        radio: true,
      },
    );
    const events: Array<{ type: string }> = [];
    engine.setBroadcastHandler((event) => events.push(event));
    radioService.playSong.mockResolvedValue({ ok: false });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    expect(engine.getPlaybackState('radio-1')).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: 'song_off_air',
      programId: 'radio-1',
    });
    expect(nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(1);
    expect(metrics.recordTrackTransition).toHaveBeenCalledWith(
      'command-failed',
    );
  });

  it('wraps a looped playlist and stops an explicitly non-looped playlist', async () => {
    const looped = createEngine({ reconciled: true, radio: true });
    looped.engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    looped.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    let requestId = looped.radioService.playSong.mock.calls[0][4];
    looped.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();
    requestId = looped.radioService.playSong.mock.calls[1][4];
    looped.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();
    expect(looped.radioService.playSong.mock.calls[2][1]).toBe(
      'https://example.test/song-1.mp3',
    );

    const nonLooped = createEngine({ reconciled: true, radio: true });
    nonLooped.engine.handleSequenceUpdated('radio-1', {
      ...SEQUENCE,
      loop: false,
    });
    nonLooped.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-b', 'boot-2', 1),
    );
    await flush();
    requestId = nonLooped.radioService.playSong.mock.calls[0][4];
    nonLooped.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();
    expect(nonLooped.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(nonLooped.nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(
      1,
    );
  });

  it('defaults an unspecified radio sequence mode to autoplay', async () => {
    const { engine, radioService } = createEngine({
      reconciled: true,
      radio: true,
    });
    const { mode: _mode, ...withoutMode } = SEQUENCE;

    engine.handleSequenceUpdated('radio-1', withoutMode);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    expect(radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('gives a running clocked log sole ownership over an authoritative end and idle reconciliation', async () => {
    const { engine, radioService, flightService, nowPlayingPublisher } =
      createEngine({ reconciled: true, radio: true });
    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const calls = radioService.playSong.mock.calls as unknown as string[][];
    const requestId = calls[0][4];
    flightService.isClockedLogRunning.mockReturnValue(true);
    engine.handleQueueUpdated('radio-1', [
      { id: 'old-queue', itemId: 'song-1', enqueuedAt: 1 },
    ]);
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 2),
    );
    await flush();
    expect(flightService.handleSongEnded).toHaveBeenCalledTimes(1);
    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    expect(nowPlayingPublisher.publishStopped).not.toHaveBeenCalled();
  });

  it('ignores duplicate track.ended events for the same request', async () => {
    const { engine, radioService, flightService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();

    expect(flightService.handleSongEnded).toHaveBeenCalledTimes(1);
  });

  it('ignores track.ended for a stale or foreign request id', async () => {
    const { engine, radioService, flightService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'not-our-request' },
    });
    await flush();

    expect(flightService.handleSongEnded).not.toHaveBeenCalled();
    expect(radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('freezes when Palazzo becomes unavailable and never advances or publishes a synthetic stop', async () => {
    const { engine, radioService, flightService, nowPlayingPublisher } =
      createEngine({ reconciled: true, radio: true });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoStatus('radio-1', {
      programId: 'radio-1',
      programType: 'radio',
      palazzoUrl: 'http://palazzo:3100',
      instanceId: 'palazzo-a',
      connection: 'unavailable',
      lastEventAt: null,
      lastSnapshotAt: null,
      degraded: true,
      detail: 'sse and state endpoint unreachable',
    });

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();

    expect(flightService.handleSongEnded).not.toHaveBeenCalled();
    expect(nowPlayingPublisher.publishStopped).not.toHaveBeenCalled();
  });

  it('recovers from unavailability by reconciling the authoritative snapshot', async () => {
    const { engine, radioService, flightService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoStatus('radio-1', {
      programId: 'radio-1',
      programType: 'radio',
      palazzoUrl: 'http://palazzo:3100',
      instanceId: 'palazzo-a',
      connection: 'unavailable',
      lastEventAt: null,
      lastSnapshotAt: null,
      degraded: true,
      detail: null,
    });

    // Palazzo returns: the snapshot is idle, so our command has ended.
    engine.handlePalazzoStatus('radio-1', {
      programId: 'radio-1',
      programType: 'radio',
      palazzoUrl: 'http://palazzo:3100',
      instanceId: 'palazzo-a',
      connection: 'connected',
      lastEventAt: new Date().toISOString(),
      lastSnapshotAt: new Date().toISOString(),
      degraded: false,
      detail: null,
    });
    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 5),
    );
    await flush();

    expect(flightService.handleSongEnded).toHaveBeenCalledTimes(1);
    // The sequence recovers and commands the successor.
    expect(radioService.playSong).toHaveBeenCalledTimes(2);
  });

  it('adopts authoritative position from playing snapshots', async () => {
    const { engine, radioService } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot('palazzo-a', 'boot-1', 3, requestId),
    );
    const playback = engine.getPlaybackState('radio-1');
    expect(playback).not.toBeNull();
    expect(playback?.telemetryStale).toBe(false);
  });

  it('does not advance a TV-only program from Palazzo state and keeps its timer behavior', async () => {
    const { engine, radioService, flightService } = createEngine({
      reconciled: false,
      tv: true,
    });

    engine.handleSequenceUpdated('tv-1', SEQUENCE);
    await flush();
    expect(radioService.playSong).toHaveBeenCalledTimes(1);

    // Palazzo lifecycle events for a program without telemetry are inert.
    const requestId = radioService.playSong.mock.calls[0][4];
    engine.handlePalazzoEvent('tv-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();
    expect(flightService.handleSongEnded).not.toHaveBeenCalled();

    // Legacy estimated-duration completion still applies.
    await jest.advanceTimersByTimeAsync(1000);
    expect(flightService.handleSongEnded).toHaveBeenCalledTimes(1);
  });

  it('publishes stopped only when an authoritative manual-song end has no successor', async () => {
    const { engine, radioService, nowPlayingPublisher } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleSequenceUpdated('radio-1', { ...SEQUENCE, mode: 'manual' });
    engine.handleManualSong(
      'radio-1',
      'https://example.test/manual.mp3',
      'Manual song',
      'Manual artist',
      1000,
    );
    await flush();
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush();

    expect(nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(1);
  });

  it('keeps manual stop distinct from appliance unavailability', async () => {
    const { engine, nowPlayingPublisher } = createEngine({
      reconciled: true,
      radio: true,
    });

    engine.handleManualSong(
      'radio-1',
      'https://example.test/manual.mp3',
      'Manual song',
    );
    engine.handleStopSong('radio-1');

    expect(nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(1);
  });

  it('plays the persisted FIFO queue before resuming the advanced playlist cursor', async () => {
    const {
      engine,
      radioService,
      prisma,
      setPersistedProgramState,
      getPersistedProgramState,
    } = createEngine({ reconciled: true, radio: true });
    const queue = [{ id: 'queue-1', itemId: 'song-1', enqueuedAt: 1 }];
    setPersistedProgramState({
      songSequence: TWO_SONG_SEQUENCE,
      songQueue: queue,
    });

    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    engine.handleQueueUpdated('radio-1', queue);
    const playlistRequestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: playlistRequestId },
    });
    await flush(20);

    expect(radioService.playSong.mock.calls.map((call) => call[1])).toEqual([
      'https://example.test/song-1.mp3',
      'https://example.test/song-1.mp3',
    ]);
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      queueEntryId: 'queue-1',
    });
    expect(prisma.programState.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          songSequence: expect.objectContaining({ activeItemId: 'song-2' }),
        },
      }),
    );

    const queuedRequestId = radioService.playSong.mock.calls[1][4];
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: queuedRequestId },
    });
    await flush(20);

    expect(radioService.playSong.mock.calls.map((call) => call[1])).toEqual([
      'https://example.test/song-1.mp3',
      'https://example.test/song-1.mp3',
      'https://example.test/song-2.mp3',
    ]);
    expect(getPersistedProgramState().songQueue).toEqual([]);
  });

  it('adopts a persisted queue head after restart and consumes it on authoritative end', async () => {
    const { engine, radioService, setPersistedProgramState } = createEngine({
      reconciled: true,
      radio: true,
    });
    const queue = [
      {
        id: 'queue-2',
        itemId: 'song-2',
        enqueuedAt: 2,
        active: true,
        playbackRequestId: 'inherited-queue-request',
      },
    ];
    setPersistedProgramState({
      songSequence: TWO_SONG_SEQUENCE,
      songQueue: queue,
    });
    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handleQueueUpdated('radio-1', queue);

    engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(
        'palazzo-a',
        'boot-1',
        1,
        'inherited-queue-request',
        'https://example.test/song-2.mp3',
      ),
    );
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      queueEntryId: 'queue-2',
    });

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'inherited-queue-request' },
    });
    await flush(20);

    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    expect(radioService.playSong.mock.calls[0][1]).toBe(
      'https://example.test/song-1.mp3',
    );
  });

  it('does not mistake the prior playlist request for an identical claimed queue item after restart', async () => {
    const { engine, radioService, setPersistedProgramState } = createEngine({
      reconciled: true,
      radio: true,
    });
    const queue = [
      {
        id: 'queue-2',
        itemId: 'song-2',
        enqueuedAt: 2,
        active: true,
        playbackRequestId: 'queued-request',
      },
    ];
    setPersistedProgramState({
      songSequence: TWO_SONG_SEQUENCE,
      songQueue: queue,
    });
    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handleQueueUpdated('radio-1', queue);

    engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(
        'palazzo-a',
        'boot-1',
        1,
        'prior-playlist-request',
        'https://example.test/song-2.mp3',
      ),
    );
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      queueEntryId: null,
    });

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'prior-playlist-request' },
    });
    await flush(20);

    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    expect(radioService.playSong.mock.calls[0][4]).toBe('queued-request');
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      queueEntryId: 'queue-2',
    });
  });

  it('releases a queue claim without consuming it when Palazzo rejects the command', async () => {
    const {
      engine,
      radioService,
      nowPlayingPublisher,
      metrics,
      setPersistedProgramState,
      getPersistedProgramState,
    } = createEngine({ reconciled: true, radio: true });
    const queue = [
      {
        id: 'queue-2',
        itemId: 'song-2',
        enqueuedAt: 2,
        active: true,
        playbackRequestId: 'queue-request',
      },
    ];
    setPersistedProgramState({
      songSequence: TWO_SONG_SEQUENCE,
      songQueue: queue,
    });
    radioService.playSong.mockResolvedValue({ ok: false });
    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handleQueueUpdated('radio-1', queue);

    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush(20);

    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    expect(getPersistedProgramState().songQueue).toEqual([
      { id: 'queue-2', itemId: 'song-2', enqueuedAt: 2 },
    ]);
    expect(nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(1);
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith('released');
    expect(metrics.recordSongQueueAction).not.toHaveBeenCalledWith('consumed');
  });

  it('releases the active queue claim when an operator stops playback', async () => {
    const {
      engine,
      setPersistedProgramState,
      getPersistedProgramState,
      metrics,
    } = createEngine({ reconciled: true, radio: true });
    const queue = [
      {
        id: 'queue-2',
        itemId: 'song-2',
        enqueuedAt: 2,
        active: true,
        playbackRequestId: 'queued-request',
      },
    ];
    setPersistedProgramState({
      songSequence: TWO_SONG_SEQUENCE,
      songQueue: queue,
    });
    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handleQueueUpdated('radio-1', queue);
    engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(
        'palazzo-a',
        'boot-1',
        1,
        'queued-request',
        'https://example.test/song-2.mp3',
      ),
    );

    engine.handleStopSong('radio-1');
    await flush(20);

    expect(getPersistedProgramState().songQueue).toEqual([
      { id: 'queue-2', itemId: 'song-2', enqueuedAt: 2 },
    ]);
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith('released');
  });

  it('stops safely without commanding the queue when cursor persistence fails', async () => {
    const {
      engine,
      radioService,
      nowPlayingPublisher,
      metrics,
      prisma,
      setPersistedProgramState,
    } = createEngine({ reconciled: true, radio: true });
    const queue = [{ id: 'queue-1', itemId: 'song-2', enqueuedAt: 1 }];
    setPersistedProgramState({
      songSequence: TWO_SONG_SEQUENCE,
      songQueue: queue,
    });
    engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    engine.handleQueueUpdated('radio-1', queue);
    prisma.programState.update.mockRejectedValueOnce(new Error('db down'));
    const requestId = radioService.playSong.mock.calls[0][4];

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush(20);

    expect(radioService.playSong).toHaveBeenCalledTimes(1);
    expect(nowPlayingPublisher.publishStopped).toHaveBeenCalledTimes(1);
    expect(metrics.recordSongQueueAction).toHaveBeenCalledWith(
      'persistence-failed',
    );
  });

  it('persists duplicate enqueue requests as distinct FIFO entries', async () => {
    const { engine, getPersistedProgramState } = createEngine({
      reconciled: true,
      radio: true,
    });

    const first = await engine.enqueueSong('radio-1', 'song-2');
    const second = await engine.enqueueSong('radio-1', 'song-2');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second[0].id).not.toBe(second[1].id);
    expect(getPersistedProgramState().songQueue).toEqual(second);
  });
});

describe('similarity picker in the engine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const leaf = (n: number, artist: string) => ({
    id: `item-${n}`,
    kind: 'preset',
    songId: n,
    title: `Song ${n}`,
    artist,
    coverUrl: '',
    audioUrl: `https://example.test/${n}.mp3`,
    durationMs: 1000,
  });
  const SIM_SEQUENCE = {
    mode: 'autoplay',
    loop: true,
    intervalMs: 500,
    items: [leaf(1, 'A'), leaf(2, 'B'), leaf(3, 'C')],
  };
  const W = 30;
  const row = (songId: number, segment: string, vector: number[]) => ({
    songId,
    segment,
    windowSeconds: W,
    vector: `[${vector.join(',')}]`,
  });
  // Song 1 closes like song 3 opens; song 2 opens orthogonally; song 4 only
  // exists in the catalog and also opens like song 1 closes.
  const FULL_ROWS = [
    row(1, 'closing', [1, 0, 0]),
    row(2, 'opening', [0, 1, 0]),
    row(3, 'opening', [1, 0.1, 0]),
    row(4, 'opening', [1, 0.05, 0]),
  ];

  async function build(
    mode: string,
    rows = FULL_ROWS,
    extra: { pool?: string; threshold?: number } = {},
  ) {
    const similarityRows = {
      radioSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            similarityMode: mode,
            similarityThreshold: extra.threshold ?? 0.8,
            similarityWindowSeconds: W,
            similarityPool: extra.pool ?? 'sequence',
            programState: { programId: 'radio-1', songArtistCycle: null },
          },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue(rows),
      song: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 4,
            artist: 'D',
            title: 'Song 4',
            audioUrl: 'https://example.test/4.mp3',
            coverUrl: null,
            durationMs: 1000,
          },
        ]),
      },
      similarityDecision: { create: jest.fn().mockResolvedValue({}) },
      programState: { update: jest.fn().mockResolvedValue({}) },
    };
    const metricsStub = { recordSimilarityAction: jest.fn() };
    const similarity = new SongSimilarityService(
      similarityRows as never,
      metricsStub as never,
    );
    await similarity.onModuleInit();
    similarity.onModuleDestroy();
    const harness = createEngine({ reconciled: true, radio: true, similarity });
    harness.engine.handleSequenceUpdated('radio-1', SIM_SEQUENCE);
    harness.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    return { ...harness, similarity, similarityRows };
  }

  const playedUrls = (radioService: { playSong: jest.Mock }) =>
    radioService.playSong.mock.calls.map((call) => call[1] as string);

  async function endCurrent(
    h: Awaited<ReturnType<typeof build>>,
    callIndex: number,
  ) {
    const requestId = h.radioService.playSong.mock.calls[callIndex][4];
    h.engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: requestId },
    });
    h.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    await flush(20);
  }

  it('off: follows the cursor and never touches similarity data', async () => {
    const h = await build('off');
    await endCurrent(h, 0);
    expect(playedUrls(h.radioService).slice(0, 2)).toEqual([
      'https://example.test/1.mp3',
      'https://example.test/2.mp3',
    ]);
    expect(h.similarityRows.similarityDecision.create).not.toHaveBeenCalled();
    expect(h.similarityRows.programState.update).not.toHaveBeenCalled();
    expect(h.similarityRows.$queryRaw).not.toHaveBeenCalled();
    expect(h.metrics.recordSimilarityAction).not.toHaveBeenCalled();
  });

  it('without a similarity service the engine behaves as before', async () => {
    const h = createEngine({ reconciled: true, radio: true });
    h.engine.handleSequenceUpdated('radio-1', SIM_SEQUENCE);
    h.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    expect(playedUrls(h.radioService)).toEqual(['https://example.test/1.mp3']);
  });

  it('shadow: plays the cursor song and records the proposal beside it', async () => {
    const h = await build('shadow');
    await endCurrent(h, 0);
    expect(playedUrls(h.radioService).slice(0, 2)).toEqual([
      'https://example.test/1.mp3',
      'https://example.test/2.mp3',
    ]);
    const decisions = h.similarityRows.similarityDecision.create.mock.calls.map(
      (c: [{ data: Record<string, unknown> }]) => c[0].data,
    );
    const second = decisions.at(-1);
    expect(second).toMatchObject({
      programId: 'radio-1',
      mode: 'shadow',
      outcome: 'selected',
      currentSongId: 1,
      proposedSongId: 3,
      playedSongId: 2,
    });
    expect(h.metrics.recordSimilarityAction).toHaveBeenCalledWith(
      'shadow-recorded',
    );
  });

  it('on: plays the closest passing song and resumes the cursor after it', async () => {
    const h = await build('on');
    await endCurrent(h, 0);
    expect(playedUrls(h.radioService)[1]).toBe('https://example.test/3.mp3');
    expect(h.metrics.recordSimilarityAction).toHaveBeenCalledWith('selected');
  });

  it('on: falls back to the cursor when the current song has no embedding', async () => {
    const h = await build(
      'on',
      FULL_ROWS.filter((r) => r.segment !== 'closing'),
    );
    await endCurrent(h, 0);
    expect(playedUrls(h.radioService)[1]).toBe('https://example.test/2.mp3');
    expect(h.metrics.recordSimilarityAction).toHaveBeenCalledWith(
      'fallback-no-embedding',
    );
  });

  it('on: falls back when nothing clears the threshold', async () => {
    const h = await build('on', FULL_ROWS, { threshold: 0.9999999 });
    await endCurrent(h, 0);
    expect(playedUrls(h.radioService)[1]).toBe('https://example.test/2.mp3');
    expect(h.metrics.recordSimilarityAction).toHaveBeenCalledWith(
      'fallback-no-candidate',
    );
  });

  it('on: leaves favorites to the high-rotation quota instead of ranking them', async () => {
    const h = await build('on');
    h.engine.handleSequenceUpdated('radio-1', {
      ...SIM_SEQUENCE,
      items: [
        SIM_SEQUENCE.items[0],
        SIM_SEQUENCE.items[1],
        { ...SIM_SEQUENCE.items[2], highRotation: true },
      ],
    });
    const before = h.metrics.recordSimilarityAction.mock.calls.length;
    await endCurrent(h, 0);
    // The quota (due, empty history) airs the favorite; similarity is not asked.
    expect(h.metrics.recordHighRotationAction).toHaveBeenCalledWith('selected');
    expect(h.metrics.recordSimilarityAction.mock.calls).toHaveLength(before);
  });

  it('on + catalog pool: fills from the catalog and does not skip the cursor successor', async () => {
    // Only song 4 (catalog) opens like song 1 closes.
    const rows = [
      row(1, 'closing', [1, 0, 0]),
      row(2, 'opening', [0, 1, 0]),
      row(3, 'opening', [0, 0, 1]),
      row(4, 'opening', [1, 0.05, 0]),
    ];
    const h = await build('on', rows, { pool: 'catalog' });
    await endCurrent(h, 0);
    expect(playedUrls(h.radioService)[1]).toBe('https://example.test/4.mp3');
    await endCurrent(h, 1);
    expect(playedUrls(h.radioService)[2]).toBe('https://example.test/2.mp3');
  });

  it('on + sequence pool never leaves the playlist', async () => {
    const rows = [
      row(1, 'closing', [1, 0, 0]),
      row(2, 'opening', [0, 1, 0]),
      row(3, 'opening', [0, 0, 1]),
      row(4, 'opening', [1, 0.05, 0]),
    ];
    const h = await build('on', rows);
    await endCurrent(h, 0);
    expect(playedUrls(h.radioService)[1]).toBe('https://example.test/2.mp3');
  });

  it('records the model identity the vectors are matched against', () => {
    expect(SIMILARITY_MODEL.name).toBe('discogs-effnet-bs64-1');
  });
});

describe('SongExecutionEngine track events', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function startedEngine() {
    const harness = createEngine({ reconciled: true, radio: true });
    harness.engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    harness.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const firstCall = harness.radioService.playSong.mock.calls[0] as Parameters<
      RadioService['playSong']
    >;
    const requestId = firstCall[4] as string;
    return { ...harness, requestId };
  }

  it('emits exactly one event for each track.started and track.ended, with the pinned fields', async () => {
    const { engine, requestId } = await startedEngine();
    const events: SongEngineTrackEvent[] = [];
    engine.trackEvents$.subscribe((event) => events.push(event));

    jest.setSystemTime(new Date('2026-11-16T10:00:00.000Z'));
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: {
        playbackRequestId: requestId,
        title: 'Song one',
        artist: 'Artist one',
        coverUrl: 'https://example.test/song-1.jpg',
        url: 'https://example.test/song-1.mp3',
      },
    });
    expect(events).toEqual([
      {
        programId: 'radio-1',
        type: 'track.started',
        playbackRequestId: requestId,
        title: 'Song one',
        artist: 'Artist one',
        url: 'https://example.test/song-1.mp3',
        at: new Date('2026-11-16T10:00:00.000Z'),
      },
    ]);

    jest.setSystemTime(new Date('2026-11-16T10:03:00.000Z'));
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId, title: null },
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      programId: 'radio-1',
      type: 'track.ended',
      playbackRequestId: requestId,
      title: null,
      artist: null,
      url: null,
      at: new Date('2026-11-16T10:03:00.000Z'),
    });
  });

  it('emits a duplicate track.ended for the same request exactly once in total', async () => {
    const { engine, metrics, requestId } = await startedEngine();
    const events: SongEngineTrackEvent[] = [];
    engine.trackEvents$.subscribe((event) => events.push(event));

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: requestId },
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });

    expect(metrics.recordTrackTransition).toHaveBeenCalledWith(
      'ignored-duplicate',
    );
    expect(
      events.map((event) => [event.type, event.playbackRequestId]),
    ).toEqual([
      ['track.started', requestId],
      ['track.ended', requestId],
    ]);
  });

  it('emits no start for a command a manual song already replaced, and records the manual song as usual', async () => {
    const { engine, metrics, radioService, requestId } = await startedEngine();
    // A manual song takes over before Palazzo confirms the first command.
    engine.handleManualSong(
      'radio-1',
      'https://example.test/manual.mp3',
      'Manual',
      'Artist',
      120_000,
    );
    await flush();
    const manualCall = radioService.playSong.mock.calls[1] as Parameters<
      RadioService['playSong']
    >;
    const manualRequestId = manualCall[4] as string;
    const events: SongEngineTrackEvent[] = [];
    engine.trackEvents$.subscribe((event) => events.push(event));

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: requestId },
    });
    expect(metrics.recordTrackTransition).toHaveBeenCalledWith('adopted');
    expect(events).toEqual([]);

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: manualRequestId },
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: manualRequestId },
    });
    expect(
      events.map((event) => [event.type, event.playbackRequestId]),
    ).toEqual([
      ['track.started', manualRequestId],
      ['track.ended', manualRequestId],
    ]);
  });

  it('emits an inferred end at the advance time when an idle snapshot ends the song, and ignores the late real end', async () => {
    const { engine, metrics, requestId } = await startedEngine();
    const events: SongEngineTrackEvent[] = [];
    engine.trackEvents$.subscribe((event) => events.push(event));

    jest.setSystemTime(new Date('2026-11-16T10:00:00.000Z'));
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: requestId },
    });
    // The track.ended never arrives; Palazzo later reports idle.
    jest.setSystemTime(new Date('2026-11-16T10:03:10.000Z'));
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 2),
    );
    expect(metrics.recordTrackTransition).toHaveBeenCalledWith('advanced');
    expect(events[1]).toEqual({
      programId: 'radio-1',
      type: 'track.ended',
      playbackRequestId: requestId,
      title: 'Song one',
      artist: 'Artist one',
      url: 'https://example.test/song-1.mp3',
      at: new Date('2026-11-16T10:03:10.000Z'),
      inferred: true,
    });

    jest.setSystemTime(new Date('2026-11-16T10:03:20.000Z'));
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });
    expect(metrics.recordTrackTransition).toHaveBeenCalledWith(
      'ignored-duplicate',
    );
    expect(events.map((event) => event.type)).toEqual([
      'track.started',
      'track.ended',
    ]);
  });

  it('emits nothing for transitions the engine ignores', async () => {
    const { engine, metrics, requestId } = await startedEngine();
    const events: SongEngineTrackEvent[] = [];
    engine.trackEvents$.subscribe((event) => events.push(event));

    // Mismatched start.
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: 'foreign-request' },
    });
    // End without a request id.
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: '' },
    });
    // End for a request that is not the active song.
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'foreign-request' },
    });
    // End while frozen.
    engine.handlePalazzoStatus('radio-1', {
      programId: 'radio-1',
      programType: 'radio',
      palazzoUrl: 'http://palazzo:3100',
      instanceId: 'palazzo-a',
      connection: 'unavailable',
      lastEventAt: null,
      lastSnapshotAt: null,
      degraded: true,
      detail: 'sse and state endpoint unreachable',
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });

    for (const outcome of [
      'ignored-mismatch',
      'ignored-no-active',
      'ignored-frozen',
    ]) {
      expect(metrics.recordTrackTransition).toHaveBeenCalledWith(outcome);
    }
    expect(events).toEqual([]);
  });

  it('emits nothing for a track.ended when no song is active', async () => {
    const { engine, metrics } = createEngine({ reconciled: true, radio: true });
    engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('palazzo-a', 'boot-1', 1),
    );
    await flush();
    const events: SongEngineTrackEvent[] = [];
    engine.trackEvents$.subscribe((event) => events.push(event));

    engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'some-request' },
    });

    expect(engine.getPlaybackState('radio-1')).toBeNull();
    expect(metrics.recordTrackTransition).toHaveBeenCalledWith(
      'ignored-no-active',
    );
    expect(events).toEqual([]);
  });

  it('emits nothing for playback.position, audio levels, intro events or unhandled programs', async () => {
    const { engine, requestId } = await startedEngine();
    const events: SongEngineTrackEvent[] = [];
    engine.trackEvents$.subscribe((event) => events.push(event));

    engine.handlePalazzoEvent('radio-1', {
      type: 'playback.position',
      data: { playbackRequestId: requestId, positionSeconds: 5 },
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'audio.levels',
      data: {
        song: { rms: 0, peak: 0 },
        instant: { rms: 0, peak: 0 },
        output: { rms: 0, peak: 0 },
      },
    });
    engine.handlePalazzoEvent('radio-1', {
      type: 'intro.started',
      data: {
        programId: 'radio-1',
        playbackId: `${requestId}:intro`,
        parentPlaybackId: requestId,
      },
    });
    // Not a registered radio program, and a radio program with no state yet.
    engine.handlePalazzoEvent('tv-1', {
      type: 'track.started',
      data: { playbackRequestId: requestId },
    });
    engine.registerRadioProgram('radio-2');
    engine.handlePalazzoEvent('radio-2', {
      type: 'track.ended',
      data: { playbackRequestId: requestId },
    });

    expect(events).toEqual([]);
  });

  it('keeps handling this event and the next one when a subscriber throws', async () => {
    const previous = rxjsConfig.onUnhandledError;
    const unhandled = jest.fn();
    rxjsConfig.onUnhandledError = unhandled;
    try {
      const { engine, radioService, flightService, metrics, requestId } =
        await startedEngine();
      const received: SongEngineTrackEvent[] = [];
      engine.trackEvents$.subscribe(() => {
        throw new Error('subscriber failed');
      });
      engine.trackEvents$.subscribe((event) => received.push(event));

      expect(() =>
        engine.handlePalazzoEvent('radio-1', {
          type: 'track.started',
          data: { playbackRequestId: requestId },
        }),
      ).not.toThrow();
      expect(engine.getPlaybackState('radio-1')).toMatchObject({
        isPlaying: true,
        audioUrl: 'https://example.test/song-1.mp3',
      });

      expect(() =>
        engine.handlePalazzoEvent('radio-1', {
          type: 'track.ended',
          data: { playbackRequestId: requestId },
        }),
      ).not.toThrow();
      expect(metrics.recordTrackTransition).toHaveBeenCalledWith('adopted');
      expect(metrics.recordTrackTransition).toHaveBeenCalledWith('advanced');
      await flush(12);
      expect(flightService.handleSongEnded).toHaveBeenCalledTimes(1);
      expect(radioService.playSong).toHaveBeenCalledTimes(2);
      expect(received.map((event) => event.type)).toEqual([
        'track.started',
        'track.ended',
      ]);
      jest.runOnlyPendingTimers();
      expect(unhandled).toHaveBeenCalledWith(new Error('subscriber failed'));
    } finally {
      rxjsConfig.onUnhandledError = previous;
    }
  });

  it('catches a subscriber error that RxJS rethrows synchronously', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    rxjsConfig.useDeprecatedSynchronousErrorHandling = true;
    try {
      const { engine, requestId } = await startedEngine();
      engine.trackEvents$.subscribe(() => {
        throw new Error('subscriber failed');
      });

      expect(() =>
        engine.handlePalazzoEvent('radio-1', {
          type: 'track.started',
          data: { playbackRequestId: requestId },
        }),
      ).not.toThrow();
      expect(engine.getPlaybackState('radio-1')).toMatchObject({
        isPlaying: true,
        audioUrl: 'https://example.test/song-1.mp3',
      });
    } finally {
      rxjsConfig.useDeprecatedSynchronousErrorHandling = false;
      warn.mockRestore();
    }
  });

  it('adds no awaited work: handling returns before a subscriber settles', async () => {
    const { engine, requestId } = await startedEngine();
    let settled = false;
    const pending = new Promise<void>(() => {});
    engine.trackEvents$.subscribe(() => {
      void pending.then(() => {
        settled = true;
      });
    });

    const result = engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: requestId },
    }) as unknown;
    expect(result).toBeUndefined();
    await Promise.resolve(result);
    expect(engine.getPlaybackState('radio-1')).toMatchObject({
      isPlaying: true,
    });
    expect(settled).toBe(false);
  });
});
