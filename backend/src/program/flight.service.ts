import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';
import type {
  FlightCue,
  FlightCueKind,
  FlightRuntimeState,
  FlightSequence,
} from './flight.types';

const FLIGHT_CUE_KINDS: Set<FlightCueKind> = new Set([
  'scene',
  'playSong',
  'stopSong',
  'wait',
  'waitForSongEnd',
  'sceneUpdate',
  'instant',
  'mixer',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  return undefined;
}

function normalizeFlightCue(value: unknown): FlightCue | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = value.kind;
  if (
    typeof kind !== 'string' ||
    !FLIGHT_CUE_KINDS.has(kind as FlightCueKind)
  ) {
    return null;
  }

  const id =
    typeof value.id === 'string' && value.id.trim().length > 0
      ? value.id.trim()
      : createId('cue');

  const cue: FlightCue = {
    id,
    kind: kind as FlightCueKind,
    label: normalizeOptionalString(value.label),
  };

  const sceneId = normalizeOptionalNumber(value.sceneId);
  if (sceneId !== undefined) {
    cue.sceneId = sceneId;
  }

  const transitionId = normalizeOptionalString(value.transitionId);
  if (transitionId !== undefined) {
    cue.transitionId = transitionId;
  }

  const songId = normalizeOptionalNumber(value.songId);
  if (songId !== undefined) {
    cue.songId = songId;
  }

  const durationMs = normalizeOptionalNumber(value.durationMs);
  if (durationMs !== undefined && durationMs >= 0) {
    cue.durationMs = durationMs;
  }

  if (isRecord(value.metadataPatch)) {
    cue.metadataPatch = value.metadataPatch;
  }

  const instantId = normalizeOptionalNumber(value.instantId);
  if (instantId !== undefined) {
    cue.instantId = instantId;
  }

  if (isRecord(value.mixerChange)) {
    const change: FlightCue['mixerChange'] = {};
    const channelId = value.mixerChange.channelId;
    if (
      channelId === 'main' ||
      channelId === 'song' ||
      channelId === 'instants' ||
      channelId === 'sceneInstant' ||
      channelId === 'stream'
    ) {
      change.channelId = channelId;
    }
    const volume = normalizeOptionalNumber(value.mixerChange.volume);
    if (volume !== undefined) {
      change.volume = volume;
    }
    if (typeof value.mixerChange.muted === 'boolean') {
      change.muted = value.mixerChange.muted;
    }
    if (typeof value.mixerChange.solo === 'boolean') {
      change.solo = value.mixerChange.solo;
    }
    cue.mixerChange = change;
  }

  return cue;
}

function normalizeFlightItems(value: unknown): FlightCue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: FlightCue[] = [];
  for (const raw of value) {
    const cue = normalizeFlightCue(raw);
    if (cue) {
      items.push(cue);
    }
  }
  return items;
}

function deepPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepPatch(result[key], value);
    } else if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }

  return result;
}

