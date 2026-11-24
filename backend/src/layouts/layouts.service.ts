import { Injectable } from '@nestjs/common';
import {
  LAYOUT_CHANGE_FIELDS,
  OperatorChangeRecorder,
  summarizeChange,
} from '../operator-change/operator-change-recorder';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LayoutsService {
  constructor(
    private prisma: PrismaService,
    private readonly recorder: OperatorChangeRecorder,
  ) {}

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
    const actor = this.recorder.actor();
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.componentType !== undefined)
      updateData.componentType = data.componentType;
    if (data.settings !== undefined)
      updateData.settings = JSON.stringify(data.settings);

    const previous = await this.prisma.layout.findUnique({ where: { id } });
    const layout = await this.prisma.layout.update({
      where: { id },
      data: updateData,
    });
    await this.recorder.record({
      actor,
      target: 'layout',
      targetId: String(id),
      programId: null,
      capability: { mcp: 'layout_update', console: 'layout.update' },
      summary: summarizeChange(LAYOUT_CHANGE_FIELDS, data, previous, layout),
    });
    return layout;
  }

  async remove(id: number) {
    return this.prisma.layout.delete({
      where: { id },
    });
  }
}
