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
}

/** Which ends a SoundExchange export counts: all, only inferred, or none inferred. */
export type AsRunInferredFilter = 'include' | 'only' | 'exclude';

/** Review flags an inferred end can carry. */
export type AsRunReviewFlag = 'short' | 'no-start';

/**
 * An inferred end less than this long after its start is recorded and counted,
 * but flagged `short` for review: a play that brief through a dropped
 * connection is more likely a stale reconnect or an immediate skip.
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
