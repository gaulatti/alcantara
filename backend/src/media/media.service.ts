import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  async findAll(params: FindAllParams) {
    const { search, sortBy, sortOrder, page, limit } = params;

    const where: Prisma.MediaWhereInput = {};

    if (search) {
      const term = search.trim();
      if (term) {
        where.name = { contains: term, mode: 'insensitive' };
      }
    }

    const actualSortBy = ALLOWED_SORT_FIELDS.includes(sortBy as typeof ALLOWED_SORT_FIELDS[number])
      ? (sortBy as string)
      : 'updatedAt';
    const actualSortOrder: 'asc' | 'desc' = sortOrder === 'asc' ? 'asc' : 'desc';

    const orderBy: Prisma.MediaOrderByWithRelationInput[] = [
      { [actualSortBy]: actualSortOrder },
      { id: 'desc' },
    ] as Prisma.MediaOrderByWithRelationInput[];

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.media.findMany({ where, orderBy, skip, take: limit }),
      this.prisma.media.count({ where }),
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

  async findOne(id: number) {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    return media;
  }

  async create(data: MediaInput) {
    const name = this.toRequiredTrimmedString(data.name, 'name');
    const imageUrl = this.toRequiredTrimmedString(data.imageUrl, 'imageUrl');

    return this.prisma.media.create({
      data: {
        name,
        imageUrl,
      },
    });
  }

  async update(id: number, data: MediaInput) {
    await this.findOne(id);

    const updateData: Prisma.MediaUpdateInput = {};

    if (data.name !== undefined) {
      updateData.name = this.toRequiredTrimmedString(data.name, 'name');
    }

    if (data.imageUrl !== undefined) {
      updateData.imageUrl = this.toRequiredTrimmedString(data.imageUrl, 'imageUrl');
    }

    if (Object.keys(updateData).length === 0) {
      return this.findOne(id);
    }

    return this.prisma.media.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    const impactedRows = await this.prisma.mediaGroupItem.findMany({
      where: { mediaId: id },
      select: { mediaGroupId: true },
    });
    const impactedGroupIds = [...new Set(impactedRows.map((row) => row.mediaGroupId))];

    await this.prisma.$transaction(async (tx) => {
      await tx.media.delete({ where: { id } });

      for (const mediaGroupId of impactedGroupIds) {
        await this.rebalanceGroupItems(tx, mediaGroupId);
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
