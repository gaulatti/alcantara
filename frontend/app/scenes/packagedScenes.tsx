import React, { Suspense, lazy } from 'react';
import { getProgramAudioBusSnapshot, subscribeProgramAudioBus } from '../utils/programAudioBus';
import { fetchSongCatalog } from '../services/songs';
import type { ModoItalianoGiorgiaChyronProps, ModoItalianoPodcastPlayerProps, ModoItalianoGiorgiaClockProps } from '@modoitaliano/giorgia/scenes';
import type {
  ModoItalianoBracketProps,
  ModoItalianoChyronProps,
  ModoItalianoClockProps,
  ModoItalianoPodcastPlayerProps as LegacyPodcastPlayerProps,
} from '@modoitaliano/giorgia/scenes/legacy';

/**
 * The on-air scene renderers are @modoitaliano/giorgia's (gaulatti/alcantara#382, #391). This
 * module only loads the package when a scene is on screen and supplies what the library cannot
 * know: this app's program audio bus for the clocks and its song catalog for the bracket. No
 * renderer component lives in this app; `scenes/noLocalRenderers.test.ts` keeps it that way.
 */

/** The clocks read the playing song through this; the identity is stable on purpose. */
const audioBus = { getSnapshot: getProgramAudioBusSnapshot, subscribe: subscribeProgramAudioBus };

const Chyron = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes')).ModoItalianoGiorgiaChyron }));
const Clock = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes')).ModoItalianoGiorgiaClock }));
const PodcastPlayer = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes')).ModoItalianoGiorgiaPodcastPlayer }));
const LegacyChyron = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes/legacy')).ModoItalianoChyron }));
const LegacyClock = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes/legacy')).ModoItalianoClock }));
const LegacyBracket = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes/legacy')).ModoItalianoBracket }));
const LegacyPodcastPlayer = lazy(async () => ({ default: (await import('@modoitaliano/giorgia/scenes/legacy')).ModoItalianoPodcastPlayer }));

export function ModoItalianoGiorgiaChyron(props: ModoItalianoGiorgiaChyronProps) {
  return (
    <Suspense fallback={null}>
      <Chyron {...props} />
    </Suspense>
  );
}

export function ModoItalianoGiorgiaClock(props: Omit<ModoItalianoGiorgiaClockProps, 'audioBus'>) {
  return (
    <Suspense fallback={null}>
      <Clock {...props} audioBus={audioBus} />
    </Suspense>
  );
}

export function ModoItalianoGiorgiaPodcastPlayer(props: ModoItalianoPodcastPlayerProps) {
  return (
    <Suspense fallback={null}>
      <PodcastPlayer {...props} />
    </Suspense>
  );
}

export function ModoItalianoChyron(props: ModoItalianoChyronProps) {
  return (
    <Suspense fallback={null}>
      <LegacyChyron {...props} />
    </Suspense>
  );
}

export function ModoItalianoClock(props: Omit<ModoItalianoClockProps, 'audioBus'>) {
  return (
    <Suspense fallback={null}>
      <LegacyClock {...props} audioBus={audioBus} />
    </Suspense>
  );
}

export function ModoItalianoBracket(props: Omit<ModoItalianoBracketProps, 'loadSongCatalog'>) {
  return (
    <Suspense fallback={null}>
      <LegacyBracket {...props} loadSongCatalog={fetchSongCatalog} />
    </Suspense>
  );
}

export function ModoItalianoPodcastPlayer(props: LegacyPodcastPlayerProps) {
  return (
    <Suspense fallback={null}>
      <LegacyPodcastPlayer {...props} />
    </Suspense>
  );
}
