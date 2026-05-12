import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

    return this.prisma.stinger.create({
      data: {
        name,
        videoUrl,
        cutPointMs: data.cutPointMs ?? 1000,
        enabled: data.enabled ?? true,
      },
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

    return this.prisma.stinger.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.stinger.delete({ where: { id } });
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
