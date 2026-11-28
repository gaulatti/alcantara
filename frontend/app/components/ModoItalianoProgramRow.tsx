import React, { Suspense, lazy, type ComponentType } from 'react';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import type { ProgramRowPlan } from '../utils/programRow';
import { GIORGIA } from '@modoitaliano/giorgia/scenes';
import { ModoItalianoGiorgiaChyron, ModoItalianoGiorgiaClock, audioBus } from '../scenes/packagedScenes';

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

interface LibraryRowProps {
  programId: string;
  timeOverride: GlobalTimeOverride | null;
  songSequence?: unknown;
  audioBus: typeof audioBus;
  clockProps: { showWorldClocks: boolean; showLogo: boolean; showPlaybackProgress: boolean; keySafe: boolean };
  chyronProps: { show: boolean; textSequence?: unknown; ctaSequence?: unknown; keySafe: boolean };
}

/**
 * Giorgia's own program row when the installed version ships one, else the copy below. The copy goes, with this
 * choice, once the app depends on a release that has it.
 */
const ProgramRow = lazy(async () => {
  const scenes = (await import('@modoitaliano/giorgia/scenes')) as unknown as Record<string, unknown>;
  const Library = 'ModoItalianoGiorgiaProgramRow' in scenes ? (scenes.ModoItalianoGiorgiaProgramRow as ComponentType<LibraryRowProps> | undefined) : undefined;
  return { default: (Library ?? LocalProgramRow) as ComponentType<LibraryRowProps> };
});

/**
 * The bottom row a scene's Giorgia clock and chyron share, as decided by `resolveProgramRow`.
 */
export const ModoItalianoProgramRow: React.FC<ModoItalianoProgramRowProps> = ({ plan, metadata, programId, timeOverride = null, songSequence }) => {
  const chyron = metadata[plan.chyronType] || {};
  const clock = metadata[plan.clockType] || {};
  // One switch for the pair: set on either component, it applies to both.
  const keySafe = toBoolean(clock.keySafe, false) || toBoolean(chyron.keySafe, false);
  return (
    <Suspense fallback={null}>
      <ProgramRow
        programId={programId}
        timeOverride={timeOverride}
        songSequence={songSequence}
        audioBus={audioBus}
        clockProps={{
          showWorldClocks: toBoolean(clock.showWorldClocks, true),
          showLogo: toBoolean(clock.showLogo, true),
          showPlaybackProgress: toBoolean(clock.showPlaybackProgress, true),
          keySafe
        }}
        chyronProps={{ show: toBoolean(chyron.show, true), textSequence: chyron.textSequence, ctaSequence: chyron.ctaSequence, keySafe }}
      />
    </Suspense>
  );
};

function LocalProgramRow({ programId, timeOverride, songSequence, clockProps, chyronProps }: LibraryRowProps) {
  const clockCommonProps = {
    programId,
    timeOverride,
    transitionDurationMs: 300,
    shuffleCities: false,
    widthPx: 220,
    showWorldClocks: clockProps.showWorldClocks,
    showLogo: clockProps.showLogo,
    showPlaybackProgress: clockProps.showPlaybackProgress,
    showBellIcon: false,
    songSequence,
    language: 'es' as const
  };
  const keySafe = clockProps.keySafe;
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
          <ModoItalianoGiorgiaChyron show={chyronProps.show} textSequence={chyronProps.textSequence} ctaSequence={chyronProps.ctaSequence} inline keySafe={keySafe} />
        </div>
        <div data-program-row-slot='clock' className='min-w-0'>
          <ModoItalianoGiorgiaClock {...clockCommonProps} part='onAir' inline keySafe={keySafe} />
        </div>
      </div>
    </>
  );
}
