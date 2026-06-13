import { apiUrl } from '../utils/apiBaseUrl';
import type { SongCatalogItem, PaginatedResponse } from '../models/broadcast';

export interface FetchSongsParams {
  search?: string;
  enabled?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export async function fetchSongCatalog(): Promise<SongCatalogItem[]> {
  const res = await fetch(apiUrl('/songs?limit=0'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: PaginatedResponse<SongCatalogItem> = await res.json();
  return body.data;
}

export async function fetchSongsPage(params?: FetchSongsParams): Promise<PaginatedResponse<SongCatalogItem>> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.enabled !== undefined) query.set('enabled', String(params.enabled));
  if (params?.sortBy) query.set('sortBy', params.sortBy);
  if (params?.sortOrder) query.set('sortOrder', params.sortOrder);
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));

  const qs = query.toString();
  const res = await fetch(apiUrl(`/songs${qs ? `?${qs}` : ''}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
