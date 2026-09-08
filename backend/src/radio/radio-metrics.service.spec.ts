import { RadioMetricsService } from './radio-metrics.service';

describe('RadioMetricsService', () => {
  it('renders bounded-cardinality Prometheus output', () => {
    const metrics = new RadioMetricsService();
    metrics.recordConnectionState('connected', 1);
    metrics.recordConnectionState('unavailable', 1);
    metrics.recordReconnectAttempt();
    metrics.recordReconnectFailure();
    metrics.recordSnapshotReconciliation('accepted');
    metrics.recordSnapshotReconciliation('instance-conflict');
    metrics.recordEventIgnored('duplicate');
    metrics.recordEventIgnored('stale-sequence');
    metrics.recordDegradedPrograms(2);
    metrics.recordStaleTelemetryPrograms(1);
    metrics.recordTrackTransition('advanced');
    metrics.recordTrackTransition('ignored-frozen');
    metrics.recordIntroTransition('failed');
    metrics.recordMachineRequest('song-play', 'success');
    metrics.recordMachineRequest('song-play', 'deduplicated');
    metrics.recordMachineRequest('event-connect', 'unauthorized');
    metrics.recordMachineRetry('song-play');

    const rendered = metrics.render();
    expect(rendered).toContain(
      'alcantara_palazzo_sse_connections{state="connected"} 1',
    );
    expect(rendered).toContain(
      'alcantara_palazzo_sse_connections{state="unavailable"} 1',
    );
    expect(rendered).toContain('alcantara_palazzo_reconnect_attempts_total 1');
    expect(rendered).toContain(
      'alcantara_palazzo_snapshot_reconciliation_total{result="accepted"} 1',
    );
    expect(rendered).toContain(
      'alcantara_palazzo_events_ignored_total{reason="duplicate"} 1',
    );
    expect(rendered).toContain('alcantara_radio_programs_degraded 2');
    expect(rendered).toContain(
      'alcantara_radio_track_transitions_total{result="advanced"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_track_transitions_total{result="ignored-frozen"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_intro_transitions_total{result="failed"} 1',
    );
    expect(rendered).toContain(
      'alcantara_palazzo_machine_requests_total{operation="song-play",result="success"} 1',
    );
    expect(rendered).toContain(
      'alcantara_palazzo_machine_requests_total{operation="event-connect",result="unauthorized"} 1',
    );
    expect(rendered).toContain(
      'alcantara_palazzo_machine_retries_total{operation="song-play"} 1',
    );
  });

  it('never emits unbounded label values', () => {
    const metrics = new RadioMetricsService();
    const rendered = metrics.render();
    // Program IDs, request IDs, URLs, and titles must never appear as labels.
    expect(rendered).not.toContain('programId=');
    expect(rendered).not.toContain('requestId=');
    expect(rendered).not.toContain('url=');
    expect(rendered).not.toContain('title=');
  });

  it('tracks connection state transitions in both directions', () => {
    const metrics = new RadioMetricsService();
    metrics.recordConnectionState('polling', 1);
    metrics.recordConnectionState('polling', 1);
    metrics.recordConnectionState('polling', -1);
    expect(metrics.snapshot().connectionsByState).toEqual({ polling: 1 });
    metrics.recordConnectionState('polling', -1);
    expect(metrics.snapshot().connectionsByState).toEqual({});
  });
});
