import { RadioMetricsService } from './radio-metrics.service';

describe('RadioMetricsService', () => {
  it('counts analysis drops by bounded reason only and ignores unknown reasons', () => {
    const metrics = new RadioMetricsService();
    metrics.recordAnalysisDrop('segue-invalid');
    metrics.recordAnalysisDrop('segue-invalid');
    metrics.recordAnalysisDrop('loudness-invalid');
    metrics.recordAnalysisDrop('https://media.example/song.mp3' as never);

    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE alcantara_radio_analysis_dropped_total counter');
    expect(rendered).toContain('alcantara_radio_analysis_dropped_total{result="segue-invalid"} 2');
    expect(rendered).toContain('alcantara_radio_analysis_dropped_total{result="loudness-invalid"} 1');
    expect(rendered).toContain('alcantara_radio_analysis_dropped_total{result="segue-beyond-duration"} 0');
    expect(rendered).toContain('alcantara_radio_analysis_dropped_total{result="ambiguous-match"} 0');
    expect(rendered).toContain('alcantara_radio_analysis_dropped_total{result="segue-edge-bound"} 0');
    expect(rendered.split('\n').filter((line) => line.startsWith('alcantara_radio_analysis_dropped_total{'))).toHaveLength(5);
    expect(rendered).not.toContain('media.example');
    expect(metrics.snapshot().analysisDrops).toEqual({ 'segue-invalid': 2, 'loudness-invalid': 1 });
  });

  // gaulatti/alcantara#234: cue groups by shape, bounded, exported at 0.
  it('counts cue groups by bounded shape only', () => {
    const metrics = new RadioMetricsService();
    metrics.recordCueGroup('head_filled');
    metrics.recordCueGroup('head_filled');
    metrics.recordCueGroup('both');
    metrics.recordCueGroup('bogus' as never);
    const lines = metrics
      .render()
      .split('\n')
      .filter((line) => line.startsWith('alcantara_radio_cue_groups_total{'));
    expect(lines).toEqual([
      'alcantara_radio_cue_groups_total{shape="both"} 1',
      'alcantara_radio_cue_groups_total{shape="head_filled"} 2',
      'alcantara_radio_cue_groups_total{shape="tail_filled"} 0',
      'alcantara_radio_cue_groups_total{shape="none"} 0',
    ]);
  });

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
    metrics.recordTrackTransition('command-failed');
    metrics.recordIntroTransition('failed');
    metrics.recordSongQueueAction('enqueued');
    metrics.recordSongQueueAction('released');
    metrics.recordSongQueueAction('persistence-failed');
    metrics.recordSongQueueDepth(3);
    metrics.recordHighRotationAction('selected');
    metrics.recordHighRotationAction('history-persistence-failed');
    metrics.recordSimilarityAction('selected');
    metrics.recordSimilarityAction('selected');
    metrics.recordSimilarityAction('fallback-no-embedding');
    metrics.recordSimilarityAction('shadow-recorded');
    metrics.recordSimilarityAction('bogus' as never);
    metrics.recordHighRotationFavorites(12);
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
      'alcantara_radio_track_transitions_total{result="command-failed"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_intro_transitions_total{result="failed"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_song_queue_actions_total{result="enqueued"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_song_queue_actions_total{result="released"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_song_queue_actions_total{result="persistence-failed"} 1',
    );
    expect(rendered).toContain('alcantara_radio_song_queue_depth 3');
    expect(rendered).toContain(
      'alcantara_radio_high_rotation_actions_total{result="selected"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_high_rotation_actions_total{result="history-persistence-failed"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_similarity_total{result="selected"} 2',
    );
    expect(rendered).toContain(
      'alcantara_radio_similarity_total{result="fallback-no-embedding"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_similarity_total{result="shadow-recorded"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_similarity_total{result="fallback-no-candidate"} 0',
    );
    expect(rendered).not.toContain('bogus');
    expect(rendered).toContain('alcantara_radio_high_rotation_favorites 12');
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

// gaulatti/alcantara#230: the engine's own reads of Palazzo's state.
describe('RadioMetricsService engine resyncs', () => {
  it('counts resyncs by bounded trigger and result, with every series present', () => {
    const metrics = new RadioMetricsService();
    metrics.recordEngineResync('foreign_ended', 'resumed');
    metrics.recordEngineResync('watchdog', 'resumed');
    metrics.recordEngineResync('watchdog', 'resumed');
    metrics.recordEngineResync('watchdog', 'unavailable');
    const rendered = metrics.render();
    expect(rendered).toContain(
      '# TYPE alcantara_radio_engine_resyncs_total counter',
    );
    expect(rendered).toContain(
      'alcantara_radio_engine_resyncs_total{trigger="foreign_ended",result="resumed"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="resumed"} 2',
    );
    expect(rendered).toContain(
      'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="playing"} 0',
    );
    const series = rendered
      .split('\n')
      .filter((line) =>
        line.startsWith('alcantara_radio_engine_resyncs_total{'),
      );
    expect(series).toHaveLength(13);
    expect(metrics.snapshot().engineResyncs).toEqual({
      'foreign_ended:resumed': 1,
      'watchdog:resumed': 2,
      'watchdog:unavailable': 1,
    });
  });
});
