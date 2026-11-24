import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../utils/apiBaseUrl';

export interface ModoItalianoGiorgiaArtistBumperProps {
  show?: boolean;
  artist?: string;
  songTitle?: string;
  /** Media label whose first four different images, in its saved order, are used. Takes precedence over `images`. */
  labelId?: unknown;
  /** Exactly four distinct image URLs, in playback order, used when no label is set. */
  images?: unknown;
  contentType?: string;
  creditLines?: unknown;
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

/** The label a bumper takes its images from, or null when its images are set by hand. */
export function normalizeArtistBumperLabelId(labelId: unknown): string | null {
  return typeof labelId === 'string' && labelId.trim() ? labelId.trim() : null;
}

/**
 * The four images a label gives the bumper, or null when the label has no images.
 *
 * It takes the label's first four different images in its saved order. A label
 * with one to three images still plays: its images repeat to fill the four
 * cuts. Giorgia requires four distinct URLs, so a repeated image carries a URL
 * fragment, which names the same file.
 */
export function pickArtistBumperLabelImages(urls: readonly unknown[]): readonly [string, string, string, string] | null {
  const distinct = [...new Set(urls.map(text).filter(Boolean))].slice(0, 4);
  if (!distinct.length) return null;
  const cut = (index: number) => {
    const url = distinct[index % distinct.length];
    return index < distinct.length ? url : `${url}#repeat-${Math.floor(index / distinct.length) + 1}`;
  };
  return [cut(0), cut(1), cut(2), cut(3)];
}

/** Why a bumper cannot play yet, for the editor; null when it can. `labelImageUrls` are the selected label's images. */
export function describeArtistBumperProblem(
  props: Pick<ModoItalianoGiorgiaArtistBumperProps, 'artist' | 'songTitle' | 'images' | 'labelId'>,
  labelImageUrls: readonly unknown[] = []
): string | null {
  if (!text(props.artist)) return 'Add the artist.';
  if (!text(props.songTitle)) return 'Add the song title.';
  if (normalizeArtistBumperLabelId(props.labelId)) {
    return pickArtistBumperLabelImages(labelImageUrls) ? null : 'The label has no images.';
  }
  if (!resolveArtistBumperImages(props.images)) return 'Add four different images.';
  return null;
}

interface LabelImagesPayload {
  images?: Array<{ imageUrl?: unknown; position?: unknown }>;
}

/** Loads a label's image URLs in saved order, the same way the slideshow does. Null until loaded. */
function useLabelImageUrls(labelId: string | null): string[] | null {
  const [loaded, setLoaded] = useState<{ labelId: string; urls: string[] } | null>(null);

  useEffect(() => {
    if (!labelId) return;
    let cancelled = false;
    fetch(apiUrl(`/media-labels/${encodeURIComponent(labelId)}/images`))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Media label ${labelId}: HTTP ${response.status}`);
        return (await response.json()) as LabelImagesPayload;
      })
      .then((payload) => {
        if (cancelled) return;
        const images = Array.isArray(payload.images) ? [...payload.images] : [];
        images.sort((left, right) => Number(left.position) - Number(right.position));
        setLoaded({ labelId, urls: images.map((image) => text(image.imageUrl)).filter(Boolean) });
      })
      .catch((error) => console.error('Failed to load artist bumper label images:', error));
    return () => {
      cancelled = true;
    };
  }, [labelId]);

  return labelId && loaded?.labelId === labelId ? loaded.urls : null;
}

/**
 * Full-screen Giorgia artist bumper: a 12-second artist-and-song introduction
 * that ends on the "In onda ora" card. It plays once, silent, each time it is
 * shown or its content changes, and holds its last frame.
 */
export const ModoItalianoGiorgiaArtistBumper: React.FC<ModoItalianoGiorgiaArtistBumperProps> = ({
  show = true,
  artist,
  songTitle,
  labelId,
  images,
  contentType,
  creditLines
}) => {
  const normalizedLabelId = normalizeArtistBumperLabelId(labelId);
  const labelImageUrls = useLabelImageUrls(normalizedLabelId);
  const inputProps = useMemo(() => {
    const resolvedImages = normalizedLabelId ? pickArtistBumperLabelImages(labelImageUrls ?? []) : resolveArtistBumperImages(images);
    if (!resolvedImages || !text(artist) || !text(songTitle)) return null;
    const credits = Array.isArray(creditLines) ? creditLines.map(text) : [];
    return {
      artist: text(artist),
      songTitle: text(songTitle),
      images: resolvedImages,
      // The bumper plays silent, and its eyebrow and site address are never passed, so Giorgia's own
      // "ModoItaliano presenta" and modoitaliano.fm always apply. A blank content type also uses Giorgia's default.
      audioUrl: null,
      ...(text(contentType) ? { contentType: text(contentType) } : {}),
      /* v8 ignore next -- credits comes from text() on each entry, which always returns a string, so credits[0] is never nullish here and its `?? ''` cannot run; this line also holds the reached credit checks, which the existing credit tests cover. */
      ...(credits[0] || credits[1] ? { creditLines: [credits[0] ?? '', credits[1] ?? ''] as const } : {})
    };
  }, [artist, songTitle, normalizedLabelId, labelImageUrls, images, contentType, creditLines]);

  if (!show || !inputProps) return null;

  return (
    <div
      className='modoitaliano-giorgia-artist-bumper'
      aria-label='Modo Italiano Giorgia artist bumper'
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}
    >
      <Suspense fallback={null}>
        {/* A new key restarts the bumper from its first frame whenever its content changes. */}
        <ArtistBumperPlayer key={JSON.stringify(inputProps)} inputProps={inputProps} />
      </Suspense>
    </div>
  );
};
