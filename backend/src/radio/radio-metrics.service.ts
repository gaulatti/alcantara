import { Injectable } from '@nestjs/common';

export type PalazzoEventIgnoreReason =
  | 'duplicate'
  | 'stale-sequence'
  | 'superseded-boot'
  | 'sequence-gap'
  | 'cross-program'
  | 'malformed'
  | 'unknown-type'
  | 'unsupported-version';

/**
 * A Palazzo value Alcantara does not know and reads as a safe default instead
 * of rejecting the whole payload (gaulatti/ariston#217). The label is the
 * field, never the unknown value.
 */
export type PalazzoUnknownField =
  | 'availability'
  | 'status'
  | 'intro-status'
  | 'withdrawn-reason';

export type PalazzoMachineOperation =
  | 'song-play'
  | 'song-stop'
  | 'instant-play'
  | 'instant-stop'
  | 'mixer-read'
  | 'mixer-update'
  | 'state-read'
  | 'event-connect'
  | 'output-monitor'
  | 'filler-prepare'
  | 'automation-read'
  | 'automation-start'
  | 'automation-stop'
  | 'next-announce'
  | 'next-withdraw';

export type PalazzoMachineResult =
  | 'success'
  | 'deduplicated'
  | 'unauthorized'
  | 'rejected'
  | 'unavailable'
  | 'malformed'
  | 'cross-program'
  /**
   * Palazzo answered with a value Alcantara does not know and the request was
   * read safely instead of failing (gaulatti/ariston#217).
   */
  | 'unknown-value';

/**
 * gaulatti/alcantara#230: the engine read Palazzo's state itself, because a
 * foreign track ended or because Palazzo kept reporting no playback (the
 * watchdog), and what it found: `resumed` (Palazzo was idle and the engine
 * reconciled from it), `resumed_no_command` (a watchdog resume after which
 * nothing was commanded or advanced, gaulatti/alcantara#233), `playing`
 * (Palazzo was playing; nothing to do), `unavailable` (no state could be read).
 */
export type EngineResyncTrigger =
  | 'foreign_ended'
  | 'watchdog'
  | 'command_failed';
export type EngineResyncResult =
  | 'resumed'
  | 'resumed_no_command'
  | 'playing'
  | 'unavailable'
  | 'undecided';
/**
 * Engine paths that degrade instead of failing (#237): Palazzo state unreadable
 * at resync, radio settings unreadable when advancing the bumper sequence, a
 * bumper attempt that failed before its send, and a command with no radio
 * settings for the program.
 */
export type EngineDegradedSite =
  | 'telemetry_state'
  | 'bumper_settings'
  | 'bumper_attempt'
  | 'radio_settings_missing';
export const ENGINE_DEGRADED_SITES: EngineDegradedSite[] = [
  'telemetry_state',
  'bumper_settings',
  'bumper_attempt',
  'radio_settings_missing',
];

const RESYNC_TRIGGERS: EngineResyncTrigger[] = [
  'foreign_ended',
  'watchdog',
  'command_failed',
];
const RESYNC_RESULTS: EngineResyncResult[] = [
  'resumed',
  'resumed_no_command',
  'playing',
  'unavailable',
  'undecided',
];

export type TrackTransitionResult =
  | 'advanced'
  | 'ignored-no-active'
  | 'ignored-mismatch'
  | 'ignored-duplicate'
  | 'ignored-frozen'
  | 'adopted'
  | 'unidentified'
  | 'command-failed'
  | 'published-stopped';

export type SongRequestFailureReason = 'timeout' | 'other';

export type IntroTransitionResult =
  | 'submitted'
  | 'accepted'
  | 'started'
  | 'ended'
  | 'failed'
  | 'ignored-mismatch';

/** Why an operator's take or start was refused before anything was saved (gaulatti/alcantara#609). */
export type StartRefusalReason = 'engine_unavailable';
const START_REFUSAL_REASONS: StartRefusalReason[] = ['engine_unavailable'];

export type SongQueueActionResult =
  | 'enqueued'
  | 'claimed'
  | 'released'
  | 'removed'
  | 'reordered'
  | 'consumed'
  | 'cursor-persisted'
  | 'rejected'
  | 'persistence-failed';

export type HighRotationActionResult =
  | 'selected'
  | 'played'
  | 'cooldown-skipped'
  | 'quota-unmet'
  | 'history-persistence-failed';

// Why analysis-derived segue or loudness was left off a song command or announcement (the song still plays without it).
export type AnalysisDropResult =
  | 'segue-invalid'
  | 'segue-beyond-duration'
  | 'segue-edge-bound'
  | 'loudness-invalid'
  | 'ambiguous-match'
  // A song sent with no analysis at all (gaulatti/alcantara#255).
  | 'no-asset'
  | 'not-analyzed'
  | 'lookup-failed';

