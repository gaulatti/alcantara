export const EARONE_SANREMO_REALTIME_URL =
  'https://api6.xdevel.com/xsocial/earone/public/posts/451e7ddf8b08?clientId=43671f1197420c16e74a872b491ab86674f5d728&itemsLimit=100&anonymousPublicKey=d29cb65024ea0886fa7d5659c05ef5a724b8280e';

export interface EaroneRealtimeEntry {
  earoneSongId: string;
  ranking: string;
  radioSpinsToday: string;
  artist: string;
  title: string;
  normalizedKey: string;
}

export interface EaroneRealtimeLookup {
  bySongId: Record<string, EaroneRealtimeEntry>;
  byNormalizedText: Record<string, EaroneRealtimeEntry>;
  updatedAt: string | null;
}

interface EaroneApiSong {
  curPos?: number;
  spins?: number;
  song?: {
    earoneSongId?: number | string;
    title?: string;
    tracks?: Array<{
      artists?: Array<{
        name?: string;
      }>;
    }>;
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

function buildDisplayKey(artist: string, title: string): string {
  const normalizedArtist = normalizeFragment(artist);
  const normalizedTitle = normalizeFragment(title);
  return [normalizedArtist, normalizedTitle].filter(Boolean).join(' ');
}

function getArtists(song: EaroneApiSong): string {
  const artists = song.song?.tracks?.[0]?.artists ?? [];
  return artists
    .map((artist) => (typeof artist?.name === 'string' ? artist.name.trim() : ''))
    .filter(Boolean)
    .join(' & ');
}

export function buildEaroneRealtimeLookup(payload: unknown): EaroneRealtimeLookup {
  const songs = Array.isArray((payload as any)?.result?.postTypeData?.songs)
    ? (((payload as any).result.postTypeData.songs as EaroneApiSong[]) ?? [])
    : [];

  const lookup: EaroneRealtimeLookup = {
    bySongId: {},
    byNormalizedText: {},
    updatedAt:
      typeof (payload as any)?.result?.modifiedOn === 'string'
        ? (payload as any).result.modifiedOn
        : null
  };

  for (const song of songs) {
    const earoneSongIdValue = song.song?.earoneSongId;
    const earoneSongId =
      typeof earoneSongIdValue === 'string' || typeof earoneSongIdValue === 'number'
        ? String(earoneSongIdValue)
        : '';
    const title = typeof song.song?.title === 'string' ? song.song.title.trim() : '';
    const artist = getArtists(song);

    if (!earoneSongId || !title || !artist) {
      continue;
    }

    const normalizedKey = buildDisplayKey(artist, title);
    const entry: EaroneRealtimeEntry = {
      earoneSongId,
      ranking:
        typeof song.curPos === 'number' && Number.isFinite(song.curPos)
          ? String(song.curPos)
          : '',
      radioSpinsToday:
        typeof song.spins === 'number' && Number.isFinite(song.spins)
          ? String(song.spins)
          : '',
      artist,
      title,
      normalizedKey
    };

    lookup.bySongId[earoneSongId] = entry;
    if (normalizedKey && !lookup.byNormalizedText[normalizedKey]) {
      lookup.byNormalizedText[normalizedKey] = entry;
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
