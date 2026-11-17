import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

/** success: stored; retry: failed and scheduled again; failure: failed for good. */
export type MediaAnalysisResult = 'success' | 'retry' | 'failure';

const RESULTS = new Set<string>(['success', 'retry', 'failure']);

@Injectable()
export class MediaAnalysisMetrics {
  private readonly analyses: Counter<string>;
  private readonly duration: Histogram<string>;

  constructor(managed: ManagedMetricsService) {
    this.analyses = new Counter({
      name: 'alcantara_media_analyses_total',
      help: 'Audio asset analysis runs by bounded result.',
      labelNames: ['result'],
      registers: [managed.registry],
    });
    this.duration = new Histogram({
      name: 'alcantara_media_analysis_duration_seconds',
      help: 'Wall time of one audio asset analysis run by bounded result.',
      labelNames: ['result'],
      buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers: [managed.registry],
    });
    for (const result of RESULTS) {
      this.analyses.inc({ result }, 0);
    }
  }

  record(result: MediaAnalysisResult, seconds: number): void {
    const label = RESULTS.has(result) ? result : 'failure';
    this.analyses.inc({ result: label });
    this.duration.observe({ result: label }, Math.max(0, seconds));
  }
}