export type SimilarityActionResult =
  | 'selected'
  | 'fallback-no-candidate'
  | 'fallback-no-embedding'
  | 'shadow-recorded'
  | 'decision-persistence-failed';

/** Outcome of announcing the next song to Palazzo (contract palazzo#40 §5). */
export type NextAnnouncementResult =
  | 'accepted'
  | 'not_ready'
  | 'rejected'
  | 'unsupported'
  | 'withdrawn';

/** How the engine moved from one song to the next at an accepted end. */
export type HandoffPath = 'preloaded' | 'command' | 'race_replaced';
/** Why a started song was left without an announced successor (gaulatti/alcantara#232). */
export type AnnouncementSkipReason =
  | 'bumper_slot'
  | 'bumper_unavailable'
  | 'intro'
  | 'clocked_log'
  | 'no_successor'
  | 'queue_head_active'
  | 'not_autoplay'
  | 'unsupported'
  | 'superseded'
  | 'refused';
export const ANNOUNCEMENT_SKIP_REASONS: AnnouncementSkipReason[] = [
  'bumper_slot',
  'bumper_unavailable',
  'intro',
  'clocked_log',
  'no_successor',
  'queue_head_active',
  'not_autoplay',
  'unsupported',
  'superseded',
  'refused',
];
/**
 * A bumper spot by how it reached Palazzo: `announced` with the next song
 * (gaulatti/palazzo#50) or `command` (played after the end, then the song by
 * command); `sent` when Palazzo took it, `played` on Palazzo's
 * instant.started for it, `failed` when Palazzo did not take a command spot,
 * `retried` for each retry of a command spot Palazzo refused as not ready yet
 * (gaulatti/alcantara#274).
 */
export type BumperPath = 'announced' | 'command';
/** A write of the playlist cursor after it advanced (#277). */
export type CursorWriteResult = 'succeeded' | 'failed' | 'conflict';
const CURSOR_WRITE_RESULTS: CursorWriteResult[] = [
  'succeeded',
  'failed',
  'conflict',
];
/** How the song on air at a restart was recognised (#277). */
export type InheritedAdoptionPath = 'leaf' | 'cursor_leaf' | 'catalogue';
const INHERITED_ADOPTION_PATHS: InheritedAdoptionPath[] = [
  'leaf',
  'cursor_leaf',
  'catalogue',
];
export type BumperResult = 'sent' | 'played' | 'failed' | 'retried';
const BUMPER_PATHS: BumperPath[] = ['announced', 'command'];
const BUMPER_RESULTS: BumperResult[] = ['sent', 'played', 'failed', 'retried'];
/** `failed` and `retried` are command spots; an announced spot travels with its announcement, whose refusal is counted as a skip. */
const isBumperSeries = (path: BumperPath, result: BumperResult): boolean =>
  BUMPER_PATHS.includes(path) &&
  BUMPER_RESULTS.includes(result) &&
  !(path === 'announced' && (result === 'failed' || result === 'retried'));

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
  engineResyncs: Record<string, number>;
  introTransitions: Record<string, number>;
  songRequestFailures: Record<string, number>;
  songQueueActions: Record<string, number>;
  songQueueDepth: number;
  highRotationActions: Record<string, number>;
  similarityActions: Record<string, number>;
  analysisDrops: Record<string, number>;
  nextAnnouncements: Record<string, number>;
  handoffs: Record<string, number>;
  highRotationFavorites: number;
  staleTelemetryPrograms: number;
  palazzoConfigRejected: number;
  machineRequests: Record<string, number>;
  machineRetries: Record<string, number>;
  outputConfidenceTransitions: Record<string, number>;
  outputSilentPrograms: number;
}

const OUTPUT_CONFIDENCE_STATES = [
  'unknown',
  'unavailable',
  'idle',
  'checking',
  'audible',
  'silent',
] as const;
const RADIO_LOG_RESULTS = [
  'interrupted',
  'completed',
  // An as-run play whose end never arrived, closed when a later play ended (#241).
  'unended-closed',
  // The close of an unended play failed; the real end was still recorded (#241).
  'unended-close-failed',
  'record-failed',
  'resume-failed',
  'filled',
  'fill-failed',
  'generated',
  'edited',
  'edit-failed',
  'generation-failed',
  'published',
  'started',
  'start-failed',
  'cue-failed',
  'preflight-failed',
  'poll-failed',
] as const;
const RECOVERY_PREPARATION_RESULTS = ['ready', 'failed'] as const;

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
  'sequence-gap',
  'cross-program',
  'malformed',
  'unknown-type',
  'unsupported-version',
];

const UNKNOWN_FIELDS: PalazzoUnknownField[] = [
  'availability',
  'status',
  'intro-status',
  'withdrawn-reason',
];

