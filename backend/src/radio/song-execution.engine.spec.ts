import { SongExecutionEngine } from './song-execution.engine';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { RadioMetricsService } from './radio-metrics.service';
import type { PalazzoPlaybackState } from './palazzo-contract';

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
      coverUrl: null,
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
}) {
  let currentProgramState = {
    programId: opts.tv ? 'tv-1' : 'radio-1',
    type: opts.tv ? 'tv' : 'radio',
    songSequence: TWO_SONG_SEQUENCE as unknown,
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
  const engine = new SongExecutionEngine(
    radioService as unknown as RadioService,
    flightService as unknown as FlightService,
    prisma as unknown as PrismaService,
    nowPlayingPublisher as unknown as NowPlayingPublisherService,
    metrics as unknown as RadioMetricsService,
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
    const firstRequestId = firstCall[4]!;
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
    const normalRequestId = normalCall[4]!;
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
    const secondRequestId = secondCall[4]!;
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

describe('SongExecutionEngine queue persistence and restart boundaries', () => {
  const engines: SongExecutionEngine[] = [];
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')),
  );
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.onModuleDestroy();
    jest.useRealTimers();
  });
  function fixture(
    options: { reconciled: boolean; radio?: boolean; tv?: boolean } = {
      reconciled: true,
      radio: true,
    },
  ) {
    const f = createEngine(options);
    engines.push(f.engine);
    return f;
  }
  const queued = (id: string, active = false) => ({
    id,
    itemId: 'song-2',
    enqueuedAt: Date.now(),
    ...(active ? { active: true, playbackRequestId: 'active-request' } : {}),
  });

  it('loads enabled radio/simulcast programs at restart without commanding audio before an authoritative snapshot', async () => {
    const f = fixture({ reconciled: true });
    f.prisma.radioSettings.findMany.mockResolvedValue([
      {
        palazzoUrl: '',
        programState: { programId: 'missing-url', type: 'radio' },
      },
      {
        palazzoUrl: 'https://radio.example',
        programState: { programId: 'television', type: 'tv' },
      },
      {
        palazzoUrl: 'https://radio.example',
        programState: {
          programId: 'manual',
          type: 'radio',
          songSequence: { ...SEQUENCE, mode: 'manual' },
          songQueue: [],
          songRotation: null,
        },
      },
      {
        palazzoUrl: 'https://radio.example',
        programState: {
          programId: 'empty',
          type: 'both',
          songSequence: null,
          songQueue: [],
          songRotation: null,
        },
      },
      {
        palazzoUrl: 'https://radio.example',
        programState: {
          programId: 'radio-1',
          type: 'both',
          songSequence: TWO_SONG_SEQUENCE,
          songQueue: [],
          songRotation: null,
        },
      },
    ]);
    await f.engine.onModuleInit();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    f.engine.handlePalazzoSnapshot(
      'manual',
      idleSnapshot('instance', 'boot', 1),
    );
    f.engine.handlePalazzoSnapshot(
      'empty',
      idleSnapshot('instance', 'boot', 1),
    );
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 1),
    );
    await flush(20);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(f.radioService.playSong.mock.calls[0][0]).toBe('radio-1');
  });

  it('releases progress and duration timers during shutdown', async () => {
    const f = fixture({ reconciled: false, tv: true });
    f.engine.handleManualSong(
      'tv-1',
      'https://example.test/manual.mp3',
      undefined,
      undefined,
      undefined,
    );
    await flush();
    expect(f.engine.getPlaybackState('tv-1')).toMatchObject({
      title: '',
      artist: '',
      durationMs: 300000,
    });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    f.engine.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects blank, unknown and ambiguous playlist identities before persisting a queue', async () => {
    const f = fixture();
    await expect(f.engine.enqueueSong('radio-1', ' ')).rejects.toThrow(
      'itemId is required',
    );
    await expect(f.engine.enqueueSong('radio-1', 'missing')).rejects.toThrow(
      'one playable playlist item',
    );
    f.setPersistedProgramState({
      songSequence: {
        ...SEQUENCE,
        items: [SEQUENCE.items[0], SEQUENCE.items[0]],
      },
    });
    await expect(f.engine.enqueueSong('radio-1', 'song-1')).rejects.toThrow(
      'one playable playlist item',
    );
    expect(f.prisma.programState.update).not.toHaveBeenCalled();
    expect(f.metrics.recordSongQueueAction).toHaveBeenLastCalledWith(
      'rejected',
    );
  });

  it('rejects missing and TV-only programs before changing queue state', async () => {
    const f = fixture({ reconciled: true, tv: true });
    await expect(f.engine.enqueueSong('tv-1', 'song-1')).rejects.toThrow(
      'only for Radio and Simulcast',
    );
    f.prisma.programState.findUnique.mockResolvedValueOnce(null);
    await expect(f.engine.enqueueSong('missing', 'song-1')).rejects.toThrow(
      'Program not found',
    );
    expect(f.prisma.programState.update).not.toHaveBeenCalled();
  });

  it('enforces the complete persisted queue length before accepting another FIFO entry', async () => {
    const f = fixture();
    f.setPersistedProgramState({
      songQueue: Array.from({ length: 100 }, (_, index) =>
        queued(`entry-${index}`),
      ),
    });
    await expect(f.engine.enqueueSong('radio-1', 'song-1')).rejects.toThrow(
      'limited to 100 entries',
    );
    expect(f.prisma.programState.update).not.toHaveBeenCalled();
  });

  it('removes only a pending entry and publishes the committed FIFO state', async () => {
    const f = fixture();
    const broadcast = jest.fn();
    f.engine.setBroadcastHandler(broadcast);
    f.setPersistedProgramState({
      songQueue: [queued('first'), queued('second')],
    });
    expect(await f.engine.removeQueuedSong('radio-1', ' first ')).toEqual([
      queued('second'),
    ]);
    expect(f.getPersistedProgramState().songQueue).toEqual([queued('second')]);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'song_queue_update',
      programId: 'radio-1',
      songQueue: [queued('second')],
    });
    expect(f.metrics.recordSongQueueAction).toHaveBeenLastCalledWith('removed');
  });

  it('refuses blank, missing and playing queue removals while preserving existing entries', async () => {
    const f = fixture();
    const entries = [queued('playing', true), queued('pending')];
    f.setPersistedProgramState({ songQueue: entries });
    await expect(f.engine.removeQueuedSong('radio-1', ' ')).rejects.toThrow(
      'queue entry ID is required',
    );
    await expect(
      f.engine.removeQueuedSong('radio-1', 'unknown'),
    ).rejects.toThrow('Queued song not found');
    await expect(
      f.engine.removeQueuedSong('radio-1', 'playing'),
    ).rejects.toThrow('playing queue entry cannot be removed');
    expect(f.getPersistedProgramState().songQueue).toEqual(entries);
    expect(f.prisma.programState.update).not.toHaveBeenCalled();
  });

  it.each(
    [
      undefined,
      'first',
      [7],
      [''],
      ['first', 'first'],
      ['first'],
      ['first', 'foreign'],
    ].map((value) => [value] as const),
  )(
    'rejects malformed or incomplete queue reorder requests atomically: %p',
    async (entryIds) => {
      const f = fixture();
      f.setPersistedProgramState({
        songQueue: [queued('first'), queued('second')],
      });
      await expect(
        f.engine.reorderSongQueue('radio-1', entryIds as any),
      ).rejects.toThrow();
      expect(f.prisma.programState.update).not.toHaveBeenCalled();
      expect(f.metrics.recordSongQueueAction).toHaveBeenLastCalledWith(
        'rejected',
      );
    },
  );

  it('reorders every pending entry exactly once after the currently playing head', async () => {
    const f = fixture();
    f.setPersistedProgramState({
      songQueue: [queued('playing', true), queued('first'), queued('second')],
    });
    await expect(
      f.engine.reorderSongQueue('radio-1', ['first', 'playing', 'second']),
    ).rejects.toThrow('playing queue entry must remain first');
    const result = await f.engine.reorderSongQueue('radio-1', [
      ' playing ',
      'second',
      'first',
    ]);
    expect(result.map((entry) => entry.id)).toEqual([
      'playing',
      'second',
      'first',
    ]);
    expect(result[0]).toMatchObject({
      active: true,
      playbackRequestId: 'active-request',
    });
    expect(f.getPersistedProgramState().songQueue).toEqual(result);
    expect(f.metrics.recordSongQueueAction).toHaveBeenLastCalledWith(
      'reordered',
    );
  });

  it.each(['enqueue', 'remove', 'reorder'] as const)(
    'keeps %s storage failures visible and releases the serial gate for the next accepted edit',
    async (action) => {
      const f = fixture();
      f.setPersistedProgramState({ songQueue: [queued('first')] });
      const outage = new Error('queue persistence unavailable');
      f.prisma.programState.update.mockRejectedValueOnce(outage);
      const operation =
        action === 'enqueue'
          ? f.engine.enqueueSong('radio-1', 'song-1')
          : action === 'remove'
            ? f.engine.removeQueuedSong('radio-1', 'first')
            : f.engine.reorderSongQueue('radio-1', ['first']);
      await expect(operation).rejects.toBe(outage);
      expect(f.metrics.recordSongQueueAction).toHaveBeenLastCalledWith(
        'persistence-failed',
      );
      expect(await f.engine.enqueueSong('radio-1', 'song-2')).toHaveLength(2);
    },
  );

  it('serializes concurrent FIFO edits so a later enqueue cannot restore an already removed entry', async () => {
    const f = fixture();
    f.setPersistedProgramState({ songQueue: [queued('first')] });
    const [removed, appended] = await Promise.all([
      f.engine.removeQueuedSong('radio-1', 'first'),
      f.engine.enqueueSong('radio-1', 'song-2'),
    ]);
    expect(removed).toEqual([]);
    expect(appended).toHaveLength(1);
    expect(appended[0].id).not.toBe('first');
    expect(f.getPersistedProgramState().songQueue).toEqual(appended);
  });

  it('ignores foreign position events and applies matching authoritative position/remaining values', async () => {
    const f = fixture();
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'playback.position',
      data: { positionSeconds: 1 },
    });
    f.engine.handleManualSong(
      'radio-1',
      'https://example.test/manual.mp3',
      'Manual',
      'Artist',
      30000,
    );
    await flush();
    const requestId = f.radioService.playSong.mock.calls[0][4];
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: {
        playbackRequestId: requestId,
        coverUrl: 'https://example.test/cover.jpg',
      },
    });
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'playback.position',
      data: { playbackRequestId: 'foreign', positionSeconds: 20 },
    });
    expect(f.engine.getPlaybackState('radio-1')?.positionMs).toBe(0);
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'playback.position',
      data: {
        playbackRequestId: requestId,
        positionSeconds: 2,
        remainingSeconds: 8,
      },
    });
    expect(f.engine.getPlaybackState('radio-1')).toMatchObject({
      positionMs: 2000,
      durationMs: 10000,
      coverUrl: 'https://example.test/cover.jpg',
      telemetryStale: false,
    });
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'playback.position',
      data: {
        playbackRequestId: requestId,
        positionSeconds: -1,
        remainingSeconds: -1,
      },
    });
    expect(f.engine.getPlaybackState('radio-1')?.positionMs).toBe(2000);
    await jest.advanceTimersByTimeAsync(16000);
    expect(f.engine.getPlaybackState('radio-1')?.telemetryStale).toBe(true);
  });

  it('publishes explicit stop even when no local runtime exists and forwards estimated renderer end only to Flight', async () => {
    const f = fixture();
    f.engine.handleStopSong('unseen');
    f.engine.handleSongEnded('radio-1');
    expect(f.nowPlayingPublisher.publishStopped).toHaveBeenCalledWith('unseen');
    expect(f.flightService.handleSongEnded).toHaveBeenCalledWith('radio-1');
    expect(f.radioService.playSong).not.toHaveBeenCalled();
  });
});

