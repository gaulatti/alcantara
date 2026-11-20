import {
  ManagedMetricsService,
  POMPEII_CHANNEL_RESET_METRIC_REASONS,
} from './managed-metrics.service';
import { POMPEII_CHANNEL_RESET_REASONS } from '../auth/pompeii.service';

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
    expect(samples).toHaveLength(48);
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

describe('ManagedMetricsService Pompeii channel reset metrics', () => {
  it('counts resets by the closed reason set only, starting at zero', async () => {
    const metrics = new ManagedMetricsService();
    const before = await metrics.registry.metrics();
    expect(before).toContain(
      'alcantara_pompeii_channel_resets_total{reason="deadline_exceeded"} 0',
    );
    expect(before).toContain(
      'alcantara_pompeii_channel_resets_total{reason="unavailable"} 0',
    );
    metrics.recordPompeiiChannelReset('deadline_exceeded');
    metrics.recordPompeiiChannelReset('unavailable');
    metrics.recordPompeiiChannelReset('deadline_exceeded');
    metrics.recordPompeiiChannelReset('api.pompeii.example:443');
    const text = await metrics.registry.metrics();
    const samples = text
      .split('\n')
      .filter((line) =>
        line.startsWith('alcantara_pompeii_channel_resets_total{'),
      );
    expect(samples).toEqual([
      'alcantara_pompeii_channel_resets_total{reason="deadline_exceeded"} 2',
      'alcantara_pompeii_channel_resets_total{reason="unavailable"} 1',
    ]);
    expect(text).not.toContain('api.pompeii.example');
  });

  it('keeps the metric reasons equal to the channel reasons', () => {
    expect([...POMPEII_CHANNEL_RESET_METRIC_REASONS]).toEqual([
      ...POMPEII_CHANNEL_RESET_REASONS,
    ]);
  });
});

describe('ManagedMetricsService authorization refusal metrics', () => {
  it('counts refusals by the closed reason set only, starting at zero', async () => {
    const metrics = new ManagedMetricsService();
    const before = await metrics.registry.metrics();
    expect(before).toContain(
      'alcantara_auth_refusals_total{reason="unsupported_credential"} 0',
    );
    metrics.recordAuthRefusal('unsupported_credential');
    metrics.recordAuthRefusal('unsupported_credential');
    metrics.recordAuthRefusal('unlisted-reason');
    const text = await metrics.registry.metrics();
    const samples = text
      .split('\n')
      .filter((line) => line.startsWith('alcantara_auth_refusals_total{'));
    expect(samples).toEqual([
      'alcantara_auth_refusals_total{reason="unsupported_credential"} 2',
    ]);
    expect(text).not.toContain('unlisted-reason');
  });

  it('counts MCP authentications by bounded result, every series from zero', async () => {
    const metrics = new ManagedMetricsService();
    const before = await metrics.registry.metrics();
    for (const result of [
      'ok',
      'unauthenticated',
      'forbidden',
      'unavailable',
      'rate_limited',
    ])
      expect(before).toContain(
        `alcantara_mcp_auth_total{result="${result}"} 0`,
      );
    metrics.recordMcpAuth('ok');
    metrics.recordMcpAuth('forbidden');
    metrics.recordMcpAuth('Bearer something');
    const text = await metrics.registry.metrics();
    expect(text).toContain('alcantara_mcp_auth_total{result="ok"} 1');
    expect(text).toContain('alcantara_mcp_auth_total{result="forbidden"} 1');
    expect(text).not.toContain('Bearer something');
  });
});

describe('MCP request metric', () => {
  it('counts calls by registered tool, tier and closed result, and bounds everything else', async () => {
    const metrics = new ManagedMetricsService();
    metrics.registerMcpTools(['sample_tool']);
    metrics.recordMcpRequest('sample_tool', 'A', 'ok');
    metrics.recordMcpRequest('sample_tool', 'A', 'rate_limited');
    metrics.recordMcpRequest('secret-title-as-tool', 'Q', 'free text error');
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'alcantara_mcp_requests_total{tool="sample_tool",tier="A",result="ok"} 1',
    );
    expect(text).toContain(
      'alcantara_mcp_requests_total{tool="sample_tool",tier="A",result="rate_limited"} 1',
    );
    expect(text).toContain(
      'alcantara_mcp_requests_total{tool="unknown",tier="unknown",result="unavailable"} 1',
    );
    expect(text).not.toContain('secret-title-as-tool');
    expect(text).not.toContain('free text error');
  });
});
