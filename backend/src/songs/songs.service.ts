import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
}

interface FindAllParams {
  search?: string;
  enabled?: boolean;
  sortBy?: string;
  sortOrder?: string;
  page: number;
  limit: number;
}

const ALLOWED_SORT_FIELDS = ['id', 'artist', 'title', 'durationMs', 'updatedAt', 'createdAt', 'enabled'] as const;

@Injectable()
export class SongsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(params: FindAllParams) {
    const { search, enabled, sortBy, sortOrder, page, limit } = params;

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

    const actualSortBy = ALLOWED_SORT_FIELDS.includes(sortBy as typeof ALLOWED_SORT_FIELDS[number])
      ? (sortBy as string)
      : 'artist';
    const actualSortOrder: 'asc' | 'desc' = sortOrder === 'asc' ? 'asc' : 'desc';

    const orderBy: Prisma.SongOrderByWithRelationInput[] = [
      { [actualSortBy]: actualSortOrder },
      { id: 'desc' },
    ] as Prisma.SongOrderByWithRelationInput[];

    const skip = (page - 1) * limit;

    const [data, total, catalogTotal, catalogEnabled, durationAgg] = await Promise.all([
      this.prisma.song.findMany({ where, orderBy, skip, take: limit }),
      this.prisma.song.count({ where }),
      this.prisma.song.count(),
      this.prisma.song.count({ where: { enabled: true } }),
      this.prisma.song.aggregate({
        _sum: { durationMs: true },
        _count: { durationMs: true },
      }),
    ]);

    return {
      data,
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

  async findOne(id: number) {
    const song = await this.prisma.song.findUnique({ where: { id } });
    if (!song) {
      throw new NotFoundException('Song not found');
    }
    return song;
  }

  async create(data: SongInput) {
    const artist = this.toTrimmedString(data.artist);
    const title = this.toTrimmedString(data.title);
    const audioUrl = this.toRequiredTrimmedString(data.audioUrl, 'audioUrl');

    if (!artist && !title) {
      throw new BadRequestException('artist or title is required');
    }

    return this.prisma.song.create({
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
  }

  async update(id: number, data: SongInput) {
    const existing = await this.findOne(id);
    const artist = data.artist === undefined ? existing.artist : this.toTrimmedString(data.artist);
    const title = data.title === undefined ? existing.title : this.toTrimmedString(data.title);

    if (!artist && !title) {
      throw new BadRequestException('artist or title is required');
    }

    const updateData: Record<string, unknown> = {
      artist,
      title,
    };

    if (data.audioUrl !== undefined) {
      updateData.audioUrl = this.toRequiredTrimmedString(data.audioUrl, 'audioUrl');
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

    return this.prisma.song.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.song.delete({ where: { id } });
    return { deletedSongId: id };
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
