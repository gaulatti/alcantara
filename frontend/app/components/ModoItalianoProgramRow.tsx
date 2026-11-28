import React, { Suspense, lazy } from 'react';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import type { ProgramRowPlan } from '../utils/programRow';
import { audioBus } from '../scenes/packagedScenes';

interface ModoItalianoProgramRowProps {
  plan: ProgramRowPlan;
  /** Scene metadata keyed by component type. */
  metadata: Record<string, any>;
  programId: string;
  timeOverride?: GlobalTimeOverride | null;
  songSequence?: unknown;
}

const ProgramRow = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes')).ModoItalianoGiorgiaProgramRow }));

/**
 * Hands Giorgia's program row the stored settings of the scene's clock and chyron, as decided by
 * `resolveProgramRow`. The library reads them and draws the row.
 */
export const ModoItalianoProgramRow: React.FC<ModoItalianoProgramRowProps> = ({ plan, metadata, programId, timeOverride = null, songSequence }) => (
  <Suspense fallback={null}>
    <ProgramRow
      programId={programId}
      timeOverride={timeOverride}
      songSequence={songSequence}
      audioBus={audioBus}
      clockProps={metadata[plan.clockType] || {}}
      chyronProps={metadata[plan.chyronType] || {}}
    />
  </Suspense>
);
