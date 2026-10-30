import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { RadioMetricsService } from './radio-metrics.service';
import {
  collectProgramSongLeaves,
  normalizeProgramSongSequence,
  type ProgramResolvedSongLeaf,
} from './song-sequence.utils';
import {
  CATALOG_ITEM_PREFIX,
  DEFAULT_SIMILARITY_SETTINGS,
  SIMILARITY_MODEL,
  markArtistPlayed,
  normalizeArtistCycle,
  normalizeSimilaritySettings,
  parseVectorLiteral,
  pickSimilarSong,
  toVectorLiteral,
  validateEmbeddingUploadHeader,
  validateEmbeddingUploadSong,
  type ArtistCycleState,
  type EmbeddingUploadPayload,
  type SimilarityCandidate,
  type SimilarityOutcome,
  type SimilarityPickResult,
  type SimilaritySettings,
} from './song-similarity.utils';

export const MAX_UPLOAD_SONGS_PER_REQUEST = 25;
const MAX_DECISIONS_PER_PROGRAM = 1000;
const PRUNE_EVERY_INSERTS = 25;
const CATALOG_REFRESH_MS = 5 * 60 * 1000;

interface CatalogSong {
  id: number;
  artist: string;
  title: string;
  audioUrl: string;
  coverUrl: string | null;
  durationMs: number | null;
}

type VectorKey = string;
const vectorKey = (
  songId: number,
  segment: string,
  windowSeconds: number,
): VectorKey => `${songId}|${segment}|${windowSeconds}`;

export interface SimilarityProposal {
  result: SimilarityPickResult;
  /** Leaf the picker chose, ready to hand to the engine; null on fallback. */
  leaf: ProgramResolvedSongLeaf | null;
}

export interface SimilarityLeafInput {
  leaf: ProgramResolvedSongLeaf;
  /** Rotation rules (e.g. high-rotation cooldown) forbid it right now. */
  blocked: boolean;
}

/**
 * Holds station similarity settings, the embedding cache and the artist cycle
 * so the engine's synchronous selection path never waits on the database.
 * With mode `off` (the default, and the state after any load failure) nothing
 * here is consulted or written.
 */
