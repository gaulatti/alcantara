import React, { Suspense, lazy, type ComponentType } from 'react';
import { getProgramAudioBusSnapshot, subscribeProgramAudioBus } from '../utils/programAudioBus';
// The current local renderer: the fallback until the closer deletes it.
import { ModoItalianoClock as LocalClock } from './ModoItalianoClock';

type ClockProps = React.ComponentProps<typeof LocalClock>;
type PackagedClockProps = ClockProps & { audioBus: typeof audioBus };

/** The packaged clock reads the playing song through this; the identity is stable on purpose. */
const audioBus = { getSnapshot: getProgramAudioBusSnapshot, subscribe: subscribeProgramAudioBus };

/**
 * Giorgia's legacy clock when the pinned @modoitaliano/giorgia exports it from `/scenes/legacy`,
 * otherwise the local renderer (gaulatti/alcantara#391). A missing export falls back; a failed
 * import is a real defect and surfaces. The closer imports the export directly and deletes the
 * local renderer and this fallback.
 */
const Clock = lazy(async () => {
  const module = (await import('@modoitaliano/giorgia/scenes/legacy')) as Record<string, unknown>;
  const packaged = 'ModoItalianoClock' in module ? (module.ModoItalianoClock as ComponentType<PackagedClockProps>) : undefined;
  return { default: packaged ?? (LocalClock as ComponentType<PackagedClockProps>) };
});

export function GiorgiaLegacyClockRenderer(props: ClockProps) {
  return (
    <Suspense fallback={null}>
      <Clock {...props} audioBus={audioBus} />
    </Suspense>
  );
}
