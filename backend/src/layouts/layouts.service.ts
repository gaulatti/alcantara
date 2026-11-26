import { Injectable } from '@nestjs/common';
import {
  LAYOUT_CHANGE_FIELDS,
  OperatorChangeRecorder,
  summarizeChange,
} from '../operator-change/operator-change-recorder';
import { PrismaService } from '../prisma.service';
import { forTeam } from '../tenancy/scoped-prisma';

@Injectable()
export class LayoutsService {
  constructor(
    private prisma: PrismaService,
    private readonly recorder: OperatorChangeRecorder,
  ) {}

  /**
   * The layouts of one team (gaulatti/alcantara#122). `0` means no team is configured, which production refuses, and
   * sees every row, as elsewhere. The scenes included with a layout are not scoped here.
   */
  private db(teamId: number): Pick<PrismaService, 'layout'> {
    return teamId > 0
      ? (forTeam(this.prisma, teamId) as unknown as PrismaService)
      : this.prisma;
  }

  async findAll(teamId = 0) {
    return this.db(teamId).layout.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number, teamId = 0) {
    return this.db(teamId).layout.findUnique({
      where: { id },
      include: { scenes: true },
    });
  }

  async create(
    data: { name: string; componentType: string; settings?: any },
    teamId = 0,
  ) {
    return this.db(teamId).layout.create({
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
    teamId = 0,
  ) {
    const db = this.db(teamId);
    const actor = this.recorder.actor();
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.componentType !== undefined)
      updateData.componentType = data.componentType;
    if (data.settings !== undefined)
      updateData.settings = JSON.stringify(data.settings);

    const previous = await db.layout.findUnique({ where: { id } });
    const layout = await db.layout.update({
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

  async remove(id: number, teamId = 0) {
    return this.db(teamId).layout.delete({
      where: { id },
    });
  }
}
