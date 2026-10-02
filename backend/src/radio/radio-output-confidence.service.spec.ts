import { RadioMetricsService } from './radio-metrics.service';
import { RadioOutputConfidenceService } from './radio-output-confidence.service';

describe('RadioOutputConfidenceService', () => {
  it('expires confidence for metrics even when no desk is open', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
    const metrics = new RadioMetricsService();
    const service = new RadioOutputConfidenceService(metrics);
    service.onModuleInit();
    try {
      service.observe({
        type: 'radio_leg_status',
        programId: 'radio-test',
        status: { connection: 'connected' },
      } as any);
      service.observe({
        type: 'song_playback_active',
        programId: 'radio-test',
        playback: { isPlaying: true },
      } as any);
      service.observe({
        type: 'audio_levels',
        programId: 'radio-test',
        sampledAt: new Date().toISOString(),
        levels: { output: { rms: 0, peak: 0 } },
      } as any);
      jest.advanceTimersByTime(10_000);
      expect(metrics.render()).toContain(
        'alcantara_radio_output_silent_programs 1',
      );
      jest.advanceTimersByTime(10_000);
      expect(metrics.render()).toContain(
        'alcantara_radio_output_silent_programs 0',
      );
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('detects sustained quiet output while program audio is expected and clears it on sound', () => {
    const metrics = new RadioMetricsService();
    const service = new RadioOutputConfidenceService(metrics);
    const start = Date.now();
    service.observe({
      type: 'radio_leg_status',
      programId: 'radio-test',
      status: { connection: 'connected' },
    } as any);
    service.observe({
      type: 'song_playback_active',
      programId: 'radio-test',
      playback: { isPlaying: true },
    } as any);
    service.observe({
      type: 'audio_levels',
      programId: 'radio-test',
      sampledAt: new Date(start).toISOString(),
      levels: { output: { rms: 0, peak: 0 } },
    } as any);
    expect(service.get('radio-test', start + 500).state).toBe('checking');
    expect(service.get('radio-test', start + 10_500).state).toBe('silent');
    service.observe({
      type: 'audio_levels',
      programId: 'radio-test',
      sampledAt: new Date(start + 11_000).toISOString(),
      levels: { output: { rms: 0.1, peak: 0.2 } },
    } as any);
    expect(service.get('radio-test', start + 11_000).state).toBe('audible');
    expect(service.get('radio-test', start + 27_000).state).toBe('unknown');
    const exposition = metrics.render();
    expect(exposition).toContain(
      'alcantara_radio_output_confidence_transitions_total{state="silent"} 1',
    );
    expect(exposition).toContain('alcantara_radio_output_silent_programs 0');
    expect(exposition).not.toContain('radio-test');
  });
});
