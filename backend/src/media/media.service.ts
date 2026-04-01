import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

interface MediaInput {
  name?: string;
  imageUrl?: string;
}

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.media.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
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
