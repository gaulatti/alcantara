import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { ProgramFillerState } from '../models/filler';

/**
 * Says up front that renaming a show leaves its filler to be prepared again (gaulatti/alcantara#122): the playout
 * engines hold a prepared filler under the old ID. It says nothing for a show with no prepared filler, or when the
 * filler state cannot be read.
 */
export function RenameFillerNotice({ programId, nextProgramId }: { programId: string; nextProgramId: string }) {
  const renaming = nextProgramId.trim() !== '' && nextProgramId.trim() !== programId;
  const [prepared, setPrepared] = useState<string | null>(null);

  useEffect(() => {
    if (!renaming) return;
    let current = true;
    api
      .get<ProgramFillerState>(`/broadcast/programs/${encodeURIComponent(programId)}/fillers`)
      .then(({ data }) => {
        const hasFiller = Object.values(data.legs).some((leg) => leg.pending || leg.active);
        if (current && hasFiller) setPrepared(programId);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [programId, renaming]);

  if (!renaming || prepared !== programId) return null;
  return (
    <p role="status" className="mt-2 text-sm text-amber-300">
      Its filler will need preparing again.
    </p>
  );
}
