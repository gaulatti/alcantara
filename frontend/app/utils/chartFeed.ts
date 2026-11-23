import { apiUrl } from './apiBaseUrl';
import type { ChartValues } from './programChartValues';

/**
 * Provider-neutral chart feed, refreshed by the backend from the chart
 * upstream every 15 seconds. It is the program page's only chart source.
 */
export const CHART_FEED_URL = apiUrl('/charts/realtime');

/** One entry of `GET /charts/realtime`. */
export interface ChartFeedEntry {
  provider: string;
  externalId: string | null;
  title: string;
  artist: string;
  rank: string | null;
  spins: string | null;
  updatedAt: string;
}

/** Entries by chart id and by match key, the first entry winning a shared key. */
export interface ChartFeedLookup {
  byId: Record<string, ChartFeedEntry>;
  byKey: Record<string, ChartFeedEntry>;
  updatedAt: string | null;
}

/** The text normalization chart matching has always used (and the backend uses for its keys). */
export function normalizeChartText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An entry's match key: normalized artist, then normalized title, as the backend builds it. */
export function chartEntryKey(artist: string, title: string): string {
  return [normalizeChartText(artist), normalizeChartText(title)].filter(Boolean).join(' ');
}

/** Finds an entry by chart id, else by the chyron text normalized to a match key. */
export function matchChartEntry<Entry>(
  lookup: { byId: Record<string, Entry>; byKey: Record<string, Entry> } | null,
  options: { id?: string | null; text?: string | null }
): Entry | null {
  if (!lookup) {
    return null;
  }
  const id = typeof options.id === 'string' && options.id.trim() ? options.id.trim() : null;
  if (id && lookup.byId[id]) {
    return lookup.byId[id];
  }
  const key = typeof options.text === 'string' && options.text.trim() ? normalizeChartText(options.text) : '';
  if (key && lookup.byKey[key]) {
    return lookup.byKey[key];
  }
  return null;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Builds the lookup from a feed payload, or returns null when the payload is not a feed. */
export function buildChartFeedLookup(payload: unknown): ChartFeedLookup | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const lookup: ChartFeedLookup = { byId: {}, byKey: {}, updatedAt: null };
  for (const item of payload as Array<Partial<ChartFeedEntry> | null>) {
    if (!item || typeof item.artist !== 'string' || typeof item.title !== 'string') {
      continue;
    }
    const key = chartEntryKey(item.artist, item.title);
    if (!key || !item.artist || !item.title) {
      continue;
    }
    const entry: ChartFeedEntry = {
      provider: optionalText(item.provider) ?? '',
      externalId: optionalText(item.externalId),
      title: item.title,
      artist: item.artist,
      rank: optionalText(item.rank),
      spins: optionalText(item.spins),
      updatedAt: optionalText(item.updatedAt) ?? ''
    };
    lookup.updatedAt = lookup.updatedAt ?? optionalText(item.updatedAt);
    if (entry.externalId) {
      lookup.byId[entry.externalId] = entry;
    }
    if (!lookup.byKey[key]) {
      lookup.byKey[key] = entry;
    }
  }
  return lookup;
}

/**
 * The page's chart lookup from the feed. A feed that does not answer, answers
 * with an error or does not return a list is an error for the caller to report;
 * the page then keeps the last lookup it loaded.
 */
export async function loadChartLookup(fetchImpl: typeof fetch = fetch): Promise<ChartFeedLookup> {
  const res = await fetchImpl(CHART_FEED_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const lookup = buildChartFeedLookup(await res.json());
  if (!lookup) {
    throw new Error('The chart feed did not return a list');
  }
  return lookup;
}

/** Rank and spins for a chyron item from the loaded feed. */
export function realtimeChartValues(lookup: ChartFeedLookup | null, options: { id?: string | null; text?: string | null }): ChartValues | null {
  const entry = matchChartEntry(lookup, options);
  return entry ? { rank: entry.rank, spins: entry.spins } : null;
}
