import React, { Suspense, lazy, type ComponentType } from 'react';
// The current local renderer: the fallback until the closer deletes it.
import { ModoItalianoGiorgiaPodcastPlayer as LocalPodcastPlayer } from './ModoItalianoGiorgiaPodcastPlayer';

type PodcastPlayerProps = React.ComponentProps<typeof LocalPodcastPlayer>;

/**
 * Giorgia's podcast player when the pinned @modoitaliano/giorgia exports it from `/scenes`,
 * otherwise the local renderer (gaulatti/alcantara#382).
 */
const PodcastPlayer = lazy(async () => {
  const module = (await import('@modoitaliano/giorgia/scenes')) as Record<string, unknown>;
  const packaged =
    'ModoItalianoGiorgiaPodcastPlayer' in module
      ? (module.ModoItalianoGiorgiaPodcastPlayer as ComponentType<PodcastPlayerProps>)
      : undefined;
  return { default: packaged ?? LocalPodcastPlayer };
});

export function GiorgiaPodcastPlayerRenderer(props: PodcastPlayerProps) {
  return (
    <Suspense fallback={null}>
      <PodcastPlayer {...props} />
    </Suspense>
  );
}
