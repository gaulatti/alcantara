import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ProgramService } from '../program/program.service';

@Injectable()
export class ScenesService {
  constructor(
    private prisma: PrismaService,
    private programService: ProgramService,
  ) {}

  async findAll() {
    return this.prisma.scene.findMany({
      include: { layout: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.scene.findUnique({
      where: { id },
      include: { layout: true },
    });
  }

  async create(data: { name: string; layoutId: number; chyronText?: string; metadata?: any }) {
    const scene = await this.prisma.scene.create({
      data: {
        name: data.name,
        layoutId: data.layoutId,
        chyronText: data.chyronText,
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      },
      include: { layout: true },
    });
    return scene;
  }

  async update(
    id: number,
    data: { name?: string; layoutId?: number; chyronText?: string; metadata?: any },
  ) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.layoutId !== undefined) updateData.layoutId = data.layoutId;
    if (data.chyronText !== undefined) updateData.chyronText = data.chyronText;
    if (data.metadata !== undefined)
      updateData.metadata = JSON.stringify(data.metadata);

    const scene = await this.prisma.scene.update({
      where: { id },
      data: updateData,
      include: { layout: true },
    });

    const programIds = await this.programService.getProgramIdsByActiveScene(id);
    for (const programId of programIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'scene_update',
        scene,
      });
    }

    return scene;
  }

  async updateChyron(id: number, chyronText: string) {
    const scene = await this.prisma.scene.update({
      where: { id },
      data: { chyronText },
      include: { layout: true },
    });

    const programIds = await this.programService.getProgramIdsByActiveScene(id);
    for (const programId of programIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'chyron_update',
        scene,
      });
    }

    return scene;
  }

  async remove(id: number) {
    const assignedProgramIds =
      await this.programService.getProgramIdsByAssignedScene(id);
    const clearedProgramIds = await this.programService.clearActiveScene(id);
    for (const programId of clearedProgramIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'scene_cleared',
      });
    }

    const deleted = await this.prisma.scene.delete({
      where: { id },
    });

    for (const programId of assignedProgramIds) {
      const state = await this.programService.getState(programId);
      this.programService.broadcastUpdate(programId, {
        type: 'program_scenes_changed',
        state,
      });
    }

    return deleted;
  }
}
