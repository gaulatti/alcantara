import React, { Suspense, lazy, type ComponentType } from 'react';
// The current local renderer: the fallback until the closer deletes it.
import { ModoItalianoPodcastPlayer as LocalPodcastPlayer } from './ModoItalianoPodcastPlayer';

type PodcastPlayerProps = React.ComponentProps<typeof LocalPodcastPlayer>;
type PackagedPodcastPlayerProps = PodcastPlayerProps;

/**
 * Giorgia's legacy podcastplayer when the pinned @modoitaliano/giorgia exports it from `/scenes/legacy`,
 * otherwise the local renderer (gaulatti/alcantara#391). A missing export falls back; a failed
 * import is a real defect and surfaces. The closer imports the export directly and deletes the
 * local renderer and this fallback.
 */
const PodcastPlayer = lazy(async () => {
  const module = (await import('@modoitaliano/giorgia/scenes/legacy')) as Record<string, unknown>;
  const packaged = 'ModoItalianoPodcastPlayer' in module ? (module.ModoItalianoPodcastPlayer as ComponentType<PackagedPodcastPlayerProps>) : undefined;
  return { default: packaged ?? (LocalPodcastPlayer as ComponentType<PackagedPodcastPlayerProps>) };
});

export function GiorgiaLegacyPodcastPlayerRenderer(props: PodcastPlayerProps) {
  return (
    <Suspense fallback={null}>
      <PodcastPlayer {...props} />
    </Suspense>
  );
}