const MACHINE_OPERATIONS: PalazzoMachineOperation[] = [
  'song-play',
  'song-stop',
  'instant-play',
  'instant-stop',
  'mixer-read',
  'mixer-update',
  'state-read',
  'event-connect',
  'output-monitor',
  'filler-prepare',
  'automation-read',
  'automation-start',
  'automation-stop',
  'next-announce',
  'next-withdraw',
];

const MACHINE_RESULTS: PalazzoMachineResult[] = [
  'success',
  'deduplicated',
  'unauthorized',
  'rejected',
  'unavailable',
  'malformed',
  'cross-program',
  'unknown-value',
];

const TRANSITION_RESULTS: TrackTransitionResult[] = [
  'advanced',
  'ignored-no-active',
  'ignored-mismatch',
  'ignored-duplicate',
  'ignored-frozen',
  'adopted',
  'unidentified',
  'command-failed',
  'published-stopped',
];

const SONG_REQUEST_FAILURE_REASONS: SongRequestFailureReason[] = [
  'timeout',
  'other',
];

const INTRO_TRANSITION_RESULTS: IntroTransitionResult[] = [
  'submitted',
  'accepted',
  'started',
  'ended',
  'failed',
  'ignored-mismatch',
];

const SONG_QUEUE_ACTION_RESULTS: SongQueueActionResult[] = [
  'enqueued',
  'claimed',
  'released',
  'removed',
  'reordered',
  'consumed',
  'cursor-persisted',
  'rejected',
  'persistence-failed',
];

/**
 * The cue group sent with a song (gaulatti/alcantara#234): both edges
 * measured, the head filled with 0 (only the tail measured), the tail filled
 * with the song's duration (only the head measured), or none sent.
 */
export type CueGroupShape = 'both' | 'head_filled' | 'tail_filled' | 'none';
const CUE_GROUP_SHAPES: CueGroupShape[] = [
  'both',
  'head_filled',
  'tail_filled',
  'none',
];
const ANALYSIS_DROP_RESULTS: AnalysisDropResult[] = [
  'segue-invalid',
  'segue-beyond-duration',
  'segue-edge-bound',
  'loudness-invalid',
  'ambiguous-match',
  'no-asset',
  'not-analyzed',
  'lookup-failed',
];

const NEXT_ANNOUNCEMENT_RESULTS: NextAnnouncementResult[] = [
  'accepted',
  'not_ready',
  'rejected',
  'unsupported',
  'withdrawn',
];

const HANDOFF_PATHS: HandoffPath[] = ['preloaded', 'command', 'race_replaced'];

const SIMILARITY_ACTION_RESULTS: SimilarityActionResult[] = [
  'selected',
  'fallback-no-candidate',
  'fallback-no-embedding',
  'shadow-recorded',
  'decision-persistence-failed',
];