@Injectable()
export class FlightService implements OnModuleDestroy {
  private readonly runtimes = new Map<string, FlightRuntimeState>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ProgramService))
    private readonly programService: ProgramService,
  ) {}

  onModuleDestroy(): void {
    for (const runtime of this.runtimes.values()) {
      this.clearTimer(runtime);
    }
    this.runtimes.clear();
  }

  async listFlightSequences(
    programId: string,
  ): Promise<Omit<FlightSequence, 'programStateId'>[]> {
    const state = await this.getProgramStateRecord(programId);
    const sequences = await this.prisma.flightSequence.findMany({
      where: { programStateId: state.id },
      orderBy: { createdAt: 'asc' },
    });

    return sequences.map((seq) => this.toFlightSequence(seq));
  }

  async getActiveFlightSequence(programId: string) {
    const state = await this.prisma.programState.findUnique({
      where: { programId },
    });

    if (!state?.activeFlightSequenceId) {
      return null;
    }

    const sequence = await this.prisma.flightSequence.findUnique({
      where: { id: state.activeFlightSequenceId },
    });

    if (!sequence) {
      return null;
    }

    return {
      activeSequenceId: state.activeFlightSequenceId,
      sequence: this.toFlightSequence(sequence),
    };
  }

  async createFlightSequence(
    programId: string,
    data: {
      name: string;
      items?: unknown;
      loop?: boolean;
    },
  ): Promise<Omit<FlightSequence, 'programStateId'>> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) {
      throw new BadRequestException('flight sequence name is required');
    }

    const state = await this.getProgramStateRecord(normalizedProgramId);
    const items = normalizeFlightItems(data.items);

    try {
      const sequence = await this.prisma.flightSequence.create({
        data: {
          programStateId: state.id,
          name,
          items: items as any,
          loop: data.loop === true,
        },
      });

      return this.toFlightSequence(sequence);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new BadRequestException(
          `flight sequence "${name}" already exists`,
        );
      }
      throw err;
    }
  }

  async updateFlightSequence(
    programId: string,
    sequenceId: number,
    data: {
      name?: string;
      items?: unknown;
      loop?: boolean;
    },
  ): Promise<Omit<FlightSequence, 'programStateId'>> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.getProgramStateRecord(normalizedProgramId);

    const existing = await this.prisma.flightSequence.findFirst({
      where: { id: sequenceId, programStateId: state.id },
    });
    if (!existing) {
      throw new NotFoundException('flight sequence not found');
    }

    const runtime = this.runtimes.get(normalizedProgramId);
    const isActiveRuntime = runtime?.sequenceId === sequenceId;

    if (isActiveRuntime && runtime?.isRunning) {
      await this.stop(normalizedProgramId);
    }

    const updateData: any = {};
    if (typeof data.name === 'string' && data.name.trim().length > 0) {
      updateData.name = data.name.trim();
    }
    if (Array.isArray(data.items) || data.items === undefined) {
      updateData.items = normalizeFlightItems(data.items) as any;
    }
    if (typeof data.loop === 'boolean') {
      updateData.loop = data.loop;
    }

    try {
      const sequence = await this.prisma.flightSequence.update({
        where: { id: sequenceId },
        data: updateData,
      });

      if (isActiveRuntime) {
        this.runtimes.delete(normalizedProgramId);
      }

      return this.toFlightSequence(sequence);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new BadRequestException(
          `flight sequence "${updateData.name ?? existing.name}" already exists`,
        );
      }
      throw err;
    }
  }

  async deleteFlightSequence(
    programId: string,
    sequenceId: number,
  ): Promise<{ deletedId: number }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.getProgramStateRecord(normalizedProgramId);

    const existing = await this.prisma.flightSequence.findFirst({
      where: { id: sequenceId, programStateId: state.id },
    });
    if (!existing) {
      throw new NotFoundException('flight sequence not found');
    }

    const runtime = this.runtimes.get(normalizedProgramId);
    if (runtime?.sequenceId === sequenceId) {
      await this.stop(normalizedProgramId);
      this.runtimes.delete(normalizedProgramId);
    }

    await this.prisma.flightSequence.delete({
      where: { id: sequenceId },
    });

    if (state.activeFlightSequenceId === sequenceId) {
      await this.prisma.programState.update({
        where: { id: state.id },
        data: { activeFlightSequenceId: null },
      });
    }

    return { deletedId: sequenceId };
  }

  async activateFlightSequence(
    programId: string,
    sequenceId: number,
  ): Promise<{ activeSequenceId: number | null }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.getProgramStateRecord(normalizedProgramId);

    const existing = await this.prisma.flightSequence.findFirst({
      where: { id: sequenceId, programStateId: state.id },
    });
    if (!existing) {
      throw new NotFoundException('flight sequence not found');
    }

    await this.stop(normalizedProgramId);
    this.runtimes.delete(normalizedProgramId);

    await this.prisma.programState.update({
      where: { id: state.id },
      data: { activeFlightSequenceId: sequenceId },
    });

    await this.prisma.flightSequence.update({
      where: { id: sequenceId },
      data: { isRunning: false, activeItemId: null },
    });

    await this.broadcastFlightUpdate(normalizedProgramId, sequenceId);
    return { activeSequenceId: sequenceId };
  }

  async deactivateFlightSequence(
    programId: string,
  ): Promise<{ activeSequenceId: null }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.getProgramStateRecord(normalizedProgramId);

    await this.stop(normalizedProgramId);
    this.runtimes.delete(normalizedProgramId);

    await this.prisma.programState.update({
      where: { id: state.id },
      data: { activeFlightSequenceId: null },
    });

    await this.broadcastFlightUpdate(normalizedProgramId, null);
    return { activeSequenceId: null };
  }

  async start(programId: string): Promise<{ ok: boolean }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.getProgramStateRecord(normalizedProgramId);

    if (!state.activeFlightSequenceId) {
      throw new BadRequestException('no active flight sequence');
    }

    const sequence = await this.prisma.flightSequence.findUnique({
      where: { id: state.activeFlightSequenceId },
    });
    if (!sequence) {
      throw new NotFoundException('active flight sequence not found');
    }

    const items = normalizeFlightItems(sequence.items);
    if (items.length === 0) {
      throw new BadRequestException('flight sequence has no cues');
    }

    await this.stop(normalizedProgramId);

    const runtime: FlightRuntimeState = {
      sequenceId: sequence.id,
      programId: normalizedProgramId,
      items,
      loop: sequence.loop,
      activeIndex: 0,
      isRunning: true,
      generation: Date.now(),
      timer: null,
      waitingForSongEnd: false,
      startedAt: Date.now(),
    };

    this.runtimes.set(normalizedProgramId, runtime);
    await this.persistRuntimeState(runtime);
    await this.broadcastFlightUpdate(normalizedProgramId);

    void this.executeCueAtIndex(normalizedProgramId, 0, runtime.generation);

    return { ok: true };
  }

  async stop(programId: string): Promise<{ ok: boolean }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const runtime = this.runtimes.get(normalizedProgramId);

    if (runtime) {
      runtime.isRunning = false;
      runtime.waitingForSongEnd = false;
      this.clearTimer(runtime);
      this.runtimes.delete(normalizedProgramId);
    }

    const state = await this.getProgramStateRecord(normalizedProgramId);
    if (state.activeFlightSequenceId) {
      await this.prisma.flightSequence.update({
        where: { id: state.activeFlightSequenceId },
        data: { isRunning: false },
      });
    }

    try {
      await this.programService.takeProgramSongOffAir(normalizedProgramId);
    } catch {
      // ignore
    }

    await this.broadcastFlightUpdate(normalizedProgramId);
    return { ok: true };
  }

  async go(programId: string): Promise<{ ok: boolean }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const runtime = this.runtimes.get(normalizedProgramId);

    if (!runtime || !runtime.isRunning) {
      console.log(`[Flight] go(${normalizedProgramId}): runtime not running, calling start()`);
      return this.start(normalizedProgramId);
    }

    this.clearTimer(runtime);
    runtime.waitingForSongEnd = false;
    runtime.generation += 1;
    console.log(`[Flight] go(${normalizedProgramId}): advancing from cue #${runtime.activeIndex} to #${runtime.activeIndex + 1}`);

    const nextIndex = runtime.activeIndex + 1;
    if (nextIndex >= runtime.items.length) {
      if (runtime.loop) {
        await this.executeCueAtIndex(
          normalizedProgramId,
          0,
          runtime.generation,
        );
      } else {
        await this.stop(normalizedProgramId);
      }
      return { ok: true };
    }

    await this.executeCueAtIndex(
      normalizedProgramId,
      nextIndex,
      runtime.generation,
    );
    return { ok: true };
  }

  async reset(programId: string): Promise<{ ok: boolean }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const wasRunning =
      this.runtimes.get(normalizedProgramId)?.isRunning ?? false;

    await this.stop(normalizedProgramId);

    const state = await this.getProgramStateRecord(normalizedProgramId);
    if (state.activeFlightSequenceId) {
      await this.prisma.flightSequence.update({
        where: { id: state.activeFlightSequenceId },
        data: { activeItemId: null, isRunning: false },
      });
    }

    await this.broadcastFlightUpdate(normalizedProgramId);

    if (wasRunning) {
      return this.start(normalizedProgramId);
    }

    return { ok: true };
  }

  async handleSongEnded(programId: string): Promise<{ ok: boolean }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const runtime = this.runtimes.get(normalizedProgramId);

    if (!runtime || !runtime.isRunning || !runtime.waitingForSongEnd) {
      console.log(
        `[Flight] handleSongEnded(${normalizedProgramId}): ` +
        `runtime=${!!runtime} isRunning=${runtime?.isRunning} ` +
        `waitingForSongEnd=${runtime?.waitingForSongEnd}`,
      );
      return { ok: false };
    }

    console.log(`[Flight] handleSongEnded(${normalizedProgramId}): advancing from cue #${runtime.activeIndex}`);
    this.clearTimer(runtime);
    runtime.waitingForSongEnd = false;
    runtime.generation += 1;

    const nextIndex = runtime.activeIndex + 1;
    if (nextIndex >= runtime.items.length) {
      if (runtime.loop) {
        await this.executeCueAtIndex(
          normalizedProgramId,
          0,
          runtime.generation,
        );
      } else {
        await this.stop(normalizedProgramId);
      }
      return { ok: true };
    }

    await this.executeCueAtIndex(
      normalizedProgramId,
      nextIndex,
      runtime.generation,
    );
    return { ok: true };
  }

  private async executeCueAtIndex(
    programId: string,
    index: number,
    generation: number,
  ): Promise<void> {
    const runtime = this.runtimes.get(programId);
    if (!runtime || runtime.generation !== generation || !runtime.isRunning) {
      return;
    }

    if (index < 0 || index >= runtime.items.length) {
      if (runtime.loop && runtime.items.length > 0) {
        return this.executeCueAtIndex(programId, 0, generation);
      }
      await this.stop(programId);
      return;
    }

    runtime.activeIndex = index;
    runtime.waitingForSongEnd = false;
    await this.persistRuntimeState(runtime);
    await this.broadcastFlightUpdate(programId);

    const cue = runtime.items[index];

    try {
      await this.executeCue(programId, cue);
    } catch (err) {
      console.error(`Flight cue execution failed (${cue.kind})`, err);
    }

    if (runtime.generation !== generation || !runtime.isRunning) {
      return;
    }

    if (cue.kind === 'wait') {
      const durationMs =
        typeof cue.durationMs === 'number' && cue.durationMs >= 0
          ? cue.durationMs
          : 0;
      runtime.timer = setTimeout(() => {
        void this.advance(programId, generation);
      }, durationMs);
      return;
    }

    if (cue.kind === 'waitForSongEnd') {
      runtime.waitingForSongEnd = true;
      const songEndTimeoutMs = 5 * 60 * 1000;
      runtime.timer = setTimeout(() => {
        const current = this.runtimes.get(programId);
        if (current?.waitingForSongEnd) {
          current.waitingForSongEnd = false;
          current.generation += 1;
          void this.advance(programId, current.generation);
        }
      }, songEndTimeoutMs);
      return;
    }

    void this.advance(programId, generation);
  }

  private async advance(programId: string, generation: number): Promise<void> {
    const runtime = this.runtimes.get(programId);
    if (!runtime || runtime.generation !== generation || !runtime.isRunning) {
      return;
    }

    const nextIndex = runtime.activeIndex + 1;
    if (nextIndex >= runtime.items.length) {
      if (runtime.loop) {
        await this.executeCueAtIndex(programId, 0, generation);
      } else {
        await this.stop(programId);
      }
      return;
    }

    await this.executeCueAtIndex(programId, nextIndex, generation);
  }

  private async executeCue(programId: string, cue: FlightCue): Promise<void> {
    switch (cue.kind) {
      case 'scene':
        if (typeof cue.sceneId === 'number') {
          await this.programService.activateScene(
            cue.sceneId,
            programId,
            cue.transitionId ?? null,
          );
        }
        break;

      case 'playSong':
        await this.executePlaySongCue(programId, cue);
        break;

      case 'stopSong':
        await this.programService.takeProgramSongOffAir(programId);
        break;

      case 'sceneUpdate':
        if (typeof cue.sceneId === 'number' && isRecord(cue.metadataPatch)) {
          await this.executeSceneUpdateCue(cue.sceneId, cue.metadataPatch);
        }
        break;

      case 'instant':
        if (typeof cue.instantId === 'number') {
          await this.programService.playInstant(cue.instantId, programId);
        }
        break;

      case 'mixer':
        if (isRecord(cue.mixerChange)) {
          await this.executeMixerCue(programId, cue.mixerChange);
        }
        break;

      case 'wait':
      case 'waitForSongEnd':
        break;
    }
  }

  private async executePlaySongCue(
    programId: string,
    cue: FlightCue,
  ): Promise<void> {
    let songSequence: unknown = null;

    if (typeof cue.songId === 'number') {
      const song = await this.prisma.song.findUnique({
        where: { id: cue.songId },
      });
      if (song) {
        const itemId = createId('song');
        songSequence = {
          mode: 'manual',
          items: [
            {
              id: itemId,
              kind: 'preset',
              artist: song.artist,
              title: song.title,
              coverUrl: song.coverUrl ?? '',
              audioUrl: song.audioUrl,
              durationMs: song.durationMs ?? undefined,
            },
          ],
          activeItemId: itemId,
          intervalMs: 4000,
          loop: false,
          startedAt: Date.now(),
        };
      }
    }

    await this.programService.updateProgramAudioBus(
      { songSequence },
      programId,
    );
  }

  private async executeSceneUpdateCue(
    sceneId: number,
    metadataPatch: Record<string, unknown>,
  ): Promise<void> {
    const scene = await this.prisma.scene.findUnique({
      where: { id: sceneId },
    });
    if (!scene) {
      return;
    }

    let parsed: Record<string, unknown> = {};
    try {
      if (scene.metadata) {
        const raw = JSON.parse(scene.metadata);
        if (isRecord(raw)) {
          parsed = raw;
        }
      }
    } catch {
      parsed = {};
    }

    const nextMetadata = deepPatch(parsed, metadataPatch);

    const updated = await this.prisma.scene.update({
      where: { id: sceneId },
      data: { metadata: JSON.stringify(nextMetadata) },
      include: { layout: true },
    });

    const programIds =
      await this.programService.getProgramIdsByAssignedScene(sceneId);
    for (const programId of programIds) {
      this.programService.broadcastUpdate(programId, {
        type: 'scene_update',
        scene: updated,
      });
    }
  }

  private async executeMixerCue(
    programId: string,
    mixerChange: NonNullable<FlightCue['mixerChange']>,
  ): Promise<void> {
    const current = await this.programService.getProgramAudioBus(programId);
    const mixerSettings = current.mixerSettings;
    if (!mixerSettings || typeof mixerSettings !== 'object') {
      return;
    }

    const settings = mixerSettings as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (mixerChange.channelId === 'main') {
      if (typeof mixerChange.volume === 'number') {
        patch.mainMasterVolume = mixerChange.volume;
      }
    } else if (mixerChange.channelId) {
      const channels = Array.isArray(settings.mixerChannels)
        ? settings.mixerChannels
        : [];
      const nextChannels = channels.map((channel: unknown) => {
        const record = isRecord(channel) ? channel : {};
        if (record.id !== mixerChange.channelId) {
          return record;
        }
        const next: Record<string, unknown> = { ...record };
        if (typeof mixerChange.volume === 'number') {
          next.volume = mixerChange.volume;
        }
        if (typeof mixerChange.muted === 'boolean') {
          next.muted = mixerChange.muted;
        }
        if (typeof mixerChange.solo === 'boolean') {
          next.solo = mixerChange.solo;
        }
        return next;
      });
      patch.mixerChannels = nextChannels;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    await this.programService.updateProgramAudioBus(
      { mixerSettings: patch },
      programId,
    );
  }

  private async persistRuntimeState(
    runtime: FlightRuntimeState,
  ): Promise<void> {
    const activeItem = runtime.items[runtime.activeIndex];
    await this.prisma.flightSequence.update({
      where: { id: runtime.sequenceId },
      data: {
        isRunning: runtime.isRunning,
        activeItemId: activeItem?.id ?? null,
      },
    });
  }

  private async broadcastFlightUpdate(
    programId: string,
    activeSequenceId?: number | null,
  ): Promise<void> {
    const runtime = this.runtimes.get(programId);

    let resolvedActiveSequenceId: number | null;
    if (activeSequenceId !== undefined) {
      resolvedActiveSequenceId = activeSequenceId;
    } else {
      const state = await this.prisma.programState.findUnique({
        where: { programId },
        select: { activeFlightSequenceId: true },
      });
      resolvedActiveSequenceId = state?.activeFlightSequenceId ?? null;
    }

    const payload: any = {
      type: 'flight_update',
      programId,
      activeSequenceId: resolvedActiveSequenceId,
      runtime: runtime
        ? {
            sequenceId: runtime.sequenceId,
            activeIndex: runtime.activeIndex,
            isRunning: runtime.isRunning,
            waitingForSongEnd: runtime.waitingForSongEnd,
            activeItemId: runtime.items[runtime.activeIndex]?.id ?? null,
            totalItems: runtime.items.length,
            loop: runtime.loop,
          }
        : null,
    };

    this.programService.broadcastUpdate(programId, payload);
  }

  private clearTimer(runtime: FlightRuntimeState): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
  }

  private async getProgramStateRecord(programId: string) {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const state = await this.prisma.programState.findUnique({
      where: { programId: normalizedProgramId },
    });
    if (!state) {
      throw new NotFoundException('program not found');
    }
    return state;
  }

  private normalizeProgramId(programId: string): string {
    const normalized = typeof programId === 'string' ? programId.trim() : '';
    if (!normalized) {
      throw new BadRequestException('programId is required');
    }
    return normalized;
  }

  private toFlightSequence(seq: any): Omit<FlightSequence, 'programStateId'> {
    return {
      id: seq.id,
      name: seq.name,
      items: normalizeFlightItems(seq.items),
      loop: seq.loop,
      isRunning: seq.isRunning,
      activeItemId: seq.activeItemId,
      createdAt: seq.createdAt,
      updatedAt: seq.updatedAt,
    };
  }
}
