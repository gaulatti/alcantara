import React from 'react';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import type { ProgramRowPlan } from '../utils/programRow';
import { ModoItalianoChyron } from './ModoItalianoChyron';
import { ModoItalianoClock } from './ModoItalianoClock';
import { ModoItalianoDisclaimer } from './ModoItalianoDisclaimer';
import { ModoItalianoGiorgiaChyron } from './ModoItalianoGiorgiaChyron';
import { ModoItalianoGiorgiaClock } from './ModoItalianoGiorgiaClock';
import { GIORGIA } from './giorgiaBroadcast';

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
 * The bottom row a scene's Modo Italiano clock and chyron share, as decided by
 * `resolveProgramRow`. The Giorgia and legacy families each have their own
 * layout; the legacy one is kept exactly as it has always rendered.
 */
export const ModoItalianoProgramRow: React.FC<ModoItalianoProgramRowProps> = ({ plan, metadata, programId, timeOverride = null, songSequence }) => {
  const chyronProps = (plan.chyronType ? metadata[plan.chyronType] : null) || {};
  const clockProps = metadata[plan.clockType] || {};
  const showChyron = Boolean(plan.chyronType) && toBoolean(chyronProps.show, true);
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

  if (plan.clockType === 'modoitaliano-giorgia-clock') {
    return (
      <>
        {/* The Giorgia clock is a top-left header, separate from the row; only its on-air block sits in the row. */}
        <ModoItalianoGiorgiaClock {...clockCommonProps} part='header' />
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
            <ModoItalianoGiorgiaChyron show={showChyron} textSequence={chyronProps.textSequence} ctaSequence={chyronProps.ctaSequence} inline />
          </div>
          <div data-program-row-slot='clock' className='min-w-0'>
            <ModoItalianoGiorgiaClock {...clockCommonProps} part='onAir' inline />
          </div>
        </div>
      </>
    );
  }

  const disclaimerProps = metadata['modoitaliano-disclaimer'] || {};
  const disclaimerText = typeof disclaimerProps.text === 'string' ? disclaimerProps.text.trim() : '';
  const showDisclaimer = plan.hasDisclaimer && !showChyron && toBoolean(disclaimerProps.show, true) && !!disclaimerText;

  return (
    <div data-program-row='legacy' className='absolute z-[950] flex items-end gap-6' style={{ left: '110px', right: '110px', bottom: '110px' }}>
      <div data-program-row-slot='chyron' className='flex-1 min-w-0'>
        {showChyron ? (
          <ModoItalianoChyron show textSequence={chyronProps.textSequence} ctaSequence={chyronProps.ctaSequence} inline />
        ) : showDisclaimer ? (
          <ModoItalianoDisclaimer
            text={disclaimerProps.text || ''}
            show
            align={disclaimerProps.align === 'left' || disclaimerProps.align === 'center' || disclaimerProps.align === 'right' ? disclaimerProps.align : 'right'}
            fontSizePx={typeof disclaimerProps.fontSizePx === 'number' ? disclaimerProps.fontSizePx : 20}
            opacity={typeof disclaimerProps.opacity === 'number' ? disclaimerProps.opacity : 0.82}
            inline
          />
        ) : null}
      </div>
      <div data-program-row-slot='clock' className='shrink-0'>
        <ModoItalianoClock {...clockCommonProps} inline />
      </div>
    </div>
  );
};
