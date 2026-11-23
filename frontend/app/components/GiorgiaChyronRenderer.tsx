import React, { Suspense, lazy, type ComponentType } from 'react';
// The current local renderer: the fallback until the closer deletes it.
import { ModoItalianoGiorgiaChyron as LocalChyron } from './ModoItalianoGiorgiaChyron';

type ChyronProps = React.ComponentProps<typeof LocalChyron>;

/**
 * Giorgia's chyron when the pinned @modoitaliano/giorgia exports it from `/scenes`, otherwise the
 * local renderer (gaulatti/alcantara#382). The package is loaded only when the component is on
 * screen. A missing export falls back; a failed import is a real defect and surfaces. The closer
 * bumps the pin, imports the export directly and deletes the local renderer and this fallback.
 */
const Chyron = lazy(async () => {
  const module = (await import('@modoitaliano/giorgia/scenes')) as Record<string, unknown>;
  const packaged =
    'ModoItalianoGiorgiaChyron' in module ? (module.ModoItalianoGiorgiaChyron as ComponentType<ChyronProps>) : undefined;
  return { default: packaged ?? LocalChyron };
});

export function GiorgiaChyronRenderer(props: ChyronProps) {
  return (
    <Suspense fallback={null}>
      <Chyron {...props} />
    </Suspense>
  );
}
