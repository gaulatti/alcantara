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
 * at once (gaulatti/palazzo#40). Stored on the `ended` row; NULL for
 * Palazzo's own and idle-inferred ends.
 */
export type AsRunEndReason =
  | 'stopped'
  | 'replaced'
  | 'superseded'
  | 'preempted';

export const AS_RUN_END_REASONS: readonly string[] = [
  'stopped',
  'replaced',
  'superseded',
  'preempted',
];

/**
 * End reasons that are recorded but never counted as a performance: a
 * preempted song was on air for at most the moment the engine took to replace
 * it at the handoff.
 */
export const AS_RUN_UNCOUNTED_END_REASONS: readonly string[] = ['preempted'];

/** Which ends a SoundExchange export counts: all, only inferred, or none inferred. */
export type AsRunInferredFilter = 'include' | 'only' | 'exclude';

/** Review flags an inferred end can carry. */
export type AsRunReviewFlag = 'short' | 'no-start';

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