describe('SongExecutionEngine intro degradation and station bumper boundaries', () => {
  const engines: SongExecutionEngine[] = [];
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')),
  );
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  function fixture() {
    const f = createEngine({ reconciled: true, radio: true });
    engines.push(f.engine);
    return f;
  }
  async function started() {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 1),
    );
    await flush(20);
    return f;
  }
  function endCurrent(f: ReturnType<typeof fixture>) {
    const call = f.radioService.playSong.mock.calls.at(-1)!;
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: call[4] },
    });
  }

  it.each([
    null,
    { enabled: false, audioUrl: 'https://media.test/voice.mp3' },
    { enabled: true, audioUrl: ' ' },
  ])(
    'plays the main song with visible degradation when a cue voice clip is unavailable: %p',
    async (clip) => {
      const f = fixture();
      f.prisma.instant.findUnique.mockResolvedValue(clip as any);
      f.engine.handleManualSong(
        'radio-1',
        'https://media.test/song.mp3',
        'Main',
        'Artist',
        30000,
        undefined,
        undefined,
        { instantId: 3 },
      );
      await flush();
      expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
      expect(f.engine.getPlaybackState('radio-1')).toMatchObject({
        introStatus: 'degraded',
        introFailureReason: 'Voice track is unavailable',
      });
      expect(f.metrics.recordIntroTransition).toHaveBeenCalledWith('failed');
    },
  );

  it.each([
    {
      programId: 'other',
      instant: {
        enabled: true,
        audioUrl: 'https://media.test/intro.mp3',
        volume: 1,
      },
      reason: 'Assigned intro belongs to another program',
    },
    {
      programId: 'radio-1',
      instant: {
        enabled: false,
        audioUrl: 'https://media.test/intro.mp3',
        volume: 1,
      },
      reason: 'Assigned intro is unavailable',
    },
    {
      programId: 'radio-1',
      instant: { enabled: true, audioUrl: ' ', volume: 1 },
      reason: 'Assigned intro is unavailable',
    },
  ])(
    'keeps the main song alive when its catalog intro fails program/availability checks: %p',
    async ({ reason, ...assignment }) => {
      const f = fixture();
      f.prisma.songIntro.findUnique.mockResolvedValue(assignment as any);
      f.engine.handleManualSong(
        'radio-1',
        'https://media.test/song.mp3',
        'Main',
        'Artist',
        30000,
        undefined,
        101,
      );
      await flush();
      expect(f.engine.getPlaybackState('radio-1')).toMatchObject({
        introStatus: 'degraded',
        introFailureReason: reason,
      });
      expect(f.radioService.playSong.mock.calls[0][6]).toBeUndefined();
    },
  );

  it('keeps intro lookup failure visible while still sending the main playback command', async () => {
    const f = fixture();
    f.prisma.songIntro.findUnique.mockRejectedValue(
      new Error('catalog unavailable'),
    );
    f.engine.handleManualSong(
      'radio-1',
      'https://media.test/song.mp3',
      'Main',
      'Artist',
      30000,
      undefined,
      101,
    );
    await flush();
    expect(f.engine.getPlaybackState('radio-1')).toMatchObject({
      introStatus: 'degraded',
      introFailureReason: 'Intro assignment lookup failed',
    });
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it('does not send a delayed intro lookup command after the operator has already stopped its song', async () => {
    const f = fixture();
    let resolveIntro!: (value: any) => void;
    f.prisma.songIntro.findUnique.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIntro = resolve;
        }),
    );
    f.engine.handleManualSong(
      'radio-1',
      'https://media.test/song.mp3',
      'Main',
      'Artist',
      30000,
      undefined,
      101,
    );
    f.engine.handleStopSong('radio-1');
    resolveIntro({
      programId: 'radio-1',
      instant: {
        enabled: true,
        audioUrl: 'https://media.test/intro.mp3',
        volume: 1,
      },
    });
    await flush();
    expect(f.engine.getPlaybackState('radio-1')).toBeNull();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
  });

  it('requires acknowledgement of the exact submitted intro and adopts the downstream authoritative song id', async () => {
    const f = fixture();
    f.prisma.instant.findUnique.mockResolvedValue({
      enabled: true,
      audioUrl: 'https://media.test/intro.mp3',
      volume: 0.5,
    } as any);
    f.radioService.playSong.mockResolvedValue({
      ok: true,
      playbackRequestId: 'appliance-authoritative',
      introPlaybackId: 'different-intro',
    } as any);
    f.engine.handleManualSong(
      'radio-1',
      'https://media.test/song.mp3',
      'Main',
      'Artist',
      30000,
      undefined,
      undefined,
      { instantId: 3 },
    );
    await flush();
    expect(f.engine.getPlaybackState('radio-1')).toMatchObject({
      introStatus: 'degraded',
      introFailureReason: 'Palazzo did not accept the assigned intro',
    });
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'appliance-authoritative' },
    });
    await flush();
    expect(f.engine.getPlaybackState('radio-1')).toBeNull();
    expect(f.metrics.recordTrackTransition).toHaveBeenCalledWith('advanced');
  });

  it('clears optimistic playback when a real command rejects rather than leaving a phantom on-air song', async () => {
    const f = fixture();
    f.radioService.playSong.mockRejectedValue(
      new Error('executor unavailable'),
    );
    f.engine.handleManualSong('radio-1', 'https://media.test/song.mp3');
    await flush();
    expect(f.engine.getPlaybackState('radio-1')).toBeNull();
    expect(f.nowPlayingPublisher.publishStopped).toHaveBeenCalledWith(
      'radio-1',
    );
  });

  it('bounds intro failures, rejects foreign bindings and allows later confirmed intro completion', async () => {
    const f = fixture();
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'intro.started',
      data: {
        programId: 'radio-1',
        playbackId: 'intro',
        parentPlaybackId: 'missing',
      },
    });
    f.engine.handleManualSong('radio-1', 'https://media.test/song.mp3');
    await flush();
    const parentPlaybackId = f.radioService.playSong.mock.calls[0][4];
    const data = {
      programId: 'radio-1',
      playbackId: 'intro',
      parentPlaybackId,
    };
    for (const foreign of [
      { ...data, programId: 'other' },
      { ...data, parentPlaybackId: 'other' },
    ])
      f.engine.handlePalazzoEvent('radio-1', {
        type: 'intro.started',
        data: foreign,
      });
    expect(f.engine.getPlaybackState('radio-1')?.introStatus).toBe('none');
    f.engine.handlePalazzoEvent('radio-1', { type: 'intro.started', data });
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'intro.failed',
      data: { ...data, playbackId: 'other', failureReason: 'foreign' },
    });
    expect(f.engine.getPlaybackState('radio-1')?.introStatus).toBe('playing');
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'intro.failed',
      data: { ...data, failureReason: 'x'.repeat(500) },
    });
    expect(
      f.engine.getPlaybackState('radio-1')?.introFailureReason,
    ).toHaveLength(200);
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'intro.failed',
      data: { ...data, failureReason: ' ' },
    });
    expect(f.engine.getPlaybackState('radio-1')?.introFailureReason).toBe(
      'Intro playback failed',
    );
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'intro.failed',
      data: { ...data, reason: 'Legacy failure' },
    });
    expect(f.engine.getPlaybackState('radio-1')?.introFailureReason).toBe(
      'Legacy failure',
    );
    f.engine.handlePalazzoEvent('radio-1', { type: 'intro.ended', data });
    expect(f.engine.getPlaybackState('radio-1')).toMatchObject({
      introStatus: 'completed',
      introFailureReason: null,
    });
  });

  it('plays sequential station bumpers between songs and waits the actual bumper interval before the next song', async () => {
    const f = await started();
    f.radioService.getRadioSettings.mockResolvedValue({
      bumperEnabled: true,
      bumperInterval: 1,
      bumperInstantIds: [11, 12],
      bumperMode: 'sequential',
    } as any);
    f.prisma.instant.findUnique.mockImplementation(
      async ({ where }) =>
        ({
          audioUrl: `https://media.test/${where.id}.mp3`,
          name: 'Station ident',
        }) as any,
    );
    endCurrent(f);
    await flush(20);
    expect(f.radioService.playInstant.mock.calls[0][1]).toBe(
      'https://media.test/11.mp3',
    );
    await jest.advanceTimersByTimeAsync(7999);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
    endCurrent(f);
    await flush(20);
    expect(f.radioService.playInstant.mock.calls[1][1]).toBe(
      'https://media.test/12.mp3',
    );
    await jest.advanceTimersByTimeAsync(8000);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(3);
  });

  it('selects the configured random bumper and continues normally when the bumper executor fails', async () => {
    const f = await started();
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    f.radioService.getRadioSettings.mockResolvedValue({
      bumperEnabled: true,
      bumperInterval: 1,
      bumperInstantIds: [11, 12],
      bumperMode: 'random',
    } as any);
    f.prisma.instant.findUnique.mockResolvedValue({
      audioUrl: 'https://media.test/ident.mp3',
      name: 'Ident',
    } as any);
    f.radioService.playInstant.mockRejectedValue(
      new Error('ident unavailable'),
    );
    endCurrent(f);
    await flush(20);
    expect(f.prisma.instant.findUnique).toHaveBeenCalledWith({
      where: { id: 12 },
    });
    expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
  });

  it.each([
    { bumperEnabled: false, bumperInterval: 1, bumperInstantIds: [11] },
    { bumperEnabled: true, bumperInterval: 0, bumperInstantIds: [11] },
    { bumperEnabled: true, bumperInterval: 1, bumperInstantIds: [] },
    { bumperEnabled: true, bumperInterval: 2, bumperInstantIds: [11] },
  ])(
    'does not invent a station bumper when its configuration/cadence does not call for one: %p',
    async (settings) => {
      const f = await started();
      f.radioService.getRadioSettings.mockResolvedValue(settings as any);
      endCurrent(f);
      await flush(20);
      expect(f.radioService.playInstant).not.toHaveBeenCalled();
      expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
    },
  );

  it('continues after a missing bumper clip or a settings lookup failure', async () => {
    const f = await started();
    f.radioService.getRadioSettings.mockResolvedValue({
      bumperEnabled: true,
      bumperInterval: 1,
      bumperInstantIds: [11],
    } as any);
    endCurrent(f);
    await flush(20);
    expect(f.radioService.playInstant).not.toHaveBeenCalled();
    expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
    f.radioService.getRadioSettings.mockRejectedValue(
      new Error('settings unavailable'),
    );
    endCurrent(f);
    await flush(20);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(3);
  });
});

