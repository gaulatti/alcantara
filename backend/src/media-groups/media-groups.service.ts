import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  OperatorChangeRecorder,
  summarizeChange,
} from '../operator-change/operator-change-recorder';
import { MEDIA_GROUP_CHANGE_FIELDS } from '../operator-change/library-change-fields';
import {
  deleteLegacyMediaGroupLabel,
  syncLegacyMediaGroupLabel,
} from '../media-assets/media-label-sync';
import { forTeam } from '../tenancy/scoped-prisma';

interface MediaGroupInput {
  name?: string;
  description?: string | null;
  mediaIds?: number[];
}

interface FindAllParams {
  search?: string;
  sortBy?: string;
  sortOrder?: string;
  page: number;
  limit: number;
}

const ALLOWED_SORT_FIELDS = ['id', 'name', 'updatedAt', 'createdAt'] as const;

type MediaGroupRecord = Prisma.MediaGroupGetPayload<{
  include: {
    mediaItems: {
      include: { media: true };
      orderBy: { position: 'asc' };
    };
  };
}>;

@Injectable()
export class MediaGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recorder: OperatorChangeRecorder,
  ) {}

  /**
   * The rows of one team (gaulatti/alcantara#122): groups, the media they may hold and their labels. `0` means no
   * team is configured, which production refuses, and sees every row. Nested relations are not scoped.
   */
  private db(teamId: number): PrismaService {
    return teamId > 0
      ? (forTeam(this.prisma, teamId) as unknown as PrismaService)
      : this.prisma;
  }

  async findAll(params: FindAllParams, teamId = 0) {
    const { search, sortBy, sortOrder, page, limit } = params;

    const where: Prisma.MediaGroupWhereInput = {};

    if (search) {
      const term = search.trim();
      if (term) {
        where.name = { contains: term, mode: 'insensitive' };
      }
    }

    const actualSortBy = ALLOWED_SORT_FIELDS.includes(
      sortBy as (typeof ALLOWED_SORT_FIELDS)[number],
    )
      ? (sortBy as string)
      : 'updatedAt';
    const actualSortOrder: 'asc' | 'desc' =
      sortOrder === 'asc' ? 'asc' : 'desc';

    const orderBy: Prisma.MediaGroupOrderByWithRelationInput[] = [
      { [actualSortBy]: actualSortOrder },
      { id: 'desc' },
    ] as Prisma.MediaGroupOrderByWithRelationInput[];

    const skip = limit > 0 ? (page - 1) * limit : 0;

    const [groups, total] = await Promise.all([
      this.db(teamId).mediaGroup.findMany({
        where,
        include: {
          mediaItems: {
            include: { media: true },
            orderBy: { position: 'asc' },
          },
        },
        orderBy,
        ...(limit > 0 ? { skip, take: limit } : {}),
      }),
      this.db(teamId).mediaGroup.count({ where }),
    ]);

    return {
      data: groups.map((group) => this.mapGroup(group)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number, teamId = 0) {
    const group = await this.db(teamId).mediaGroup.findUnique({
      where: { id },
      include: {
        mediaItems: {
          include: { media: true },
          orderBy: { position: 'asc' },
        },
      },
    });

    if (!group) {
      throw new NotFoundException('Media group not found');
    }

    return this.mapGroup(group);
  }

  async create(data: MediaGroupInput, teamId = 0) {
    const name = this.toRequiredTrimmedString(data.name, 'name');
    const description = this.toOptionalTrimmedString(data.description);
    const mediaIds = this.normalizeMediaIds(data.mediaIds, false);

    await this.assertMediaIdsExist(mediaIds, teamId);

    let group: MediaGroupRecord | null = null;
    try {
      group = await this.db(teamId).$transaction(async (tx) => {
        const created = await tx.mediaGroup.create({
          data: {
            name,
            description,
          },
        });

        if (mediaIds.length > 0) {
          await tx.mediaGroupItem.createMany({
            data: mediaIds.map((mediaId, index) => ({
              mediaGroupId: created.id,
              mediaId,
              position: index,
            })),
          });
        }

        const hydrated = await tx.mediaGroup.findUnique({
          where: { id: created.id },
          include: {
            mediaItems: {
              include: { media: true },
              orderBy: { position: 'asc' },
            },
          },
        });
        if (!hydrated) {
          throw new NotFoundException('Media group not found after create');
        }
        await syncLegacyMediaGroupLabel(tx, hydrated);
        return hydrated;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException('Media group name already exists');
      }
      throw error;
    }

    if (!group) {
      throw new NotFoundException('Media group not found after create');
    }

    return this.mapGroup(group);
  }

  async update(id: number, data: MediaGroupInput, teamId = 0) {
    const actor = this.recorder.actor();
    await this.ensureMediaGroupExists(id, teamId);

    const updateData: Prisma.MediaGroupUpdateInput = {};

    if (data.name !== undefined) {
      updateData.name = this.toRequiredTrimmedString(data.name, 'name');
    }

    if (data.description !== undefined) {
      updateData.description = this.toOptionalTrimmedString(data.description);
    }

    const hasMediaIds = Object.prototype.hasOwnProperty.call(
      data,
      'mediaIds',
    ) as boolean;
    const mediaIds = this.normalizeMediaIds(data.mediaIds, hasMediaIds);

    if (hasMediaIds) {
      await this.assertMediaIdsExist(mediaIds, teamId);
    }

    // The size of the list before it is replaced, for the change record; never in the way of the change.
    const previousCount =
      actor && hasMediaIds
        ? await this.prisma.mediaGroupItem
            .count({ where: { mediaGroupId: id } })
            .catch(() => null)
        : null;

    let group: MediaGroupRecord | null = null;
    try {
      group = await this.db(teamId).$transaction(async (tx) => {
        if (Object.keys(updateData).length > 0) {
          await tx.mediaGroup.update({
            where: { id },
            data: updateData,
          });
        }

        if (hasMediaIds) {
          await tx.mediaGroupItem.deleteMany({ where: { mediaGroupId: id } });
          if (mediaIds.length > 0) {
            await tx.mediaGroupItem.createMany({
              data: mediaIds.map((mediaId, index) => ({
                mediaGroupId: id,
                mediaId,
                position: index,
              })),
            });
          }
        }

        const hydrated = await tx.mediaGroup.findUnique({
          where: { id },
          include: {
            mediaItems: {
              include: { media: true },
              orderBy: { position: 'asc' },
            },
          },
        });
        if (!hydrated) {
          throw new NotFoundException('Media group not found after update');
        }
        await syncLegacyMediaGroupLabel(tx, hydrated);
        return hydrated;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException('Media group name already exists');
      }
      throw error;
    }

    if (!group) {
      throw new NotFoundException('Media group not found after update');
    }

    // The change is final; recording who made it never blocks it (gaulatti/alcantara#236).
    await this.recorder.record({
      actor,
      target: 'media_group',
      targetId: String(id),
      programId: null,
      capability: { mcp: 'media_group_update', console: 'media-groups.update' },
      summary: summarizeChange(
        MEDIA_GROUP_CHANGE_FIELDS,
        { ...data },
        { mediaIds: previousCount },
        { mediaIds: group.mediaItems.length },
      ),
    });
    return this.mapGroup(group);
  }

  async remove(id: number, teamId = 0) {
    await this.ensureMediaGroupExists(id, teamId);
    await this.db(teamId).$transaction(async (tx) => {
      await tx.mediaGroup.delete({ where: { id } });
      await deleteLegacyMediaGroupLabel(tx, id);
    });
    return { deletedMediaGroupId: id };
  }

  private async ensureMediaGroupExists(
    id: number,
    teamId: number,
  ): Promise<void> {
    const group = await this.db(teamId).mediaGroup.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!group) {
      throw new NotFoundException('Media group not found');
    }
  }

  private async assertMediaIdsExist(
    mediaIds: number[],
    teamId: number,
  ): Promise<void> {
    if (mediaIds.length === 0) {
      return;
    }

    const rows = await this.db(teamId).media.findMany({
      where: { id: { in: mediaIds } },
      select: { id: true },
    });
    const existing = new Set(rows.map((row) => row.id));
    const missing = mediaIds.filter((mediaId) => !existing.has(mediaId));

    if (missing.length > 0) {
      throw new BadRequestException(`Unknown media ids: ${missing.join(', ')}`);
    }
  }

  private normalizeMediaIds(value: unknown, required: boolean): number[] {
    if (!required && (value === undefined || value === null)) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new BadRequestException('mediaIds must be an array');
    }

    const deduped: number[] = [];
    const seen = new Set<number>();

    for (const entry of value) {
      const numeric = typeof entry === 'number' ? entry : Number(entry);
      if (
        !Number.isFinite(numeric) ||
        numeric <= 0 ||
        !Number.isInteger(numeric)
      ) {
        throw new BadRequestException(
          'mediaIds must contain positive integer ids',
        );
      }

      if (!seen.has(numeric)) {
        seen.add(numeric);
        deduped.push(numeric);
      }
    }

    return deduped;
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

  private mapGroup(group: MediaGroupRecord) {
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      items: group.mediaItems.map((item) => ({
        id: item.id,
        mediaGroupId: item.mediaGroupId,
        mediaId: item.mediaId,
        position: item.position,
        media: item.media,
      })),
    };
  }
}