const HIGH_ROTATION_ACTION_RESULTS: HighRotationActionResult[] = [
  'selected',
  'played',
  'cooldown-skipped',
  'quota-unmet',
  'history-persistence-failed',
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
  private readonly monitorSessions = {
    opened: 0,
    closed: 0,
    aborted: 0,
    failure: 0,
    rejected: 0,
  };
  recordMonitor(result: keyof RadioMetricsService['monitorSessions']): void {
    this.monitorSessions[result] += 1;
  }

  private readonly listenerConfiguration = { success: 0, failure: 0 };
  private readonly operatorChangeRecords = { recorded: 0, failed: 0 };
  /** gaulatti/alcantara#242: two sources on a program's bus past the allowance, by bounded kind. */
  private readonly programBusOverlaps = { song_song: 0, spot_song: 0 };
  private readonly programBusOverlapsActive = { song_song: 0, spot_song: 0 };
  private readonly programBusOverlapFlags = {
    flagged: 0,
    missing: 0,
    failed: 0,
  };
  private readonly outputConfidenceTransitions = new Map<string, number>();
  private readonly radioLogResults = new Map<string, number>();
  private readonly recoveryPreparations = new Map<string, number>();
  private outputSilentPrograms = 0;
  private readonly connectionsByState = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectFailures = 0;
  private readonly snapshotReconciliation = new Map<string, number>();
  private readonly eventsIgnored = new Map<string, number>();
  private readonly unknownValues = new Map<string, number>();
  private degradedPrograms = 0;
  private staleTelemetryPrograms = 0;
  private palazzoConfigRejected = 0;
  private readonly trackTransitions = new Map<string, number>();
  private readonly engineResyncs = new Map<string, number>();
  private readonly engineDegraded = new Map<EngineDegradedSite, number>();
  private readonly introTransitions = new Map<string, number>();
  private readonly songRequestFailures = new Map<string, number>();
  private readonly songQueueActions = new Map<string, number>();
  private readonly startRefusals = new Map<string, number>();
  private songQueueDepth = 0;
  private readonly highRotationActions = new Map<string, number>();
  private readonly similarityActions = new Map<string, number>();
  private readonly analysisDrops = new Map<string, number>();
  private readonly cueGroups = new Map<string, number>();
  private readonly nextAnnouncements = new Map<string, number>();
  private readonly handoffs = new Map<string, number>();
  private readonly announcementSkips = new Map<string, number>();
  private readonly bumpers = new Map<string, number>();
  private readonly cursorWrites = new Map<string, number>();
  private readonly inheritedAdoptions = new Map<string, number>();
  private highRotationFavorites = 0;
  private automaticPrograms = 0;
  private readonly machineRequests = new Map<string, number>();
  private readonly machineRetries = new Map<string, number>();

  recordConnectionState(
    state: (typeof CONNECTION_STATES)[number],
    delta: 1 | -1,
  ): void {
    if (!CONNECTION_STATES.includes(state)) return;
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

  recordUnknownValue(field: PalazzoUnknownField): void {
    this.unknownValues.set(field, (this.unknownValues.get(field) ?? 0) + 1);
  }

  recordDegradedPrograms(count: number): void {
    this.degradedPrograms = Math.max(0, count);
  }

  recordStaleTelemetryPrograms(count: number): void {
    this.staleTelemetryPrograms = Math.max(0, count);
  }

  /** A Palazzo URL the allowlist rejected when a program's client was started (#257). */
  recordPalazzoConfigRejected(): void {
    this.palazzoConfigRejected += 1;
  }

  recordTrackTransition(result: TrackTransitionResult): void {
    if (!TRANSITION_RESULTS.includes(result)) return;
    this.trackTransitions.set(
      result,
      (this.trackTransitions.get(result) ?? 0) + 1,
    );
  }

  recordEngineResync(
    trigger: EngineResyncTrigger,
    result: EngineResyncResult,
  ): void {
    const key = `${trigger}:${result}`;
    this.engineResyncs.set(key, (this.engineResyncs.get(key) ?? 0) + 1);
  }

  /** An engine path that degraded instead of failing (#237). */
  recordEngineDegraded(site: EngineDegradedSite): void {
    if (!ENGINE_DEGRADED_SITES.includes(site)) return;
    this.engineDegraded.set(site, (this.engineDegraded.get(site) ?? 0) + 1);
  }

  /** A song Palazzo could not load (`playout.request_failed`), by reason. */
  recordSongRequestFailure(reason: SongRequestFailureReason): void {
    this.songRequestFailures.set(
      reason,
      (this.songRequestFailures.get(reason) ?? 0) + 1,
    );
  }

  recordIntroTransition(result: IntroTransitionResult): void {
    if (!INTRO_TRANSITION_RESULTS.includes(result)) return;
    this.introTransitions.set(
      result,
      (this.introTransitions.get(result) ?? 0) + 1,
    );
  }

  /** An operator's take or start refused before anything was saved, by bounded reason. */
  recordStartRefused(reason: StartRefusalReason): void {
    if (!START_REFUSAL_REASONS.includes(reason)) return;
    this.startRefusals.set(reason, (this.startRefusals.get(reason) ?? 0) + 1);
  }

  recordSongQueueAction(result: SongQueueActionResult): void {
    if (!SONG_QUEUE_ACTION_RESULTS.includes(result)) return;
    this.songQueueActions.set(
      result,
      (this.songQueueActions.get(result) ?? 0) + 1,
    );
  }

  recordSongQueueDepth(count: number): void {
    this.songQueueDepth = Math.max(0, Math.floor(count));
  }

  recordHighRotationAction(result: HighRotationActionResult): void {
    if (!HIGH_ROTATION_ACTION_RESULTS.includes(result)) return;
    this.highRotationActions.set(
      result,
      (this.highRotationActions.get(result) ?? 0) + 1,
    );
  }

  recordSimilarityAction(result: SimilarityActionResult): void {
    if (!SIMILARITY_ACTION_RESULTS.includes(result)) return;
    this.similarityActions.set(
      result,
      (this.similarityActions.get(result) ?? 0) + 1,
    );
  }

  recordAnalysisDrop(result: AnalysisDropResult): void {
    if (!ANALYSIS_DROP_RESULTS.includes(result)) return;
    this.analysisDrops.set(result, (this.analysisDrops.get(result) ?? 0) + 1);
  }

  recordCueGroup(shape: CueGroupShape): void {
    if (!CUE_GROUP_SHAPES.includes(shape)) return;
    this.cueGroups.set(shape, (this.cueGroups.get(shape) ?? 0) + 1);
  }

  recordNextAnnouncement(result: NextAnnouncementResult): void {
    if (!NEXT_ANNOUNCEMENT_RESULTS.includes(result)) return;
    this.nextAnnouncements.set(
      result,
      (this.nextAnnouncements.get(result) ?? 0) + 1,
    );
  }

  recordHandoff(path: HandoffPath): void {
    if (!HANDOFF_PATHS.includes(path)) return;
    this.handoffs.set(path, (this.handoffs.get(path) ?? 0) + 1);
  }

  recordAnnouncementSkipped(reason: AnnouncementSkipReason): void {
    if (!ANNOUNCEMENT_SKIP_REASONS.includes(reason)) return;
    this.announcementSkips.set(
      reason,
      (this.announcementSkips.get(reason) ?? 0) + 1,
    );
  }

  recordCursorWrite(result: CursorWriteResult): void {
    if (!CURSOR_WRITE_RESULTS.includes(result)) return;
    this.cursorWrites.set(result, (this.cursorWrites.get(result) ?? 0) + 1);
  }

  recordInheritedAdoption(path: InheritedAdoptionPath): void {
    if (!INHERITED_ADOPTION_PATHS.includes(path)) return;
    this.inheritedAdoptions.set(
      path,
      (this.inheritedAdoptions.get(path) ?? 0) + 1,
    );
  }

  recordBumper(path: BumperPath, result: BumperResult): void {
    if (!isBumperSeries(path, result)) return;
    const key = `${path}\t${result}`;
    this.bumpers.set(key, (this.bumpers.get(key) ?? 0) + 1);
  }

  recordHighRotationFavorites(count: number): void {
    this.highRotationFavorites = Math.max(0, Math.floor(count));
  }

  recordMachineRequest(
    operation: PalazzoMachineOperation,
    result: PalazzoMachineResult,
  ): void {
    if (
      !MACHINE_OPERATIONS.includes(operation) ||
      !MACHINE_RESULTS.includes(result)
    )
      return;
    const key = `${operation}:${result}`;
    this.machineRequests.set(key, (this.machineRequests.get(key) ?? 0) + 1);
  }

  recordMachineRetry(operation: PalazzoMachineOperation): void {
    if (!MACHINE_OPERATIONS.includes(operation)) return;
    this.machineRetries.set(
      operation,
      (this.machineRetries.get(operation) ?? 0) + 1,
    );
  }

  recordOutputConfidenceTransition(state: string): void {
    if (!(OUTPUT_CONFIDENCE_STATES as readonly string[]).includes(state))
      return;
    this.outputConfidenceTransitions.set(
      state,
      (this.outputConfidenceTransitions.get(state) ?? 0) + 1,
    );
  }

  /** Radio programs whose rotation runs on its own (autoplay or shuffle). */
  recordAutomaticPrograms(count: number): void {
    this.automaticPrograms = Math.max(0, Math.floor(count));
  }

  recordOutputSilentPrograms(count: number): void {
    this.outputSilentPrograms = Math.max(0, Math.floor(count));
  }

  recordListenerConfiguration(result: 'success' | 'failure'): void {
    this.listenerConfiguration[result] += 1;
  }

  /** gaulatti/alcantara#236: whether the operator change record of a settings write was stored. */
  recordOperatorChangeRecord(result: 'recorded' | 'failed'): void {
    this.operatorChangeRecords[result] += 1;
  }

  /** gaulatti/alcantara#242: an overlap on a program's bus lasted past the allowance. */
  recordProgramBusOverlap(kind: 'song_song' | 'spot_song'): void {
    this.programBusOverlaps[kind] += 1;
  }

  /** gaulatti/alcantara#242: a raised overlap began (+1) or ended (-1). */
  setProgramBusOverlapActive(
    kind: 'song_song' | 'spot_song',
    delta: 1 | -1,
  ): void {
    this.programBusOverlapsActive[kind] = Math.max(
      0,
      this.programBusOverlapsActive[kind] + delta,
    );
  }

  /** gaulatti/alcantara#242: whether the as-run review flag of a raised overlap was stored. */
  recordProgramBusOverlapFlag(result: 'flagged' | 'missing' | 'failed'): void {
    this.programBusOverlapFlags[result] += 1;
  }

  recordRadioLogResult(result: string): void {
    if (!(RADIO_LOG_RESULTS as readonly string[]).includes(result)) return;
    this.radioLogResults.set(
      result,
      (this.radioLogResults.get(result) ?? 0) + 1,
    );
  }

  recordRecoveryPreparation(result: string): void {
    if (!(RECOVERY_PREPARATION_RESULTS as readonly string[]).includes(result))
      return;
    this.recoveryPreparations.set(
      result,
      (this.recoveryPreparations.get(result) ?? 0) + 1,
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
      engineResyncs: Object.fromEntries(this.engineResyncs),
      introTransitions: Object.fromEntries(this.introTransitions),
      songRequestFailures: Object.fromEntries(this.songRequestFailures),
      songQueueActions: Object.fromEntries(this.songQueueActions),
      songQueueDepth: this.songQueueDepth,
      highRotationActions: Object.fromEntries(this.highRotationActions),
      similarityActions: Object.fromEntries(this.similarityActions),
      analysisDrops: Object.fromEntries(this.analysisDrops),
      nextAnnouncements: Object.fromEntries(this.nextAnnouncements),
      handoffs: Object.fromEntries(this.handoffs),
      highRotationFavorites: this.highRotationFavorites,
      staleTelemetryPrograms: this.staleTelemetryPrograms,
      palazzoConfigRejected: this.palazzoConfigRejected,
      machineRequests: Object.fromEntries(this.machineRequests),
      machineRetries: Object.fromEntries(this.machineRetries),
      outputConfidenceTransitions: Object.fromEntries(
        this.outputConfidenceTransitions,
      ),
      outputSilentPrograms: this.outputSilentPrograms,
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
      '# HELP alcantara_palazzo_unknown_values_total Palazzo values Alcantara does not know, read as a safe default.',
      '# TYPE alcantara_palazzo_unknown_values_total counter',
    );
    for (const field of UNKNOWN_FIELDS) {
      lines.push(
        `alcantara_palazzo_unknown_values_total{field="${field}"} ${this.unknownValues.get(field) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_palazzo_telemetry_stale_programs Radio programs with stale Palazzo telemetry.',
      '# TYPE alcantara_palazzo_telemetry_stale_programs gauge',
      `alcantara_palazzo_telemetry_stale_programs ${this.staleTelemetryPrograms}`,
      '# HELP alcantara_palazzo_config_rejected_total Palazzo URLs the allowlist rejected when a program started consuming telemetry; the program has no engine until its settings change.',
      '# TYPE alcantara_palazzo_config_rejected_total counter',
      `alcantara_palazzo_config_rejected_total ${this.palazzoConfigRejected}`,
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
    lines.push(
      '# HELP alcantara_radio_engine_resyncs_total Times the song engine read Palazzo state itself, by trigger and outcome.',
      '# TYPE alcantara_radio_engine_resyncs_total counter',
    );
    for (const trigger of RESYNC_TRIGGERS)
      for (const result of RESYNC_RESULTS)
        // resumed_no_command is the watchdog's alone (#233).
        if (result !== 'resumed_no_command' || trigger === 'watchdog')
          lines.push(
            `alcantara_radio_engine_resyncs_total{trigger="${trigger}",result="${result}"} ${this.engineResyncs.get(`${trigger}:${result}`) ?? 0}`,
          );
    lines.push(
      '# HELP alcantara_radio_engine_degraded_total Song engine paths that degraded instead of failing, by site.',
      '# TYPE alcantara_radio_engine_degraded_total counter',
    );
    for (const site of ENGINE_DEGRADED_SITES)
      lines.push(
        `alcantara_radio_engine_degraded_total{site="${site}"} ${this.engineDegraded.get(site) ?? 0}`,
      );
    lines.push(
      '# HELP alcantara_radio_intro_transitions_total Atomic song-intro lifecycle transitions by bounded result.',
      '# TYPE alcantara_radio_intro_transitions_total counter',
    );
    for (const result of INTRO_TRANSITION_RESULTS) {
      lines.push(
        `alcantara_radio_intro_transitions_total{result="${result}"} ${this.introTransitions.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_song_request_failures_total Songs Palazzo could not load (playout.request_failed) by bounded reason.',
      '# TYPE alcantara_radio_song_request_failures_total counter',
    );
    for (const reason of SONG_REQUEST_FAILURE_REASONS) {
      lines.push(
        `alcantara_radio_song_request_failures_total{reason="${reason}"} ${this.songRequestFailures.get(reason) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_song_queue_actions_total Persisted Play Next queue actions by bounded result.',
      '# TYPE alcantara_radio_song_queue_actions_total counter',
    );
    for (const result of SONG_QUEUE_ACTION_RESULTS) {
      lines.push(
        `alcantara_radio_song_queue_actions_total{result="${result}"} ${this.songQueueActions.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_start_refused_total Operator takes and starts refused before anything was saved, by bounded reason.',
      '# TYPE alcantara_radio_start_refused_total counter',
    );
    for (const reason of START_REFUSAL_REASONS) {
      lines.push(
        `alcantara_radio_start_refused_total{reason="${reason}"} ${this.startRefusals.get(reason) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_song_queue_depth Total queued song entries across radio-capable programs.',
      '# TYPE alcantara_radio_song_queue_depth gauge',
      `alcantara_radio_song_queue_depth ${this.songQueueDepth}`,
    );
    lines.push(
      '# HELP alcantara_radio_high_rotation_actions_total High rotation scheduler actions by bounded result.',
      '# TYPE alcantara_radio_high_rotation_actions_total counter',
    );
    for (const result of HIGH_ROTATION_ACTION_RESULTS) {
      lines.push(
        `alcantara_radio_high_rotation_actions_total{result="${result}"} ${this.highRotationActions.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_similarity_total Similarity picker outcomes by bounded result.',
      '# TYPE alcantara_radio_similarity_total counter',
    );
    for (const result of SIMILARITY_ACTION_RESULTS) {
      lines.push(
        `alcantara_radio_similarity_total{result="${result}"} ${this.similarityActions.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_analysis_dropped_total Analysis-derived segue or loudness left off a song command or next-song announcement, including songs sent with no analysis at all, by bounded reason.',
      '# TYPE alcantara_radio_analysis_dropped_total counter',
    );
    for (const result of ANALYSIS_DROP_RESULTS) {
      lines.push(
        `alcantara_radio_analysis_dropped_total{result="${result}"} ${this.analysisDrops.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_cue_groups_total Cue groups sent with a song or announcement, by shape: both edges measured, head filled with 0, tail filled with the duration, or none sent.',
      '# TYPE alcantara_radio_cue_groups_total counter',
    );
    for (const shape of CUE_GROUP_SHAPES) {
      lines.push(
        `alcantara_radio_cue_groups_total{shape="${shape}"} ${this.cueGroups.get(shape) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_next_announcements_total Next-song announcements to Palazzo by bounded result.',
      '# TYPE alcantara_radio_next_announcements_total counter',
    );
    for (const result of NEXT_ANNOUNCEMENT_RESULTS) {
      lines.push(
        `alcantara_radio_next_announcements_total{result="${result}"} ${this.nextAnnouncements.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_handoffs_total Song-to-song handoffs at an accepted end, by bounded path.',
      '# TYPE alcantara_radio_handoffs_total counter',
    );
    for (const path of HANDOFF_PATHS) {
      lines.push(
        `alcantara_radio_handoffs_total{path="${path}"} ${this.handoffs.get(path) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_announcement_skipped_total Started songs left without an announced successor, by bounded reason (once per song).',
      '# TYPE alcantara_radio_announcement_skipped_total counter',
    );
    for (const reason of ANNOUNCEMENT_SKIP_REASONS) {
      lines.push(
        `alcantara_radio_announcement_skipped_total{reason="${reason}"} ${this.announcementSkips.get(reason) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_bumpers_total Bumper spots by how they reached Palazzo (announced with the next song, or command after the end) and result (sent, played on Palazzo, failed: a command spot Palazzo did not take, retried: a command spot Palazzo refused as not ready yet and the engine sent again).',
      '# TYPE alcantara_radio_bumpers_total counter',
    );
    for (const path of BUMPER_PATHS) {
      for (const result of BUMPER_RESULTS) {
        if (!isBumperSeries(path, result)) continue;
        lines.push(
          `alcantara_radio_bumpers_total{path="${path}",result="${result}"} ${this.bumpers.get(`${path}\t${result}`) ?? 0}`,
        );
      }
    }
    lines.push(
      '# HELP alcantara_radio_cursor_writes_total Writes of the playlist cursor after it advanced, by result (succeeded; failed: the database refused or timed out, the next song is not delayed; conflict: the stored sequence was edited meanwhile, or changed under the write, so nothing was written).',
      '# TYPE alcantara_radio_cursor_writes_total counter',
    );
    for (const result of CURSOR_WRITE_RESULTS) {
      lines.push(
        `alcantara_radio_cursor_writes_total{result="${result}"} ${this.cursorWrites.get(result) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_inherited_adoptions_total Songs on air at a restart that the engine recorded as its own, by how it recognised them (leaf: the one sequence leaf with that audio; cursor_leaf: the leaf the cursor points at, when the audio is not unique in the sequence; catalogue: the song catalogue, outside the cursor).',
      '# TYPE alcantara_radio_inherited_adoptions_total counter',
    );
    for (const path of INHERITED_ADOPTION_PATHS) {
      lines.push(
        `alcantara_radio_inherited_adoptions_total{path="${path}"} ${this.inheritedAdoptions.get(path) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_high_rotation_favorites Configured high rotation playlist songs across radio-capable programs.',
      '# TYPE alcantara_radio_high_rotation_favorites gauge',
      `alcantara_radio_high_rotation_favorites ${this.highRotationFavorites}`,
      '# HELP alcantara_radio_automatic_programs Radio programs in autoplay or shuffle, whose rotation the engine runs on its own.',
      '# TYPE alcantara_radio_automatic_programs gauge',
      `alcantara_radio_automatic_programs ${this.automaticPrograms}`,
    );
    lines.push(
      '# HELP alcantara_palazzo_machine_requests_total Program-scoped Palazzo machine requests by bounded operation and result.',
      '# TYPE alcantara_palazzo_machine_requests_total counter',
    );
    for (const operation of MACHINE_OPERATIONS) {
      for (const result of MACHINE_RESULTS) {
        lines.push(
          `alcantara_palazzo_machine_requests_total{operation="${operation}",result="${result}"} ${this.machineRequests.get(`${operation}:${result}`) ?? 0}`,
        );
      }
    }
    lines.push(
      '# HELP alcantara_radio_output_confidence_transitions_total Output confidence state transitions by bounded state.',
      '# TYPE alcantara_radio_output_confidence_transitions_total counter',
    );
    for (const state of OUTPUT_CONFIDENCE_STATES) {
      lines.push(
        `alcantara_radio_output_confidence_transitions_total{state="${state}"} ${this.outputConfidenceTransitions.get(state) ?? 0}`,
      );
    }
    lines.push(
      '# HELP alcantara_radio_output_silent_programs Radio programs with expected playback and confirmed low output level.',
      '# TYPE alcantara_radio_output_silent_programs gauge',
      `alcantara_radio_output_silent_programs ${this.outputSilentPrograms}`,
    );
    lines.push(
      '# HELP alcantara_radio_monitor_sessions_total Backend Program monitor connection transitions.',
      '# TYPE alcantara_radio_monitor_sessions_total counter',
      ...Object.entries(this.monitorSessions).map(
        ([result, value]) =>
          `alcantara_radio_monitor_sessions_total{result="${result}"} ${value}`,
      ),
      '# HELP alcantara_radio_listener_configuration_total Listener URL persistence outcomes, including validation failures.',
      '# TYPE alcantara_radio_listener_configuration_total counter',
      ...(['success', 'failure'] as const).map(
        (result) =>
          `alcantara_radio_listener_configuration_total{result="${result}"} ${this.listenerConfiguration[result]}`,
      ),
      '# HELP alcantara_radio_operator_change_records_total Operator change records of radio settings writes by result; a failed record never fails the write.',
      '# TYPE alcantara_radio_operator_change_records_total counter',
      ...(['recorded', 'failed'] as const).map(
        (result) =>
          `alcantara_radio_operator_change_records_total{result="${result}"} ${this.operatorChangeRecords[result]}`,
      ),
      '# HELP alcantara_program_bus_overlaps_total Two sources on a radio program bus past the allowance, by kind (song_song, spot_song).',
      '# TYPE alcantara_program_bus_overlaps_total counter',
      ...(['song_song', 'spot_song'] as const).map(
        (kind) =>
          `alcantara_program_bus_overlaps_total{kind="${kind}"} ${this.programBusOverlaps[kind]}`,
      ),
      '# HELP alcantara_program_bus_overlap_active Raised overlaps on a radio program bus that are on air now, by kind.',
      '# TYPE alcantara_program_bus_overlap_active gauge',
      ...(['song_song', 'spot_song'] as const).map(
        (kind) =>
          `alcantara_program_bus_overlap_active{kind="${kind}"} ${this.programBusOverlapsActive[kind]}`,
      ),
      '# HELP alcantara_program_bus_overlap_flags_total As-run review flags of raised overlaps by result; a failed flag never affects playout.',
      '# TYPE alcantara_program_bus_overlap_flags_total counter',
      ...(['flagged', 'missing', 'failed'] as const).map(
        (result) =>
          `alcantara_program_bus_overlap_flags_total{result="${result}"} ${this.programBusOverlapFlags[result]}`,
      ),
    );
    lines.push(
      '# HELP alcantara_radio_log_transitions_total Clocked radio log transitions by bounded result.',
      '# TYPE alcantara_radio_log_transitions_total counter',
    );
    for (const result of RADIO_LOG_RESULTS)
      lines.push(
        `alcantara_radio_log_transitions_total{result="${result}"} ${this.radioLogResults.get(result) ?? 0}`,
      );
    lines.push(
      '# HELP alcantara_radio_recovery_preparations_total Recovery playlist preparation by bounded result.',
      '# TYPE alcantara_radio_recovery_preparations_total counter',
    );
    for (const result of RECOVERY_PREPARATION_RESULTS)
      lines.push(
        `alcantara_radio_recovery_preparations_total{result="${result}"} ${this.recoveryPreparations.get(result) ?? 0}`,
      );
    lines.push(
      '# HELP alcantara_palazzo_machine_retries_total Retried idempotent Palazzo machine requests by bounded operation.',
      '# TYPE alcantara_palazzo_machine_retries_total counter',
    );
    for (const operation of MACHINE_OPERATIONS) {
      lines.push(
        `alcantara_palazzo_machine_retries_total{operation="${operation}"} ${this.machineRetries.get(operation) ?? 0}`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }
}
