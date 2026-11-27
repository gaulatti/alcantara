import {
  PlayoutLease,
  startWhenActive,
} from '../playout/playout-lease.service';
import { isDeployCandidate } from '../config/deploy-candidate';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProductionEnvironment } from '../config/local-media';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';

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

/** One entry of the provider-neutral chart feed (`GET /charts/realtime`). */
export interface ChartFeedEntry {
  provider: string;
  externalId: string | null;
  title: string;
  artist: string;
  rank: string | null;
  spins: string | null;
  /** When the refresh that produced these values ran. */
  updatedAt: string;
}

/** The provider whose ids SongChartIdentity.externalId holds for these entries. */
const RANKED_PROVIDER = 'earone';

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
const ESCPLUS_URL =
  'https://www.escplus.es/odds/sanremo2026/chart-sanremo2026.json';
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
    .map((artist) =>
      typeof artist?.name === 'string' ? artist.name.trim() : '',
    )
    .filter(Boolean)
    .join(' & ');
}

function numberToString(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : null;
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

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: ManagedMetricsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly lease?: PlayoutLease,
  ) {}

  /**
   * Outside production the two third-party chart feeds are never polled
   * (gaulatti/alcantara#206); the charts stay empty. Production polls as
   * before.
   */
  pollingEnabled(): boolean {
    if (!this.config) return true;
    return isProductionEnvironment({
      NODE_ENV: this.config.get<string>('NODE_ENV'),
    });
  }

  onModuleInit() {
    if (isDeployCandidate()) {
      this.logger.log('Deploy candidate: chart polling is off');
      return;
    }
    if (!this.pollingEnabled()) {
      this.logger.warn(
        'Chart polling is off outside production; no external chart feed is contacted',
      );
      return;
    }
    // Only the instance holding the playout lease (alcantara#873) polls.
    startWhenActive(this.lease, () => {
      void this.refreshCache();
      this.refreshTimer = setInterval(() => {
        void this.refreshCache();
      }, REFRESH_MS);
    });
  }

  onModuleDestroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  async getSnapshot() {
    if (this.cache.entries.length === 0) {
      await this.refreshCache();
    }

    return this.cache;
  }

  /**
   * The refreshed entries in a provider-neutral shape. Only rank and spins
   * are carried; the upstream's streaming counts are not part of the feed.
   */
  async getRealtimeFeed(): Promise<ChartFeedEntry[]> {
    const cache = await this.getSnapshot();
    return cache.entries.map((entry) => ({
      provider: entry.sourceKeys.earone ? RANKED_PROVIDER : 'escplus',
      externalId: entry.earoneSongId,
      title: entry.title,
      artist: entry.artist,
      rank: entry.ranking,
      spins: entry.radioSpinsToday,
      updatedAt: cache.updatedAt,
    }));
  }

  private async refreshCache() {
    if (!this.pollingEnabled()) {
      return;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.fetchAndMerge()
      .then((nextCache) => {
        this.cache = nextCache;
        this.metrics?.recordJob('charts-refresh', 'success');
        return this.storeRanks(nextCache);
      })
      .catch((error) => {
        this.metrics?.recordJob('charts-refresh', 'failure');
        this.logger.error(`Failed to refresh charts cache: ${String(error)}`);
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  // Writes the refreshed rank and spins into SongChartIdentity rows whose
  // provider and externalId match an upstream entry. Only changed, non-null
  // values are written, so a refresh never clears a rank. A failure is
  // logged and counted; the cache refresh itself has already succeeded.
  private async storeRanks(cache: CachedChartsResponse): Promise<void> {
    const live = new Map<
      string,
      { rank: string | null; spins: string | null }
    >();
    for (const entry of cache.entries) {
      if (entry.earoneSongId === null) continue;
      if (entry.ranking === null && entry.radioSpinsToday === null) continue;
      live.set(entry.earoneSongId, {
        rank: entry.ranking,
        spins: entry.radioSpinsToday,
      });
    }
    if (live.size === 0) return;

    const started = process.hrtime.bigint();
    try {
      const rows = await this.prisma.songChartIdentity.findMany({
        where: {
          provider: RANKED_PROVIDER,
          externalId: { in: [...live.keys()] },
        },
        select: { id: true, externalId: true, rank: true, spins: true },
      });
      for (const row of rows) {
        const next = live.get(row.externalId!)!;
        const data = {
          ...(next.rank !== null &&
            next.rank !== row.rank && { rank: next.rank }),
          ...(next.spins !== null &&
            next.spins !== row.spins && { spins: next.spins }),
        };
        if (Object.keys(data).length === 0) continue;
        await this.prisma.songChartIdentity.update({
          where: { id: row.id },
          data,
        });
      }
      this.recordStoreMetric('success', started);
    } catch (error) {
      this.recordStoreMetric('failure', started);
      this.logger.error(`Failed to store chart ranks: ${String(error)}`);
    }
  }

  private recordStoreMetric(result: 'success' | 'failure', started: bigint) {
    this.metrics?.recordDependency(
      'postgres',
      'write',
      result,
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
  }

  private async fetchAndMerge(): Promise<CachedChartsResponse> {
    const [earonePayload, escplusPayload] = await Promise.all([
      this.fetchJson(EARONE_URL),
      this.fetchJson(ESCPLUS_URL),
    ]);

    const mergedByKey = new Map<string, ChartEntry>();

    const earoneSongs = Array.isArray(
      earonePayload?.result?.postTypeData?.songs,
    )
      ? (earonePayload.result.postTypeData.songs as EaroneApiSong[])
      : [];

    for (const song of earoneSongs) {
      const artist = getEaroneArtists(song);
      const title =
        typeof song.song?.title === 'string' ? song.song.title.trim() : '';
      const normalizedKey = buildNormalizedKey(artist, title);
      const earoneSongIdValue = song.song?.earoneSongId;
      const earoneSongId =
        typeof earoneSongIdValue === 'string' ||
        typeof earoneSongIdValue === 'number'
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
    const dependency = url === EARONE_URL ? 'earone' : 'escplus';
    const started = process.hrtime.bigint();
    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.recordFetchMetric(dependency, 'http-error', started);
        throw new Error(`${url} responded with ${response.status}`);
      }
      const payload = await response.json();
      this.recordFetchMetric(dependency, 'success', started);
      return payload;
    } catch (error) {
      if (
        !(
          error instanceof Error && error.message.startsWith(`${url} responded`)
        )
      ) {
        this.recordFetchMetric(dependency, 'unavailable', started);
      }
      throw error;
    }
  }

  private recordFetchMetric(
    dependency: 'earone' | 'escplus',
    result: 'success' | 'http-error' | 'unavailable',
    started: bigint,
  ): void {
    this.metrics?.recordDependency(
      dependency,
      'fetch',
      result,
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
  }
}
