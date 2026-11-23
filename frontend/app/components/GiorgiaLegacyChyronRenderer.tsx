import React, { Suspense, lazy, type ComponentType } from 'react';
// The current local renderer: the fallback until the closer deletes it.
import { ModoItalianoChyron as LocalChyron } from './ModoItalianoChyron';

type ChyronProps = React.ComponentProps<typeof LocalChyron>;
type PackagedChyronProps = ChyronProps;

/**
 * Giorgia's legacy chyron when the pinned @modoitaliano/giorgia exports it from `/scenes/legacy`,
 * otherwise the local renderer (gaulatti/alcantara#391). A missing export falls back; a failed
 * import is a real defect and surfaces. The closer imports the export directly and deletes the
 * local renderer and this fallback.
 */
const Chyron = lazy(async () => {
  const module = (await import('@modoitaliano/giorgia/scenes/legacy')) as Record<string, unknown>;
  const packaged = 'ModoItalianoChyron' in module ? (module.ModoItalianoChyron as ComponentType<PackagedChyronProps>) : undefined;
  return { default: packaged ?? (LocalChyron as ComponentType<PackagedChyronProps>) };
});

export function GiorgiaLegacyChyronRenderer(props: ChyronProps) {
  return (
    <Suspense fallback={null}>
      <Chyron {...props} />
    </Suspense>
  );
}
