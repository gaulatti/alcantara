import { apiUrl } from './apiBaseUrl';
import { matchChartEntry, normalizeChartText } from './chartFeed';

export const BACKEND_SANREMO_REALTIME_URL = apiUrl('/charts/sanremo-realtime');

export interface EaroneRealtimeEntry {
  earoneSongId: string | null;
  ranking: string | null;
  radioSpinsToday: string | null;
  artist: string;
  title: string;
  normalizedKey: string;
  spotifyPlays: string | null;
  youtubeViews: string | null;
  youtubeLikes: string | null;
}

export interface EaroneRealtimeLookup {
  bySongId: Record<string, EaroneRealtimeEntry>;
  byNormalizedText: Record<string, EaroneRealtimeEntry>;
  updatedAt: string | null;
  sources?: {
    earoneUpdatedAt: string | null;
    escplusUpdatedAt: string | null;
  };
}

export function normalizeEaroneMatchKey(value: string): string {
  return normalizeChartText(value);
}

export function buildEaroneRealtimeLookup(payload: unknown): EaroneRealtimeLookup {
  const entries = Array.isArray((payload as any)?.entries) ? (((payload as any).entries as EaroneRealtimeEntry[]) ?? []) : [];

  const lookup: EaroneRealtimeLookup = {
    bySongId: {},
    byNormalizedText: {},
    updatedAt: typeof (payload as any)?.updatedAt === 'string' ? (payload as any).updatedAt : null,
    sources:
      (payload as any)?.sources && typeof (payload as any).sources === 'object'
        ? {
            earoneUpdatedAt: typeof (payload as any).sources.earoneUpdatedAt === 'string' ? (payload as any).sources.earoneUpdatedAt : null,
            escplusUpdatedAt: typeof (payload as any).sources.escplusUpdatedAt === 'string' ? (payload as any).sources.escplusUpdatedAt : null
          }
        : undefined
  };

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.normalizedKey || !entry.artist || !entry.title) {
      continue;
    }

    if (entry.earoneSongId) {
      lookup.bySongId[entry.earoneSongId] = entry;
    }
    if (entry.normalizedKey && !lookup.byNormalizedText[entry.normalizedKey]) {
      lookup.byNormalizedText[entry.normalizedKey] = entry;
    }
  }

  return lookup;
}

export function matchEaroneRealtimeEntry(
  lookup: EaroneRealtimeLookup | null,
  options: {
    earoneSongId?: string | null;
    text?: string | null;
  }
): EaroneRealtimeEntry | null {
  return matchChartEntry(lookup ? { byId: lookup.bySongId, byKey: lookup.byNormalizedText } : null, {
    id: options.earoneSongId,
    text: options.text
  });
}

/** The branded proxy's lookup; the program page uses it only when the generic feed is unavailable. */
export async function fetchEaroneRealtimeLookup(fetchImpl: typeof fetch = fetch): Promise<EaroneRealtimeLookup> {
  const res = await fetchImpl(BACKEND_SANREMO_REALTIME_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return buildEaroneRealtimeLookup(await res.json());
}
