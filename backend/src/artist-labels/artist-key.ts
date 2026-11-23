/**
 * The key an artist is matched on (gaulatti/alcantara#222 contract C4). Artist separation in the
 * radio log generator and filler, and artist labels, all use this one function so the definition of
 * "the same artist" cannot drift: case and outer spaces do not matter, anything else does.
 */
export const artistKey = (artist: string): string =>
  artist.trim().toLocaleLowerCase();
