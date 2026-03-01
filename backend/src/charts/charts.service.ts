import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

export interface ChartEntry {
  normalizedKey: string;
  earoneSongId: string | null;
  artist: string;
  title: string;
  ranking: string | null;
  radioSpinsToday: string | null;
  spotifyPlays: string | null;
  youtubeViews: string | null;
  youtubeLikes: string | null;
  sourceKeys: {
    earone: string | null;
    escplus: string | null;
  };
}

export interface CachedChartsResponse {
  updatedAt: string;
  sources: {
    earoneUpdatedAt: string | null;
    escplusUpdatedAt: string | null;
  };
  entries: ChartEntry[];
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

interface EscplusSong {
  artist?: string;
  song?: string;
  spotifyplays?: number;
  youtube?: {
    views?: number;
    likes?: number;
  };
  betsName?: string;
}

const EARONE_URL =
  'https://api6.xdevel.com/xsocial/earone/public/posts/451e7ddf8b08?clientId=43671f1197420c16e74a872b491ab86674f5d728&itemsLimit=100&anonymousPublicKey=d29cb65024ea0886fa7d5659c05ef5a724b8280e';
const ESCPLUS_URL = 'https://www.escplus.es/odds/sanremo2026/chart-sanremo2026.json';
const REFRESH_MS = 15000;

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

function buildNormalizedKey(artist: string, title: string): string {
  return [normalizeFragment(artist), normalizeFragment(title)]
    .filter(Boolean)
    .join(' ');
}

function getEaroneArtists(song: EaroneApiSong): string {
  const artists = song.song?.tracks?.[0]?.artists ?? [];
  return artists
    .map((artist) => (typeof artist?.name === 'string' ? artist.name.trim() : ''))
    .filter(Boolean)
    .join(' & ');
}

function numberToString(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

@Injectable()
export class ChartsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChartsService.name);
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;
  private cache: CachedChartsResponse = {
    updatedAt: new Date(0).toISOString(),
    sources: {
      earoneUpdatedAt: null,
      escplusUpdatedAt: null,
    },
    entries: [],
  };

  onModuleInit() {
    void this.refreshCache();
    this.refreshTimer = setInterval(() => {
      void this.refreshCache();
    }, REFRESH_MS);
  }

  onModuleDestroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  async getSanremoRealtime() {
    if (this.cache.entries.length === 0) {
      await this.refreshCache();
    }

    return this.cache;
  }

  private async refreshCache() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.fetchAndMerge()
      .then((nextCache) => {
        this.cache = nextCache;
      })
      .catch((error) => {
        this.logger.error(`Failed to refresh charts cache: ${String(error)}`);
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  private async fetchAndMerge(): Promise<CachedChartsResponse> {
    const [earonePayload, escplusPayload] = await Promise.all([
      this.fetchJson(EARONE_URL),
      this.fetchJson(ESCPLUS_URL),
    ]);

    const mergedByKey = new Map<string, ChartEntry>();

    const earoneSongs = Array.isArray(earonePayload?.result?.postTypeData?.songs)
      ? (earonePayload.result.postTypeData.songs as EaroneApiSong[])
      : [];

    for (const song of earoneSongs) {
      const artist = getEaroneArtists(song);
      const title =
        typeof song.song?.title === 'string' ? song.song.title.trim() : '';
      const normalizedKey = buildNormalizedKey(artist, title);
      const earoneSongIdValue = song.song?.earoneSongId;
      const earoneSongId =
        typeof earoneSongIdValue === 'string' || typeof earoneSongIdValue === 'number'
          ? String(earoneSongIdValue)
          : null;

      if (!artist || !title || !normalizedKey) {
        continue;
      }

      mergedByKey.set(normalizedKey, {
        normalizedKey,
        earoneSongId,
        artist,
        title,
        ranking: numberToString(song.curPos),
        radioSpinsToday: numberToString(song.spins),
        spotifyPlays: null,
        youtubeViews: null,
        youtubeLikes: null,
        sourceKeys: {
          earone: normalizedKey,
          escplus: null,
        },
      });
    }

    const escplusSongs = Array.isArray(escplusPayload)
      ? (escplusPayload as EscplusSong[])
      : [];

    for (const song of escplusSongs) {
      const artist = typeof song.artist === 'string' ? song.artist.trim() : '';
      const title = typeof song.song === 'string' ? song.song.trim() : '';
      const normalizedKey = buildNormalizedKey(artist, title);

      if (!artist || !title || !normalizedKey) {
        continue;
      }

      const existing = mergedByKey.get(normalizedKey);
      if (existing) {
        existing.spotifyPlays = numberToString(song.spotifyplays);
        existing.youtubeViews = numberToString(song.youtube?.views);
        existing.youtubeLikes = numberToString(song.youtube?.likes);
        existing.sourceKeys.escplus = normalizedKey;
        continue;
      }

      mergedByKey.set(normalizedKey, {
        normalizedKey,
        earoneSongId: null,
        artist,
        title,
        ranking: null,
        radioSpinsToday: null,
        spotifyPlays: numberToString(song.spotifyplays),
        youtubeViews: numberToString(song.youtube?.views),
        youtubeLikes: numberToString(song.youtube?.likes),
        sourceKeys: {
          earone: null,
          escplus: normalizedKey,
        },
      });
    }

    return {
      updatedAt: new Date().toISOString(),
      sources: {
        earoneUpdatedAt:
          typeof earonePayload?.result?.modifiedOn === 'string'
            ? earonePayload.result.modifiedOn
            : null,
        escplusUpdatedAt: new Date().toISOString(),
      },
      entries: [...mergedByKey.values()].sort((a, b) =>
        a.artist.localeCompare(b.artist),
      ),
    };
  }

  private async fetchJson(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url} responded with ${response.status}`);
    }
    return response.json();
  }
}
