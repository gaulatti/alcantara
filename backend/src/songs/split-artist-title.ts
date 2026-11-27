/**
 * A file with no tags is imported under its own name, "Artist - Title", with no title. Such a name is split when it
 * has exactly one " - " and text on both sides; anything else is kept as given, since which part is which is unknown.
 */
export function splitArtistTitle(
  artist: string,
  title: string,
): { artist: string; title: string } {
  if (title) return { artist, title };
  const parts = artist.split(' - ').map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { artist, title };
  return { artist: parts[0], title: parts[1] };
}
