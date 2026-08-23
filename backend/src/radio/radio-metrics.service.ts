import { Injectable } from '@nestjs/common';

type CounterKey = string;

export type PalazzoEventIgnoreReason =
  | 'duplicate'
  | 'stale-sequence'
  | 'superseded-boot';

export type TrackTransitionResult =
  | 'advanced'
  | 'ignored-no-active'
  | 'ignored-mismatch'
  | 'ignored-duplicate'
  | 'ignored-frozen'
  | 'adopted'
  | 'published-stopped';

export type SnapshotReconciliationResult =
  | 'accepted'
  | 'instance-mismatch'
  | 'instance-conflict';

export interface RadioMetricsSnapshot {
  connectionsByState: Record<string, number>;
  reconnectAttempts: number;
  reconnectFailures: number;
  snapshotReconciliation: Record<string, number>;
  eventsIgnored: Record<string, number>;
  degradedPrograms: number;
  trackTransitions: Record<string, number>;
  staleTelemetryPrograms: number;
}

const CONNECTION_STATES = [
  'connecting',
  'connected',
  'polling',
  'unavailable',
  'instance-mismatch',
  'instance-conflict',
] as const;

const RECONCILIATION_RESULTS: SnapshotReconciliationResult[] = [
  'accepted',
  'instance-mismatch',
  'instance-conflict',
];

const IGNORE_REASONS: PalazzoEventIgnoreReason[] = [
  'duplicate',
  'stale-sequence',
  'superseded-boot',
];

const TRANSITION_RESULTS: TrackTransitionResult[] = [
  'advanced',
  'ignored-no-active',
  'ignored-mismatch',
  'ignored-duplicate',
  'ignored-frozen',
  'adopted',
  'published-stopped',
];

/**
 * Bounded-cardinality Prometheus registry for the Alcantara radio engine.
 *
 * No program IDs, playback request IDs, URLs, song titles, artists, or other
 * user-controlled values are ever used as label values. Only fixed enums
 * derived from engine state appear as labels.
 */
@Injectable()
export class RadioMetricsService {
  private readonly connectionsByState = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectFailures = 0;
  private readonly snapshotReconciliation = new Map<string, number>();
  private readonly eventsIgnored = new Map<string, number>();
  private degradedPrograms = 0;
  private staleTelemetryPrograms = 0;
  private readonly trackTransitions = new Map<string, number>();

  recordConnectionState(
    state: (typeof CONNECTION_STATES)[number],
    delta: 1 | -1,
  ): void {
    if (!CONNECTION_STATES.includes(state as (typeof CONNECTION_STATES)[number]))
      return;
    const current = this.connectionsByState.get(state) ?? 0;
    const next = Math.max(0, current + delta);
    if (next === 0) this.connectionsByState.delete(state);
    else this.connectionsByState.set(state, next);
  }

  recordReconnectAttempt(): void {
    this.reconnectAttempts += 1;
  }

  recordReconnectFailure(): void {
    this.reconnectFailures += 1;
  }

  recordSnapshotReconciliation(result: SnapshotReconciliationResult): void {
    if (!RECONCILIATION_RESULTS.includes(result)) return;
    this.snapshotReconciliation.set(
      result,
      (this.snapshotReconciliation.get(result) ?? 0) + 1,
    );
  }

  recordEventIgnored(reason: PalazzoEventIgnoreReason): void {
    if (!IGNORE_REASONS.includes(reason)) return;
    this.eventsIgnored.set(reason, (this.eventsIgnored.get(reason) ?? 0) + 1);
  }

  recordDegradedPrograms(count: number): void {
    this.degradedPrograms = Math.max(0, count);
  }

  recordStaleTelemetryPrograms(count: number): void {
    this.staleTelemetryPrograms = Math.max(0, count);
  }

  recordTrackTransition(result: TrackTransitionResult): void {
    if (!TRANSITION_RESULTS.includes(result)) return;
    this.trackTransitions.set(
      result,
      (this.trackTransitions.get(result) ?? 0) + 1,
    );
  }

  snapshot(): RadioMetricsSnapshot {
    return {
      connectionsByState: Object.fromEntries(this.connectionsByState),
      reconnectAttempts: this.reconnectAttempts,
      reconnectFailures: this.reconnectFailures,
      snapshotReconciliation: Object.fromEntries(this.snapshotReconciliation),
      eventsIgnored: Object.fromEntries(this.eventsIgnored),
      degradedPrograms: this.degradedPrograms,
      trackTransitions: Object.fromEntries(this.trackTransitions),
      staleTelemetryPrograms: this.staleTelemetryPrograms,
    };
  }

  render(): string {
    const lines: string[] = [
      '# HELP alcantara_palazzo_sse_connections Radio programs by Palazzo SSE connection state.',
      '# TYPE alcantara_palazzo_sse_connections gauge',
    ];
    for (const state of CONNECTION_STATES) {
      lines.push(
        `alcantara_palazzo_sse_connections{state="${state}"} ${this.connectionsByState.get(state) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_palazzo_reconnect_attempts_total Palazzo SSE reconnect attempts.',
      '# TYPE alcantara_palazzo_reconnect_attempts_total counter',
      `alcantara_palazzo_reconnect_attempts_total ${this.reconnectAttempts}`,
      '# HELP alcantara_palazzo_reconnect_failures_total Palazzo SSE reconnect failures.',
      '# TYPE alcantara_palazzo_reconnect_failures_total counter',
      `alcantara_palazzo_reconnect_failures_total ${this.reconnectFailures}`,
      '# HELP alcantara_palazzo_snapshot_reconciliation_total Palazzo snapshot reconciliation results.',
      '# TYPE alcantara_palazzo_snapshot_reconciliation_total counter',
    );
    for (const result of RECONCILIATION_RESULTS) {
      lines.push(
        `alcantara_palazzo_snapshot_reconciliation_total{result="${result}"} ${this.snapshotReconciliation.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_palazzo_events_ignored_total Palazzo events ignored before correlation.',
      '# TYPE alcantara_palazzo_events_ignored_total counter',
    );
    for (const reason of IGNORE_REASONS) {
      lines.push(
        `alcantara_palazzo_events_ignored_total{reason="${reason}"} ${this.eventsIgnored.get(reason) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_palazzo_telemetry_stale_programs Radio programs with stale Palazzo telemetry.',
      '# TYPE alcantara_palazzo_telemetry_stale_programs gauge',
      `alcantara_palazzo_telemetry_stale_programs ${this.staleTelemetryPrograms}`,
      '# HELP alcantara_radio_programs_degraded Radio programs currently degraded or unavailable.',
      '# TYPE alcantara_radio_programs_degraded gauge',
      `alcantara_radio_programs_degraded ${this.degradedPrograms}`,
      '# HELP alcantara_radio_track_transitions_total Radio track transitions by bounded result.',
      '# TYPE alcantara_radio_track_transitions_total counter',
    );
    for (const result of TRANSITION_RESULTS) {
      lines.push(
        `alcantara_radio_track_transitions_total{result="${result}"} ${this.trackTransitions.get(result) ?? 0}`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }
}
