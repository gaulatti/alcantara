import { apiUrl } from '../utils/apiBaseUrl';
import type { SongCatalogItem } from '../models/broadcast';

export async function fetchSongCatalog(): Promise<SongCatalogItem[]> {
  const res = await fetch(apiUrl('/songs'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
