import { ManagedMetricsService } from './managed-metrics.service';

describe('ManagedMetricsService program SSE metrics', () => {
  it('renders bounded connection and snapshot results', async () => {
    const metrics = new ManagedMetricsService();

    metrics.recordProgramSseConnection(1);
    metrics.recordProgramSseConnection(1);
    metrics.recordProgramSseConnection(-1);
    metrics.recordProgramSseSnapshot('success');
    metrics.recordProgramSseSnapshot('failure');
    metrics.recordProgramSseSnapshot('unbounded-value');
    metrics.recordDependency('program-template', 'fetch', 'success', 0.25);
    metrics.recordJob('database-backup', 'success');
    metrics.recordJob('media-asset-reconciliation', 'failure');
    metrics.recordMediaLabelAssignment('success');
    metrics.recordMediaLabelAssignment('failure');
    metrics.recordMediaLabelAssignment('private-label-name');
    metrics.recordRecordingCommand('start', 'accepted');
    metrics.recordRecordingCommand('private-action', 'private-result');
    metrics.recordRecordingStatus('finalizing', 'success');

    const output = await metrics.render('');

    expect(output).toContain('alcantara_program_sse_connections 1');
    expect(output).toContain(
      'alcantara_program_sse_snapshots_total{result="success"} 1',
    );
    expect(output).toContain(
      'alcantara_program_sse_snapshots_total{result="failure"} 1',
    );
    expect(output).toContain(
      'alcantara_program_sse_snapshots_total{result="unknown"} 1',
    );
    expect(output).not.toContain('result="unbounded-value"');
    expect(output).toContain(
      'alcantara_dependency_operations_total{dependency="program-template",operation="fetch",result="success"} 1',
    );
    expect(output).toContain(
      'alcantara_jobs_total{job="database-backup",result="success"} 1',
    );
    expect(output).toContain(
      'alcantara_job_last_success_timestamp_seconds{job="database-backup"}',
    );
    expect(output).toContain(
      'alcantara_jobs_total{job="media-asset-reconciliation",result="failure"} 1',
    );
    expect(output).toContain(
      'alcantara_media_label_assignments_total{result="success"} 1',
    );
    expect(output).toContain(
      'alcantara_media_label_assignments_total{result="failure"} 1',
    );
    expect(output).toContain(
      'alcantara_media_label_assignments_total{result="unknown"} 1',
    );
    expect(output).not.toContain('private-label-name');
    expect(output).toContain(
      'alcantara_recording_commands_total{action="start",result="accepted"} 1',
    );
    expect(output).toContain(
      'alcantara_recording_commands_total{action="unknown",result="unknown"} 1',
    );
    expect(output).toContain(
      'alcantara_recording_reconciliations_total{state="finalizing",result="success"} 1',
    );
    expect(output).not.toContain('private-action');
    expect(output).not.toContain('private-result');
  });
});

describe('ManagedMetricsService outbound fetch metrics', () => {
  it('counts each caller and result from the closed sets only, starting at zero', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordOutboundFetch('program_audio', 'address');
    metrics.recordOutboundFetch('program_audio', 'address');
    metrics.recordOutboundFetch('now_playing', 'legacy_http');
    metrics.recordOutboundFetch('https://fictional.example/x', 'ok');
    metrics.recordOutboundFetch('program_audio', 'unlisted');
    const text = await metrics.registry.metrics();
    const samples = text
      .split('\n')
      .filter((line) => line.startsWith('alcantara_outbound_fetch_total{'));
    expect(samples).toHaveLength(36);
    expect(samples).toContain(
      'alcantara_outbound_fetch_total{path="program_audio",result="address"} 2',
    );
    expect(samples).toContain(
      'alcantara_outbound_fetch_total{path="now_playing",result="legacy_http"} 1',
    );
    expect(text).not.toContain('fictional.example');
    expect(text).not.toContain('unlisted');
  });
});
