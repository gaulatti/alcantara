import { RadioOutputConfidenceService } from './radio-output-confidence.service';

const T0 = Date.parse('2026-10-02T10:00:00.000Z');

function build() {
  const metrics = {
    recordOutputConfidenceTransition: jest.fn(),
    recordOutputSilentPrograms: jest.fn(),
  };
  const service = new RadioOutputConfidenceService(metrics as any);
  return { service, metrics };
}

const leg = (connection: string, programId = 'p') =>
  ({
    type: 'radio_leg_status',
    programId,
    status: { connection },
  }) as any;
const playback = (isPlaying: boolean, type = 'song_playback_active') =>
  ({ type, programId: 'p', playback: { isPlaying } }) as any;
const levels = (sampledAt: number | string, rms: number) =>
  ({
    type: 'audio_levels',
    programId: 'p',
    sampledAt:
      typeof sampledAt === 'number'
        ? new Date(sampledAt).toISOString()
        : sampledAt,
    levels: { output: { rms, peak: rms } },
  }) as any;

describe('RadioOutputConfidenceService coverage', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('onModuleDestroy is a no-op without a started refresh timer', () => {
    const { service } = build();
    expect(() => service.onModuleDestroy()).not.toThrow();
  });

  it('reports unknown for a program that was never observed', () => {
    const { service, metrics } = build();
    expect(service.get('missing')).toEqual({
      state: 'unknown',
      expectedAudio: false,
      outputRms: null,
      lastSampleAt: null,
      quietForMs: null,
    });
    expect(metrics.recordOutputConfidenceTransition).not.toHaveBeenCalled();
  });

  it('is unavailable until the radio leg is connected or polling', () => {
    const { service, metrics } = build();
    service.observe(playback(true));
    expect(service.get('p').state).toBe('unavailable');
    service.observe(leg('polling'));
    expect(service.get('p').state).toBe('unknown');
    service.observe(leg('disconnected'));
    expect(service.get('p').state).toBe('unavailable');
    expect(
      metrics.recordOutputConfidenceTransition.mock.calls.map((c) => c[0]),
    ).toEqual(['unavailable', 'unknown', 'unavailable']);
  });

  it('clears quiet tracking when the radio leg drops', () => {
    const { service } = build();
    service.observe(leg('connected'));
    service.observe(playback(true));
    service.observe(levels(T0, 0));
    expect(service.get('p', T0 + 1000).quietForMs).toBe(1000);
    service.observe(leg('error'));
    expect(service.get('p', T0 + 1000).quietForMs).toBeNull();
  });

  it('ignores invalid or non-advancing audio samples', () => {
    const { service } = build();
    service.observe(leg('connected'));
    service.observe(levels('not-a-date', 0));
    expect(service.get('p').lastSampleAt).toBeNull();
    service.observe(levels(T0, 0.5));
    service.observe(levels(T0, 0));
    service.observe(levels(T0 - 1000, 0));
    const snapshot = service.get('p', T0);
    expect(snapshot.outputRms).toBe(0.5);
    expect(snapshot.lastSampleAt).toBe(new Date(T0).toISOString());
    expect(snapshot.state).toBe('audible');
  });

  it('is idle for quiet output while no audio is expected', () => {
    const { service } = build();
    service.observe(leg('connected'));
    service.observe(levels(T0, 0));
    const snapshot = service.get('p', T0);
    expect(snapshot.state).toBe('idle');
    expect(snapshot.expectedAudio).toBe(false);
    expect(snapshot.quietForMs).toBeNull();
  });

  it('checks, then goes silent after the silence limit, keeping the first quiet timestamp', () => {
    const { service, metrics } = build();
    service.observe(leg('connected'));
    service.observe(playback(true, 'playback_update'));
    service.observe(levels(T0, 0));
    expect(service.get('p', T0 + 5000)).toMatchObject({
      state: 'checking',
      quietForMs: 5000,
    });
    service.observe(levels(T0 + 4000, 0));
    expect(service.get('p', T0 + 9_999).state).toBe('checking');
    expect(service.get('p', T0 + 10_000)).toMatchObject({
      state: 'silent',
      quietForMs: 10_000,
    });
    expect(metrics.recordOutputSilentPrograms).toHaveBeenLastCalledWith(1);
  });

  it('floors quiet duration at zero when asked about a time before the quiet start', () => {
    const { service } = build();
    service.observe(leg('connected'));
    service.observe(playback(true));
    service.observe(levels(T0, 0));
    expect(service.get('p', T0 - 500).quietForMs).toBe(0);
  });

  it('becomes unknown when the last sample is stale', () => {
    const { service } = build();
    service.observe(leg('connected'));
    service.observe(levels(T0, 0.5));
    expect(service.get('p', T0 + 15_000).state).toBe('audible');
    expect(service.get('p', T0 + 15_001).state).toBe('unknown');
  });

  it('resets expected audio and quiet tracking when playback stops', () => {
    const { service } = build();
    service.observe(leg('connected'));
    service.observe(playback(true));
    service.observe(levels(T0, 0));
    service.observe(playback(false, 'playback_update'));
    expect(service.get('p', T0 + 1000)).toMatchObject({
      expectedAudio: false,
      quietForMs: null,
      state: 'idle',
    });
  });

  it('resets expected audio and quiet tracking on song_off_air', () => {
    const { service } = build();
    service.observe(leg('connected'));
    service.observe(playback(true));
    service.observe(levels(T0, 0));
    service.observe({ type: 'song_off_air', programId: 'p' } as any);
    expect(service.get('p', T0 + 1000)).toMatchObject({
      expectedAudio: false,
      quietForMs: null,
    });
  });

  it('clears quiet tracking and silent count when sound returns', () => {
    const { service, metrics } = build();
    service.observe(leg('connected'));
    service.observe(playback(true));
    service.observe(levels(T0, 0));
    expect(service.get('p', T0 + 10_000).state).toBe('silent');
    service.observe(levels(T0 + 11_000, 0.2));
    expect(service.get('p', T0 + 11_000)).toMatchObject({
      state: 'audible',
      quietForMs: null,
    });
    expect(metrics.recordOutputSilentPrograms).toHaveBeenLastCalledWith(0);
  });

  it('does not record a transition when the state is unchanged and ignores unrelated events', () => {
    const { service, metrics } = build();
    service.observe(leg('connected'));
    const calls = metrics.recordOutputConfidenceTransition.mock.calls.length;
    service.observe({ type: 'something_else', programId: 'p' } as any);
    service.get('p');
    expect(metrics.recordOutputConfidenceTransition.mock.calls.length).toBe(
      calls,
    );
  });

  it('refreshes states on the timer so silence expires without observers', () => {
    const { service, metrics } = build();
    service.onModuleInit();
    service.observe(leg('connected'));
    service.observe(playback(true));
    service.observe(levels(T0, 0));
    expect(metrics.recordOutputSilentPrograms).not.toHaveBeenCalledWith(1);
    jest.advanceTimersByTime(10_000);
    expect(metrics.recordOutputSilentPrograms).toHaveBeenLastCalledWith(1);
    service.onModuleDestroy();
    metrics.recordOutputConfidenceTransition.mockClear();
    jest.advanceTimersByTime(30_000);
    expect(metrics.recordOutputConfidenceTransition).not.toHaveBeenCalled();
  });
});
