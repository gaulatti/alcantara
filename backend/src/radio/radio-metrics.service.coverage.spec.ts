import { RadioMetricsService } from './radio-metrics.service';

describe('RadioMetricsService coverage', () => {
  let metrics: RadioMetricsService;
  beforeEach(() => {
    metrics = new RadioMetricsService();
  });

  it('counts monitor sessions per result and renders them', () => {
    metrics.recordMonitor('opened');
    metrics.recordMonitor('opened');
    metrics.recordMonitor('rejected');
    const text = metrics.render();
    expect(text).toContain(
      'alcantara_radio_monitor_sessions_total{result="opened"} 2',
    );
    expect(text).toContain(
      'alcantara_radio_monitor_sessions_total{result="rejected"} 1',
    );
    expect(text).toContain(
      'alcantara_radio_monitor_sessions_total{result="closed"} 0',
    );
  });

  it('counts listener configuration outcomes', () => {
    metrics.recordListenerConfiguration('success');
    metrics.recordListenerConfiguration('failure');
    metrics.recordListenerConfiguration('failure');
    const text = metrics.render();
    expect(text).toContain(
      'alcantara_radio_listener_configuration_total{result="success"} 1',
    );
    expect(text).toContain(
      'alcantara_radio_listener_configuration_total{result="failure"} 2',
    );
  });

  it('tracks connection states, never going below zero and dropping empty entries', () => {
    metrics.recordConnectionState('connected', 1);
    metrics.recordConnectionState('connected', 1);
    metrics.recordConnectionState('connected', -1);
    expect(metrics.snapshot().connectionsByState).toEqual({ connected: 1 });
    metrics.recordConnectionState('connected', -1);
    expect(metrics.snapshot().connectionsByState).toEqual({});
    metrics.recordConnectionState('polling', -1);
    expect(metrics.snapshot().connectionsByState).toEqual({});
    metrics.recordConnectionState('bogus' as any, 1);
    expect(metrics.snapshot().connectionsByState).toEqual({});
  });

  it('counts reconnect attempts and failures', () => {
    metrics.recordReconnectAttempt();
    metrics.recordReconnectAttempt();
    metrics.recordReconnectFailure();
    expect(metrics.snapshot()).toMatchObject({
      reconnectAttempts: 2,
      reconnectFailures: 1,
    });
  });

  it('records only known snapshot reconciliation results', () => {
    metrics.recordSnapshotReconciliation('accepted');
    metrics.recordSnapshotReconciliation('accepted');
    metrics.recordSnapshotReconciliation('nope' as any);
    expect(metrics.snapshot().snapshotReconciliation).toEqual({ accepted: 2 });
  });

  it('records only known ignore reasons', () => {
    metrics.recordEventIgnored('duplicate');
    metrics.recordEventIgnored('nope' as any);
    expect(metrics.snapshot().eventsIgnored).toEqual({ duplicate: 1 });
  });

  it('clamps degraded and stale program gauges at zero', () => {
    metrics.recordDegradedPrograms(3);
    metrics.recordStaleTelemetryPrograms(2);
    expect(metrics.snapshot()).toMatchObject({
      degradedPrograms: 3,
      staleTelemetryPrograms: 2,
    });
    metrics.recordDegradedPrograms(-1);
    metrics.recordStaleTelemetryPrograms(-5);
    expect(metrics.snapshot()).toMatchObject({
      degradedPrograms: 0,
      staleTelemetryPrograms: 0,
    });
  });

  it('records only known track transition results', () => {
    metrics.recordTrackTransition('advanced');
    metrics.recordTrackTransition('nope' as any);
    expect(metrics.snapshot().trackTransitions).toEqual({ advanced: 1 });
  });

  it('records only known intro transition results', () => {
    metrics.recordIntroTransition('started');
    metrics.recordIntroTransition('nope' as any);
    expect(metrics.snapshot().introTransitions).toEqual({ started: 1 });
  });

  it('records only known song queue actions and floors/clamps depth', () => {
    metrics.recordSongQueueAction('enqueued');
    metrics.recordSongQueueAction('enqueued');
    metrics.recordSongQueueAction('nope' as any);
    expect(metrics.snapshot().songQueueActions).toEqual({ enqueued: 2 });
    metrics.recordSongQueueDepth(4.9);
    expect(metrics.snapshot().songQueueDepth).toBe(4);
    metrics.recordSongQueueDepth(-3);
    expect(metrics.snapshot().songQueueDepth).toBe(0);
  });

  it('records only known high rotation actions and floors/clamps favorites', () => {
    metrics.recordHighRotationAction('played');
    metrics.recordHighRotationAction('nope' as any);
    expect(metrics.snapshot().highRotationActions).toEqual({ played: 1 });
    metrics.recordHighRotationFavorites(7.5);
    expect(metrics.snapshot().highRotationFavorites).toBe(7);
    metrics.recordHighRotationFavorites(-1);
    expect(metrics.snapshot().highRotationFavorites).toBe(0);
  });

  it('records machine requests only for known operation and result pairs', () => {
    metrics.recordMachineRequest('song-play', 'success');
    metrics.recordMachineRequest('song-play', 'success');
    metrics.recordMachineRequest('bogus' as any, 'success');
    metrics.recordMachineRequest('song-play', 'bogus' as any);
    expect(metrics.snapshot().machineRequests).toEqual({
      'song-play:success': 2,
    });
  });

  it('records machine retries only for known operations', () => {
    metrics.recordMachineRetry('state-read');
    metrics.recordMachineRetry('bogus' as any);
    expect(metrics.snapshot().machineRetries).toEqual({ 'state-read': 1 });
  });

  it('records output confidence transitions and silent programs', () => {
    metrics.recordOutputConfidenceTransition('silent');
    metrics.recordOutputConfidenceTransition('silent');
    metrics.recordOutputConfidenceTransition('bogus');
    expect(metrics.snapshot().outputConfidenceTransitions).toEqual({
      silent: 2,
    });
    metrics.recordOutputSilentPrograms(2.7);
    expect(metrics.snapshot().outputSilentPrograms).toBe(2);
    metrics.recordOutputSilentPrograms(-4);
    expect(metrics.snapshot().outputSilentPrograms).toBe(0);
  });

  it('records radio log and recovery preparation results in render output', () => {
    metrics.recordRadioLogResult('published');
    metrics.recordRadioLogResult('published');
    metrics.recordRadioLogResult('bogus');
    metrics.recordRecoveryPreparation('ready');
    metrics.recordRecoveryPreparation('bogus');
    const text = metrics.render();
    expect(text).toContain(
      'alcantara_radio_log_transitions_total{result="published"} 2',
    );
    expect(text).not.toContain('bogus');
    expect(text).toContain(
      'alcantara_radio_recovery_preparations_total{result="ready"} 1',
    );
    expect(text).toContain(
      'alcantara_radio_recovery_preparations_total{result="failed"} 0',
    );
  });

  it('renders every recorded counter with its populated value', () => {
    metrics.recordConnectionState('polling', 1);
    metrics.recordReconnectAttempt();
    metrics.recordSnapshotReconciliation('instance-conflict');
    metrics.recordEventIgnored('malformed');
    metrics.recordDegradedPrograms(1);
    metrics.recordStaleTelemetryPrograms(2);
    metrics.recordTrackTransition('adopted');
    metrics.recordIntroTransition('ended');
    metrics.recordSongQueueAction('claimed');
    metrics.recordSongQueueDepth(5);
    metrics.recordHighRotationAction('quota-unmet');
    metrics.recordHighRotationFavorites(6);
    metrics.recordMachineRequest('mixer-read', 'unavailable');
    metrics.recordMachineRetry('automation-stop');
    metrics.recordOutputConfidenceTransition('audible');
    metrics.recordOutputSilentPrograms(3);
    const text = metrics.render();
    for (const line of [
      'alcantara_palazzo_sse_connections{state="polling"} 1',
      'alcantara_palazzo_reconnect_attempts_total 1',
      'alcantara_palazzo_snapshot_reconciliation_total{result="instance-conflict"} 1',
      'alcantara_palazzo_events_ignored_total{reason="malformed"} 1',
      'alcantara_palazzo_telemetry_stale_programs 2',
      'alcantara_radio_programs_degraded 1',
      'alcantara_radio_track_transitions_total{result="adopted"} 1',
      'alcantara_radio_intro_transitions_total{result="ended"} 1',
      'alcantara_radio_song_queue_actions_total{result="claimed"} 1',
      'alcantara_radio_song_queue_depth 5',
      'alcantara_radio_high_rotation_actions_total{result="quota-unmet"} 1',
      'alcantara_radio_high_rotation_favorites 6',
      'alcantara_palazzo_machine_requests_total{operation="mixer-read",result="unavailable"} 1',
      'alcantara_palazzo_machine_retries_total{operation="automation-stop"} 1',
      'alcantara_radio_output_confidence_transitions_total{state="audible"} 1',
      'alcantara_radio_output_silent_programs 3',
    ]) {
      expect(text).toContain(line);
    }
    expect(text.endsWith('\n')).toBe(true);
  });
});
