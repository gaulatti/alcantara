import React, { Suspense, lazy, useMemo } from 'react';

export interface ModoItalianoGiorgiaArtistBumperProps {
  show?: boolean;
  artist?: string;
  songTitle?: string;
  /** Exactly four distinct image URLs, in playback order. */
  images?: unknown;
  audioUrl?: string;
  eyebrow?: string;
  contentType?: string;
  creditLines?: unknown;
  siteUrl?: string;
  masterGain?: number;
}

// Giorgia's video entry pulls in Remotion, so it loads only when a bumper is actually shown.
const ArtistBumperPlayer = lazy(() => import('./ModoItalianoGiorgiaArtistBumperPlayer'));

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The four images Giorgia's bumper requires, or null. Giorgia throws unless it
 * gets exactly four distinct non-empty URLs, so an incomplete scene renders
 * nothing instead of taking the program page down.
 */
export function resolveArtistBumperImages(images: unknown): readonly [string, string, string, string] | null {
  if (!Array.isArray(images) || images.length !== 4) return null;
  const urls = images.map(text);
  if (urls.some((url) => !url) || new Set(urls).size !== 4) return null;
  return [urls[0], urls[1], urls[2], urls[3]];
}

/** Why a bumper cannot play yet, for the editor; null when it can. */
export function describeArtistBumperProblem(props: Pick<ModoItalianoGiorgiaArtistBumperProps, 'artist' | 'songTitle' | 'images'>): string | null {
  if (!text(props.artist)) return 'Add the artist.';
  if (!text(props.songTitle)) return 'Add the song title.';
  if (!resolveArtistBumperImages(props.images)) return 'Add four different images.';
  return null;
}

/**
 * Full-screen Giorgia artist bumper: a 12-second artist-and-song introduction
 * that ends on the "In onda ora" card. It plays once each time it is shown or
 * its content changes, and holds its last frame.
 */
export const ModoItalianoGiorgiaArtistBumper: React.FC<ModoItalianoGiorgiaArtistBumperProps> = ({
  show = true,
  artist,
  songTitle,
  images,
  audioUrl,
  eyebrow,
  contentType,
  creditLines,
  siteUrl,
  masterGain = 1
}) => {
  const inputProps = useMemo(() => {
    const resolvedImages = resolveArtistBumperImages(images);
    if (!resolvedImages || !text(artist) || !text(songTitle)) return null;
    const credits = Array.isArray(creditLines) ? creditLines.map(text) : [];
    return {
      artist: text(artist),
      songTitle: text(songTitle),
      images: resolvedImages,
      audioUrl: text(audioUrl) || null,
      // Blank optional fields are left out so Giorgia's own defaults apply.
      ...(text(eyebrow) ? { eyebrow: text(eyebrow) } : {}),
      ...(text(contentType) ? { contentType: text(contentType) } : {}),
      ...(credits[0] || credits[1] ? { creditLines: [credits[0] ?? '', credits[1] ?? ''] as const } : {}),
      ...(text(siteUrl) ? { siteUrl: text(siteUrl) } : {})
    };
  }, [artist, songTitle, images, audioUrl, eyebrow, contentType, creditLines, siteUrl]);

  if (!show || !inputProps) return null;

  return (
    <div
      className='modoitaliano-giorgia-artist-bumper'
      aria-label='Modo Italiano Giorgia artist bumper'
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}
    >
      <Suspense fallback={null}>
        {/* A new key restarts the bumper from its first frame whenever its content changes. */}
        <ArtistBumperPlayer key={JSON.stringify(inputProps)} inputProps={inputProps} masterGain={masterGain} />
      </Suspense>
    </div>
  );
};
