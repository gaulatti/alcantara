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
