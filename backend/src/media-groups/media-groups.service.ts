import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

interface MediaGroupInput {
  name?: string;
  description?: string | null;
  mediaIds?: number[];
}

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
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const groups = await this.prisma.mediaGroup.findMany({
      include: {
        mediaItems: {
          include: { media: true },
          orderBy: { position: 'asc' },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });

    return groups.map((group) => this.mapGroup(group));
  }

  async findOne(id: number) {
    const group = await this.prisma.mediaGroup.findUnique({
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

  async create(data: MediaGroupInput) {
    const name = this.toRequiredTrimmedString(data.name, 'name');
    const description = this.toOptionalTrimmedString(data.description);
    const mediaIds = this.normalizeMediaIds(data.mediaIds, false);

    await this.assertMediaIdsExist(mediaIds);

    let group: MediaGroupRecord | null = null;
    try {
      group = await this.prisma.$transaction(async (tx) => {
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

        return tx.mediaGroup.findUnique({
          where: { id: created.id },
          include: {
            mediaItems: {
              include: { media: true },
              orderBy: { position: 'asc' },
            },
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException('Media group name already exists');
      }
      throw error;
    }

    if (!group) {
      throw new NotFoundException('Media group not found after create');
    }

    return this.mapGroup(group);
  }

  async update(id: number, data: MediaGroupInput) {
    await this.ensureMediaGroupExists(id);

    const updateData: Prisma.MediaGroupUpdateInput = {};

    if (data.name !== undefined) {
      updateData.name = this.toRequiredTrimmedString(data.name, 'name');
    }

    if (data.description !== undefined) {
      updateData.description = this.toOptionalTrimmedString(data.description);
    }

    const hasMediaIds = Object.prototype.hasOwnProperty.call(data, 'mediaIds');
    const mediaIds = this.normalizeMediaIds(data.mediaIds, hasMediaIds);

    if (hasMediaIds) {
      await this.assertMediaIdsExist(mediaIds);
    }

    let group: MediaGroupRecord | null = null;
    try {
      group = await this.prisma.$transaction(async (tx) => {
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

        return tx.mediaGroup.findUnique({
          where: { id },
          include: {
            mediaItems: {
              include: { media: true },
              orderBy: { position: 'asc' },
            },
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException('Media group name already exists');
      }
      throw error;
    }

    if (!group) {
      throw new NotFoundException('Media group not found after update');
    }

    return this.mapGroup(group);
  }

  async remove(id: number) {
    await this.ensureMediaGroupExists(id);
    await this.prisma.mediaGroup.delete({ where: { id } });
    return { deletedMediaGroupId: id };
  }

  private async ensureMediaGroupExists(id: number): Promise<void> {
    const group = await this.prisma.mediaGroup.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!group) {
      throw new NotFoundException('Media group not found');
    }
  }

  private async assertMediaIdsExist(mediaIds: number[]): Promise<void> {
    if (mediaIds.length === 0) {
      return;
    }

    const rows = await this.prisma.media.findMany({
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
      if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
        throw new BadRequestException('mediaIds must contain positive integer ids');
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
