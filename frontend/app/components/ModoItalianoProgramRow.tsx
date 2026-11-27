import React from 'react';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import type { ProgramRowPlan } from '../utils/programRow';
import { GIORGIA } from '@modoitaliano/giorgia/scenes';
import { ModoItalianoGiorgiaChyron, ModoItalianoGiorgiaClock } from '../scenes/packagedScenes';

interface ModoItalianoProgramRowProps {
  plan: ProgramRowPlan;
  /** Scene metadata keyed by component type. */
  metadata: Record<string, any>;
  programId: string;
  timeOverride?: GlobalTimeOverride | null;
  songSequence?: unknown;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return fallback;
}

/**
 * The bottom row a scene's Giorgia clock and chyron share, as decided by `resolveProgramRow`.
 */
export const ModoItalianoProgramRow: React.FC<ModoItalianoProgramRowProps> = ({ plan, metadata, programId, timeOverride = null, songSequence }) => {
  const chyronProps = metadata[plan.chyronType] || {};
  const clockProps = metadata[plan.clockType] || {};
  const showChyron = toBoolean(chyronProps.show, true);
  const clockCommonProps = {
    programId,
    timeOverride,
    transitionDurationMs: 300,
    shuffleCities: false,
    widthPx: 220,
    showWorldClocks: toBoolean(clockProps.showWorldClocks, true),
    showLogo: toBoolean(clockProps.showLogo, true),
    showPlaybackProgress: toBoolean(clockProps.showPlaybackProgress, true),
    showBellIcon: false,
    songSequence,
    language: 'es' as const
  };

  // One switch for the pair: set on either component, it applies to both.
  const keySafe = toBoolean(clockProps.keySafe, false) || toBoolean(chyronProps.keySafe, false);
  return (
    <>
      {/* The Giorgia clock is a top-left header, separate from the row; only its on-air block sits in the row. */}
      <ModoItalianoGiorgiaClock {...clockCommonProps} part='header' keySafe={keySafe} />
      <div
        data-program-row='giorgia'
        className='absolute z-[950] flex items-end gap-12'
        style={{ left: `${GIORGIA.safeX}px`, right: `${GIORGIA.safeX}px`, bottom: `${GIORGIA.safeBottom}px` }}
      >
        {/*
          The headline keeps at least half the row, so a long now-playing title cannot squeeze it out.
          While the chyron is hidden the slot is empty and removed, and the on-air block takes the left edge.
        */}
        <div data-program-row-slot='chyron' className='flex-1 min-w-[50%] empty:hidden'>
          <ModoItalianoGiorgiaChyron show={showChyron} textSequence={chyronProps.textSequence} ctaSequence={chyronProps.ctaSequence} inline keySafe={keySafe} />
        </div>
        <div data-program-row-slot='clock' className='min-w-0'>
          <ModoItalianoGiorgiaClock {...clockCommonProps} part='onAir' inline keySafe={keySafe} />
        </div>
      </div>
    </>
  );
};
