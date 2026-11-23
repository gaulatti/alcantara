import React, { Suspense, lazy, type ComponentType } from 'react';
import { getProgramAudioBusSnapshot, subscribeProgramAudioBus } from '../utils/programAudioBus';
// The current local renderer: the fallback until the closer deletes it.
import { ModoItalianoGiorgiaClock as LocalClock } from './ModoItalianoGiorgiaClock';

type ClockProps = React.ComponentProps<typeof LocalClock>;

/** The packaged clock reads the playing song through this; the identity is stable on purpose. */
const audioBus = { getSnapshot: getProgramAudioBusSnapshot, subscribe: subscribeProgramAudioBus };

/**
 * Giorgia's clock when the pinned @modoitaliano/giorgia exports it from `/scenes`, otherwise the
 * local renderer (gaulatti/alcantara#382). The program audio bus is passed in as the packaged
 * clock's `audioBus`; the local clock reads it itself and ignores the prop.
 */
const Clock = lazy(async () => {
  const module = (await import('@modoitaliano/giorgia/scenes')) as Record<string, unknown>;
  const packaged =
    'ModoItalianoGiorgiaClock' in module
      ? (module.ModoItalianoGiorgiaClock as ComponentType<ClockProps & { audioBus: typeof audioBus }>)
      : undefined;
  return { default: packaged ?? (LocalClock as ComponentType<ClockProps & { audioBus: typeof audioBus }>) };
});

export function GiorgiaClockRenderer(props: ClockProps) {
  return (
    <Suspense fallback={null}>
      <Clock {...props} audioBus={audioBus} />
    </Suspense>
  );
}
