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

    const programState = await this.prisma.programState.findFirst();
    if (programState?.activeSceneId === id) {
      this.programService.broadcastUpdate({
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

    const programState = await this.prisma.programState.findFirst();
    if (programState?.activeSceneId === id) {
      this.programService.broadcastUpdate({
        type: 'chyron_update',
        scene,
      });
    }

    return scene;
  }

  async remove(id: number) {
    // Check if this scene is currently active
    const programState = await this.prisma.programState.findFirst();
    if (programState?.activeSceneId === id) {
      // Clear the active scene before deleting
      await this.prisma.programState.update({
        where: { id: programState.id },
        data: { activeSceneId: null },
      });
      this.programService.broadcastUpdate({
        type: 'scene_cleared',
      });
    }

    return this.prisma.scene.delete({
      where: { id },
    });
  }
}
