import { RadioOutputConfidenceService } from './radio-output-confidence.service';
import { RadioMetricsService } from './radio-metrics.service';
import type { SongPlaybackData } from './song-execution.engine';
import type {
  PalazzoConnectionState,
  PalazzoProgramStatus,
} from './palazzo-contract';

const start = Date.parse('2026-10-24T12:00:00Z');
const playback = (isPlaying: boolean): SongPlaybackData => ({
  token: 'request',
  audioUrl: 'https://media.invalid/song',
  title: 'Fixture',
  artist: 'Fixture',
  coverUrl: '',
  durationMs: 60_000,
  isPlaying,
  positionMs: 0,
  progress: 0,
  startedAt: new Date(start).toISOString(),
  updatedAt: new Date(start).toISOString(),
  telemetryStale: false,
  introStatus: 'none',
  introFailureReason: null,
  queueEntryId: null,
});
const status = (
  programId: string,
  connection: PalazzoConnectionState,
): PalazzoProgramStatus => ({
  programId,
  programType: 'radio',
  palazzoUrl: 'http://palazzo:3100',
  instanceId: 'instance',
  connection,
  lastEventAt: null,
  lastSnapshotAt: null,
  degraded: false,
  detail: null,
});

describe('radio output observations, clock boundaries and multi-program metrics', () => {
  beforeEach(() => jest.useFakeTimers({ now: start }));
  afterEach(() => jest.useRealTimers());
  function fixture() {
    const metrics = new RadioMetricsService();
    const service = new RadioOutputConfidenceService(metrics);
    const connect = (
      programId = 'one',
      connection: PalazzoConnectionState = 'connected',
    ) =>
      service.observe({
        type: 'radio_leg_status',
        programId,
        status: status(programId, connection),
      });
    const sample = (programId = 'one', at = start, rms = 0) =>
      service.observe({
        type: 'audio_levels',
        programId,
        sampledAt: new Date(at).toISOString(),
        levels: {
          song: { rms, peak: rms },
          instant: { rms: 0, peak: 0 },
          output: { rms, peak: rms },
        },
      });
    const active = (programId = 'one', playing = true) =>
      service.observe({
        type: 'playback_update',
        programId,
        playback: playback(playing),
      });
    return { service, metrics, connect, sample, active };
  }

  it('returns the complete unknown response for an unseen program and tolerates shutdown before startup', () => {
    const { service } = fixture();
    expect(service.get('unseen')).toEqual({
      state: 'unknown',
      expectedAudio: false,
      outputRms: null,
      lastSampleAt: null,
      quietForMs: null,
    });
    service.onModuleDestroy();
  });

  it('treats fresh quiet measurements as idle only while no audio is expected', () => {
    const { service, connect, sample, active } = fixture();
    connect();
    sample();
    expect(service.get('one')).toMatchObject({
      state: 'idle',
      expectedAudio: false,
      outputRms: 0,
      quietForMs: null,
    });
    active();
    expect(service.get('one')).toMatchObject({
      state: 'checking',
      expectedAudio: true,
      quietForMs: null,
    });
    sample('one', start + 1);
    expect(service.get('one', start)).toMatchObject({
      state: 'checking',
      quietForMs: 0,
    });
    active('one', false);
    expect(service.get('one')).toMatchObject({
      state: 'idle',
      expectedAudio: false,
      quietForMs: null,
    });
  });

  it.each(['connected', 'polling'] as const)(
    'uses the exact audible threshold with a %s leg',
    (connection) => {
      const { service, connect, sample, active } = fixture();
      connect('one', connection);
      active();
      sample('one', start, 0.001);
      expect(service.get('one', start + 15_000).state).toBe('audible');
      expect(service.get('one', start + 15_001).state).toBe('unknown');
    },
  );

  it('rejects duplicate, backwards and malformed timestamps without replacing the authoritative measurement', () => {
    const { service, metrics, connect, sample } = fixture();
    connect();
    sample('one', start, 0.2);
    const before = service.get('one');
    const transitions = metrics.snapshot();
    sample('one', start, 0);
    sample('one', start - 1, 0);
    service.observe({
      type: 'audio_levels',
      programId: 'one',
      sampledAt: 'not a timestamp',
      levels: {
        song: { rms: 0, peak: 0 },
        instant: { rms: 0, peak: 0 },
        output: { rms: 0, peak: 0 },
      },
    });
    expect(service.get('one')).toEqual(before);
    expect(metrics.snapshot()).toEqual(transitions);
  });

  it('clears quiet expectation on off-air and availability loss, then requires a fresh quiet interval', () => {
    const { service, connect, sample, active } = fixture();
    connect();
    active();
    sample();
    expect(service.get('one', start + 10_000).state).toBe('silent');
    service.observe({
      type: 'song_off_air',
      programId: 'one',
      triggeredAt: new Date(start + 10_000).toISOString(),
    });
    expect(service.get('one')).toMatchObject({
      state: 'idle',
      expectedAudio: false,
      quietForMs: null,
    });
    active();
    sample('one', start + 1);
    connect('one', 'unavailable');
    expect(service.get('one')).toMatchObject({
      state: 'unavailable',
      quietForMs: null,
    });
    connect('one', 'polling');
    expect(service.get('one')).toMatchObject({
      state: 'checking',
      quietForMs: null,
    });
  });

  it('aggregates silent programs independently and does not count repeated reads as transitions', () => {
    const { service, metrics, connect, sample, active } = fixture();
    for (const id of ['one', 'two']) {
      connect(id);
      active(id);
      sample(id);
    }
    for (const id of ['one', 'two']) service.get(id, start + 10_000);
    expect(metrics.snapshot().outputSilentPrograms).toBe(2);
    const before = metrics.snapshot().outputConfidenceTransitions;
    service.get('one', start + 10_000);
    expect(metrics.snapshot().outputConfidenceTransitions).toEqual(before);
    service.observe({
      type: 'song_off_air',
      programId: 'one',
      triggeredAt: new Date(start).toISOString(),
    });
    expect(metrics.snapshot().outputSilentPrograms).toBe(1);
    connect('two', 'unavailable');
    expect(metrics.snapshot().outputSilentPrograms).toBe(0);
  });

  it('keeps unrelated queue notifications from inventing expected output audio', () => {
    const { service } = fixture();
    service.observe({
      type: 'song_queue_update',
      programId: 'one',
      songQueue: [],
    });
    expect(service.get('one')).toMatchObject({
      state: 'unavailable',
      expectedAudio: false,
      outputRms: null,
    });
  });
});
