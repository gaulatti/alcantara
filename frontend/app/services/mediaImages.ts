import { apiUrl } from '../utils/apiBaseUrl';

/** One image of the media library, as `GET /media` returns it. */
export interface MediaImage {
  id: number;
  name: string;
  imageUrl: string;
}

/** The most images the logo picker lists at once; a search narrows the rest. */
export const MEDIA_IMAGE_PAGE = 60;

/**
 * The media library's images, newest first, optionally narrowed by name (gaulatti/alcantara#408).
 *
 * Ownership: `GET /media` is not scoped by team, and `Media.teamId` is not set on create. That is
 * safe today only because the deployment authorizes against a single Pompeii team, so every
 * caller's library is the same. Real per-team scoping arrives with the tenancy work of #122
 * (#548 and its follow-ups), not here.
 */
export async function fetchMediaImages(search: string): Promise<MediaImage[]> {
  const params = new URLSearchParams({ limit: String(MEDIA_IMAGE_PAGE), sortBy: 'updatedAt', sortOrder: 'desc' });
  const term = search.trim();
  if (term) params.set('search', term);
  const res = await fetch(apiUrl(`/media?${params.toString()}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error('The media library answered without a list.');
  return body.data as MediaImage[];
}