@Injectable()
export class SongSimilarityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SongSimilarityService.name);
  private readonly settings = new Map<string, SimilaritySettings>();
  private readonly cycles = new Map<string, ArtistCycleState>();
  private readonly vectors = new Map<VectorKey, number[]>();
  private catalog = new Map<number, CatalogSong>();
  private readonly insertCounts = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => RadioMetricsService))
    private readonly metrics: RadioMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reloadSettings();
      if (this.anyActive()) await this.reloadEmbeddings();
    } catch (error) {
      this.settings.clear();
      this.logger.error(
        `Similarity state could not be loaded; similarity stays off: ${String(error)}`,
      );
    }
    this.refreshTimer = setInterval(() => {
      if (!this.anyActive()) return;
      void this.reloadEmbeddings().catch((error) =>
        this.logger.error(`Similarity refresh failed: ${String(error)}`),
      );
    }, CATALOG_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  getSettings(programId: string): SimilaritySettings {
    return this.settings.get(programId) ?? DEFAULT_SIMILARITY_SETTINGS;
  }

  private anyActive(): boolean {
    return [...this.settings.values()].some((s) => s.mode !== 'off');
  }

  async reloadSettings(): Promise<void> {
    const rows = await this.prisma.radioSettings.findMany({
      select: {
        similarityMode: true,
        similarityThreshold: true,
        similarityWindowSeconds: true,
        similarityPool: true,
        programState: { select: { programId: true, songArtistCycle: true } },
      },
    });
    this.settings.clear();
    for (const row of rows) {
      const programId = row.programState.programId;
      this.settings.set(
        programId,
        normalizeSimilaritySettings({
          mode: row.similarityMode,
          threshold: row.similarityThreshold,
          windowSeconds: row.similarityWindowSeconds,
          pool: row.similarityPool,
        }),
      );
      this.cycles.set(
        programId,
        normalizeArtistCycle(row.programState.songArtistCycle),
      );
    }
  }

  /** Called after the station's settings were saved. */
  async onSettingsChanged(): Promise<void> {
    await this.reloadSettings();
    if (this.anyActive()) await this.reloadEmbeddings();
  }

  async reloadEmbeddings(): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      {
        songId: number;
        segment: string;
        windowSeconds: number;
        vector: string;
      }[]
    >`SELECT "songId", "segment", "windowSeconds", "vector"::text AS "vector"
      FROM "SongEmbedding" WHERE "model" = ${SIMILARITY_MODEL.name}`;
    this.vectors.clear();
    for (const row of rows) {
      this.vectors.set(
        vectorKey(row.songId, row.segment, row.windowSeconds),
        parseVectorLiteral(row.vector),
      );
    }
    const songs = await this.prisma.song.findMany({
      where: {
        enabled: true,
        id: { in: [...new Set(rows.map((r) => r.songId))] },
      },
      select: {
        id: true,
        artist: true,
        title: true,
        audioUrl: true,
        coverUrl: true,
        durationMs: true,
      },
    });
    this.catalog = new Map(songs.map((s) => [s.id, s]));
  }

  private vectorFor(
    songId: number | null | undefined,
    segment: 'opening' | 'closing',
    windowSeconds: number,
  ): number[] | null {
    if (!songId) return null;
    return this.vectors.get(vectorKey(songId, segment, windowSeconds)) ?? null;
  }

  /**
   * Computes what the picker would choose. Pure with respect to engine state:
   * it never changes the cycle; callers apply `result.cycleReset` when the
   * proposal is actually played.
   */
  propose(
    programId: string,
    input: {
      currentSongId: number | null;
      currentArtist: string;
      leaves: SimilarityLeafInput[];
    },
  ): SimilarityProposal {
    const settings = this.getSettings(programId);
    const cycle = this.cycles.get(programId) ?? { artists: [] };
    const closing = this.vectorFor(
      input.currentSongId,
      'closing',
      settings.windowSeconds,
    );
    const inSequence = new Set<number>();
    const sequenceCandidates: SimilarityCandidate[] = [];
    const leafByItemId = new Map<string, ProgramResolvedSongLeaf>();
    for (const { leaf, blocked } of input.leaves) {
      if (!leaf.songId || !leaf.audioUrl) continue;
      inSequence.add(leaf.songId);
      leafByItemId.set(leaf.id, leaf);
      sequenceCandidates.push({
        songId: leaf.songId,
        itemId: leaf.id,
        artist: leaf.artist,
        opening: this.vectorFor(leaf.songId, 'opening', settings.windowSeconds),
        blocked,
      });
    }

    const run = (candidates: SimilarityCandidate[]) =>
      pickSimilarSong({
        currentClosing: closing,
        currentSongId: input.currentSongId,
        currentArtist: input.currentArtist,
        candidates,
        cycle,
        threshold: settings.threshold,
      });

    let result = run(sequenceCandidates);
    if (
      settings.pool === 'catalog' &&
      result.outcome === 'fallback-no-candidate'
    ) {
      const extras: SimilarityCandidate[] = [];
      for (const song of this.catalog.values()) {
        if (inSequence.has(song.id)) continue;
        const itemId = `${CATALOG_ITEM_PREFIX}${song.id}`;
        leafByItemId.set(itemId, {
          id: itemId,
          songId: song.id,
          highRotation: false,
          artist: song.artist,
          title: song.title,
          coverUrl: song.coverUrl ?? '',
          audioUrl: song.audioUrl,
          durationMs: song.durationMs ?? undefined,
          activePathLabels: ['Catalog'],
        });
        extras.push({
          songId: song.id,
          itemId,
          artist: song.artist,
          opening: this.vectorFor(song.id, 'opening', settings.windowSeconds),
          blocked: false,
        });
      }
      const fromCatalog = run(extras);
      if (fromCatalog.outcome === 'selected') result = fromCatalog;
    }

    const leaf = result.chosen
      ? (leafByItemId.get(result.chosen.itemId) ?? null)
      : null;
    return leaf ? { result, leaf } : { result, leaf: null };
  }

  /** Marks the artist of a song that started airing, when similarity is active. */
  noteSongStarted(
    programId: string,
    artist: string | null | undefined,
    options: { resetCycle?: boolean } = {},
  ): void {
    if (this.getSettings(programId).mode === 'off') return;
    const before = this.cycles.get(programId) ?? { artists: [] };
    const base = options.resetCycle ? { artists: [] } : before;
    const next = markArtistPlayed(base, artist);
    if (next === before) return;
    this.cycles.set(programId, next);
    void this.prisma.programState
      .update({
        where: { programId },
        data: {
          songArtistCycle: next as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((error) =>
        this.logger.error(
          `Artist cycle persistence failed on ${programId}: ${String(error)}`,
        ),
      );
  }

  recordDecision(
    programId: string,
    decision: {
      mode: 'shadow' | 'on';
      outcome: SimilarityOutcome;
      currentSongId: number | null;
      proposedSongId: number | null;
      playedSongId: number | null;
      score: number | null;
      runnerUps: { songId: number; score: number }[];
    },
  ): void {
    void (async () => {
      try {
        await this.prisma.similarityDecision.create({
          data: { programId, ...decision },
        });
        const count = (this.insertCounts.get(programId) ?? 0) + 1;
        this.insertCounts.set(programId, count % PRUNE_EVERY_INSERTS);
        if (count % PRUNE_EVERY_INSERTS === 0) {
          const cutoff = await this.prisma.similarityDecision.findFirst({
            where: { programId },
            orderBy: { id: 'desc' },
            skip: MAX_DECISIONS_PER_PROGRAM,
            select: { id: true },
          });
          if (cutoff) {
            await this.prisma.similarityDecision.deleteMany({
              where: { programId, id: { lte: cutoff.id } },
            });
          }
        }
      } catch (error) {
        this.metrics.recordSimilarityAction('decision-persistence-failed');
        this.logger.error(
          `Similarity decision persistence failed on ${programId}: ${String(error)}`,
        );
      }
    })();
  }

  async listDecisions(programId: string, limit = 50) {
    const take = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    const rows = await this.prisma.similarityDecision.findMany({
      where: { programId },
      orderBy: { id: 'desc' },
      take,
    });
    const ids = new Set<number>();
    for (const row of rows) {
      for (const id of [
        row.currentSongId,
        row.proposedSongId,
        row.playedSongId,
      ]) {
        if (id) ids.add(id);
      }
    }
    const songs = await this.prisma.song.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, artist: true, title: true },
    });
    const byId = new Map(songs.map((s) => [s.id, s]));
    const label = (id: number | null) => {
      if (!id) return null;
      const song = byId.get(id);
      return {
        songId: id,
        artist: song?.artist ?? '',
        title: song?.title ?? '',
      };
    };
    return rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      outcome: row.outcome,
      createdAt: row.createdAt,
      score: row.score,
      current: label(row.currentSongId),
      proposed: label(row.proposedSongId),
      played: label(row.playedSongId),
      runnerUps: row.runnerUps,
    }));
  }

  async getCoverage(programId: string) {
    const settings = this.getSettings(programId);
    const dbSettings = await this.prisma.radioSettings.findFirst({
      where: { programState: { programId } },
      select: { similarityWindowSeconds: true },
    });
    const windowSeconds =
      dbSettings?.similarityWindowSeconds ?? settings.windowSeconds;
    const [enabledSongs, embedded] = await Promise.all([
      this.prisma.song.count({ where: { enabled: true } }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM (
          SELECT e."songId" FROM "SongEmbedding" e
          JOIN "Song" s ON s."id" = e."songId" AND s."enabled" = true
          WHERE e."model" = ${SIMILARITY_MODEL.name}
            AND e."windowSeconds" = ${windowSeconds}
          GROUP BY e."songId" HAVING COUNT(DISTINCT e."segment") = 2
        ) complete`,
    ]);
    const embeddedCount = Number(embedded[0]?.count ?? 0);
    return {
      model: SIMILARITY_MODEL,
      windowSeconds,
      enabledSongs,
      embeddedSongs: embeddedCount,
      missingSongs: Math.max(0, enabledSongs - embeddedCount),
    };
  }

  async exportSongs(
    programId: string,
    scope: 'sequence' | 'catalog',
    missingOnly: boolean,
  ) {
    const state = await this.prisma.programState.findUnique({
      where: { programId },
      select: {
        songSequence: true,
        radioSettings: { select: { similarityWindowSeconds: true } },
      },
    });
    if (!state) throw new BadRequestException('Program not found');
    const windowSeconds =
      state.radioSettings?.similarityWindowSeconds ??
      DEFAULT_SIMILARITY_SETTINGS.windowSeconds;

    let songIds: number[] | undefined;
    if (scope === 'sequence') {
      const sequence = normalizeProgramSongSequence(state.songSequence);
      songIds = [
        ...new Set(
          collectProgramSongLeaves(sequence)
            .map((leaf) => leaf.songId)
            .filter((id): id is number => typeof id === 'number'),
        ),
      ];
    }
    const songs = await this.prisma.song.findMany({
      where: { enabled: true, ...(songIds ? { id: { in: songIds } } : {}) },
      orderBy: { id: 'asc' },
      select: { id: true, artist: true, title: true, audioUrl: true },
    });
    const existing = await this.prisma.$queryRaw<
      { songId: number; segment: string; audioSha256: string }[]
    >`SELECT "songId", "segment", "audioSha256" FROM "SongEmbedding"
      WHERE "model" = ${SIMILARITY_MODEL.name}
        AND "windowSeconds" = ${windowSeconds}`;
    const bySong = new Map<
      number,
      { shas: Set<string>; segments: Set<string> }
    >();
    for (const row of existing) {
      const entry = bySong.get(row.songId) ?? {
        shas: new Set<string>(),
        segments: new Set<string>(),
      };
      entry.shas.add(row.audioSha256);
      entry.segments.add(row.segment);
      bySong.set(row.songId, entry);
    }
    const complete = (id: number) => bySong.get(id)?.segments.size === 2;
    const entries = songs
      .filter((song) => !missingOnly || !complete(song.id))
      .map((song) => {
        const known = bySong.get(song.id);
        const sha =
          known && known.shas.size === 1 && complete(song.id)
            ? [...known.shas][0]
            : null;
        return {
          songId: song.id,
          artist: song.artist,
          title: song.title,
          audioUrl: song.audioUrl,
          existingAudioSha256: sha,
        };
      });
    return {
      schema: 1 as const,
      model: SIMILARITY_MODEL,
      windowSeconds,
      songs: entries,
    };
  }

  async storeEmbeddings(payload: unknown) {
    const header = validateEmbeddingUploadHeader(payload);
    if (!header.ok) throw new BadRequestException(header.reason);
    const upload = payload as EmbeddingUploadPayload;
    if (upload.songs.length > MAX_UPLOAD_SONGS_PER_REQUEST) {
      throw new BadRequestException(
        `at most ${MAX_UPLOAD_SONGS_PER_REQUEST} songs per request`,
      );
    }
    const ids = upload.songs
      .map((s) => s?.songId)
      .filter((id): id is number => Number.isInteger(id));
    const known = new Set(
      (
        await this.prisma.song.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        })
      ).map((s) => s.id),
    );

    const results: {
      songId: number | null;
      status: 'stored' | 'rejected';
      reason?: string;
    }[] = [];
    const computedAt = new Date();
    for (const song of upload.songs) {
      const valid = validateEmbeddingUploadSong(song);
      const songId = Number.isInteger(song?.songId) ? song.songId : null;
      if (!valid.ok) {
        results.push({ songId, status: 'rejected', reason: valid.reason });
        continue;
      }
      if (!known.has(song.songId)) {
        results.push({ songId, status: 'rejected', reason: 'unknown song' });
        continue;
      }
      try {
        await this.prisma.$transaction(
          (['opening', 'closing'] as const).map(
            (segment) => this.prisma.$executeRaw`
              INSERT INTO "SongEmbedding"
                ("songId","segment","model","modelVersion","license",
                 "windowSeconds","audioSha256","vector","computedAt")
              VALUES (${song.songId}, ${segment}, ${upload.model.name},
                ${upload.model.version}, ${upload.model.license},
                ${upload.windowSeconds}, ${song.audioSha256},
                ${toVectorLiteral(song[segment])}::vector, ${computedAt})
              ON CONFLICT ("songId","segment","model","windowSeconds")
              DO UPDATE SET "modelVersion" = EXCLUDED."modelVersion",
                "license" = EXCLUDED."license",
                "audioSha256" = EXCLUDED."audioSha256",
                "vector" = EXCLUDED."vector",
                "computedAt" = EXCLUDED."computedAt"`,
          ),
        );
        results.push({ songId, status: 'stored' });
      } catch (error) {
        this.logger.error(
          `Embedding store failed for song ${song.songId}: ${String(error)}`,
        );
        results.push({ songId, status: 'rejected', reason: 'storage failed' });
      }
    }
    if (this.anyActive()) {
      try {
        await this.reloadEmbeddings();
      } catch (error) {
        this.logger.error(`Embedding refresh failed: ${String(error)}`);
      }
    }
    return { results };
  }
}
