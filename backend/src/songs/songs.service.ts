import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetKind, Prisma } from '@prisma/client';
import {
  deleteMediaAsset,
  deleteSongCoverAsset,
  syncSongAsset,
} from '../media-assets/media-asset-sync';
import { PrismaService } from '../prisma.service';

/**
 * The media-analysis columns exposed to clients. Shared with the media-assets
 * list so both responses carry the same analysis shape.
 */
export const MEDIA_ANALYSIS_SELECT = {
  assetId: true,
  status: true,
  cueInSeconds: true,
  cueOutSeconds: true,
  fadeInSeconds: true,
  fadeOutSeconds: true,
  overlapSeconds: true,
  integratedLufs: true,
  truePeakDbtp: true,
  isrc: true,
  musicbrainzRecordingId: true,
  error: true,
  attempts: true,
  nextAttemptAt: true,
  updatedAt: true,
} satisfies Prisma.MediaAssetAnalysisSelect;

interface SongInput {
  artist?: string;
  title?: string;
  audioUrl?: string;
  coverUrl?: string | null;
  durationMs?: number | null;
  earoneSongId?: string | number | null;
  earoneRank?: string | number | null;
  earoneSpins?: string | number | null;
  externalChartId?: string | number | null;
  externalChartSongId?: string | number | null;
  externalChartRank?: string | number | null;
  externalChartSpins?: string | number | null;
  externalChartProvider?: string | null;
  enabled?: boolean;
  programId?: string;
  introInstantId?: number | null;
}

interface FindAllParams {
  search?: string;
  enabled?: boolean;
  sortBy?: string;
  sortOrder?: string;
  page: number;
  limit: number;
  programId?: string;
}

export interface SongAnalysis {
  assetId: string;
  status: string;
  cueInSeconds: number | null;
  cueOutSeconds: number | null;
  fadeInSeconds: number | null;
  fadeOutSeconds: number | null;
  overlapSeconds: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  isrc: string | null;
  musicbrainzRecordingId: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  updatedAt: Date;
}

const ALLOWED_SORT_FIELDS = [
  'id',
  'artist',
  'title',
  'durationMs',
  'updatedAt',
  'createdAt',
  'enabled',
] as const;

@Injectable()
export class SongsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(params: FindAllParams) {
    const { search, enabled, sortBy, sortOrder, page, limit } = params;
    const programId = this.normalizeProgramId(params.programId);

    const where: Prisma.SongWhereInput = {};

    if (enabled !== undefined) {
      where.enabled = enabled;
    }

    if (search) {
      const term = search.trim();
      if (term) {
        where.OR = [
          { artist: { contains: term, mode: 'insensitive' } },
          { title: { contains: term, mode: 'insensitive' } },
          { earoneSongId: { contains: term, mode: 'insensitive' } },
        ];
      }
    }

    const actualSortBy = ALLOWED_SORT_FIELDS.includes(
      sortBy as (typeof ALLOWED_SORT_FIELDS)[number],
    )
      ? (sortBy as string)
      : 'artist';
    const actualSortOrder: 'asc' | 'desc' =
      sortOrder === 'asc' ? 'asc' : 'desc';

    const orderBy: Prisma.SongOrderByWithRelationInput[] = [
      { [actualSortBy]: actualSortOrder },
      { id: 'desc' },
    ] as Prisma.SongOrderByWithRelationInput[];

    const skip = limit > 0 ? (page - 1) * limit : 0;

    const [data, total, catalogTotal, catalogEnabled, durationAgg] =
      await Promise.all([
        this.prisma.song.findMany({
          where,
          orderBy,
          include: { intro: { include: { instant: true } } },
          ...(limit > 0 ? { skip, take: limit } : {}),
        }),
        this.prisma.song.count({ where }),
        this.prisma.song.count(),
        this.prisma.song.count({ where: { enabled: true } }),
        this.prisma.song.aggregate({
          _sum: { durationMs: true },
          _count: { durationMs: true },
        }),
      ]);

