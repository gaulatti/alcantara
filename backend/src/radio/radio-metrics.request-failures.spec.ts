import { RadioMetricsService } from './radio-metrics.service';

// gaulatti/alcantara#175: songs Palazzo could not load, by bounded reason.
describe('RadioMetricsService song request failures', () => {
  it('exposes both reasons from zero and counts each failure', () => {
    const metrics = new RadioMetricsService();
    expect(metrics.render()).toContain(
      'alcantara_radio_song_request_failures_total{reason="timeout"} 0',
    );
    metrics.recordSongRequestFailure('timeout');
    metrics.recordSongRequestFailure('timeout');
    metrics.recordSongRequestFailure('other');
    const text = metrics.render();
    expect(text).toContain(
      'alcantara_radio_song_request_failures_total{reason="timeout"} 2',
    );
    expect(text).toContain(
      'alcantara_radio_song_request_failures_total{reason="other"} 1',
    );
    expect(metrics.snapshot().songRequestFailures).toEqual({
      timeout: 2,
      other: 1,
    });
  });
});
