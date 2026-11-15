export interface AsRunTrackEvent {
  programId: string;
  type: 'track.started' | 'track.ended';
  playbackRequestId: string;
  title: string | null;
  artist: string | null;
  url: string | null;
  at: Date;
}

export type AsRunExportFormat = 'csv' | 'soundexchange';

export interface AsRunExportQuery {
  from?: string;
  to?: string;
  format?: string;
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
