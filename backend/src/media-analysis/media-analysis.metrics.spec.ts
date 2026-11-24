import { MetricsController } from '../metrics.controller';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { MediaAnalysisMetrics } from './media-analysis.metrics';

// Parses the text the /metrics endpoint serves and returns every sample of
// one family as its label set and value.
function samples(text: string, name: string) {
  return text
    .split('\n')
    .filter(
      (line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `),
    )
    .map((line) => {
      const match = /^(\S+?)(?:\{(.*)\})? (\S+)$/.exec(line)!;
      const labels = Object.fromEntries(
        [...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
          m[1],
          m[2],
        ]),
      );
      return { name: match[1], labels, value: Number(match[3]) };
    });
}

describe('MediaAnalysisMetrics', () => {
  it('serves analysis results on /metrics with a bounded result label only', async () => {
    const managed = new ManagedMetricsService();
    const metrics = new MediaAnalysisMetrics(managed);
    const controller = new MetricsController(
      new RadioMetricsService(),
      managed,
      undefined as never,
    );

    const before = samples(
      await controller.getMetrics(),
      'alcantara_media_analyses_total',
    );
    expect(before).toEqual(
      ['success', 'retry', 'failure'].map((result) => ({
        name: 'alcantara_media_analyses_total',
        labels: { result },
        value: 0,
      })),
    );

    expect(
      samples(
        await controller.getMetrics(),
        'alcantara_media_analysis_backlog_assets',
      ),
    ).toEqual([
      { name: 'alcantara_media_analysis_backlog_assets', labels: {}, value: 0 },
    ]);
    metrics.setBacklog(4321);
    metrics.setBacklog(-3);
    metrics.setBacklog(4320);

    metrics.record('success', 3.2);
    metrics.record('success', 2.8);
    metrics.record('retry', 180);
    metrics.record('failure', -1);
    metrics.record('unexpected' as never, 1);

    const text = await controller.getMetrics();
    const totals = samples(text, 'alcantara_media_analyses_total');
    expect(
      Object.fromEntries(totals.map((s) => [s.labels.result, s.value])),
    ).toEqual({
      success: 2,
      retry: 1,
      failure: 2,
    });
    const allowed = new Set(['success', 'retry', 'failure']);
    for (const family of [
      'alcantara_media_analyses_total',
      'alcantara_media_analysis_duration_seconds_count',
      'alcantara_media_analysis_duration_seconds_sum',
      'alcantara_media_analysis_duration_seconds_bucket',
    ]) {
      for (const sample of samples(text, family)) {
        const { le, ...rest } = sample.labels;
        expect(Object.keys(rest)).toEqual(['result']);
        expect(allowed.has(rest.result)).toBe(true);
        if (family.endsWith('_bucket')) expect(le).toBeDefined();
      }
    }
    expect(samples(text, 'alcantara_media_analysis_backlog_assets')).toEqual([
      {
        name: 'alcantara_media_analysis_backlog_assets',
        labels: {},
        value: 4320,
      },
    ]);
    const sums = samples(text, 'alcantara_media_analysis_duration_seconds_sum');
    expect(
      Object.fromEntries(sums.map((s) => [s.labels.result, s.value])),
    ).toEqual({
      success: 6,
      retry: 180,
      failure: 1,
    });
  });

  it('serves refused result writes on /metrics with a bounded outcome label only', async () => {
    const managed = new ManagedMetricsService();
    const metrics = new MediaAnalysisMetrics(managed);
    const controller = new MetricsController(
      new RadioMetricsService(),
      managed,
      undefined as never,
    );
    const name = 'alcantara_media_analysis_result_writes_total';
    const outcomes = ['retried', 'stored_after_retry', 'released', 'dropped'];

    expect(samples(await controller.getMetrics(), name)).toEqual(
      outcomes.map((outcome) => ({ name, labels: { outcome }, value: 0 })),
    );

    metrics.recordWrite('retried');
    metrics.recordWrite('retried');
    metrics.recordWrite('stored_after_retry');
    metrics.recordWrite('released');
    metrics.recordWrite('unexpected' as never);

    const totals = samples(await controller.getMetrics(), name);
    expect(
      Object.fromEntries(totals.map((s) => [s.labels.outcome, s.value])),
    ).toEqual({
      retried: 2,
      stored_after_retry: 1,
      released: 1,
      dropped: 1,
    });
    for (const sample of totals) {
      expect(Object.keys(sample.labels)).toEqual(['outcome']);
      expect(outcomes).toContain(sample.labels.outcome);
    }
  });

  it('serves the length backfill as one gauge with no labels', async () => {
    const managed = new ManagedMetricsService();
    const metrics = new MediaAnalysisMetrics(managed);
    const controller = new MetricsController(
      new RadioMetricsService(),
      managed,
      undefined as never,
    );
    const name = 'alcantara_media_analysis_duration_backfill_assets';
    expect(samples(await controller.getMetrics(), name)).toEqual([
      { name, labels: {}, value: 0 },
    ]);
    metrics.setDurationBackfill(4800);
    metrics.setDurationBackfill(-1);
    metrics.setDurationBackfill(4799);
    expect(samples(await controller.getMetrics(), name)).toEqual([
      { name, labels: {}, value: 4799 },
    ]);
  });

  it('counts cue rule 2 outcomes per edge on /metrics with bounded labels only', async () => {
    const managed = new ManagedMetricsService();
    const metrics = new MediaAnalysisMetrics(managed);
    const controller = new MetricsController(
      new RadioMetricsService(),
      managed,
      undefined as never,
    );
    const name = 'alcantara_media_analysis_cue_rule_total';
    expect(samples(await controller.getMetrics(), name)).toHaveLength(8);

    metrics.recordCueRule({ head: 'applied', tail: 'bounded' });
    metrics.recordCueRule({ head: 'applied', tail: 'applied' });
    metrics.recordCueRule({ head: 'surprise', tail: 'unchanged' });
    metrics.recordCueRule({ head: 'unchanged', tail: 'clamped' });

    const totals = Object.fromEntries(
      samples(await controller.getMetrics(), name).map((s) => [
        `${s.labels.edge}:${s.labels.result}`,
        s.value,
      ]),
    );
    expect(totals).toEqual({
      'head:applied': 2,
      'head:unchanged': 2,
      'head:bounded': 0,
      'head:clamped': 0,
      'tail:applied': 1,
      'tail:unchanged': 1,
      'tail:bounded': 1,
      'tail:clamped': 1,
    });
  });
});
