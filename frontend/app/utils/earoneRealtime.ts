export const BACKEND_SANREMO_REALTIME_URL =
  'http://localhost:3000/charts/sanremo-realtime';

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

function normalizeFragment(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEaroneMatchKey(value: string): string {
  return normalizeFragment(value);
}

export function buildEaroneRealtimeLookup(payload: unknown): EaroneRealtimeLookup {
  const entries = Array.isArray((payload as any)?.entries)
    ? (((payload as any).entries as EaroneRealtimeEntry[]) ?? [])
    : [];

  const lookup: EaroneRealtimeLookup = {
    bySongId: {},
    byNormalizedText: {},
    updatedAt:
      typeof (payload as any)?.updatedAt === 'string'
        ? (payload as any).updatedAt
        : null,
    sources:
      (payload as any)?.sources &&
      typeof (payload as any).sources === 'object'
        ? {
            earoneUpdatedAt:
              typeof (payload as any).sources.earoneUpdatedAt === 'string'
                ? (payload as any).sources.earoneUpdatedAt
                : null,
            escplusUpdatedAt:
              typeof (payload as any).sources.escplusUpdatedAt === 'string'
                ? (payload as any).sources.escplusUpdatedAt
                : null
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
  if (!lookup) {
    return null;
  }

  const normalizedId =
    typeof options.earoneSongId === 'string' && options.earoneSongId.trim()
      ? options.earoneSongId.trim()
      : null;
  if (normalizedId && lookup.bySongId[normalizedId]) {
    return lookup.bySongId[normalizedId];
  }

  const normalizedText =
    typeof options.text === 'string' && options.text.trim()
      ? normalizeEaroneMatchKey(options.text)
      : '';
  if (normalizedText && lookup.byNormalizedText[normalizedText]) {
    return lookup.byNormalizedText[normalizedText];
  }

  return null;
}
