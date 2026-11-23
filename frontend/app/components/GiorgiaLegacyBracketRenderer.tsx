import React, { Suspense, lazy, type ComponentType } from 'react';
import { fetchSongCatalog } from '../services/songs';
// The current local renderer: the fallback until the closer deletes it.
import { ModoItalianoBracket as LocalBracket } from './ModoItalianoBracket';

type BracketProps = React.ComponentProps<typeof LocalBracket>;
type PackagedBracketProps = BracketProps & { loadSongCatalog: typeof fetchSongCatalog };

/**
 * Giorgia's legacy bracket when the pinned @modoitaliano/giorgia exports it from `/scenes/legacy`,
 * otherwise the local renderer (gaulatti/alcantara#391). A missing export falls back; a failed
 * import is a real defect and surfaces. The closer imports the export directly and deletes the
 * local renderer and this fallback.
 */
const Bracket = lazy(async () => {
  const module = (await import('@modoitaliano/giorgia/scenes/legacy')) as Record<string, unknown>;
  const packaged = 'ModoItalianoBracket' in module ? (module.ModoItalianoBracket as ComponentType<PackagedBracketProps>) : undefined;
  return { default: packaged ?? (LocalBracket as ComponentType<PackagedBracketProps>) };
});

export function GiorgiaLegacyBracketRenderer(props: BracketProps) {
  return (
    <Suspense fallback={null}>
      <Bracket {...props} loadSongCatalog={fetchSongCatalog} />
    </Suspense>
  );
}
