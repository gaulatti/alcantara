import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ProgramService {
  private static readonly DEFAULT_PROGRAM_ID = 'main';
  private eventSubjects = new Map<string, Subject<any>>();

  constructor(private prisma: PrismaService) {
    this.initializeProgramState(ProgramService.DEFAULT_PROGRAM_ID);
  }

  private async initializeProgramState(programId: string) {
    await this.prisma.programState.upsert({
      where: { programId },
      update: {},
      create: { programId, activeSceneId: null },
    });
  }

  private getEventSubject(programId: string) {
    const existing = this.eventSubjects.get(programId);
    if (existing) {
      return existing;
    }

    const subject = new Subject<any>();
    this.eventSubjects.set(programId, subject);
    return subject;
  }

  private async getProgramStateWithScenes(programId: string) {
    return this.prisma.programState.upsert({
      where: { programId },
      update: {},
      create: { programId, activeSceneId: null },
      include: {
        activeScene: {
          include: { layout: true },
        },
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
      },
    });
  }

  async createProgram(programId: string) {
    const normalized = programId.trim();
    if (!normalized) {
      throw new Error('programId is required');
    }

    await this.initializeProgramState(normalized);
    return this.getProgramStateWithScenes(normalized);
  }

  async listPrograms() {
    return this.prisma.programState.findMany({
      orderBy: { programId: 'asc' },
      include: {
        activeScene: {
          include: { layout: true },
        },
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
      },
    });
  }

  async getState(programId: string = ProgramService.DEFAULT_PROGRAM_ID) {
    return this.getProgramStateWithScenes(programId);
  }

  async addSceneToProgram(
    sceneId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const scene = await this.prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene) {
      throw new Error('Scene not found');
    }

    const state = await this.prisma.programState.upsert({
      where: { programId },
      update: {},
      create: { programId, activeSceneId: null },
    });

    const existing = await this.prisma.programScene.findUnique({
      where: {
        programStateId_sceneId: {
          programStateId: state.id,
          sceneId,
        },
      },
    });

    if (!existing) {
      const currentMaxPosition = await this.prisma.programScene.aggregate({
        where: { programStateId: state.id },
        _max: { position: true },
      });
      const nextPosition = (currentMaxPosition._max.position ?? -1) + 1;

      await this.prisma.programScene.create({
        data: {
          programStateId: state.id,
          sceneId,
          position: nextPosition,
        },
      });
    }

    const updated = await this.getProgramStateWithScenes(programId);
    this.broadcastUpdate(programId, {
      type: 'program_scenes_changed',
      state: updated,
    });
    return updated;
  }

  async removeSceneFromProgram(
    sceneId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const state = await this.prisma.programState.findUnique({
      where: { programId },
      select: { id: true, activeSceneId: true },
    });

    if (!state) {
      return this.getProgramStateWithScenes(programId);
    }

    await this.prisma.programScene.deleteMany({
      where: {
        programStateId: state.id,
        sceneId,
      },
    });

    if (state.activeSceneId === sceneId) {
      await this.prisma.programState.update({
        where: { id: state.id },
        data: { activeSceneId: null },
      });
    }

    const updated = await this.getProgramStateWithScenes(programId);
    this.broadcastUpdate(programId, {
      type: 'program_scenes_changed',
      state: updated,
    });
    return updated;
  }

  async activateScene(
    sceneId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const state = await this.prisma.programState.upsert({
      where: { programId },
      update: {},
      create: { programId, activeSceneId: null },
      include: { scenes: true },
    });

    const isAssigned = state.scenes.some((programScene) => programScene.sceneId === sceneId);
    if (!isAssigned) {
      throw new Error('Scene is not assigned to this program');
    }

    const updatedState = await this.prisma.programState.update({
      where: { id: state.id },
      data: { activeSceneId: sceneId },
      include: {
        activeScene: {
          include: { layout: true },
        },
        scenes: {
          orderBy: { position: 'asc' },
          include: {
            scene: {
              include: { layout: true },
            },
          },
        },
      },
    });

    this.broadcastUpdate(programId, {
      type: 'scene_change',
      state: updatedState,
    });

    return updatedState;
  }

  async getProgramIdsByActiveScene(sceneId: number) {
    const states = await this.prisma.programState.findMany({
      where: { activeSceneId: sceneId },
      select: { programId: true },
    });
    return states.map((state) => state.programId);
  }

  async clearActiveScene(sceneId: number) {
    const programIds = await this.getProgramIdsByActiveScene(sceneId);
    if (programIds.length === 0) {
      return [];
    }

    await this.prisma.programState.updateMany({
      where: { activeSceneId: sceneId },
      data: { activeSceneId: null },
    });

    return programIds;
  }

  async getProgramIdsByAssignedScene(sceneId: number) {
    const rows = await this.prisma.programScene.findMany({
      where: { sceneId },
      include: {
        programState: {
          select: { programId: true },
        },
      },
    });

    return [...new Set(rows.map((row) => row.programState.programId))];
  }

  broadcastUpdate(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    data: any,
  ) {
    this.getEventSubject(programId).next(data);
  }

  getEventStream(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ): Observable<{ data: string }> {
    return this.getEventSubject(programId).asObservable().pipe(
      map((data) => ({
        data: JSON.stringify(data),
      })),
    );
  }
}
