import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetKind } from '@prisma/client';
import {
  deleteMediaAsset,
  syncTransitionAsset,
} from '../media-assets/media-asset-sync';
import { PrismaService } from '../prisma.service';

interface StingerInput {
  name?: string;
  videoUrl?: string;
  cutPointMs?: number;
  enabled?: boolean;
}

@Injectable()
export class StingersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.stinger.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
  }

  async findOne(id: number) {
    const stinger = await this.prisma.stinger.findUnique({ where: { id } });
    if (!stinger) {
      throw new NotFoundException('Stinger not found');
    }
    return stinger;
  }

  async create(data: StingerInput) {
    const name = this.toRequiredTrimmedString(data.name, 'name');
    const videoUrl = this.toRequiredTrimmedString(data.videoUrl, 'videoUrl');

    return this.prisma.$transaction(async (tx) => {
      const stinger = await tx.stinger.create({
        data: {
          name,
          videoUrl,
          cutPointMs: data.cutPointMs ?? 1000,
          enabled: data.enabled ?? true,
        },
      });
      await syncTransitionAsset(tx, stinger);
      return tx.stinger.findUniqueOrThrow({ where: { id: stinger.id } });
    });
  }

  async update(id: number, data: StingerInput) {
    await this.findOne(id);

    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) {
      updateData.name = this.toRequiredTrimmedString(data.name, 'name');
    }

    if (data.videoUrl !== undefined) {
      updateData.videoUrl = this.toRequiredTrimmedString(
        data.videoUrl,
        'videoUrl',
      );
    }

    if (data.cutPointMs !== undefined) {
      updateData.cutPointMs = data.cutPointMs;
    }

    if (data.enabled !== undefined) {
      updateData.enabled = data.enabled;
    }

    if (Object.keys(updateData).length === 0) {
      return this.findOne(id);
    }

    return this.prisma.$transaction(async (tx) => {
      const stinger = await tx.stinger.update({
        where: { id },
        data: updateData,
      });
      await syncTransitionAsset(tx, stinger);
      return tx.stinger.findUniqueOrThrow({ where: { id } });
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.stinger.delete({ where: { id } });
      await deleteMediaAsset(tx, MediaAssetKind.TRANSITION, id);
    });
    return { deletedStingerId: id };
  }

  private toRequiredTrimmedString(
    value: string | undefined,
    fieldName: string,
  ): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${fieldName} is required`);
    }
    return value.trim();
  }
}
