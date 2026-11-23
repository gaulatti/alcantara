import { authFetch } from "./api";

export interface ArtistLabelRow {
  artistKey: string;
  artist: string;
  labelId: string;
}

/**
 * The key the backend matches an artist on (`artistKey` in backend/src/artist-labels): case and outer
 * spaces do not matter, anything else does. The console only uses it to find the row of the artist
 * being edited; the backend is the authority.
 */
export const artistKeyOf = (artist: string): string =>
  artist.trim().toLocaleLowerCase();

export async function fetchArtistLabels(): Promise<ArtistLabelRow[]> {
  const response = await authFetch("/artist-labels");
  if (!response.ok) {
    throw new Error(`Failed to load artist labels: HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Invalid artist labels response");
  }
  return payload as ArtistLabelRow[];
}

/** Attaches the label to the artist, or removes the link with a null label. */
export async function saveArtistLabel(
  artist: string,
  labelId: string | null,
): Promise<void> {
  const response = await authFetch("/artist-labels", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artist, labelId }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      detail?.message ?? `Failed to save the artist label: HTTP ${response.status}`,
    );
  }
}
