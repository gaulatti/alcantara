import { RadioMetricsService } from './radio-metrics.service';

describe('radio metric cardinality, isolation and bounded gauges', () => {
  const hostile = 'https://secret.invalid/program/foreign-request';
  it.each(
    [
      (metrics: RadioMetricsService) =>
        metrics.recordConnectionState(hostile as never, 1),
      (metrics: RadioMetricsService) =>
        metrics.recordSnapshotReconciliation(hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordEventIgnored(hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordTrackTransition(hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordIntroTransition(hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordSongQueueAction(hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordHighRotationAction(hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordMachineRequest(hostile as never, 'success'),
      (metrics: RadioMetricsService) =>
        metrics.recordMachineRequest('song-play', hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordMachineRetry(hostile as never),
      (metrics: RadioMetricsService) =>
        metrics.recordOutputConfidenceTransition(hostile),
      (metrics: RadioMetricsService) => metrics.recordRadioLogResult(hostile),
      (metrics: RadioMetricsService) =>
        metrics.recordRecoveryPreparation(hostile),
    ].map((record) => [record]),
  )(
    'ignores malformed runtime enum labels without changing counters (%#)',
    (record) => {
      const metrics = new RadioMetricsService();
      const before = metrics.snapshot();
      const rendered = metrics.render();
      record(metrics);
      expect(metrics.snapshot()).toEqual(before);
      expect(metrics.render()).toBe(rendered);
      expect(metrics.render()).not.toContain(hostile);
    },
  );

  it('keeps nonnegative integer queue/favorite/silence gauges and prevents connection underflow', () => {
    const metrics = new RadioMetricsService();
    metrics.recordSongQueueDepth(4.9);
    metrics.recordHighRotationFavorites(5.9);
    metrics.recordOutputSilentPrograms(3.9);
    expect(metrics.snapshot()).toMatchObject({
      songQueueDepth: 4,
      highRotationFavorites: 5,
      outputSilentPrograms: 3,
    });
    metrics.recordSongQueueDepth(-1);
    metrics.recordHighRotationFavorites(-1);
    metrics.recordOutputSilentPrograms(-1);
    metrics.recordDegradedPrograms(-1);
    metrics.recordStaleTelemetryPrograms(-1);
    metrics.recordConnectionState('connected', -1);
    expect(metrics.snapshot()).toMatchObject({
      songQueueDepth: 0,
      highRotationFavorites: 0,
      outputSilentPrograms: 0,
      degradedPrograms: 0,
      staleTelemetryPrograms: 0,
      connectionsByState: {},
    });
  });

  it('accumulates allowed operational results while snapshots remain independent of caller edits', () => {
    const metrics = new RadioMetricsService();
    metrics.recordIntroTransition('started');
    metrics.recordIntroTransition('started');
    metrics.recordHighRotationAction('played');
    metrics.recordHighRotationAction('played');
    metrics.recordMachineRequest('automation-start', 'success');
    metrics.recordMachineRequest('automation-start', 'success');
    metrics.recordMachineRetry('automation-start');
    metrics.recordMachineRetry('automation-start');
    metrics.recordRecoveryPreparation('ready');
    metrics.recordRecoveryPreparation('ready');
    metrics.recordRadioLogResult('generated');
    metrics.recordRadioLogResult('generated');
    const snapshot = metrics.snapshot();
    expect(snapshot).toMatchObject({
      introTransitions: { started: 2 },
      highRotationActions: { played: 2 },
      machineRequests: { 'automation-start:success': 2 },
      machineRetries: { 'automation-start': 2 },
    });
    snapshot.machineRequests['automation-start:success'] = 99;
    expect(metrics.snapshot().machineRequests['automation-start:success']).toBe(
      2,
    );
    expect(metrics.render()).toContain(
      'alcantara_radio_recovery_preparations_total{result="ready"} 2',
    );
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="generated"} 2',
    );
  });
});
