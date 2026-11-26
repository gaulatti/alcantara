/**
 * The program filler API (gaulatti/alcantara#126, docs/program-filler.md),
 * as the operator UI reads it. Pinned here rather than imported from the
 * backend; `fillerFixture.ts` holds a response in exactly this shape.
 */
export type FillerLegName = 'television' | 'radio';

export interface FillerVersionSummary {
  version: string;
  checksum: string;
  status: 'preparing' | 'ready' | 'failed';
  reason: string | null;
  config: {
    sources: { assetId: string; sha256: string }[];
    mode: 'loop' | 'ordered' | 'shuffle';
    shuffleSeed?: string;
    profileChecksum?: string;
  };
  createdAt: string;
  preparedAt: string | null;
}

export interface FillerLegState {
  pending: FillerVersionSummary | null;
  active: FillerVersionSummary | null;
  /** Set when a configured leg was left with nothing prepared, by a rename. */
  needsPreparing?: boolean;
}

export interface ProgramFillerState {
  programId: string;
  legs: Partial<Record<FillerLegName, FillerLegState>>;
}
