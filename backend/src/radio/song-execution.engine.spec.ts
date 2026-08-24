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
): PalazzoPlaybackState {
  return {
    ...idleSnapshot(instanceId, bootId, sequence),
    status: 'playing',
    track: {
      playbackRequestId,
      title: 'Song one',
      artist: 'Artist one',
      url: 'https://example.test/song-1.mp3',
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
    handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
  };
  const metrics = {
    recordTrackTransition: jest.fn(),
    recordEventIgnored: jest.fn(),
    recordDegradedPrograms: jest.fn(),
    recordStaleTelemetryPrograms: jest.fn(),
    recordSnapshotReconciliation: jest.fn(),
    recordConnectionState: jest.fn(),
    recordReconnectAttempt: jest.fn(),
    recordReconnectFailure: jest.fn(),
  };
  const engine = new SongExecutionEngine(
    radioService as unknown as RadioService,
    flightService as unknown as FlightService,
    {} as PrismaService,
    nowPlayingPublisher as unknown as NowPlayingPublisherService,
    metrics as unknown as RadioMetricsService,
  );
  engine.setPalazzoTelemetry({
    isReconciled: () => opts.reconciled,
  });
  if (opts.radio) engine.registerRadioProgram('radio-1');
  return { engine, radioService, flightService, nowPlayingPublisher, metrics };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('SongExecutionEngine authoritative playback', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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
});
