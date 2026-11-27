import { PlayoutLease, startWhenActive } from '../playout/playout-lease.service';
import { isDeployCandidate } from '../config/deploy-candidate';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PompeiiService } from '../auth/pompeii.service';
import { PrismaService } from '../prisma.service';
import { forTeam } from '../tenancy/scoped-prisma';
import {
  RadioMetricsService,
  type SimilarityScopePath,
} from './radio-metrics.service';
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
  // gaulatti/alcantara#122: the index is shared by every program, so each pick keeps only the songs of the
  // program's team. Loaded with the settings and the embeddings.
  private readonly songTeams = new Map<number, number | null>();
  private readonly programTeams = new Map<string, number | null>();
  private readonly refused = new Set<string>();
  private readonly insertCounts = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  // Set once the first load of settings and embeddings has finished, whether
  // it worked or failed (a failed load leaves similarity off): until then the
  // vector map is empty, and a pick made from it falls back for a reason that
  // is not the song's (#277, 2026-11-22: both restarts replayed the cursor).
  private ready = false;
  private markReady!: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.markReady = () => {
      this.ready = true;
      resolve();
    };
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: RadioMetricsService,
    private readonly pompeii: PompeiiService,
    @Optional() private readonly lease?: PlayoutLease,
  ) {}

  private destroyed = false;

  /**
   * Starts the first load without waiting for it: it takes seconds, and the port does not open until every start-up
   * hook returns (alcantara#873). Whatever picks from the index waits for `whenReady()` first.
   */
  onModuleInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.reloadSettings();
      if (this.anyActive()) await this.reloadEmbeddings();
    } catch (error) {
      this.settings.clear();
      this.logger.error(
        `Similarity state could not be loaded; similarity stays off: ${String(error)}`,
      );
    }
    this.markReady();
    this.logger.log(
      `Similarity index ready: ${this.vectors.size} vectors for ${this.catalog.size} songs in ${Date.now() - startedAt} ms${this.anyActive() ? '' : ' (similarity is off)'}`,
    );
    if (isDeployCandidate()) {
      this.logger.log(
        'Deploy candidate: the similarity catalog is not refreshed',
      );
      return;
    }
    if (this.destroyed) return;
    // Only the instance holding the playout lease (alcantara#873) refreshes the catalog.
    startWhenActive(this.lease, () => {
      this.refreshTimer = setInterval(() => {
        if (!this.anyActive()) return;
        void this.reloadEmbeddings().catch((error) =>
          this.logger.error(`Similarity refresh failed: ${String(error)}`),
        );
      }, CATALOG_REFRESH_MS);
      this.refreshTimer.unref?.();
    });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /** Whether the first load of settings and embeddings has finished. */
  isReady(): boolean {
    return this.ready;
  }

  /** Resolves when the first load has finished (also if it failed). */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  getSettings(programId: string): SimilaritySettings {
    return this.settings.get(programId) ?? DEFAULT_SIMILARITY_SETTINGS;
  }

  private anyActive(): boolean {
    return [...this.settings.values()].some((s) => s.mode !== 'off');
  }

  /**
   * The team whose songs a program reads: `null` when it has none, and `0` when no station team is configured, which
   * stays unscoped.
   */
  private async teamOf(programId: string): Promise<number | null> {
    if (this.pompeii.teamId === 0) return 0;
    const program = await this.prisma.program.findUnique({
      where: { programId },
      select: { teamId: true },
    });
    return program?.teamId && program.teamId > 0 ? program.teamId : null;
  }

  /** The songs a program may read, or `null` (counted) when it has no team. */
  private async songScope(
    path: SimilarityScopePath,
    programId: string,
  ): Promise<{ team: number; db: PrismaService } | null> {
    const team = await this.teamOf(programId);
    if (team === null) {
      this.refuse(path, programId);
      return null;
    }
    return {
      team,
      db:
        team > 0
          ? (forTeam(this.prisma, team) as unknown as PrismaService)
          : this.prisma,
    };
  }

  private refuse(path: SimilarityScopePath, programId: string) {
    this.metrics.recordSimilarityScopeRefusal(path);
    const key = `${path}|${programId}`;
    if (this.refused.has(key)) return;
    this.refused.add(key);
    this.logger.warn(
      `Program ${programId} has no team; similarity ${path} reads no songs`,
    );
  }

  /** Which indexed songs a pick for this program may use. */
  private pickable(programId: string): (songId: number) => boolean {
    if (this.pompeii.teamId === 0) return () => true;
    const team = this.programTeams.get(programId);
    if (!team || team <= 0) {
      this.refuse('propose', programId);
      return () => false;
    }
    return (songId) => this.songTeams.get(songId) === team;
  }

  private async loadProgramTeams(): Promise<void> {
    if (this.pompeii.teamId === 0) return;
    const programs = await this.prisma.program.findMany({
      select: { programId: true, teamId: true },
    });
    this.programTeams.clear();
    for (const program of programs) {
      this.programTeams.set(program.programId, program.teamId);
    }
  }

  async reloadSettings(): Promise<void> {
    await this.loadProgramTeams();
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
        teamId: number | null;
      }[]
    >`SELECT e."songId", e."segment", e."windowSeconds", e."vector"::text AS "vector", s."teamId"
      FROM "SongEmbedding" e JOIN "Song" s ON s."id" = e."songId"
      WHERE e."model" = ${SIMILARITY_MODEL.name}`;
    await this.loadProgramTeams();
    this.vectors.clear();
    this.songTeams.clear();
    for (const row of rows) this.songTeams.set(row.songId, row.teamId);
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
    const pickable = this.pickable(programId);
    for (const { leaf, blocked } of input.leaves) {
      if (!leaf.songId || !leaf.audioUrl) continue;
      inSequence.add(leaf.songId);
      if (!pickable(leaf.songId)) continue;
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
        if (inSequence.has(song.id) || !pickable(song.id)) continue;
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

    // Every candidate id was registered in `leafByItemId` above.
    const leaf = result.chosen
      ? (leafByItemId.get(result.chosen.itemId) as ProgramResolvedSongLeaf)
      : null;
    return { result, leaf };
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
    // A fallback is the playlist cursor playing instead of the picker. With no
    // embedding for the song that just played it is not a normal outcome (787
    // of 792 songs are embedded), so it says what the index held (#277).
    if (decision.outcome === 'fallback-no-embedding') {
      this.logger.warn(
        `Similarity fell back to the playlist cursor on ${programId}: no closing embedding for song ${decision.currentSongId ?? 'none'} (index ${this.ready ? 'ready' : 'loading'}, ${this.vectors.size} vectors)`,
      );
    } else if (decision.outcome === 'fallback-no-candidate') {
      this.logger.log(
        `Similarity fell back to the playlist cursor on ${programId}: no candidate above the threshold after song ${decision.currentSongId ?? 'none'}`,
      );
    }
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
    const scope = await this.songScope('decisions', programId);
    const songs = scope
      ? await scope.db.song.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, artist: true, title: true },
        })
      : [];
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
    const scope = await this.songScope('coverage', programId);
    // Raw SQL is not scoped by the client, so the join names the team.
    const ofTeam = scope?.team
      ? Prisma.sql`AND s."teamId" = ${scope.team}`
      : Prisma.empty;
    const [enabledSongs, embedded] = scope
      ? await Promise.all([
          scope.db.song.count({ where: { enabled: true } }),
          this.prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*)::bigint AS count FROM (
              SELECT e."songId" FROM "SongEmbedding" e
              JOIN "Song" s ON s."id" = e."songId" AND s."enabled" = true ${ofTeam}
              WHERE e."model" = ${SIMILARITY_MODEL.name}
                AND e."windowSeconds" = ${windowSeconds}
              GROUP BY e."songId" HAVING COUNT(DISTINCT e."segment") = 2
            ) complete`,
        ])
      : [0, []];
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
    const songScope = await this.songScope('export', programId);
    const songs = songScope
      ? await songScope.db.song.findMany({
          where: { enabled: true, ...(songIds ? { id: { in: songIds } } : {}) },
          orderBy: { id: 'asc' },
          select: { id: true, artist: true, title: true, audioUrl: true },
        })
      : [];
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

  /** Stores embeddings for songs of the program's team only. */
  async storeEmbeddings(payload: unknown, programId: string) {
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
    const scope = await this.songScope('upload', programId);
    const known = new Set(
      scope
        ? (
            await scope.db.song.findMany({
              where: { id: { in: ids } },
              select: { id: true },
            })
          ).map((s) => s.id)
        : [],
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