describe('SongExecutionEngine concurrent queue claims and appliance reconciliation', () => {
  const engines: SongExecutionEngine[] = [];
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')),
  );
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.onModuleDestroy();
    jest.useRealTimers();
  });
  function fixture() {
    const f = createEngine({ reconciled: true, radio: true });
    engines.push(f.engine);
    return f;
  }
  const queueEntry = (id: string, itemId = 'song-2') => ({
    id,
    itemId,
    enqueuedAt: Date.now(),
  });
  async function reconcile(f: ReturnType<typeof fixture>) {
    f.engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 1),
    );
    await flush(30);
  }

  it.each([
    { replacement: [] },
    { replacement: [{ id: 'replacement', itemId: 'song-2', enqueuedAt: 1 }] },
  ])(
    're-reads a concurrently removed/replaced cached queue head before claiming it: %p',
    async ({ replacement }) => {
      const f = fixture();
      f.engine.handleQueueUpdated('radio-1', [queueEntry('old-head')]);
      f.setPersistedProgramState({ songQueue: replacement });
      await reconcile(f);
      expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
      expect(f.engine.getPlaybackState('radio-1')?.queueEntryId).toBe(
        replacement.length ? 'replacement' : null,
      );
      expect(f.metrics.recordSongQueueAction).not.toHaveBeenCalledWith(
        'persistence-failed',
      );
    },
  );

  it('reuses an already persisted active claim rather than issuing a second fresh queue identity', async () => {
    const f = fixture();
    const cached = queueEntry('head');
    f.engine.handleQueueUpdated('radio-1', [cached]);
    f.setPersistedProgramState({
      songQueue: [
        { ...cached, active: true, playbackRequestId: 'persisted-request' },
      ],
    });
    await reconcile(f);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(f.radioService.playSong.mock.calls[0][4]).toBe('persisted-request');
  });

  it('stops and releases a claimed queue entry whose playlist target no longer exists without playing an unrelated fallback', async () => {
    const f = fixture();
    const entry = queueEntry('orphan', 'removed-song');
    f.setPersistedProgramState({ songQueue: [entry] });
    f.engine.handleQueueUpdated('radio-1', [entry]);
    await reconcile(f);
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    expect(f.nowPlayingPublisher.publishStopped).toHaveBeenCalledWith(
      'radio-1',
    );
    expect(f.getPersistedProgramState().songQueue).toEqual([entry]);
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 2),
    );
    await flush(20);
    expect(f.radioService.playSong).not.toHaveBeenCalled();
  });

  it('does not issue a claimed queued song when a scheduled log acquired ownership during the database read', async () => {
    const f = fixture();
    const entry = queueEntry('head');
    f.setPersistedProgramState({ songQueue: [entry] });
    f.engine.handleQueueUpdated('radio-1', [entry]);
    let releaseRead!: (value: any) => void;
    f.prisma.programState.findUnique.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    );
    f.engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 1),
    );
    await flush();
    f.flightService.isClockedLogRunning.mockReturnValue(true);
    releaseRead(f.getPersistedProgramState());
    await flush(30);
    expect(f.radioService.playSong).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'handles stop-time queue claim disappearance/storage failure without consuming another entry: failure=%p',
    async (failure) => {
      const f = fixture();
      const active = {
        ...queueEntry('head'),
        active: true,
        playbackRequestId: 'active-request',
      };
      f.setPersistedProgramState({ songQueue: [active] });
      f.engine.handleQueueUpdated('radio-1', [active]);
      f.engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
      f.engine.handlePalazzoSnapshot(
        'radio-1',
        playingSnapshot(
          'instance',
          'boot',
          1,
          'active-request',
          'https://example.test/song-2.mp3',
        ),
      );
      if (failure)
        f.prisma.programState.update.mockRejectedValueOnce(
          new Error('release storage failure'),
        );
      else f.setPersistedProgramState({ songQueue: [] });
      f.engine.handleStopSong('radio-1');
      await flush(30);
      expect(f.engine.getPlaybackState('radio-1')).toBeNull();
      if (failure)
        expect(f.metrics.recordSongQueueAction).toHaveBeenCalledWith(
          'persistence-failed',
        );
      else expect(f.getPersistedProgramState().songQueue).toEqual([]);
      expect(f.metrics.recordSongQueueAction).not.toHaveBeenCalledWith(
        'consumed',
      );
    },
  );

  it('preserves a newer manual song when an older pending command confirms or rejects later', async () => {
    const f = fixture();
    let finishOld!: (result: any) => void;
    f.radioService.playSong.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    f.engine.handleManualSong('radio-1', 'https://media.test/old.mp3', 'Old');
    await flush();
    const oldRequest = f.radioService.playSong.mock.calls[0][4];
    f.engine.handleManualSong('radio-1', 'https://media.test/new.mp3', 'New');
    await flush();
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: oldRequest },
    });
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(
        'instance',
        'boot',
        2,
        oldRequest,
        'https://media.test/old.mp3',
      ),
    );
    finishOld({ ok: false });
    await flush();
    expect(f.engine.getPlaybackState('radio-1')?.title).toBe('New');
    expect(f.nowPlayingPublisher.publishStopped).not.toHaveBeenCalled();
  });

  it('withholds automation for a foreign track until its real end and a fresh idle reconciliation', async () => {
    const f = fixture();
    f.engine.handleSequenceUpdated('radio-1', TWO_SONG_SEQUENCE);
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      playingSnapshot(
        'instance',
        'boot',
        1,
        'foreign',
        'https://foreign.test/unrelated.mp3',
      ),
    );
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: '' },
    });
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: 'foreign' },
    });
    await flush();
    expect(f.radioService.playSong).not.toHaveBeenCalled();
    expect(f.metrics.recordTrackTransition).toHaveBeenCalledWith(
      'ignored-mismatch',
    );
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 2),
    );
    await flush();
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
  });

  it.each(['playing', 'failed'] as const)(
    'reconciles real matching intro snapshot status %s and fills a previously absent cover',
    async (status) => {
      const f = fixture();
      f.engine.handleManualSong(
        'radio-1',
        'https://media.test/song.mp3',
        'Main',
      );
      await flush();
      const request = f.radioService.playSong.mock.calls[0][4];
      const snapshot = playingSnapshot(
        'instance',
        'boot',
        1,
        request,
        'https://media.test/song.mp3',
      );
      snapshot.track!.coverUrl = 'https://media.test/cover.jpg';
      snapshot.intro = {
        playbackId: 'intro',
        parentPlaybackId: request,
        programId: 'radio-1',
        playbackRequestId: 'intro',
        url: 'https://media.test/intro.mp3',
        startedAt: new Date().toISOString(),
        status,
        failureReason:
          status === 'failed' ? '  Appliance intro failure  ' : undefined,
      };
      f.engine.handlePalazzoSnapshot('radio-1', snapshot);
      expect(f.engine.getPlaybackState('radio-1')).toMatchObject({
        introStatus: status === 'playing' ? 'playing' : 'degraded',
        introFailureReason:
          status === 'failed' ? 'Appliance intro failure' : null,
        coverUrl: 'https://media.test/cover.jpg',
      });
    },
  );

  it('treats an authoritative idle snapshot as a missed lifecycle end and advances exactly once', async () => {
    const f = fixture();
    await reconcile(f);
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 2),
    );
    await flush(20);
    expect(f.radioService.playSong).toHaveBeenCalledTimes(2);
    expect(f.radioService.playSong.mock.calls[1][1]).toBe(
      'https://example.test/song-2.mp3',
    );
  });

  it('suspends automatic favorites after history persistence fails instead of repeatedly spending the same rotation allowance', async () => {
    const f = fixture();
    const favorite = (id: number) => ({
      ...SEQUENCE.items[0],
      id: `favorite-${id}`,
      songId: id,
      highRotation: true,
      audioUrl: `https://media.test/favorite-${id}.mp3`,
    });
    f.engine.handleSequenceUpdated('radio-1', {
      ...TWO_SONG_SEQUENCE,
      items: [TWO_SONG_SEQUENCE.items[1], favorite(201), favorite(202)],
    });
    f.engine.handlePalazzoSnapshot(
      'radio-1',
      idleSnapshot('instance', 'boot', 1),
    );
    await flush(20);
    const request = f.radioService.playSong.mock.calls[0][4];
    f.prisma.programState.update.mockRejectedValueOnce(
      new Error('rotation history unavailable'),
    );
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: request },
    });
    await flush(20);
    expect(f.metrics.recordHighRotationAction).toHaveBeenCalledWith(
      'history-persistence-failed',
    );
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.started',
      data: { playbackRequestId: request },
    });
    f.engine.handlePalazzoEvent('radio-1', {
      type: 'track.ended',
      data: { playbackRequestId: request },
    });
    await flush(20);
    expect(f.radioService.playSong.mock.calls.at(-1)![1]).toBe(
      'https://example.test/song-2.mp3',
    );
    expect(f.metrics.recordHighRotationAction).not.toHaveBeenCalledWith(
      'played',
    );
  });

  it('continues real playout commands even if an observer cannot receive a broadcast', async () => {
    const f = fixture();
    f.engine.setBroadcastHandler(() => {
      throw new Error('observer unavailable');
    });
    f.engine.handleManualSong('radio-1', 'https://media.test/song.mp3', 'Main');
    await flush();
    expect(f.radioService.playSong).toHaveBeenCalledTimes(1);
    expect(f.engine.getPlaybackState('radio-1')?.title).toBe('Main');
  });
});
