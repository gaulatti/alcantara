export interface AsRunTrackEvent {
  programId: string;
  type: 'track.started' | 'track.ended';
  playbackRequestId: string;
  title: string | null;
  artist: string | null;
  url: string | null;
  at: Date;
  /** True on an end the engine inferred because the real end never arrived. */
  inferred?: boolean;
  /** Why the engine itself ended a started play; absent on Palazzo's own ends. */
  endReason?: AsRunEndReason;
  /**
   * Who caused the transition (gaulatti/alcantara#213), captured when the
   * operator command arrived: the Pompeii principal, `console` or `mcp`, and
   * the MCP client name. Absent on automatic transitions.
   */
  actorPrincipalId?: string | null;
  actorVia?: string | null;
  actorClient?: string | null;
}

export const AS_RUN_ACTOR_VIAS: readonly string[] = ['console', 'mcp'];

/**
 * Why the engine itself ended a started play: an operator Stop, a manual pick
 * that cut it, a playing snapshot that reported another track (inferred), or
 * `preempted`: a song announced as next that Palazzo started at the handoff
 * although it was no longer the engine's successor, so the engine replaced it
 * at once (gaulatti/palazzo#40). `not_aired`: Palazzo ended a song within a
 * second of starting it, so nothing of it was heard (gaulatti/palazzo#75).
 * Stored on the `ended` row; NULL for Palazzo's other and idle-inferred ends.
 */
export type AsRunEndReason =
  | 'stopped'
  | 'replaced'
  | 'superseded'
  | 'preempted'
  | 'fixed_start'
  | 'playout_restart'
  | 'dead_air'
  | 'not_aired';

export const AS_RUN_END_REASONS: readonly string[] = [
  'stopped',
  'replaced',
  'superseded',
  'preempted',
  // A timed block's fixed start cut the song (the airing walk). It aired until then, so it is counted, as a stop is.
  'fixed_start',
  // Palazzo restarted under the song: it aired up to the cut, so it is counted, and the row says it was cut.
  'playout_restart',
  // The dead-air watchdog played the song again, or moved past it, after it went silent on air. It aired until it fell
  // silent, so it is counted, as a stop is.
  'dead_air',
  'not_aired',
];

/**
 * End reasons that are recorded but never counted as a performance: a
 * preempted song was on air for at most the moment the engine took to replace
 * it at the handoff, and a song that never aired was not heard at all.
 */
export const AS_RUN_UNCOUNTED_END_REASONS: readonly string[] = [
  'preempted',
  'not_aired',
];

/** Which ends a SoundExchange export counts: all, only inferred, or none inferred. */
export type AsRunInferredFilter = 'include' | 'only' | 'exclude';

/** Review flags an inferred end can carry. */
/**
 * `short`: an inferred or engine-caused end soon after its start. `no-start`:
 * an end with no recorded start. `unended`: a play whose end never arrived (it
 * ended while the backend was down) closed once a later play ended
 * (gaulatti/alcantara#241). `overlap`: a start that came on air while another
 * song or a spot was still on the bus, past the allowance (gaulatti/alcantara#242).
 */
export type AsRunReviewFlag = 'short' | 'no-start' | 'unended' | 'overlap';

/**
 * How far back an open play is looked for when a later play ends (#241): at
 * most this long before the play that ended, and never earlier than this long
 * before the process started. The play on air at a restart started minutes
 * before it; older open rows are history, listed by
 * scripts/list-as-run-anomalies.mjs and corrected only by the owner's decision.
 */
export const AS_RUN_UNENDED_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const AS_RUN_UNENDED_BEFORE_BOOT_MS = 60 * 60 * 1000;

/**
 * An inferred end, or an end the engine caused (see AsRunEndReason), less than
 * this long after its start is recorded and counted, but flagged `short` for
 * review: a play that brief is more likely a stale reconnect or an immediate
 * skip.
 */
export const AS_RUN_SHORT_INFERRED_PLAY_MS = 30_000;

export type AsRunExportFormat = 'csv' | 'soundexchange';

export interface AsRunExportQuery {
  from?: string;
  to?: string;
  format?: string;
  inferred?: string;
}

export interface SoundExchangeRow {
  transmissionCategory: string;
  featuredArtist: string;
  soundRecordingTitle: string;
  isrc: string;
  albumTitle: string;
  marketingLabel: string;
  actualTotalPerformances: number;
}

export const SOUNDEXCHANGE_SPECIFICATION_VERSION =
  '37 CFR § 370.4 / SoundExchange Report of Use Delivery Specifications';

/** One sound recording's counted performances in a window. */
export interface AsRunPerformance {
  songId: number | null;
  assetId: string | null;
  artist: string;
  title: string;
  count: number;
}

/** One as-run log row as a read-only consumer sees it. */
export interface AsRunListedRecord {
  id: number;
  songId: number | null;
  assetId: string | null;
  title: string;
  artist: string;
  state: string;
  at: Date;
  playbackRequestId: string | null;
  inferred: boolean;
  reviewFlag: string | null;
  endReason: string | null;
  actorPrincipalId: string | null;
  actorVia: string | null;
  actorClient: string | null;
}
