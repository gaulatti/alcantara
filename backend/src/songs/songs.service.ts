import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

interface SongInput {
  artist?: string;
  title?: string;
  audioUrl?: string;
  coverUrl?: string | null;
  durationMs?: number | null;
  earoneSongId?: string | number | null;
  earoneRank?: string | number | null;
  earoneSpins?: string | number | null;
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
      data: data.map((song) => this.scopeIntro(song, programId)),
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
    return this.scopeIntro(song, programId);
  }

  async create(data: SongInput) {
    const artist = this.toTrimmedString(data.artist);
    const title = this.toTrimmedString(data.title);
    const audioUrl = this.toRequiredTrimmedString(data.audioUrl, 'audioUrl');

    if (!artist && !title) {
      throw new BadRequestException('artist or title is required');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const song = await tx.song.create({
          data: {
            artist,
            title,
            audioUrl,
            coverUrl: this.toOptionalTrimmedString(data.coverUrl),
            durationMs: this.toDurationMs(data.durationMs),
            earoneSongId: this.toOptionalStringValue(data.earoneSongId),
            earoneRank: this.toOptionalStringValue(data.earoneRank),
            earoneSpins: this.toOptionalStringValue(data.earoneSpins),
            enabled: data.enabled === undefined ? true : Boolean(data.enabled),
          },
        });
        if (data.introInstantId !== undefined) {
          await this.setIntro(tx, song.id, data.programId, data.introInstantId);
        }
        const saved = await tx.song.findUniqueOrThrow({
          where: { id: song.id },
          include: { intro: { include: { instant: true } } },
        });
        return this.scopeIntro(saved, this.normalizeProgramId(data.programId));
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

    if (data.earoneSongId !== undefined) {
      updateData.earoneSongId = this.toOptionalStringValue(data.earoneSongId);
    }

    if (data.earoneRank !== undefined) {
      updateData.earoneRank = this.toOptionalStringValue(data.earoneRank);
    }

    if (data.earoneSpins !== undefined) {
      updateData.earoneSpins = this.toOptionalStringValue(data.earoneSpins);
    }

    if (data.enabled !== undefined) {
      updateData.enabled = Boolean(data.enabled);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.song.update({ where: { id }, data: updateData });
        if (data.introInstantId !== undefined) {
          await this.setIntro(tx, id, data.programId, data.introInstantId);
        }
        const saved = await tx.song.findUniqueOrThrow({
          where: { id },
          include: { intro: { include: { instant: true } } },
        });
        return this.scopeIntro(saved, this.normalizeProgramId(data.programId));
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
    await this.prisma.song.delete({ where: { id } });
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
}
