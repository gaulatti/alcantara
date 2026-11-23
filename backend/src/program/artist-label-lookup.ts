/**
 * gaulatti/alcantara#424 (#222 R3): the song recipe points its bumper and slideshow at the artist's
 * media label. Artist labels are gaulatti/alcantara#423 (contract C4); the recipes read them only
 * through this port, which answers null until the integrator (gaulatti/alcantara#427) binds #423's
 * service to it. A use can always name its label directly.
 */
export const ARTIST_LABEL_LOOKUP = Symbol('ARTIST_LABEL_LOOKUP');

export interface ArtistLabelLookup {
  artistLabelFor(teamId: number | null, artist: string): Promise<string | null>;
}

export const NO_ARTIST_LABELS: ArtistLabelLookup = {
  artistLabelFor: () => Promise.resolve(null),
};
