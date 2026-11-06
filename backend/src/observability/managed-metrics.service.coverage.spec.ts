import { ManagedMetricsService } from './managed-metrics.service';

function sample(output: string, name: string, labels: Record<string, string>) {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  const line = output.split('\n').find(
    (l) =>
      l.startsWith(`${name}{`) &&
      wanted.every((w) => l.includes(w)) &&
      // exact label count
      (l.match(/="/g) ?? []).length === wanted.length,
  );
  return line === undefined ? undefined : Number(line.split(' ').pop());
}

describe('ManagedMetricsService coverage', () => {
  const originalVersion = process.env.ALCANTARA_BUILD_VERSION;
  afterEach(() => {
    if (originalVersion === undefined)
      delete process.env.ALCANTARA_BUILD_VERSION;
    else process.env.ALCANTARA_BUILD_VERSION = originalVersion;
  });

  describe('service info', () => {
    it.each([
      [undefined, 'dev'],
      ['1.2.3-rc_1', '1.2.3-rc_1'],
      ['bad version!', 'unknown'],
      ['x'.repeat(65), 'unknown'],
    ])('reports build version %p as %p', async (env, expected) => {
      if (env === undefined) delete process.env.ALCANTARA_BUILD_VERSION;
      else process.env.ALCANTARA_BUILD_VERSION = env;
      const output = await new ManagedMetricsService().render('');
      expect(
        sample(output, 'alcantara_service_info', {
          service: 'alcantara',
          runtime: 'nodejs',
          version: expected,
        }),
      ).toBe(1);
    });

    it('removes the invalid aggregate nodejs gauges and registers default metrics', async () => {
      const output = await new ManagedMetricsService().render('');
      expect(output).not.toContain('alcantara_nodejs_active_handles_total');
      expect(output).not.toContain('alcantara_nodejs_active_requests_total');
      expect(output).not.toContain('alcantara_nodejs_active_resources_total');
      expect(output).toContain('alcantara_process_cpu_user_seconds_total');
    });
  });

  describe('recordHttp', () => {
    it('normalizes method, route and status class', async () => {
      const metrics = new ManagedMetricsService();
      metrics.recordHttp('get', 'program', 200, 0.01);
      metrics.recordHttp('FETCH', 'private/route', 503, -4);
      metrics.recordHttp('POST', 'root', 99, 0.2);
      metrics.recordHttp('POST', 'root', 600, 0.2);
      metrics.recordHttp('DELETE', 'metrics', 100, 0.2);
      metrics.recordHttp('DELETE', 'metrics', 599, 0.2);
      const output = await metrics.render('');
      const c = 'alcantara_http_requests_total';
      expect(
        sample(output, c, {
          method: 'GET',
          route: 'program',
          status_class: '2xx',
        }),
      ).toBe(1);
      expect(
        sample(output, c, {
          method: 'unknown',
          route: 'unknown',
          status_class: '5xx',
        }),
      ).toBe(1);
      expect(
        sample(output, c, {
          method: 'POST',
          route: 'root',
          status_class: 'unknown',
        }),
      ).toBe(2);
      expect(
        sample(output, c, {
          method: 'DELETE',
          route: 'metrics',
          status_class: '1xx',
        }),
      ).toBe(1);
      expect(
        sample(output, c, {
          method: 'DELETE',
          route: 'metrics',
          status_class: '5xx',
        }),
      ).toBe(1);
      expect(
        sample(output, 'alcantara_http_request_duration_seconds_sum', {
          method: 'unknown',
          route: 'unknown',
        }),
      ).toBe(0);
      expect(output).not.toContain('private/route');
    });
  });

  describe('recordDependency', () => {
    it('bounds dependency, operation and result', async () => {
      const metrics = new ManagedMetricsService();
      metrics.recordDependency('postgres', 'read', 'success', 0.5);
      metrics.recordDependency('customer-db', 'drop', 'weird', -1);
      const output = await metrics.render('');
      expect(
        sample(output, 'alcantara_dependency_operations_total', {
          dependency: 'postgres',
          operation: 'read',
          result: 'success',
        }),
      ).toBe(1);
      expect(
        sample(output, 'alcantara_dependency_operations_total', {
          dependency: 'unknown',
          operation: 'unknown',
          result: 'unknown',
        }),
      ).toBe(1);
      expect(
        sample(output, 'alcantara_dependency_duration_seconds_sum', {
          dependency: 'unknown',
          operation: 'unknown',
        }),
      ).toBe(0);
      expect(output).not.toContain('customer-db');
    });
  });

  describe('recordJob', () => {
    it('stamps last-success only for successful runs', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-02-03T04:05:06Z'));
      try {
        const metrics = new ManagedMetricsService();
        metrics.recordJob('charts-refresh', 'success');
        metrics.recordJob('charts-refresh', 'failure');
        metrics.recordJob('secret-job', 'skipped');
        metrics.recordJob('database-backup', 'nonsense');
        const output = await metrics.render('');
        expect(
          sample(output, 'alcantara_jobs_total', {
            job: 'charts-refresh',
            result: 'success',
          }),
        ).toBe(1);
        expect(
          sample(output, 'alcantara_jobs_total', {
            job: 'charts-refresh',
            result: 'failure',
          }),
        ).toBe(1);
        expect(
          sample(output, 'alcantara_jobs_total', {
            job: 'unknown',
            result: 'skipped',
          }),
        ).toBe(1);
        expect(
          sample(output, 'alcantara_jobs_total', {
            job: 'database-backup',
            result: 'unknown',
          }),
        ).toBe(1);
        expect(
          sample(output, 'alcantara_job_last_success_timestamp_seconds', {
            job: 'charts-refresh',
          }),
        ).toBe(Date.parse('2026-02-03T04:05:06Z') / 1000);
        expect(output).not.toContain(
          'alcantara_job_last_success_timestamp_seconds{job="unknown"}',
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('bounds scene handoff results', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordSceneHandoff('success');
    metrics.recordSceneHandoff('failure');
    metrics.recordSceneHandoff('scene-42');
    const output = await metrics.render('');
    for (const [result, count] of [
      ['success', 1],
      ['failure', 1],
      ['unknown', 1],
    ] as const) {
      expect(sample(output, 'alcantara_scene_handoffs_total', { result })).toBe(
        count,
      );
    }
    expect(output).not.toContain('scene-42');
  });

  it('bounds operator preference actions and results', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordPreference('publish', 'conflict');
    metrics.recordPreference('user-1', 'nope');
    const output = await metrics.render('');
    const name = 'alcantara_operator_preference_operations_total';
    expect(
      sample(output, name, { action: 'publish', result: 'conflict' }),
    ).toBe(1);
    expect(sample(output, name, { action: 'unknown', result: 'unknown' })).toBe(
      1,
    );
  });

  it('bounds broadcast destination actions and results', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordBroadcastDestination('reload', 'succeeded');
    metrics.recordBroadcastDestination('delete', 'exploded');
    const output = await metrics.render('');
    const name = 'alcantara_broadcast_destination_operations_total';
    expect(
      sample(output, name, { action: 'reload', result: 'succeeded' }),
    ).toBe(1);
    expect(sample(output, name, { action: 'unknown', result: 'unknown' })).toBe(
      1,
    );
  });

  it('bounds external source operations', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordExternalSource('rotate', 'not-found');
    metrics.recordExternalSource('key=secret', 'boom');
    const output = await metrics.render('');
    const name = 'alcantara_external_source_operations_total';
    expect(
      sample(output, name, { action: 'rotate', result: 'not-found' }),
    ).toBe(1);
    expect(sample(output, name, { action: 'unknown', result: 'unknown' })).toBe(
      1,
    );
    expect(output).not.toContain('key=secret');
  });

  describe('setExternalSourceInventory', () => {
    it('replaces the previous inventory and clamps negative counts', async () => {
      const metrics = new ManagedMetricsService();
      metrics.setExternalSourceInventory([
        { transport: 'rtmp', lifecycle: 'connected', count: 3 },
        { transport: 'srt', lifecycle: 'revoked', count: 1 },
      ]);
      metrics.setExternalSourceInventory([
        { transport: 'whip', lifecycle: 'waiting', count: 2 },
        { transport: 'ftp', lifecycle: 'mystery', count: -5 },
        { transport: 'hls', lifecycle: 'offline', count: 0 },
      ]);
      const output = await metrics.render('');
      const name = 'alcantara_external_source_inventory';
      expect(
        sample(output, name, { transport: 'whip', lifecycle: 'waiting' }),
      ).toBe(2);
      expect(
        sample(output, name, { transport: 'unknown', lifecycle: 'unknown' }),
      ).toBe(0);
      expect(
        sample(output, name, { transport: 'hls', lifecycle: 'offline' }),
      ).toBe(0);
      expect(
        sample(output, name, { transport: 'rtmp', lifecycle: 'connected' }),
      ).toBeUndefined();
    });

    it('accepts an empty inventory', async () => {
      const metrics = new ManagedMetricsService();
      metrics.setExternalSourceInventory([
        { transport: 'rtmp', lifecycle: 'connected', count: 1 },
      ]);
      metrics.setExternalSourceInventory([]);
      expect(await metrics.render('')).not.toContain(
        'alcantara_external_source_inventory{',
      );
    });
  });

  it('records recording status reconciliations with bounded states', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordRecordingStatus('active', 'unavailable');
    metrics.recordRecordingStatus('bogus', 'bogus');
    const output = await metrics.render('');
    const name = 'alcantara_recording_reconciliations_total';
    expect(
      sample(output, name, { state: 'active', result: 'unavailable' }),
    ).toBe(1);
    expect(sample(output, name, { state: 'unknown', result: 'unknown' })).toBe(
      1,
    );
  });

  it('tracks program SSE connection deltas', async () => {
    const metrics = new ManagedMetricsService();
    metrics.recordProgramSseConnection(1);
    metrics.recordProgramSseConnection(1);
    metrics.recordProgramSseConnection(-1);
    expect(await metrics.render('')).toContain(
      'alcantara_program_sse_connections 1',
    );
  });

  it('appends radio metrics after the managed registry with a single newline', async () => {
    const metrics = new ManagedMetricsService();
    const output = await metrics.render('\n\n  radio_metric 1\n');
    expect(output.endsWith('\nradio_metric 1\n')).toBe(true);
    expect(output).not.toMatch(/\n\n\s*radio_metric/);
  });
});
