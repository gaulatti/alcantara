import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ProgramService {
  private static readonly DEFAULT_PROGRAM_ID = 'main';
  private static readonly FIFTHBELL_PROGRAM_ID = 'fifthbell';
  private static readonly FIFTHBELL_LAYOUT_NAME = 'FifthBell Layout';
  private static readonly FIFTHBELL_SCENE_NAME = 'FifthBell Scene';
  private static readonly FIFTHBELL_LAYOUT_COMPONENT_TYPE =
    'fifthbell-content,fifthbell-marquee,toni-clock';
  private static readonly FIFTHBELL_AVAILABLE_WEATHER_CITIES = [
    'New York',
    'San Juan',
    'Los Angeles',
    'Honolulu',
    'Mexico City',
    'Havana',
    'London',
    'Paris',
    'Berlin',
    'Rome',
    'Madrid',
    'Athens',
    'Santiago',
    'Buenos Aires',
    'Rio',
    'Lima',
    'Caracas',
    'Bogotá',
    'Tokyo',
    'Seoul',
    'Shanghai',
    'Hong Kong',
    'Bangkok',
    'Jakarta',
  ] as const;
  private static readonly FIFTHBELL_DEFAULT_CONTENT_CONFIG = {
    showArticles: true,
    showWeather: true,
    showEarthquakes: true,
    showMarkets: true,
    showCallsignTake: true,
    weatherCities: [...ProgramService.FIFTHBELL_AVAILABLE_WEATHER_CITIES],
    languageRotation: ['en', 'es', 'en', 'it'],
    dataLoadTimeoutMs: 15000,
    playlistDefaultDurationMs: 10000,
    playlistUpdateIntervalMs: 100,
    articlesDurationMs: 10000,
    weatherDurationMs: 5000,
    earthquakesDurationMs: 10000,
    marketsDurationMs: 10000,
    audioCueEnabled: true,
    audioCueMinute: 59,
    audioCueSecond: 55,
    callsignPrelaunchUntilNyc: '2026-01-02T21:30:00',
    callsignWindowStartSecond: 50,
    callsignWindowEndSecond: 3,
  } as const;
  private static readonly FIFTHBELL_DEFAULT_MARQUEE_CONFIG = {
    showMarquee: false,
    marqueeMinPostsCount: 4,
    marqueeMinAverageRelevance: 0,
    marqueeMinMedianRelevance: 0,
    marqueePixelsPerSecond: 150,
    marqueeMinDurationSeconds: 10,
    marqueeHeightPx: 72,
  } as const;
  private static readonly FIFTHBELL_DEFAULT_CORNER_CONFIG = {
    showWorldClocks: true,
    showBellIcon: true,
    worldClockRotateIntervalMs: 7000,
    worldClockTransitionMs: 300,
    worldClockShuffle: true,
    worldClockWidthPx: 200,
  } as const;
  private static readonly RELOJ_PROGRAM_ID = 'reloj';
  private static readonly RELOJ_LAYOUT_NAME = 'Reloj Layout';
  private static readonly RELOJ_SCENE_NAME = 'Reloj Scene';
  private static readonly RELOJ_LOOP_PROGRAM_ID = 'reloj-loop';
  private static readonly RELOJ_LOOP_LAYOUT_NAME = 'Reloj Loop Layout';
  private static readonly RELOJ_LOOP_SCENE_NAME = 'Reloj Loop Scene';
  private static readonly BROADCAST_SETTINGS_ID = 1;

  private eventSubjects = new Map<string, Subject<any>>();

  constructor(private prisma: PrismaService) {
    this.ensureBuiltinPrograms();
  }

  private async initializeProgramState(programId: string) {
    await this.prisma.programState.upsert({
      where: { programId },
      update: {},
      create: { programId, activeSceneId: null },
    });
  }

  private async ensureBuiltinPrograms() {
    await this.initializeProgramState(ProgramService.DEFAULT_PROGRAM_ID);
    await this.ensureFifthBellProgramConfigured();
    await this.ensureRelojProgramConfigured();
    await this.ensureRelojLoopProgramConfigured();
    await this.ensureBroadcastSettings();
  }

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

  private async ensureFifthBellProgramConfigured() {
    const state = await this.prisma.programState.upsert({
      where: { programId: ProgramService.FIFTHBELL_PROGRAM_ID },
      update: {},
      create: {
        programId: ProgramService.FIFTHBELL_PROGRAM_ID,
        activeSceneId: null,
      },
      select: { id: true, activeSceneId: true },
    });

    const layout = await this.prisma.layout.upsert({
      where: { name: ProgramService.FIFTHBELL_LAYOUT_NAME },
      update: {
        componentType: ProgramService.FIFTHBELL_LAYOUT_COMPONENT_TYPE,
      },
      create: {
        name: ProgramService.FIFTHBELL_LAYOUT_NAME,
        componentType: ProgramService.FIFTHBELL_LAYOUT_COMPONENT_TYPE,
        settings: JSON.stringify({}),
      },
      select: { id: true },
    });

    let scene = await this.prisma.scene.findFirst({
      where: {
        name: ProgramService.FIFTHBELL_SCENE_NAME,
        layoutId: layout.id,
      },
      select: { id: true, metadata: true },
    });

    if (!scene) {
      scene = await this.prisma.scene.create({
        data: {
          name: ProgramService.FIFTHBELL_SCENE_NAME,
          layoutId: layout.id,
          chyronText: null,
          metadata: JSON.stringify({
            'fifthbell-content':
              ProgramService.FIFTHBELL_DEFAULT_CONTENT_CONFIG,
            'fifthbell-marquee':
              ProgramService.FIFTHBELL_DEFAULT_MARQUEE_CONFIG,
            'toni-clock': ProgramService.FIFTHBELL_DEFAULT_CORNER_CONFIG,
          }),
        },
        select: { id: true, metadata: true },
      });
    }

    const parseMetadata = (
      rawMetadata: string | null,
    ): Record<string, unknown> => {
      if (!rawMetadata) {
        return {};
      }

      try {
        const parsed = JSON.parse(rawMetadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // no-op
      }

      return {};
    };

    const pickKnownKeys = <T extends Record<string, unknown>>(
      defaults: T,
      ...sources: unknown[]
    ): T => {
      const result: Record<string, unknown> = { ...defaults };
      for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          continue;
        }

        const asObject = source as Record<string, unknown>;
        for (const key of Object.keys(defaults)) {
          if (asObject[key] !== undefined) {
            result[key] = asObject[key];
          }
        }
      }
      return result as T;
    };

    const currentMetadata = parseMetadata(scene.metadata);
    const legacyConfig =
      currentMetadata.fifthbell &&
      typeof currentMetadata.fifthbell === 'object' &&
      !Array.isArray(currentMetadata.fifthbell)
        ? (currentMetadata.fifthbell as Record<string, unknown>)
        : {};
    const nextMetadata: Record<string, unknown> = {
      ...currentMetadata,
      'fifthbell-content': pickKnownKeys(
        ProgramService.FIFTHBELL_DEFAULT_CONTENT_CONFIG as unknown as Record<
          string,
          unknown
        >,
        legacyConfig,
        currentMetadata['fifthbell-content'],
      ),
      'fifthbell-marquee': pickKnownKeys(
        ProgramService.FIFTHBELL_DEFAULT_MARQUEE_CONFIG as unknown as Record<
          string,
          unknown
        >,
        legacyConfig,
        currentMetadata['fifthbell-marquee'],
      ),
      'toni-clock': pickKnownKeys(
        ProgramService.FIFTHBELL_DEFAULT_CORNER_CONFIG as unknown as Record<
          string,
          unknown
        >,
        legacyConfig,
        currentMetadata['fifthbell-corner'],
        currentMetadata['toni-clock'],
      ),
    };

    const currentMetadataJson = JSON.stringify(currentMetadata);
    const nextMetadataJson = JSON.stringify(nextMetadata);
    if (currentMetadataJson !== nextMetadataJson) {
      await this.prisma.scene.update({
        where: { id: scene.id },
        data: { metadata: nextMetadataJson },
      });
    }

    const existingAssignment = await this.prisma.programScene.findUnique({
      where: {
        programStateId_sceneId: {
          programStateId: state.id,
          sceneId: scene.id,
        },
      },
      select: { id: true },
    });

    if (!existingAssignment) {
      const maxPosition = await this.prisma.programScene.aggregate({
        where: { programStateId: state.id },
        _max: { position: true },
      });

      await this.prisma.programScene.create({
        data: {
          programStateId: state.id,
          sceneId: scene.id,
          position: (maxPosition._max.position ?? -1) + 1,
        },
      });
    }

    if (!state.activeSceneId) {
      await this.prisma.programState.update({
        where: { id: state.id },
        data: { activeSceneId: scene.id },
      });
    }
  }

  private async ensureRelojProgramConfigured() {
    const state = await this.prisma.programState.upsert({
      where: { programId: ProgramService.RELOJ_PROGRAM_ID },
      update: {},
      create: {
        programId: ProgramService.RELOJ_PROGRAM_ID,
        activeSceneId: null,
      },
      select: { id: true, activeSceneId: true },
    });

    const layout = await this.prisma.layout.upsert({
      where: { name: ProgramService.RELOJ_LAYOUT_NAME },
      update: {
        componentType: 'reloj-clock',
      },
      create: {
        name: ProgramService.RELOJ_LAYOUT_NAME,
        componentType: 'reloj-clock',
        settings: JSON.stringify({}),
      },
      select: { id: true },
    });

    let scene = await this.prisma.scene.findFirst({
      where: {
        name: ProgramService.RELOJ_SCENE_NAME,
        layoutId: layout.id,
      },
      select: { id: true },
    });

    if (!scene) {
      scene = await this.prisma.scene.create({
        data: {
          name: ProgramService.RELOJ_SCENE_NAME,
          layoutId: layout.id,
          chyronText: null,
          metadata: JSON.stringify({ 'reloj-clock': {} }),
        },
        select: { id: true },
      });
    }

    const existingAssignment = await this.prisma.programScene.findUnique({
      where: {
        programStateId_sceneId: {
          programStateId: state.id,
          sceneId: scene.id,
        },
      },
      select: { id: true },
    });

    if (!existingAssignment) {
      const maxPosition = await this.prisma.programScene.aggregate({
        where: { programStateId: state.id },
        _max: { position: true },
      });

      await this.prisma.programScene.create({
        data: {
          programStateId: state.id,
          sceneId: scene.id,
          position: (maxPosition._max.position ?? -1) + 1,
        },
      });
    }

    if (!state.activeSceneId) {
      await this.prisma.programState.update({
        where: { id: state.id },
        data: { activeSceneId: scene.id },
      });
    }
  }

  private async ensureRelojLoopProgramConfigured() {
    const state = await this.prisma.programState.upsert({
      where: { programId: ProgramService.RELOJ_LOOP_PROGRAM_ID },
      update: {},
      create: {
        programId: ProgramService.RELOJ_LOOP_PROGRAM_ID,
        activeSceneId: null,
      },
      select: { id: true, activeSceneId: true },
    });

    const layout = await this.prisma.layout.upsert({
      where: { name: ProgramService.RELOJ_LOOP_LAYOUT_NAME },
      update: {
        componentType: 'reloj-loop-clock',
      },
      create: {
        name: ProgramService.RELOJ_LOOP_LAYOUT_NAME,
        componentType: 'reloj-loop-clock',
        settings: JSON.stringify({}),
      },
      select: { id: true },
    });

    let scene = await this.prisma.scene.findFirst({
      where: {
        name: ProgramService.RELOJ_LOOP_SCENE_NAME,
        layoutId: layout.id,
      },
      select: { id: true },
    });

    if (!scene) {
      scene = await this.prisma.scene.create({
        data: {
          name: ProgramService.RELOJ_LOOP_SCENE_NAME,
          layoutId: layout.id,
          chyronText: null,
          metadata: JSON.stringify({
            'reloj-loop-clock': {
              timezone: 'Europe/Madrid',
            },
          }),
        },
        select: { id: true },
      });
    }

    const existingAssignment = await this.prisma.programScene.findUnique({
      where: {
        programStateId_sceneId: {
          programStateId: state.id,
          sceneId: scene.id,
        },
      },
      select: { id: true },
    });

    if (!existingAssignment) {
      const maxPosition = await this.prisma.programScene.aggregate({
        where: { programStateId: state.id },
        _max: { position: true },
      });

      await this.prisma.programScene.create({
        data: {
          programStateId: state.id,
          sceneId: scene.id,
          position: (maxPosition._max.position ?? -1) + 1,
        },
      });
    }

    if (!state.activeSceneId) {
      await this.prisma.programState.update({
        where: { id: state.id },
        data: { activeSceneId: scene.id },
      });
    }
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
    await this.ensureBuiltinPrograms();

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
    if (programId === ProgramService.FIFTHBELL_PROGRAM_ID) {
      await this.ensureFifthBellProgramConfigured();
    } else if (programId === ProgramService.RELOJ_PROGRAM_ID) {
      await this.ensureRelojProgramConfigured();
    } else if (programId === ProgramService.RELOJ_LOOP_PROGRAM_ID) {
      await this.ensureRelojLoopProgramConfigured();
    }

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
    transitionId?: string | null,
  ) {
    const state = await this.prisma.programState.upsert({
      where: { programId },
      update: {},
      create: { programId, activeSceneId: null },
      include: { scenes: true },
    });

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

    this.broadcastUpdate(programId, {
      type: 'scene_change',
      transitionId: normalizedTransitionId,
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
