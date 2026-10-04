import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Prisma } from '@prisma/client';
import { ProgramService } from './program.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { generateRadioLog, parseRadioLogRules } from './radio-log-generator';
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

  const clockOffsetSeconds = normalizeOptionalNumber(value.clockOffsetSeconds);
  if (clockOffsetSeconds !== undefined) {
    cue.clockOffsetSeconds = clockOffsetSeconds;
  }
  const voiceTrackInstantId = normalizeOptionalNumber(
    value.voiceTrackInstantId,
  );
  if (voiceTrackInstantId !== undefined) {
    cue.voiceTrackInstantId = voiceTrackInstantId;
  }
  for (const field of [
    'voiceDuckGain',
    'voiceFadeInSeconds',
    'voiceFadeOutSeconds',
  ] as const) {
    if (typeof value[field] === 'number' && Number.isFinite(value[field])) {
      cue[field] = value[field] as number;
    }
  }

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
export class FlightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FlightService.name);
  private readonly runtimes = new Map<string, FlightRuntimeState>();
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleTickRunning = false;
  private readonly cueOperations = new Map<string, Promise<unknown>>();

  private async serializeCueOperation<T>(
    programId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.cueOperations.get(programId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    this.cueOperations.set(programId, operation);
    try {
      return await operation;
    } finally {
      if (this.cueOperations.get(programId) === operation)
        this.cueOperations.delete(programId);
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ProgramService))
    private readonly programService: ProgramService,
    private readonly metrics: RadioMetricsService,
  ) {}

  onModuleInit(): void {
    this.scheduleTimer = setInterval(() => {
      void this.startDuePublishedLogs();
    }, 1000);
  }

  onModuleDestroy(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
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

  async generateTaggedLog(
    programId: string,
    sequenceId: number,
    data: { revision?: number; rules?: unknown },
  ): Promise<{ items: FlightCue[] }> {
    try {
      const state = await this.getProgramStateRecord(programId);
      if (state.type !== 'radio' && state.type !== 'both')
        throw new BadRequestException('Radio logs require a radio leg');
      const sequence = await this.prisma.flightSequence.findFirst({
        where: { id: sequenceId, programStateId: state.id },
      });
      if (!sequence) throw new NotFoundException('radio log not found');
      if (
        !sequence.scheduledAt ||
        sequence.publishedAt ||
        sequence.lastStartedAt ||
        sequence.isRunning
      )
        throw new BadRequestException(
          'Tag generation is available only for an unaired draft hour',
        );
      if (data?.revision !== sequence.revision)
        throw new ConflictException(
          'The log changed. Reload before generating.',
        );
      const rules = parseRadioLogRules(data.rules);
      const labelIds = [...new Set(rules.slots.map((slot) => slot.labelId))];
      const [labels, songs, previous] = await Promise.all([
        this.prisma.mediaLabel.findMany({
          where: { id: { in: labelIds } },
          select: { id: true, name: true },
        }),
        this.prisma.song.findMany({
          where: {
            enabled: true,
            audioUrl: { not: '' },
            asset: { labels: { some: { labelId: { in: labelIds } } } },
          },
          select: {
            id: true,
            artist: true,
            durationMs: true,
            asset: {
              select: {
                labels: {
                  where: { labelId: { in: labelIds } },
                  select: { labelId: true, position: true },
                },
              },
            },
          },
        }),
        this.prisma.flightSequence.findMany({
          where: {
            programStateId: state.id,
            publishedAt: { not: null },
            scheduledAt: { lt: sequence.scheduledAt },
          },
          orderBy: { scheduledAt: 'desc' },
          take: 24,
          select: { items: true },
        }),
      ]);
      const previousSongIds = previous
        .reverse()
        .flatMap((log) =>
          normalizeFlightItems(log.items).flatMap((cue) =>
            cue.kind === 'playSong' && cue.songId ? [cue.songId] : [],
          ),
        );
      const items = generateRadioLog(rules, songs, labels, previousSongIds);
      const preflight = await this.preflightClockItems(programId, items);
      if (!preflight.ready)
        throw new BadRequestException(preflight.issues.join('; '));
      this.metrics.recordRadioLogResult('generated');
      return { items };
    } catch (cause) {
      this.metrics.recordRadioLogResult('generation-failed');
      throw cause;
    }
  }

  private parseScheduledAt(value: string | null | undefined): Date | null {
    if (value == null) return null;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(value)
    ) {
      throw new BadRequestException('scheduledAt must be an ISO time');
    }
    const parsed = new Date(value);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 13) !== value.slice(0, 13)
    ) {
      throw new BadRequestException('scheduledAt is invalid');
    }
    return parsed;
  }

  private validateClockItems(items: FlightCue[]): void {
    if (!items.length || items.length > 120) {
      throw new BadRequestException('a clocked log needs 1-120 items');
    }
    let previousHardTime = -1;
    const ids = new Set<string>();
    for (const [index, cue] of items.entries()) {
      if (ids.has(cue.id))
        throw new BadRequestException('log item IDs must be unique');
      ids.add(cue.id);
      if (!['playSong', 'instant', 'stopSong'].includes(cue.kind)) {
        throw new BadRequestException(
          'clocked logs support songs, clips, and stop cues',
        );
      }
      if (cue.clockOffsetSeconds !== undefined) {
        if (
          !Number.isInteger(cue.clockOffsetSeconds) ||
          cue.clockOffsetSeconds < 0 ||
          cue.clockOffsetSeconds >= 3600 ||
          cue.clockOffsetSeconds < previousHardTime
        ) {
          throw new BadRequestException(
            'clock times must be ordered within the hour',
          );
        }
        previousHardTime = cue.clockOffsetSeconds;
      }
      if (index === 0 && cue.clockOffsetSeconds !== 0) {
        throw new BadRequestException(
          'the first log item must start at the hour',
        );
      }
      if (
        cue.kind === 'playSong' &&
        (!Number.isInteger(cue.songId) || (cue.songId ?? 0) < 1)
      ) {
        throw new BadRequestException('each song cue needs a catalog song');
      }
      if (
        cue.kind === 'instant' &&
        (!Number.isInteger(cue.instantId) || (cue.instantId ?? 0) < 1)
      ) {
        throw new BadRequestException('each clip cue needs an audio clip');
      }
      if (
        cue.voiceTrackInstantId !== undefined &&
        (cue.kind !== 'playSong' ||
          !Number.isInteger(cue.voiceTrackInstantId) ||
          cue.voiceTrackInstantId < 1)
      ) {
        throw new BadRequestException(
          'a voice track must belong to a song cue',
        );
      }
      if (
        (cue.voiceDuckGain !== undefined ||
          cue.voiceFadeInSeconds !== undefined ||
          cue.voiceFadeOutSeconds !== undefined) &&
        !cue.voiceTrackInstantId
      ) {
        throw new BadRequestException(
          'voice mix settings need a recorded voice track',
        );
      }
      if (
        cue.voiceDuckGain !== undefined &&
        (cue.voiceDuckGain < 0 || cue.voiceDuckGain > 1)
      ) {
        throw new BadRequestException(
          'voice duck gain must be between 0 and 1',
        );
      }
      for (const fade of [cue.voiceFadeInSeconds, cue.voiceFadeOutSeconds]) {
        if (fade !== undefined && (fade < 0 || fade > 5))
          throw new BadRequestException(
            'voice fades must be between 0 and 5 seconds',
          );
      }
    }
  }

  private normalizeClockItems(value: unknown): FlightCue[] {
    if (!Array.isArray(value))
      throw new BadRequestException('items must be an array');
    for (const raw of value) {
      if (
        !isRecord(raw) ||
        typeof raw.id !== 'string' ||
        !raw.id.trim() ||
        !['playSong', 'instant', 'stopSong'].includes(String(raw.kind))
      ) {
        throw new BadRequestException(
          'each log item needs an ID and supported cue kind',
        );
      }
      for (const field of [
        'clockOffsetSeconds',
        'songId',
        'instantId',
        'voiceTrackInstantId',
      ] as const) {
        if (
          raw[field] !== undefined &&
          (!Number.isInteger(raw[field]) || Number(raw[field]) < 0)
        ) {
          throw new BadRequestException(
            `${field} must be a nonnegative integer`,
          );
        }
      }
      for (const field of [
        'voiceDuckGain',
        'voiceFadeInSeconds',
        'voiceFadeOutSeconds',
      ] as const) {
        if (
          raw[field] !== undefined &&
          (typeof raw[field] !== 'number' || !Number.isFinite(raw[field]))
        ) {
          throw new BadRequestException(`${field} must be a finite number`);
        }
      }
    }
    const items = normalizeFlightItems(value);
    this.validateClockItems(items);
    return items;
  }

  private async preflightClockItems(programId: string, items: FlightCue[]) {
    this.validateClockItems(items);
    const songIds = [
      ...new Set(items.flatMap((cue) => (cue.songId ? [cue.songId] : []))),
    ];
    const instantIds = [
      ...new Set(
        items.flatMap((cue) =>
          [cue.instantId, cue.voiceTrackInstantId].filter(
            (id): id is number => typeof id === 'number',
          ),
        ),
      ),
    ];
    const [songs, instants] = await Promise.all([
      this.prisma.song.findMany({
        where: { id: { in: songIds } },
        select: { id: true, enabled: true, audioUrl: true, durationMs: true },
      }),
      this.prisma.instant.findMany({
        where: { id: { in: instantIds } },
        select: { id: true, enabled: true, audioUrl: true },
      }),
    ]);
    const playableSongs = new Map(songs.map((song) => [song.id, song]));
    const playableInstants = new Map(
      instants.map((instant) => [instant.id, instant]),
    );
    const issues: string[] = [];
    for (const [index, cue] of items.entries()) {
      if (cue.songId) {
        const song = playableSongs.get(cue.songId);
        if (!song?.enabled || !song.audioUrl.trim())
          issues.push(`Item ${index + 1}: song unavailable`);
      }
      for (const id of [cue.instantId, cue.voiceTrackInstantId]) {
        if (!id) continue;
        const instant = playableInstants.get(id);
        if (!instant?.enabled || !instant.audioUrl.trim())
          issues.push(`Item ${index + 1}: audio clip unavailable`);
      }
    }
    return { programId, ready: issues.length === 0, issues };
  }

  async preflightFlightSequence(programId: string, sequenceId: number) {
    const state = await this.getProgramStateRecord(programId);
    const sequence = await this.prisma.flightSequence.findFirst({
      where: { id: sequenceId, programStateId: state.id },
    });
    if (!sequence) throw new NotFoundException('flight sequence not found');
    if (!sequence.scheduledAt)
      throw new BadRequestException('not a clocked log');
    return this.preflightClockItems(
      programId,
      normalizeFlightItems(sequence.items),
    );
  }

  async publishFlightSequence(
    programId: string,
    sequenceId: number,
    revision: number,
  ) {
    const state = await this.getProgramStateRecord(programId);
    if (state.type !== 'radio' && state.type !== 'both')
      throw new BadRequestException('program has no radio leg');
    const sequence = await this.prisma.flightSequence.findFirst({
      where: { id: sequenceId, programStateId: state.id },
    });
    if (!sequence) throw new NotFoundException('flight sequence not found');
    if (!sequence.scheduledAt || sequence.scheduledAt.getTime() <= Date.now())
      throw new BadRequestException('the scheduled hour must be in the future');
    if (sequence.loop)
      throw new BadRequestException('a clocked log cannot loop');
    if (sequence.revision !== revision)
      throw new ConflictException(
        'log revision changed; reload before publishing',
      );
    const preflight = await this.preflightClockItems(
      programId,
      normalizeFlightItems(sequence.items),
    );
    if (!preflight.ready) {
      this.metrics.recordRadioLogResult('preflight-failed');
      throw new BadRequestException(preflight.issues.join('; '));
    }
    const result = await this.prisma.flightSequence.updateMany({
      where: { id: sequenceId, revision },
      data: { publishedAt: new Date(), revision: { increment: 1 } },
    });
    if (result.count !== 1)
      throw new ConflictException(
        'log revision changed; reload before publishing',
      );
    this.metrics.recordRadioLogResult('published');
    return this.toFlightSequence(
      await this.prisma.flightSequence.findUniqueOrThrow({
        where: { id: sequenceId },
      }),
    );
  }

  private async startDuePublishedLogs(): Promise<void> {
    if (this.scheduleTickRunning) return;
    this.scheduleTickRunning = true;
    try {
      const now = new Date();
      const due = await this.prisma.flightSequence.findMany({
        where: {
          publishedAt: { not: null },
          lastStartedAt: null,
          scheduledAt: { gte: new Date(now.getTime() - 5000), lte: now },
        },
        include: { programState: { select: { programId: true } } },
        take: 20,
      });
      for (const sequence of due) {
        const claimed = await this.prisma.flightSequence.updateMany({
          where: {
            id: sequence.id,
            lastStartedAt: null,
            publishedAt: { not: null },
          },
          data: { lastStartedAt: now },
        });
        if (claimed.count !== 1) continue;
        try {
          const preflight = await this.preflightClockItems(
            sequence.programState.programId,
            normalizeFlightItems(sequence.items),
          );
          if (!preflight.ready)
            throw new BadRequestException(preflight.issues.join('; '));
          await this.activateFlightSequence(
            sequence.programState.programId,
            sequence.id,
          );
          await this.start(sequence.programState.programId);
        } catch (error) {
          this.metrics.recordRadioLogResult('start-failed');
          // A claimed hour never repeats automatically after an ambiguous failure.
          this.programService.broadcastUpdate(sequence.programState.programId, {
            type: 'radio_log_start_failed',
            sequenceId: sequence.id,
          });
        }
      }
    } catch {
      this.metrics.recordRadioLogResult('poll-failed');
      this.logger.error('Scheduled radio log poll failed');
    } finally {
      this.scheduleTickRunning = false;
    }
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
      scheduledAt?: string | null;
    },
  ): Promise<Omit<FlightSequence, 'programStateId'>> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) {
      throw new BadRequestException('flight sequence name is required');
    }

    const state = await this.getProgramStateRecord(normalizedProgramId);
    const scheduledAt = this.parseScheduledAt(data.scheduledAt);
    if (scheduledAt && state.type !== 'radio' && state.type !== 'both')
      throw new BadRequestException('program has no radio leg');
    const items =
      scheduledAt && Array.isArray(data.items) && data.items.length
        ? this.normalizeClockItems(data.items)
        : normalizeFlightItems(data.items);
    if (scheduledAt && data.loop === true)
      throw new BadRequestException('a clocked log cannot loop');

    try {
      const sequence = await this.prisma.flightSequence.create({
        data: {
          programStateId: state.id,
          name,
          items: items as any,
          loop: data.loop === true,
          scheduledAt,
        },
      });

      return this.toFlightSequence(sequence);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new BadRequestException(
          scheduledAt
            ? 'a radio log already exists for this scheduled hour or name'
            : `flight sequence "${name}" already exists`,
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
      scheduledAt?: string | null;
      revision?: number;
    },
  ): Promise<Omit<FlightSequence, 'programStateId'>> {
    return this.serializeCueOperation(this.normalizeProgramId(programId), () =>
      this.updateFlightSequenceUnlocked(programId, sequenceId, data),
    );
  }

  private async updateFlightSequenceUnlocked(
    programId: string,
    sequenceId: number,
    data: {
      name?: string;
      items?: unknown;
      loop?: boolean;
      scheduledAt?: string | null;
      revision?: number;
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
    try {
      if (existing.scheduledAt && data.revision !== existing.revision) {
        throw new ConflictException(
          'log revision changed; reload before editing',
        );
      }

      if (
        existing.scheduledAt &&
        existing.lastStartedAt &&
        !runtime?.isRunning &&
        (data.items !== undefined ||
          data.scheduledAt !== undefined ||
          data.loop !== undefined)
      ) {
        throw new ConflictException(
          'an aired or stopped log cannot be rewritten',
        );
      }
      if (existing.publishedAt && data.scheduledAt !== undefined) {
        throw new ConflictException(
          'a published log cannot change its scheduled hour',
        );
      }
      const updateData: {
        name?: string;
        items?: Prisma.InputJsonValue;
        loop?: boolean;
        scheduledAt?: Date | null;
        revision?: { increment: number };
      } = {};
      if (typeof data.name === 'string' && data.name.trim().length > 0) {
        updateData.name = data.name.trim();
      }
      if (data.items !== undefined) {
        if (!Array.isArray(data.items)) {
          throw new BadRequestException('items must be an array');
        }
        updateData.items = data.items as Prisma.InputJsonValue;
      }
      if (typeof data.loop === 'boolean') {
        updateData.loop = data.loop;
      }
      if (data.scheduledAt !== undefined) {
        updateData.scheduledAt = this.parseScheduledAt(data.scheduledAt);
      }
      const nextScheduledAt =
        updateData.scheduledAt === undefined
          ? existing.scheduledAt
          : updateData.scheduledAt;
      if (nextScheduledAt && state.type !== 'radio' && state.type !== 'both')
        throw new BadRequestException('program has no radio leg');
      if (nextScheduledAt && (updateData.loop ?? existing.loop))
        throw new BadRequestException('a clocked log cannot loop');
      const nextItems =
        updateData.items === undefined
          ? normalizeFlightItems(existing.items)
          : nextScheduledAt && (updateData.items as unknown[]).length
            ? this.normalizeClockItems(updateData.items)
            : normalizeFlightItems(updateData.items);
      if (nextScheduledAt && nextItems.length)
        this.validateClockItems(nextItems);
      if (updateData.items !== undefined)
        updateData.items = nextItems as unknown as Prisma.InputJsonValue;
      if (isActiveRuntime && runtime?.isRunning) {
        if (data.scheduledAt !== undefined || data.loop !== undefined) {
          throw new ConflictException(
            'an on-air log cannot change its schedule or loop',
          );
        }
        const current = normalizeFlightItems(existing.items);
        const protectedCount = runtime.activeIndex + 1;
        if (
          nextItems.length < protectedCount ||
          JSON.stringify(nextItems.slice(0, protectedCount)) !==
            JSON.stringify(current.slice(0, protectedCount))
        ) {
          throw new ConflictException(
            'on-air and played log items cannot be edited',
          );
        }
      }
      if (existing.publishedAt) {
        const preflight = await this.preflightClockItems(
          normalizedProgramId,
          nextItems,
        );
        if (!preflight.ready)
          throw new BadRequestException(preflight.issues.join('; '));
      }
      updateData.revision = { increment: 1 };

      try {
        const result = await this.prisma.flightSequence.updateMany({
          where: { id: sequenceId, revision: existing.revision },
          data: updateData,
        });
        if (result.count !== 1)
          throw new ConflictException(
            'log revision changed; reload before editing',
          );
        const sequence = await this.prisma.flightSequence.findUniqueOrThrow({
          where: { id: sequenceId },
        });
        if (isActiveRuntime && runtime?.isRunning) {
          runtime.items = nextItems;
          if (runtime.waitingForSongEnd) this.armNextHardCue(runtime);
        }

        if (existing.scheduledAt) this.metrics.recordRadioLogResult('edited');
        return this.toFlightSequence(sequence);
      } catch (err: unknown) {
        if (isRecord(err) && err.code === 'P2002') {
          throw new BadRequestException(
            `flight sequence "${updateData.name ?? existing.name}" already exists`,
          );
        }
        throw err;
      }
    } catch (cause) {
      if (existing.scheduledAt)
        this.metrics.recordRadioLogResult('edit-failed');
      throw cause;
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

    if (existing.scheduledAt) {
      if (!existing.publishedAt)
        throw new BadRequestException(
          'publish the clocked log before activating',
        );
      const preflight = await this.preflightClockItems(
        normalizedProgramId,
        normalizeFlightItems(existing.items),
      );
      if (!preflight.ready)
        throw new BadRequestException(preflight.issues.join('; '));
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
    if (sequence.scheduledAt) {
      if (!sequence.publishedAt)
        throw new BadRequestException(
          'publish the clocked log before starting',
        );
      const preflight = await this.preflightClockItems(
        normalizedProgramId,
        items,
      );
      if (!preflight.ready)
        throw new BadRequestException(preflight.issues.join('; '));
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
      scheduledAtMs: sequence.scheduledAt?.getTime() ?? null,
    };

    this.runtimes.set(normalizedProgramId, runtime);
    if (sequence.scheduledAt && !sequence.lastStartedAt) {
      await this.prisma.flightSequence.update({
        where: { id: sequence.id },
        data: { lastStartedAt: new Date() },
      });
    }
    await this.persistRuntimeState(runtime);
    await this.broadcastFlightUpdate(normalizedProgramId);
    if (sequence.scheduledAt) this.metrics.recordRadioLogResult('started');

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
      console.log(
        `[Flight] go(${normalizedProgramId}): runtime not running, calling start()`,
      );
      return this.start(normalizedProgramId);
    }

    if (runtime.scheduledAtMs !== null && Date.now() < runtime.scheduledAtMs) {
      throw new BadRequestException(
        'the log cannot advance before its scheduled hour',
      );
    }
    this.clearTimer(runtime);
    runtime.waitingForSongEnd = false;
    runtime.generation += 1;
    console.log(
      `[Flight] go(${normalizedProgramId}): advancing from cue #${runtime.activeIndex} to #${runtime.activeIndex + 1}`,
    );

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

  isClockedLogRunning(programId: string): boolean {
    const runtime = this.runtimes.get(programId);
    return !!runtime?.isRunning && runtime.scheduledAtMs !== null;
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

    console.log(
      `[Flight] handleSongEnded(${normalizedProgramId}): advancing from cue #${runtime.activeIndex}`,
    );
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
    return this.serializeCueOperation(programId, () =>
      this.executeCueAtIndexUnlocked(programId, index, generation),
    );
  }

  private async executeCueAtIndexUnlocked(
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
        return this.executeCueAtIndexUnlocked(programId, 0, generation);
      }
      await this.stop(programId);
      return;
    }

    const cue = runtime.items[index];

    if (
      runtime.scheduledAtMs !== null &&
      cue.clockOffsetSeconds !== undefined
    ) {
      const dueAt = runtime.scheduledAtMs + cue.clockOffsetSeconds * 1000;
      if (dueAt > Date.now()) {
        runtime.timer = setTimeout(() => {
          void this.executeCueAtIndex(programId, index, generation);
        }, dueAt - Date.now());
        return;
      }
    }

    runtime.activeIndex = index;
    runtime.waitingForSongEnd = false;
    await this.persistRuntimeState(runtime);
    await this.broadcastFlightUpdate(programId);

    try {
      await this.executeCue(programId, cue);
    } catch (err) {
      console.error(`Flight cue execution failed (${cue.kind})`, err);
      if (runtime.scheduledAtMs !== null) {
        this.metrics.recordRadioLogResult('cue-failed');
        await this.stop(programId);
        this.programService.broadcastUpdate(programId, {
          type: 'radio_log_cue_failed',
          sequenceId: runtime.sequenceId,
          cueId: cue.id,
        });
        return;
      }
    }

    if (runtime.generation !== generation || !runtime.isRunning) {
      return;
    }

    if (runtime.scheduledAtMs !== null && cue.kind === 'playSong') {
      runtime.waitingForSongEnd = true;
      this.armNextHardCue(runtime);
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

  private armNextHardCue(runtime: FlightRuntimeState): void {
    this.clearTimer(runtime);
    const nextHard = runtime.items.find(
      (cue, index) =>
        index > runtime.activeIndex && cue.clockOffsetSeconds !== undefined,
    );
    if (!nextHard || runtime.scheduledAtMs === null) return;
    const generation = runtime.generation;
    runtime.timer = setTimeout(
      () => {
        const current = this.runtimes.get(runtime.programId);
        if (current?.generation !== generation || !current.waitingForSongEnd)
          return;
        const index = current.items.findIndex((cue) => cue.id === nextHard.id);
        if (index <= current.activeIndex) return;
        current.waitingForSongEnd = false;
        current.generation += 1;
        void this.executeCueAtIndex(
          current.programId,
          index,
          current.generation,
        );
      },
      Math.max(
        0,
        runtime.scheduledAtMs +
          nextHard.clockOffsetSeconds! * 1000 -
          Date.now(),
      ),
    );
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
    let selectedSong: {
      id: number;
      audioUrl: string;
      title: string;
      artist: string;
      coverUrl: string | null;
      durationMs: number | null;
    } | null = null;

    if (typeof cue.songId === 'number') {
      const song = await this.prisma.song.findUnique({
        where: { id: cue.songId },
      });
      if (song?.enabled && song.audioUrl.trim()) {
        selectedSong = song;
        const itemId = createId('song');
        songSequence = {
          mode: 'manual',
          items: [
            {
              id: itemId,
              kind: 'preset',
              songId: song.id,
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

    if (!selectedSong) {
      throw new BadRequestException('scheduled song is unavailable');
    }
    await this.programService.updateProgramAudioBus(
      { songSequence },
      programId,
    );
    this.programService.takeCatalogSongOnAir(
      programId,
      selectedSong,
      cue.voiceTrackInstantId
        ? {
            instantId: cue.voiceTrackInstantId,
            duckGain: cue.voiceDuckGain,
            fadeInSeconds: cue.voiceFadeInSeconds,
            fadeOutSeconds: cue.voiceFadeOutSeconds,
          }
        : undefined,
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
      scheduledAt: seq.scheduledAt ?? null,
      publishedAt: seq.publishedAt ?? null,
      revision: seq.revision ?? 1,
      lastStartedAt: seq.lastStartedAt ?? null,
      createdAt: seq.createdAt,
      updatedAt: seq.updatedAt,
    };
  }
}