    return {
      data: data.map((song) =>
        this.withGenericChartFields(this.scopeIntro(song, programId)),
      ),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        catalogTotal,
        catalogEnabled,
        catalogTotalDurationMs: durationAgg._sum.durationMs ?? 0,
        catalogKnownDurationCount: durationAgg._count.durationMs,
      },
    };
  }

  async findOne(id: number, requestedProgramId?: string) {
    const programId = this.normalizeProgramId(requestedProgramId);
    const song = await this.prisma.song.findUnique({
      where: { id },
      include: { intro: { include: { instant: true } } },
    });
    if (!song) {
      throw new NotFoundException('Song not found');
    }
    return this.withGenericChartFields(this.scopeIntro(song, programId));
  }

  /**
   * The stored audio analysis (cue points, fades, loudness, status) of each
   * media asset, keyed by asset ID. An asset with no row has no entry.
   */
  async findAnalyses(assetIds: string[]) {
    if (assetIds.length === 0) return new Map<string, SongAnalysis>();
    const rows = await this.prisma.mediaAssetAnalysis.findMany({
      where: { assetId: { in: assetIds } },
      select: MEDIA_ANALYSIS_SELECT,
    });
    return new Map<string, SongAnalysis>(rows.map((row) => [row.assetId, row]));
  }

  async create(data: SongInput) {
    const artist = this.toTrimmedString(data.artist);
    const title = this.toTrimmedString(data.title);
    const audioUrl = this.toRequiredTrimmedString(data.audioUrl, 'audioUrl');

    if (!artist && !title) {
      throw new BadRequestException('artist or title is required');
    }

    const earoneSongId = this.toOptionalStringValue(
      data.earoneSongId ?? data.externalChartId ?? data.externalChartSongId,
    );
    const earoneRank = this.toOptionalStringValue(
      data.earoneRank ?? data.externalChartRank,
    );
    const earoneSpins = this.toOptionalStringValue(
      data.earoneSpins ?? data.externalChartSpins,
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const song = await tx.song.create({
          data: {
            artist,
            title,
            audioUrl,
            coverUrl: this.toOptionalTrimmedString(data.coverUrl),
            durationMs: this.toDurationMs(data.durationMs),
            earoneSongId,
            earoneRank,
            earoneSpins,
            enabled: data.enabled === undefined ? true : Boolean(data.enabled),
          },
        });
        await syncSongAsset(tx, song);
        if (
          tx.songChartIdentity &&
          (earoneSongId !== null || earoneRank !== null || earoneSpins !== null)
        ) {
          await this.syncChartIdentity(tx, song, data.externalChartProvider);
        }
        if (data.introInstantId !== undefined) {
          await this.setIntro(tx, song.id, data.programId, data.introInstantId);
        }
        const saved = await tx.song.findUniqueOrThrow({
          where: { id: song.id },
          include: { intro: { include: { instant: true } } },
        });
        return this.withGenericChartFields(
          this.scopeIntro(saved, this.normalizeProgramId(data.programId)),
        );
      });
    } catch (error) {
      this.rethrowIntroConflict(error);
    }
  }

  async update(id: number, data: SongInput) {
    const existing = await this.prisma.song.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Song not found');
    }
    const artist =
      data.artist === undefined
        ? existing.artist
        : this.toTrimmedString(data.artist);
    const title =
      data.title === undefined
        ? existing.title
        : this.toTrimmedString(data.title);

    if (!artist && !title) {
      throw new BadRequestException('artist or title is required');
    }

    const updateData: Record<string, unknown> = {
      artist,
      title,
    };

    if (data.audioUrl !== undefined) {
      updateData.audioUrl = this.toRequiredTrimmedString(
        data.audioUrl,
        'audioUrl',
      );
    }

    if (data.coverUrl !== undefined) {
      updateData.coverUrl = this.toOptionalTrimmedString(data.coverUrl);
    }

    if (data.durationMs !== undefined) {
      updateData.durationMs = this.toDurationMs(data.durationMs);
    }

    if (
      data.earoneSongId !== undefined ||
      data.externalChartId !== undefined ||
      data.externalChartSongId !== undefined
    ) {
      updateData.earoneSongId = this.toOptionalStringValue(
        data.earoneSongId ?? data.externalChartId ?? data.externalChartSongId,
      );
    }

    if (data.earoneRank !== undefined || data.externalChartRank !== undefined) {
      updateData.earoneRank = this.toOptionalStringValue(
        data.earoneRank ?? data.externalChartRank,
      );
    }

    if (data.earoneSpins !== undefined || data.externalChartSpins !== undefined) {
      updateData.earoneSpins = this.toOptionalStringValue(
        data.earoneSpins ?? data.externalChartSpins,
      );
    }

    if (data.enabled !== undefined) {
      updateData.enabled = Boolean(data.enabled);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const song = await tx.song.update({ where: { id }, data: updateData });
        await syncSongAsset(tx, song);
        if (tx.songChartIdentity) {
          await this.syncChartIdentity(tx, song, data.externalChartProvider);
        }
        if (data.introInstantId !== undefined) {
          await this.setIntro(tx, id, data.programId, data.introInstantId);
        }
        const saved = await tx.song.findUniqueOrThrow({
          where: { id },
          include: { intro: { include: { instant: true } } },
        });
        return this.withGenericChartFields(
          this.scopeIntro(saved, this.normalizeProgramId(data.programId)),
        );
      });
    } catch (error) {
      this.rethrowIntroConflict(error);
    }
  }

  async remove(id: number) {
    const existing = await this.prisma.song.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Song not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.song.delete({ where: { id } });
      await deleteMediaAsset(tx, MediaAssetKind.SONG, id);
      await deleteSongCoverAsset(tx, id);
    });
    return { deletedSongId: id };
  }

  private normalizeProgramId(value: unknown): string {
    if (value === undefined || value === null) return 'main';
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.trim().length > 100
    ) {
      throw new BadRequestException(
        'programId must be a non-empty bounded string',
      );
    }
    return value.trim();
  }

  private scopeIntro<
    T extends {
      intro: ({ programId: string } & Record<string, unknown>) | null;
    },
  >(song: T, programId: string): T {
    return {
      ...song,
      intro: song.intro?.programId === programId ? song.intro : null,
    };
  }

  private async setIntro(
    tx: Prisma.TransactionClient,
    songId: number,
    requestedProgramId: string | undefined,
    instantId: number | null,
  ): Promise<void> {
    const programId = this.normalizeProgramId(requestedProgramId);
    const program = await tx.programState.findUnique({
      where: { programId },
      select: { programId: true },
    });
    if (!program) {
      throw new BadRequestException('Program not found');
    }

    const current = await tx.songIntro.findUnique({
      where: { songId },
      select: { id: true, programId: true, instantId: true },
    });
    if (current && current.programId !== programId) {
      throw new BadRequestException('Song intro belongs to another program');
    }
    if (instantId === null) {
      if (current) await tx.songIntro.delete({ where: { id: current.id } });
      return;
    }
    if (!Number.isInteger(instantId) || instantId <= 0) {
      throw new BadRequestException('introInstantId must identify an Instant');
    }
    const instant = await tx.instant.findUnique({
      where: { id: instantId },
      select: { id: true, enabled: true, audioUrl: true },
    });
    if (!instant || !instant.enabled || !instant.audioUrl.trim()) {
      throw new BadRequestException(
        'Song intro Instant is missing or unavailable',
      );
    }
    const assigned = await tx.songIntro.findUnique({
      where: { instantId },
      select: { songId: true, programId: true },
    });
    if (assigned && assigned.songId !== songId) {
      throw new BadRequestException(
        'Instant is already assigned as a song intro',
      );
    }
    await tx.songIntro.upsert({
      where: { songId },
      create: { songId, instantId, programId },
      update: { instantId },
    });
  }

  private rethrowIntroConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new BadRequestException(
        'Song or Instant already has an active intro assignment',
      );
    }
    throw error;
  }

  private toTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private toRequiredTrimmedString(value: unknown, fieldName: string): string {
    const normalized = this.toTrimmedString(value);
    if (!normalized) {
      throw new BadRequestException(`${fieldName} is required`);
    }
    return normalized;
  }

  private toOptionalTrimmedString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const normalized = this.toTrimmedString(value);
    return normalized || null;
  }

  private toOptionalStringValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    const normalized = this.toTrimmedString(value);
    return normalized || null;
  }

  private toDurationMs(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new BadRequestException('durationMs must be a positive number');
    }

    return Math.max(1, Math.round(numeric));
  }

  // The song's SongChartIdentity follows its chart values: written while any is set, removed once all are cleared.
  // An update without a provider keeps the stored one; a new row without one is 'earone', the only provider today.
  private async syncChartIdentity(
    tx: Prisma.TransactionClient,
    song: { id: number; earoneSongId: string | null; earoneRank: string | null; earoneSpins: string | null },
    requestedProvider?: string | null,
  ) {
    if (song.earoneSongId === null && song.earoneRank === null && song.earoneSpins === null) {
      await tx.songChartIdentity.deleteMany({ where: { songId: song.id } });
      return;
    }
    const values = { externalId: song.earoneSongId, rank: song.earoneRank, spins: song.earoneSpins };
    const provider = typeof requestedProvider === 'string' && requestedProvider.trim() ? requestedProvider.trim() : undefined;
    await tx.songChartIdentity.upsert({
      where: { songId: song.id },
      create: { songId: song.id, provider: provider ?? 'earone', ...values },
      update: { ...values, ...(provider !== undefined && { provider }) },
    });
  }

  private withGenericChartFields<
    T extends {
      earoneSongId: string | null;
      earoneRank: string | null;
      earoneSpins: string | null;
    },
  >(
    song: T,
  ): T & {
    externalChartId: string | null;
    externalChartSongId: string | null;
    externalChartRank: string | null;
    externalChartSpins: string | null;
  } {
    return {
      ...song,
      externalChartId: song.earoneSongId,
      externalChartSongId: song.earoneSongId,
      externalChartRank: song.earoneRank,
      externalChartSpins: song.earoneSpins,
    };
  }
}
