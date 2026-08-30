import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetricsController } from '../src/metrics.controller';
import { ObservabilityModule } from '../src/observability/observability.module';
import { ManagedMetricsService } from '../src/observability/managed-metrics.service';
import { RadioMetricsService } from '../src/radio/radio-metrics.service';

describe('private Prometheus scrape boundary (e2e)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  let directory: string;
  let tokenPath: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'alcantara-metrics-'));
    tokenPath = join(directory, 'token');
    writeFileSync(tokenPath, 'private-scrape-token\n', { mode: 0o600 });
    process.env.METRICS_TOKEN_FILE = tokenPath;
    process.env.ALCANTARA_BUILD_VERSION = 'e2e-test';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule],
      controllers: [MetricsController],
      providers: [RadioMetricsService],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    const metrics = app.get(ManagedMetricsService);
    metrics.recordHttp('GET', 'radio', 200, 0.01);
    metrics.recordHttp(
      'UNTRUSTED_METHOD',
      'https://private.invalid/program/secret',
      799,
      0.02,
    );
    metrics.recordDependency('pompeii', 'authorize', 'success', 0.01);
    metrics.recordDependency(
      'private-host.invalid',
      'raw-error-value',
      'credential-value',
      0.02,
    );
    metrics.recordJob('charts-refresh', 'failure');
    metrics.recordPreference('write', 'conflict');
    metrics.recordBroadcastDestination('start', 'failed');
    const radioMetrics = app.get(RadioMetricsService);
    radioMetrics.recordMachineRequest('song-play', 'deduplicated');
    radioMetrics.recordMachineRequest('event-connect', 'unauthorized');
    radioMetrics.recordMachineRetry('song-play');
    radioMetrics.recordEventIgnored('sequence-gap');
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.METRICS_TOKEN_FILE;
    delete process.env.ALCANTARA_BUILD_VERSION;
  });

  it('rejects missing and invalid credentials', async () => {
    expect((await fetch(`${origin}/metrics`)).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/metrics`, {
          headers: { Authorization: 'Bearer wrong-token' },
        })
      ).status,
    ).toBe(401);
  });

  it('returns parseable-format managed and preserved radio metrics without unbounded values', async () => {
    const response = await fetch(`${origin}/metrics`, {
      headers: { Authorization: 'Bearer private-scrape-token' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    const body = await response.text();
    expect(body).toContain('alcantara_service_info');
    expect(body).toContain('alcantara_process_cpu_user_seconds_total');
    expect(body).not.toContain('alcantara_nodejs_active_handles_total');
    expect(body).not.toContain('alcantara_nodejs_active_requests_total');
    expect(body).not.toContain('alcantara_nodejs_active_resources_total');
    expect(body).toContain('alcantara_http_requests_total');
    expect(body).toContain('alcantara_dependency_operations_total');
    expect(body).toContain('alcantara_jobs_total');
    expect(body).toContain('alcantara_palazzo_sse_connections');
    expect(body).toContain(
      'alcantara_operator_preference_operations_total{action="write",result="conflict"} 1',
    );
    expect(body).toContain(
      'alcantara_broadcast_destination_operations_total{action="start",result="failed"} 1',
    );
    expect(body).toContain(
      'alcantara_palazzo_machine_requests_total{operation="song-play",result="deduplicated"} 1',
    );
    expect(body).toContain(
      'alcantara_palazzo_machine_requests_total{operation="event-connect",result="unauthorized"} 1',
    );
    expect(body).toContain(
      'alcantara_palazzo_machine_retries_total{operation="song-play"} 1',
    );
    expect(body).toContain(
      'alcantara_palazzo_events_ignored_total{reason="sequence-gap"} 1',
    );
    expect(body).toContain('method="unknown"');
    expect(body).toContain('route="unknown"');
    expect(body).not.toContain('private-scrape-token');
    expect(body).not.toContain('private-host.invalid');
    expect(body).not.toContain('raw-error-value');
    expect(body).not.toContain('credential-value');
    expect(body).not.toContain('https://private.invalid/program/secret');
    if (process.env.METRICS_SCRAPE_OUTPUT) {
      writeFileSync(process.env.METRICS_SCRAPE_OUTPUT, body);
    }
  });

  it('fails closed when the scrape credential file disappears', async () => {
    unlinkSync(tokenPath);
    const response = await fetch(`${origin}/metrics`, {
      headers: { Authorization: 'Bearer private-scrape-token' },
    });
    expect(response.status).toBe(503);
  });
});
