import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ProgramService {
  private static readonly DEFAULT_PROGRAM_ID = 'main';
  private static readonly BROADCAST_SETTINGS_ID = 1;
  private eventSubjects = new Map<string, Subject<any>>();

  constructor(private prisma: PrismaService) {}

  private async ensureBroadcastSettings() {
    return this.prisma.broadcastSettings.upsert({
      where: { id: ProgramService.BROADCAST_SETTINGS_ID },
      update: {},
      create: {
        id: ProgramService.BROADCAST_SETTINGS_ID,
        timeOverrideEnabled: false,
      },
    });
  }

  async getBroadcastSettings() {
    return this.ensureBroadcastSettings();
  }

  private normalizeOverrideTime(startTime: string): string {
    const normalized = startTime.trim();
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(normalized);
    if (!match) {
      throw new Error('startTime must be in HH:mm format');
    }
    return `${match[1]}:${match[2]}`;
  }

  async updateBroadcastSettings(data: {
    enabled: boolean;
    startTime?: string | null;
  }) {
    const enabled = Boolean(data.enabled);
    let startTime: string | null = null;
    let startedAt: Date | null = null;

    if (enabled) {
      if (!data.startTime) {
        throw new Error('startTime is required when enabling time override');
      }
      startTime = this.normalizeOverrideTime(data.startTime);
      startedAt = new Date();
    }

    const settings = await this.prisma.broadcastSettings.upsert({
      where: { id: ProgramService.BROADCAST_SETTINGS_ID },
      update: {
        timeOverrideEnabled: enabled,
        timeOverrideStartTime: startTime,
        timeOverrideStartedAt: startedAt,
      },
      create: {
        id: ProgramService.BROADCAST_SETTINGS_ID,
        timeOverrideEnabled: enabled,
        timeOverrideStartTime: startTime,
        timeOverrideStartedAt: startedAt,
      },
    });

    this.broadcastGlobalUpdate({
      type: 'broadcast_settings_update',
      settings,
    });

    return settings;
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

  private normalizeProgramId(programId: string): string {
    const normalized = programId.trim();
    if (!normalized) {
      throw new Error('programId is required');
    }
    return normalized;
  }

  private async getProgramStateRecord(programId: string) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { id: true, programId: true },
    });

    if (!state) {
      throw new Error('Program not found');
    }

    return state;
  }

  private async getProgramStateWithScenes(programId: string) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
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

    if (!state) {
      throw new Error('Program not found');
    }

    return state;
  }

  async createProgram(programId: string) {
    const normalized = this.normalizeProgramId(programId);

    const existing = await this.prisma.programState.findUnique({
      where: { programId: normalized },
      select: { id: true },
    });

    if (existing) {
      throw new Error('Program already exists');
    }

    await this.prisma.programState.create({
      data: { programId: normalized, activeSceneId: null },
    });

    return this.getProgramStateWithScenes(normalized);
  }

  async renameProgram(programId: string, nextProgramId: string) {
    const current = this.normalizeProgramId(programId);
    const next = this.normalizeProgramId(nextProgramId);
    if (current === next) {
      return this.getProgramStateWithScenes(current);
    }

    const existingTarget = await this.prisma.programState.findUnique({
      where: { programId: next },
      select: { id: true },
    });
    if (existingTarget) {
      throw new Error('Target program id already exists');
    }

    const existingSource = await this.prisma.programState.findUnique({
      where: { programId: current },
      select: { id: true },
    });
    if (!existingSource) {
      throw new Error('Program not found');
    }

    await this.prisma.programState.update({
      where: { id: existingSource.id },
      data: { programId: next },
    });

    const currentSubject = this.eventSubjects.get(current);
    if (currentSubject) {
      this.eventSubjects.set(next, currentSubject);
      this.eventSubjects.delete(current);
    }

    return this.getProgramStateWithScenes(next);
  }

  async deleteProgram(programId: string) {
    const normalized = this.normalizeProgramId(programId);
    const existing = await this.prisma.programState.findUnique({
      where: { programId: normalized },
      select: { id: true },
    });

    if (!existing) {
      throw new Error('Program not found');
    }

    await this.prisma.programState.delete({
      where: { id: existing.id },
    });

    const subject = this.eventSubjects.get(normalized);
    if (subject) {
      subject.complete();
      this.eventSubjects.delete(normalized);
    }

    return { deletedProgramId: normalized };
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
    const scene = await this.prisma.scene.findUnique({
      where: { id: sceneId },
    });
    if (!scene) {
      throw new Error('Scene not found');
    }

    const state = await this.getProgramStateRecord(programId);

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
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      select: { id: true, activeSceneId: true },
    });

    if (!state) {
      throw new Error('Program not found');
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

    const updated = await this.getProgramStateWithScenes(normalizedProgramId);
    this.broadcastUpdate(normalizedProgramId, {
      type: 'program_scenes_changed',
      state: updated,
    });
    return updated;
  }

  async activateScene(
    sceneId: number,
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    transitionId?: string | null,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: { scenes: true },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    const isAssigned = state.scenes.some(
      (programScene) => programScene.sceneId === sceneId,
    );
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

    const normalizedTransitionId =
      typeof transitionId === 'string' && transitionId.trim()
        ? transitionId.trim()
        : null;

    this.broadcastUpdate(normalizedProgramId, {
      type: 'scene_change',
      transitionId: normalizedTransitionId,
      state: updatedState,
    });

    return updatedState;
  }

  async takeProgramOffAir(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
      include: { scenes: true },
    });
    if (!state) {
      throw new Error('Program not found');
    }

    if (!state.activeSceneId) {
      return this.getProgramStateWithScenes(normalizedProgramId);
    }

    const updatedState = await this.prisma.programState.update({
      where: { id: state.id },
      data: { activeSceneId: null },
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

    this.broadcastUpdate(normalizedProgramId, {
      type: 'scene_change',
      transitionId: null,
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

  async listInstants() {
    return this.prisma.instant.findMany({
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  async createInstant(data: {
    name: string;
    audioUrl: string;
    volume?: number;
    enabled?: boolean;
  }) {
    const name = (data.name || '').trim();
    const audioUrl = (data.audioUrl || '').trim();

    if (!name) {
      throw new BadRequestException('name is required');
    }
    if (!audioUrl) {
      throw new BadRequestException('audioUrl is required');
    }

    const maxPosition = await this.prisma.instant.aggregate({
      _max: { position: true },
    });
    const nextPosition = (maxPosition._max.position ?? -1) + 1;

    return this.prisma.instant.create({
      data: {
        name,
        audioUrl,
        volume:
          typeof data.volume === 'number' && Number.isFinite(data.volume)
            ? Math.min(1, Math.max(0, data.volume))
            : 1,
        enabled: data.enabled !== undefined ? Boolean(data.enabled) : true,
        position: nextPosition,
      },
    });
  }

  async updateInstant(
    instantId: number,
    data: {
      name?: string;
      audioUrl?: string;
      volume?: number;
      enabled?: boolean;
    },
  ) {
    const instant = await this.prisma.instant.findUnique({
      where: { id: instantId },
      select: { id: true },
    });

    if (!instant) {
      throw new NotFoundException('Instant not found');
    }

    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) {
        throw new BadRequestException('name cannot be empty');
      }
      updateData.name = name;
    }

    if (data.audioUrl !== undefined) {
      const audioUrl = data.audioUrl.trim();
      if (!audioUrl) {
        throw new BadRequestException('audioUrl cannot be empty');
      }
      updateData.audioUrl = audioUrl;
    }

    if (data.volume !== undefined) {
      if (!Number.isFinite(data.volume)) {
        throw new BadRequestException('volume must be a number');
      }
      updateData.volume = Math.min(1, Math.max(0, data.volume));
    }

    if (data.enabled !== undefined) {
      updateData.enabled = Boolean(data.enabled);
    }

    return this.prisma.instant.update({
      where: { id: instant.id },
      data: updateData,
    });
  }

  async deleteInstant(instantId: number) {
    const instant = await this.prisma.instant.findUnique({
      where: { id: instantId },
      select: { id: true },
    });

    if (!instant) {
      throw new NotFoundException('Instant not found');
    }

    await this.prisma.instant.delete({
      where: { id: instant.id },
    });

    const remaining = await this.prisma.instant.findMany({
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    await Promise.all(
      remaining.map((item, index) =>
        this.prisma.instant.update({
          where: { id: item.id },
          data: { position: index },
        }),
      ),
    );

    return { deletedInstantId: instant.id };
  }

  async playInstant(instantId: number) {
    const instant = await this.prisma.instant.findUnique({
      where: { id: instantId },
    });

    if (!instant) {
      throw new NotFoundException('Instant not found');
    }
    if (!instant.enabled) {
      throw new BadRequestException('Instant is disabled');
    }

    this.broadcastGlobalUpdate({
      type: 'instant_play',
      instant: {
        id: instant.id,
        name: instant.name,
        audioUrl: instant.audioUrl,
        volume: instant.volume,
      },
      triggeredAt: new Date().toISOString(),
    });

    return { ok: true };
  }

  async stopAllInstants() {
    this.broadcastGlobalUpdate({
      type: 'instant_stop_all',
      triggeredAt: new Date().toISOString(),
    });

    return { ok: true };
  }

  broadcastUpdate(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
    data: any,
  ) {
    this.getEventSubject(programId).next(data);
  }

  private broadcastGlobalUpdate(data: any) {
    for (const subject of this.eventSubjects.values()) {
      subject.next(data);
    }
  }

  getEventStream(
    programId: string = ProgramService.DEFAULT_PROGRAM_ID,
  ): Observable<{ data: string }> {
    return this.getEventSubject(programId)
      .asObservable()
      .pipe(
        map((data) => ({
          data: JSON.stringify(data),
        })),
      );
  }
}
