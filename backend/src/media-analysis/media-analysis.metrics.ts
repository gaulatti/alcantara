import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

/** success: stored; retry: failed and scheduled again; failure: failed for good. */
export type MediaAnalysisResult = 'success' | 'retry' | 'failure';

const RESULTS = new Set<string>(['success', 'retry', 'failure']);

/**
 * What became of a finished result whose write the database refused (#278):
 * retried (held for another run), stored_after_retry, released (the claim was
 * given back with its attempt) or dropped (it cannot be stored; the lease runs out).
 */
export type MediaAnalysisWriteOutcome =
  | 'retried'
  | 'stored_after_retry'
  | 'released'
  | 'dropped';

const WRITE_OUTCOMES = new Set<string>([
  'retried',
  'stored_after_retry',
  'released',
  'dropped',
]);

/** What cue rule 2 did to one edge of an analysed song (gaulatti/alcantara#235). */
const CUE_RULE_EDGES = new Set<string>(['head', 'tail']);
const CUE_RULE_RESULTS = new Set<string>(['applied', 'unchanged', 'bounded']);

@Injectable()
export class MediaAnalysisMetrics {
  private readonly analyses: Counter<string>;
  private readonly duration: Histogram<string>;
  private readonly backlog: Gauge<string>;
  private readonly writes: Counter<string>;
  private readonly durationBackfill: Gauge<string>;
  private readonly cueRule: Counter<string>;

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
    this.backlog = new Gauge({
      name: 'alcantara_media_analysis_backlog_assets',
      help: 'Audio assets waiting for analysis (unanalysed, stale or due a retry) at the last poll.',
      registers: [managed.registry],
    });
    this.writes = new Counter({
      name: 'alcantara_media_analysis_result_writes_total',
      help: 'Finished audio analyses whose result write the database refused, by bounded outcome.',
      labelNames: ['outcome'],
      registers: [managed.registry],
    });
    for (const outcome of WRITE_OUTCOMES) {
      this.writes.inc({ outcome }, 0);
    }
    this.durationBackfill = new Gauge({
      name: 'alcantara_media_analysis_duration_backfill_assets',
      help: 'Analysed audio assets still without a stored length that can be measured now, at the last poll (#296).',
      registers: [managed.registry],
    });
    for (const result of RESULTS) {
      this.analyses.inc({ result }, 0);
    }
    this.cueRule = new Counter({
      name: 'alcantara_media_analysis_cue_rule_total',
      help: 'Cue rule 2 outcome per edge of an analysed song: applied (the edge moved), unchanged, or bounded (it would move too far, so the earlier rule is kept).',
      labelNames: ['edge', 'result'],
      registers: [managed.registry],
    });
    for (const edge of CUE_RULE_EDGES) {
      for (const result of CUE_RULE_RESULTS) {
        this.cueRule.inc({ edge, result }, 0);
      }
    }
  }

  setBacklog(assets: number): void {
    this.backlog.set(Math.max(0, assets));
  }

  recordWrite(outcome: MediaAnalysisWriteOutcome): void {
    this.writes.inc({
      outcome: WRITE_OUTCOMES.has(outcome) ? outcome : 'dropped',
    });
  }

  recordCueRule(outcome: { head: string; tail: string }): void {
    for (const edge of ['head', 'tail'] as const) {
      this.cueRule.inc({
        edge,
        result: CUE_RULE_RESULTS.has(outcome[edge])
          ? outcome[edge]
          : 'unchanged',
      });
    }
  }

  setDurationBackfill(assets: number): void {
    this.durationBackfill.set(Math.max(0, assets));
  }

  record(result: MediaAnalysisResult, seconds: number): void {
    const label = RESULTS.has(result) ? result : 'failure';
    this.analyses.inc({ result: label });
    this.duration.observe({ result: label }, Math.max(0, seconds));
  }
}
