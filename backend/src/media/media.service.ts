import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetKind, Prisma } from '@prisma/client';
import {
  deleteMediaAsset,
  syncImageAsset,
} from '../media-assets/media-asset-sync';
import { syncLegacyMediaGroupLabel } from '../media-assets/media-label-sync';
import { PrismaService } from '../prisma.service';
import {
  OperatorChangeRecorder,
  summarizeChange,
} from '../operator-change/operator-change-recorder';
import { MEDIA_CHANGE_FIELDS } from '../operator-change/library-change-fields';
import { forTeam } from '../tenancy/scoped-prisma';

interface MediaInput {
  name?: string;
  imageUrl?: string;
}

interface FindAllParams {
  search?: string;
  sortBy?: string;
  sortOrder?: string;
  page: number;
  limit: number;
}

const ALLOWED_SORT_FIELDS = ['id', 'name', 'updatedAt', 'createdAt'] as const;

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recorder: OperatorChangeRecorder,
  ) {}

  /**
   * The rows of one team (gaulatti/alcantara#122): media, their assets, and the groups and labels a delete touches.
   * `0` means no team is configured, which production refuses, and sees every row. Nested relations are not scoped.
   */
  private db(teamId: number): PrismaService {
    return teamId > 0
      ? (forTeam(this.prisma, teamId) as unknown as PrismaService)
      : this.prisma;
  }

  /** The row just written; findUniqueOrThrow is refused on the team-scoped client. */
  private async readBack(
    tx: Prisma.TransactionClient,
    id: number,
    teamId: number,
  ) {
    return teamId > 0
      ? (await tx.media.findUnique({ where: { id } }))!
      : tx.media.findUniqueOrThrow({ where: { id } });
  }

  async findAll(params: FindAllParams, teamId = 0) {
    const { search, sortBy, sortOrder, page, limit } = params;

    const where: Prisma.MediaWhereInput = {};

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

    const orderBy: Prisma.MediaOrderByWithRelationInput[] = [
      { [actualSortBy]: actualSortOrder },
      { id: 'desc' },
    ] as Prisma.MediaOrderByWithRelationInput[];

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.db(teamId).media.findMany({ where, orderBy, skip, take: limit }),
      this.db(teamId).media.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number, teamId = 0) {
    const media = await this.db(teamId).media.findUnique({ where: { id } });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    return media;
  }

  async create(data: MediaInput, teamId = 0) {
    const name = this.toRequiredTrimmedString(data.name, 'name');
    const imageUrl = this.toRequiredTrimmedString(data.imageUrl, 'imageUrl');

    return this.db(teamId).$transaction(async (tx) => {
      const media = await tx.media.create({ data: { name, imageUrl } });
      await syncImageAsset(tx, media);
      return this.readBack(tx, media.id, teamId);
    });
  }

  async update(id: number, data: MediaInput, teamId = 0) {
    const actor = this.recorder.actor();
    await this.findOne(id, teamId);

    const updateData: Prisma.MediaUpdateInput = {};

    if (data.name !== undefined) {
      updateData.name = this.toRequiredTrimmedString(data.name, 'name');
    }

    if (data.imageUrl !== undefined) {
      updateData.imageUrl = this.toRequiredTrimmedString(
        data.imageUrl,
        'imageUrl',
      );
    }

    if (Object.keys(updateData).length === 0) {
      return this.findOne(id, teamId);
    }

    const result = await this.db(teamId).$transaction(async (tx) => {
      const media = await tx.media.update({ where: { id }, data: updateData });
      await syncImageAsset(tx, media);
      return this.readBack(tx, id, teamId);
    });
    // The change is final; recording who made it never blocks it (gaulatti/alcantara#236).
    await this.recorder.record({
      actor,
      target: 'media',
      targetId: String(id),
      programId: null,
      capability: { mcp: 'media_update', console: 'media.update' },
      summary: summarizeChange(MEDIA_CHANGE_FIELDS, { ...data }, null, null),
    });
    return result;
  }

  async remove(id: number, teamId = 0) {
    await this.findOne(id, teamId);

    const impactedRows = await this.prisma.mediaGroupItem.findMany({
      where: { mediaId: id },
      select: { mediaGroupId: true },
    });
    const impactedGroupIds = [
      ...new Set(impactedRows.map((row) => row.mediaGroupId)),
    ];

    await this.db(teamId).$transaction(async (tx) => {
      await tx.media.delete({ where: { id } });
      await deleteMediaAsset(tx, MediaAssetKind.IMAGE, id);

      for (const mediaGroupId of impactedGroupIds) {
        await this.rebalanceGroupItems(tx, mediaGroupId);
        const query = {
          where: { id: mediaGroupId },
          include: {
            mediaItems: {
              include: { media: true },
              orderBy: { position: 'asc' as const },
            },
          },
        };
        const group =
          teamId > 0
            ? (await tx.mediaGroup.findUnique(query))!
            : await tx.mediaGroup.findUniqueOrThrow(query);
        await syncLegacyMediaGroupLabel(tx, group);
      }
    });

    return { deletedMediaId: id };
  }

  private async rebalanceGroupItems(
    tx: Prisma.TransactionClient,
    mediaGroupId: number,
  ): Promise<void> {
    const currentItems = await tx.mediaGroupItem.findMany({
      where: { mediaGroupId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    for (let index = 0; index < currentItems.length; index += 1) {
      await tx.mediaGroupItem.update({
        where: { id: currentItems[index].id },
        data: { position: 100000 + index },
      });
    }

    for (let index = 0; index < currentItems.length; index += 1) {
      await tx.mediaGroupItem.update({
        where: { id: currentItems[index].id },
        data: { position: index },
      });
    }
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
}
