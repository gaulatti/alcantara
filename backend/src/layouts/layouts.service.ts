import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LayoutsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.layout.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.layout.findUnique({
      where: { id },
      include: { scenes: true },
    });
  }

  async create(data: { name: string; componentType: string; settings?: any }) {
    return this.prisma.layout.create({
      data: {
        name: data.name,
        componentType: data.componentType,
        settings: data.settings ? JSON.stringify(data.settings) : '{}',
      },
    });
  }

  async update(
    id: number,
    data: { name?: string; componentType?: string; settings?: any },
  ) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.componentType !== undefined)
      updateData.componentType = data.componentType;
    if (data.settings !== undefined)
      updateData.settings = JSON.stringify(data.settings);

    return this.prisma.layout.update({
      where: { id },
      data: updateData,
    });
  }

  async remove(id: number) {
    return this.prisma.layout.delete({
      where: { id },
    });
  }
}
