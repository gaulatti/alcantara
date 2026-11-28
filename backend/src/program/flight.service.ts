import {
  PlayoutLease,
  startWhenActive,
} from '../playout/playout-lease.service';
import {
  AutomationEngineUnavailableError,
  isRadioOnlyEngineOff,
  radioEngineReadiness,
} from '../radio/engine-availability';
import { isDeployCandidate } from '../config/deploy-candidate';
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
  Optional,
} from '@nestjs/common';
import {
  FLIGHT_SEQUENCE_CHANGE_FIELDS,
  FLIGHT_SEQUENCE_PUBLISH_FIELDS,
  OperatorChangeRecorder,
  summarizeChange,
} from '../operator-change/operator-change-recorder';
import { PrismaService } from '../prisma.service';
import { PompeiiService } from '../auth/pompeii.service';
import { forTeam } from '../tenancy/scoped-prisma';
import type { Prisma } from '@prisma/client';
import { ProgramService } from './program.service';
import {
  RadioMetricsService,
  type LogSongScopePath,
} from '../radio/radio-metrics.service';
import { generateRadioLog, parseRadioLogRules } from './radio-log-generator';
import { fillRadioRundown, parseFillerRules } from './radio-rundown-filler';
import { fixedStartWindowRefusal } from './fixed-start-window';
import type {
  FlightCue,
  FlightCueKind,
  FlightCueOutcome,
  FlightRecipeUse,
  FlightRuntimeState,
  FlightSequence,
} from './flight.types';

/** How late a published log may start: the scheduler skips one later than this. */
export const START_GRACE_MS = 5000;
/** The longest a daypart block with a soft start waits for the song on air to end before cutting it. */
export const DAYPART_SOFT_WAIT_MS = 6 * 60_000;

/**
 * gaulatti/alcantara#719: how long past its due time a timed-block cue that failed
 * while the engine was unavailable may still air. Past it the cue is skipped.
 */
export const ENGINE_OUTAGE_GRACE_MS = 60_000;

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

/**
 * Keeps a well-formed recipe-use tag (C1). A malformed tag is dropped and the cue kept: the cue still
 * plays, it just stops being grouped with its use.
 */
export function normalizeRecipeUse(
  value: unknown,
): FlightRecipeUse | undefined {
  if (!isRecord(value)) return undefined;
  const text = (input: unknown): string | null =>
    typeof input === 'string' && input.trim().length > 0 && input.length <= 64
      ? input
      : null;
  const positiveInteger = (input: unknown): number | null =>
    Number.isInteger(input) && (input as number) > 0 ? (input as number) : null;
  const params = isRecord(value.params) ? value.params : {};
  const useId = text(value.useId);
  const step = text(value.step);
  const recipeId = positiveInteger(value.recipeId);
  const recipeRevision = positiveInteger(value.recipeRevision);
  const songId = positiveInteger(params.songId);
  if (!useId || !step || !recipeId || !recipeRevision || !songId) {
    return undefined;
  }
  if (
    params.labelId !== undefined &&
    params.labelId !== null &&
    typeof params.labelId !== 'string'
  ) {
    return undefined;
  }
  const labelId = params.labelId === undefined ? undefined : params.labelId;
  return {
    useId,
    recipeId,
    recipeRevision,
    step,
    params: labelId === undefined ? { songId } : { songId, labelId },
  };
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

  if (typeof value.isFiller === 'boolean') cue.isFiller = value.isFiller;
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
      cue[field] = value[field];
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
    // A fader position, usually between 0 and 1. It must not go through
    // normalizeOptionalNumber, which rounds to an integer for ids and
    // durations: that turned every partial level into fully up or fully down.
    const volume = value.mixerChange.volume;
    if (typeof volume === 'number' && Number.isFinite(volume)) {
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

  const recipeUse = normalizeRecipeUse(value.recipeUse);
  if (recipeUse) {
    cue.recipeUse = recipeUse;
  }

  return cue;
}

export function normalizeFlightItems(value: unknown): FlightCue[] {
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

/** The event a preflight issue or warning is about: its 1-based place, the name the desk shows, and why. */
export interface PreflightEvent {
  item: number;
  name: string;
  reason: string;
}

@Injectable()
export class FlightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FlightService.name);
  private readonly runtimes = new Map<string, FlightRuntimeState>();
  /** Programs whose engine is unavailable now, as handleEngineAvailability reports it. */
  private readonly enginesDown = new Set<string>();
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
    private readonly recorder: OperatorChangeRecorder,
    private readonly pompeii: PompeiiService,
    @Optional() private readonly lease?: PlayoutLease,
  ) {}

  private readonly refusedSongScopes = new Set<string>();

  /**
   * The songs a program's logs, recipes and cues may read (gaulatti/alcantara#122): its team's, all of them when no
   * station team is configured, and none (`null`, counted) when the program has no team.
   */
  async programSongDb(
    path: LogSongScopePath,
    programId: string,
  ): Promise<PrismaService | null> {
    if (this.pompeii.teamId === 0) return this.prisma;
    const program = await this.prisma.program.findUnique({
      where: { programId },
      select: { teamId: true },
    });
    if (program?.teamId && program.teamId > 0) {
      return forTeam(this.prisma, program.teamId) as unknown as PrismaService;
    }
    this.metrics.recordLogSongScopeRefusal(path);
    const key = `${path}|${programId}`;
    if (!this.refusedSongScopes.has(key)) {
      this.refusedSongScopes.add(key);
      this.logger.warn(
        `Program ${programId} has no team; ${path} reads no songs`,
      );
    }
    return null;
  }

  async onModuleInit(): Promise<void> {
    if (isDeployCandidate()) {
      this.logger.log(
        'Deploy candidate: rundown blocks are left as they are and none is started',
      );
      return;
    }
    // Only the instance holding the playout lease (alcantara#873) runs the rundown.
    await startWhenActive(this.lease, () => this.startRundown());
  }

  private async startRundown(): Promise<void> {
    // Runtime timers cannot survive a process restart. Preserve the one-time
    // start claim and rotation; mark interrupted blocks accurately in the UI.
    const interrupted = await this.prisma.flightSequence.updateMany({
      where: { isRunning: true, scheduledAt: { not: null } },
      data: { isRunning: false },
    });
    if (interrupted.count) this.metrics.recordRadioLogResult('interrupted');
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

  async listFlightSequences(programId: string): Promise<
    (Omit<FlightSequence, 'programStateId'> & {
      cueOutcomes: FlightCueOutcome[];
    })[]
  > {
    const state = await this.getProgramStateRecord(programId);
    const sequences = await this.prisma.flightSequence.findMany({
      where: { programStateId: state.id },
      orderBy: { createdAt: 'asc' },
    });
    const outcomes = await this.cueOutcomesBySequence(
      sequences.map((seq) => seq.id),
    );

    return sequences.map((seq) => ({
      ...this.toFlightSequence(seq),
      cueOutcomes: outcomes.get(seq.id) ?? [],
    }));
  }

  /**
   * gaulatti/alcantara#726: the cues of these rundowns that were logged as not aired, from the
   * as-run rows written for them, so the rundown shows them as skipped instead of played.
   */
  private async cueOutcomesBySequence(
    sequenceIds: number[],
  ): Promise<Map<number, FlightCueOutcome[]>> {
    const bySequence = new Map<number, FlightCueOutcome[]>();
    if (sequenceIds.length === 0) return bySequence;
    const rows = await this.prisma.asRunRecord.findMany({
      where: {
        flightSequenceId: { in: sequenceIds },
        flightCueId: { not: null },
        state: 'not-aired',
      },
      select: { flightSequenceId: true, flightCueId: true, endReason: true },
      orderBy: { at: 'asc' },
    });
    for (const row of rows) {
      const list = bySequence.get(row.flightSequenceId!) ?? [];
      if (!list.some((outcome) => outcome.cueId === row.flightCueId))
        list.push({
          cueId: row.flightCueId!,
          state: 'not-aired',
          reason: row.endReason,
        });
      bySequence.set(row.flightSequenceId!, list);
    }
    return bySequence;
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
          'Tag generation is available only for an unaired draft block',
        );
      if (data?.revision !== sequence.revision)
        throw new ConflictException(
          'The log changed. Reload before generating.',
        );
      const items = await this.proposeCues(
        programId,
        state.id,
        sequence.scheduledAt,
        data.rules,
      );
      this.metrics.recordRadioLogResult('generated');
      return { items };
    } catch (cause) {
      this.metrics.recordRadioLogResult('generation-failed');
      throw cause;
    }
  }

  /** What a block at `scheduledAt` would hold under these rules, checked as a publish checks it. Writes nothing. */
  async previewTaggedLog(
    programId: string,
    scheduledAt: Date,
    rules: unknown,
  ): Promise<FlightCue[]> {
    const state = await this.getProgramStateRecord(programId);
    return this.proposeCues(programId, state.id, scheduledAt, rules);
  }

  private async proposeCues(
    programId: string,
    programStateId: number,
    scheduledAt: Date,
    ruleInput: unknown,
  ): Promise<FlightCue[]> {
    const rules = parseRadioLogRules(ruleInput);
    const labelIds = [...new Set(rules.slots.map((slot) => slot.labelId))];
    const songDb = await this.programSongDb('generate', programId);
    const [labels, songs, previous] = await Promise.all([
      this.prisma.mediaLabel.findMany({
        where: { id: { in: labelIds } },
        select: { id: true, name: true },
      }),
      songDb
        ? songDb.song.findMany({
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
          })
        : [],
      this.prisma.flightSequence.findMany({
        where: {
          programStateId,
          publishedAt: { not: null },
          scheduledAt: { lt: scheduledAt },
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
    return items;
  }

  async fillRundown(
    programId: string,
    sequenceId: number,
    data: { revision?: number; rules?: unknown; items?: unknown },
  ) {
    try {
      const state = await this.getProgramStateRecord(programId);
      if (state.type !== 'radio' && state.type !== 'both')
        throw new BadRequestException('Scheduled rundowns require a radio leg');
      const sequence = await this.prisma.flightSequence.findFirst({
        where: { id: sequenceId, programStateId: state.id },
      });
      if (!sequence) throw new NotFoundException('rundown not found');
      if (
        !sequence.scheduledAt ||
        sequence.publishedAt ||
        sequence.lastStartedAt ||
        sequence.isRunning
      )
        throw new BadRequestException(
          'Fill gaps only in an unaired unpublished draft',
        );
      if (data?.revision !== sequence.revision)
        throw new ConflictException(
          'The rundown changed. Reload before filling.',
        );
      const rules = parseFillerRules(data.rules);
      const items = this.normalizeClockItems(data.items);
      const contentIds = items.flatMap((cue) =>
        cue.songId ? [cue.songId] : [],
      );
      const songDb = await this.programSongDb('generate', programId);
      const [label, songs, previous] = await Promise.all([
        this.prisma.mediaLabel.findUnique({ where: { id: rules.labelId } }),
        songDb
          ? songDb.song.findMany({
              where: {
                enabled: true,
                audioUrl: { not: '' },
                OR: [
                  { id: { in: contentIds } },
                  { asset: { labels: { some: { labelId: rules.labelId } } } },
                ],
              },
              select: {
                id: true,
                artist: true,
                title: true,
                durationMs: true,
                asset: {
                  select: {
                    labels: { select: { labelId: true, position: true } },
                  },
                },
              },
            })
          : [],
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
      if (!label) throw new BadRequestException('Filler tag no longer exists');
      const history = previous
        .reverse()
        .flatMap((log) =>
          normalizeFlightItems(log.items).flatMap((cue) =>
            cue.songId ? [cue.songId] : [],
          ),
        );
      const preview = fillRadioRundown(rules, items, songs, history);
      const preflight = await this.preflightClockItems(
        programId,
        preview.items,
      );
      if (!preflight.ready)
        throw new BadRequestException(preflight.issues.join('; '));
      this.metrics.recordRadioLogResult('filled');
      return preview;
    } catch (cause) {
      this.metrics.recordRadioLogResult('fill-failed');
      throw cause;
    }
  }

  private parseScheduledAt(value: string | null | undefined): Date | null {
    if (value == null) return null;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(value)
    ) {
      throw new BadRequestException(
        'scheduledAt must be a whole minute, ISO time',
      );
    }
    const parsed = new Date(value);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
    ) {
      throw new BadRequestException('scheduledAt is invalid');
    }
    return parsed;
  }

  /**
   * #788 (MCP parity, item 4): why saving these cues or this start would be refused by the fixed-start window, or null.
   * For an MCP dry run, which saves nothing; the save itself refuses the same way.
   */
  async fixedStartWindowProblem(
    programId: string,
    sequenceId: number | null,
    data: { items?: unknown; scheduledAt?: string | null },
  ): Promise<string | null> {
    if (data.items === undefined && data.scheduledAt === undefined) return null;
    const state = await this.getProgramStateRecord(
      this.normalizeProgramId(programId),
    );
    const existing =
      sequenceId === null
        ? null
        : await this.prisma.flightSequence.findFirst({
            where: { id: sequenceId, programStateId: state.id },
            select: { items: true, scheduledAt: true },
          });
    const scheduledAt =
      data.scheduledAt === undefined
        ? (existing?.scheduledAt ?? null)
        : this.parseScheduledAt(data.scheduledAt);
    if (!scheduledAt) return null;
    const items = normalizeFlightItems(data.items ?? existing?.items);
    return this.fixedStartWindowWhy(state.id, sequenceId, scheduledAt, items);
  }

  /**
   * #788 (MCP parity, item 4): the desk's fixed-start window (D3), enforced on the save path the console and MCP
   * share: within FIXED_START_MAX_HOURS of the block start and before the next scheduled block of the program.
   */
  private async refuseOutsideFixedStartWindow(
    programStateId: number,
    sequenceId: number | null,
    scheduledAt: Date,
    items: FlightCue[],
  ): Promise<void> {
    const why = await this.fixedStartWindowWhy(
      programStateId,
      sequenceId,
      scheduledAt,
      items,
    );
    if (why) throw new BadRequestException(why);
  }

  private async fixedStartWindowWhy(
    programStateId: number,
    sequenceId: number | null,
    scheduledAt: Date,
    items: FlightCue[],
  ): Promise<string | null> {
    const later = await this.prisma.flightSequence.findMany({
      where: {
        programStateId,
        scheduledAt: { gt: scheduledAt },
        ...(sequenceId === null ? {} : { id: { not: sequenceId } }),
      },
      select: { id: true, scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
      take: 1,
    });
    const next = later?.[0]?.scheduledAt ?? null;
    return fixedStartWindowRefusal(items, scheduledAt, next);
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
          !Number.isSafeInteger(cue.clockOffsetSeconds) ||
          cue.clockOffsetSeconds < 0 ||
          cue.clockOffsetSeconds < previousHardTime
        ) {
          throw new BadRequestException(
            'fixed starts must be ordered from the block start',
          );
        }
        previousHardTime = cue.clockOffsetSeconds;
      }
      if (index === 0 && cue.clockOffsetSeconds !== 0) {
        throw new BadRequestException(
          'the first event must start at the block start',
        );
      }
      if (
        cue.kind === 'playSong' &&
        (!Number.isInteger(cue.songId) || (cue.songId as number) < 1)
      ) {
        throw new BadRequestException('each song cue needs a catalog song');
      }
      if (
        cue.kind === 'instant' &&
        (!Number.isInteger(cue.instantId) || (cue.instantId as number) < 1)
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
      if (raw.isFiller !== undefined && typeof raw.isFiller !== 'boolean')
        throw new BadRequestException('isFiller must be boolean');
      if (
        raw.durationMs !== undefined &&
        (typeof raw.durationMs !== 'number' ||
          !Number.isFinite(raw.durationMs) ||
          raw.durationMs <= 0)
      )
        throw new BadRequestException('durationMs must be positive');
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

  private async preflightClockItems(
    programId: string,
    items: FlightCue[],
    timing?: {
      scheduledAt: Date;
      rotationMode: string | null;
      hasFollowingBlock: boolean;
    },
  ) {
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
    const songDb = songIds.length
      ? await this.programSongDb('validate', programId)
      : null;
    const readSongs = async () =>
      songDb
        ? await songDb.song.findMany({
            where: { id: { in: songIds } },
            select: {
              id: true,
              enabled: true,
              audioUrl: true,
              durationMs: true,
              title: true,
            },
          })
        : [];
    const [songs, instants, engine] = await Promise.all([
      readSongs(),
      this.prisma.instant.findMany({
        where: { id: { in: instantIds } },
        select: { id: true, enabled: true, audioUrl: true, name: true },
      }),
      radioEngineReadiness(this.prisma, programId),
    ]);
    const playableSongs = new Map(songs.map((song) => [song.id, song]));
    const playableInstants = new Map(
      instants.map((instant) => [instant.id, instant]),
    );
    const issues: string[] = [];
    // Warnings never block a start: a song of unknown length still plays, but
    // the block's later times are estimates around it.
    const warnings: string[] = [];
    // Additive, one entry per issue and per warning in the same order: the event it is about, by the name the desk
    // shows (its label, else the song or clip), or null for one about the whole block. The strings are unchanged.
    const issueEvents: Array<PreflightEvent | null> = [];
    const warningEvents: Array<PreflightEvent | null> = [];
    const eventOf = (index: number, reason: string): PreflightEvent | null => {
      const cue = items[index];
      const name =
        cue.label?.trim() ||
        (cue.songId ? playableSongs.get(cue.songId)?.title?.trim() : '') ||
        (cue.instantId
          ? playableInstants.get(cue.instantId)?.name?.trim()
          : '') ||
        '';
      return name ? { item: index + 1, name, reason } : null;
    };
    const issue = (index: number, reason: string) => {
      issues.push(`Item ${index + 1}: ${reason}`);
      issueEvents.push(eventOf(index, reason));
    };
    for (const [index, cue] of items.entries()) {
      if (cue.songId) {
        const song = playableSongs.get(cue.songId);
        if (!song?.enabled || !song.audioUrl.trim())
          issue(index, 'song unavailable');
        else if (song.durationMs == null) {
          warnings.push(`Item ${index + 1}: song duration unknown`);
          warningEvents.push(eventOf(index, 'song duration unknown'));
        }
      }
      for (const id of [cue.instantId, cue.voiceTrackInstantId]) {
        if (!id) continue;
        const instant = playableInstants.get(id);
        if (!instant?.enabled || !instant.audioUrl.trim())
          issue(index, 'audio clip unavailable');
      }
    }
    if (timing)
      for (const timed of this.clockTimingWarnings(
        items,
        playableSongs,
        timing,
      )) {
        warnings.push(timed.message);
        warningEvents.push(
          timed.index === null ? null : eventOf(timed.index, timed.message),
        );
      }
    // A block whose show's radio is not set up, or is off, would air nothing: say so, without blocking, since the
    // engine may be set up before the block starts (the rundown-building walk; GM's decision D1).
    if (engine === 'not-configured') {
      warnings.push(
        "Radio isn't set up for this show: set it up in Radio distribution before the block starts",
      );
      warningEvents.push(null);
    } else if (engine === 'disabled') {
      warnings.push(
        'Radio is off for this show: turn it on in Radio distribution before the block starts',
      );
      warningEvents.push(null);
    }
    return {
      programId,
      ready: issues.length === 0,
      issues,
      warnings,
      issueEvents,
      warningEvents,
      engine,
    };
  }

  /**
   * Timing warnings for a clocked block, from the times its items name. D5: a block with nothing scheduled after it,
   * on a Manual rotation, goes silent at its end. D6: an unknown-length song before a fixed start may be cut by it.
   * A warning is only given where the times are known: an unknown song length makes the block's end unknown.
   */
  private clockTimingWarnings(
    items: FlightCue[],
    playableSongs: Map<number, { durationMs: number | null }>,
    timing: {
      scheduledAt: Date;
      rotationMode: string | null;
      hasFollowingBlock: boolean;
    },
  ): Array<{ message: string; index: number | null }> {
    const clock = (seconds: number) =>
      new Date(timing.scheduledAt.getTime() + seconds * 1000)
        .toISOString()
        .slice(11, 16);
    const warnings: Array<{ message: string; index: number | null }> = [];
    let cursor = 0;
    let endKnown = true;
    const unknownBefore: boolean[] = [];
    for (const [index, cue] of items.entries()) {
      const start = cue.clockOffsetSeconds ?? cursor;
      if (cue.clockOffsetSeconds !== undefined && unknownBefore.some(Boolean)) {
        warnings.push({
          message: `May be cut by the fixed start at ${clock(cue.clockOffsetSeconds)}.`,
          index,
        });
      }
      let duration: number | null = 0;
      if (cue.songId) {
        const song = playableSongs.get(cue.songId);
        if (song && song.durationMs == null) {
          unknownBefore.push(true);
          duration = null;
        } else {
          duration = song?.durationMs != null ? song.durationMs / 1000 : 0;
        }
      }
      if (duration === null) endKnown = false;
      cursor = start + (duration ?? 0);
    }
    if (
      endKnown &&
      timing.rotationMode === 'manual' &&
      !timing.hasFollowingBlock
    ) {
      warnings.push({
        message: `After this block nothing is scheduled and the rotation is Manual: the station goes silent at ${clock(cursor)}.`,
        index: null,
      });
    }
    return warnings;
  }

  async preflightFlightSequence(programId: string, sequenceId: number) {
    const state = await this.getProgramStateRecord(programId);
    const sequence = await this.prisma.flightSequence.findFirst({
      where: { id: sequenceId, programStateId: state.id },
    });
    if (!sequence) throw new NotFoundException('flight sequence not found');
    if (!sequence.scheduledAt)
      throw new BadRequestException('not a clocked log');
    const [rotation, following] = await Promise.all([
      this.prisma.programState.findUnique({
        where: { programId },
        select: { songSequence: true },
      }),
      this.prisma.flightSequence.findMany({
        where: {
          programStateId: state.id,
          scheduledAt: { gt: sequence.scheduledAt },
        },
        select: { id: true },
        take: 1,
      }),
    ]);
    const rotationMode =
      rotation?.songSequence &&
      typeof (rotation.songSequence as { mode?: unknown }).mode === 'string'
        ? (rotation.songSequence as { mode: string }).mode
        : null;
    return this.preflightClockItems(
      programId,
      normalizeFlightItems(sequence.items),
      {
        scheduledAt: sequence.scheduledAt,
        rotationMode,
        hasFollowingBlock: following.length > 0,
      },
    );
  }

  async publishFlightSequence(
    programId: string,
    sequenceId: number,
    revision: number,
  ) {
    const actor = this.recorder.actor();
    const state = await this.getProgramStateRecord(programId);
    if (state.type !== 'radio' && state.type !== 'both')
      throw new BadRequestException('program has no radio leg');
    const sequence = await this.prisma.flightSequence.findFirst({
      where: { id: sequenceId, programStateId: state.id },
    });
    if (!sequence) throw new NotFoundException('flight sequence not found');
    if (!sequence.scheduledAt || sequence.scheduledAt.getTime() <= Date.now())
      throw new BadRequestException(
        'the scheduled start must be in the future',
      );
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
    const published = this.toFlightSequence(
      await this.prisma.flightSequence.findUniqueOrThrow({
        where: { id: sequenceId },
      }),
    );
    await this.recorder.record({
      actor,
      target: 'flight_sequence',
      targetId: String(sequenceId),
      programId,
      capability: {
        mcp: 'program_publish_flight_sequence_by_id',
        console: 'program.publish-flight-sequence',
      },
      summary: summarizeChange(
        FLIGHT_SEQUENCE_PUBLISH_FIELDS,
        { publishedAt: true, revision: true },
        sequence,
        published,
      ),
    });
    return published;
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
          scheduledAt: {
            gte: new Date(now.getTime() - START_GRACE_MS),
            lte: now,
          },
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
          // A block made from a daypart clock has its own rules; one a person published starts as it always has.
          if (sequence.clockId != null) await this.startDaypartBlock(sequence);
          else await this.activateAndStart(sequence);
        } catch (error) {
          this.metrics.recordRadioLogResult('start-failed');
          // A claimed block never repeats automatically after an ambiguous failure.
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

  private async activateAndStart(sequence: {
    id: number;
    programState: { programId: string };
  }): Promise<void> {
    await this.activateFlightSequence(
      sequence.programState.programId,
      sequence.id,
    );
    await this.start(sequence.programState.programId);
  }

  /**
   * gaulatti/alcantara#124: only a station playing by itself is taken over, so a block made from a clock is skipped
   * in Manual (which off air leaves it in) or while the engine is frozen. A soft start lets the song on air finish.
   */
  private async startDaypartBlock(
    sequence: FlightSequence & { programState: { programId: string } },
  ): Promise<void> {
    const programId = sequence.programState.programId;
    const rotation = this.programService.getRotationOnAir(programId);
    if (
      rotation.frozen ||
      (rotation.mode !== 'autoplay' && rotation.mode !== 'shuffle')
    ) {
      await this.prisma.flightSequence.update({
        where: { id: sequence.id },
        data: { daypartOutcome: 'skipped' },
      });
      this.metrics.recordDaypartBlock('skipped');
      this.programService.broadcastUpdate(programId, {
        type: 'radio_daypart_skipped',
        sequenceId: sequence.id,
      });
      return;
    }
    if (sequence.daypartStart === 'soft' && rotation.songOnAir)
      await this.startAfterSongOnAir(sequence);
    else await this.activateAndStart(sequence);
    this.metrics.recordDaypartBlock('started');
  }

  /**
   * Gives a block the rundown without cutting the song on air: it owns what plays next, so the song's end starts its
   * first cue, and a song still on air after DAYPART_SOFT_WAIT_MS is cut as a hard start would cut it.
   */
  private async startAfterSongOnAir(
    sequence: FlightSequence & { programState: { programId: string } },
  ): Promise<void> {
    const programId = sequence.programState.programId;
    const scheduledAtMs = sequence.scheduledAt!.getTime();
    await this.serializeCueOperation(programId, async () => {
      const previous = this.runtimes.get(programId);
      const runtime: FlightRuntimeState = {
        sequenceId: sequence.id,
        programId,
        items: normalizeFlightItems(sequence.items),
        loop: false,
        // Before the first cue: the end of the song on air advances to it.
        activeIndex: -1,
        isRunning: true,
        generation: Date.now(),
        timer: null,
        waitingForSongEnd: true,
        startedAt: Date.now(),
        scheduledAtMs,
      };
      // In place before anything is awaited: the song on air may end at any moment.
      this.runtimes.set(programId, runtime);
      if (previous) {
        this.clearTimer(previous);
        previous.isRunning = false;
        await this.persistRuntimeState(previous);
      }
      await this.prisma.programState.update({
        where: { programId },
        data: { activeFlightSequenceId: sequence.id },
      });
      await this.persistRuntimeState(runtime);
      await this.broadcastFlightUpdate(programId);
      runtime.timer = setTimeout(
        () => {
          // Still the same block, still waiting.
          if (
            this.runtimes.get(programId) !== runtime ||
            runtime.activeIndex >= 0
          )
            return;
          runtime.waitingForSongEnd = false;
          runtime.generation += 1;
          void this.executeCueAtIndex(programId, 0, runtime.generation);
        },
        Math.max(0, scheduledAtMs + DAYPART_SOFT_WAIT_MS - Date.now()),
      );
    });
    this.programService.reviewAnnouncedSong(programId);
    this.metrics.recordRadioLogResult('started');
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
    if (scheduledAt && items.length)
      await this.refuseOutsideFixedStartWindow(
        state.id,
        null,
        scheduledAt,
        items,
      );

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
            ? 'a radio log already exists for this scheduled start or name'
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
    const actor = this.recorder.actor();
    let previous: Record<string, unknown> | null = null;
    const result = await this.serializeCueOperation(
      this.normalizeProgramId(programId),
      async () => {
        if (actor)
          previous = await this.prisma.flightSequence.findUnique({
            where: { id: sequenceId },
          });
        return this.updateFlightSequenceUnlocked(programId, sequenceId, data);
      },
    );
    await this.recorder.record({
      actor,
      target: 'flight_sequence',
      targetId: String(sequenceId),
      programId: this.normalizeProgramId(programId),
      capability: {
        mcp: 'program_update_flight_sequence_by_id',
        console: 'program.update-flight-sequence',
      },
      summary: summarizeChange(
        FLIGHT_SEQUENCE_CHANGE_FIELDS,
        data,
        previous,
        result,
      ),
    });
    return result;
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
          'a published log cannot change its scheduled start',
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
      // The window is checked only when the cues or the start are written, so an older block still loads and renames.
      if (
        nextScheduledAt &&
        nextItems.length &&
        (data.items !== undefined || data.scheduledAt !== undefined)
      )
        await this.refuseOutsideFixedStartWindow(
          state.id,
          sequenceId,
          nextScheduledAt,
          nextItems,
        );
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
          else if (
            runtime.items[runtime.activeIndex]?.kind === 'instant' &&
            runtime.items[runtime.activeIndex]?.durationMs
          )
            this.armTimedClip(runtime);
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

    if (!existing.scheduledAt || this.runtimes.has(normalizedProgramId))
      await this.stopRuntime(normalizedProgramId, !!existing.scheduledAt);
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

  /** A deleted program: any armed rundown timer is cleared and what was held for it is dropped. */
  removeProgram(programId: string): void {
    const runtime = this.runtimes.get(programId);
    if (runtime) this.clearTimer(runtime);
    this.runtimes.delete(programId);
    this.enginesDown.delete(programId);
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

    if (!sequence.scheduledAt || this.runtimes.has(normalizedProgramId))
      await this.stopRuntime(normalizedProgramId, !!sequence.scheduledAt);

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

  /** `flightDriven`: the flight itself stops (not an operator), keeping the rotation's mode (#173). */
  stop(
    programId: string,
    options: { flightDriven?: boolean } = {},
  ): Promise<{ ok: boolean }> {
    return this.stopRuntime(programId, false, options.flightDriven === true);
  }

  /** `flightDriven`: the flight itself stops the song, keeping the rotation's mode (#173). */
  private async stopRuntime(
    programId: string,
    preserveRotation: boolean,
    flightDriven = false,
  ): Promise<{ ok: boolean }> {
    const normalizedProgramId = this.normalizeProgramId(programId);
    const runtime = this.runtimes.get(normalizedProgramId);

    if (runtime) {
      runtime.waitingForSongEnd = false;
      this.clearTimer(runtime);
    }

    try {
      const state = await this.getProgramStateRecord(normalizedProgramId);
      if (state.activeFlightSequenceId) {
        await this.prisma.flightSequence.update({
          where: { id: state.activeFlightSequenceId },
          data: { isRunning: false },
        });
      }
      try {
        if (preserveRotation)
          await this.programService.stopProgramSongForTimedBlock(
            normalizedProgramId,
          );
        else if (flightDriven)
          await this.programService.takeProgramSongOffAir(normalizedProgramId, {
            flightDriven: true,
          });
        else
          await this.programService.takeProgramSongOffAir(normalizedProgramId);
      } catch (error) {
        if (preserveRotation) throw error;
      }
    } finally {
      // Keep log ownership during the physical cut: a late track-ended event
      // cannot advance the continuous cursor or start a second song.
      if (runtime) runtime.isRunning = false;
      if (this.runtimes.get(normalizedProgramId) === runtime)
        this.runtimes.delete(normalizedProgramId);
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
        'the log cannot advance before its scheduled start',
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
        await this.finishBlock(runtime);
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
    return (
      !!runtime?.isRunning &&
      runtime.scheduledAtMs !== null &&
      Date.now() >= runtime.scheduledAtMs
    );
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
        await this.finishBlock(runtime);
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
    /** Why the song on air is cut for this cue: a fixed start it reached (W3), logged as the song's end reason. */
    cut?: 'fixed_start',
  ): Promise<void> {
    return this.serializeCueOperation(programId, () =>
      cut
        ? this.executeCueAtIndexUnlocked(programId, index, generation, cut)
        : this.executeCueAtIndexUnlocked(programId, index, generation),
    );
  }

  private async executeCueAtIndexUnlocked(
    programId: string,
    index: number,
    generation: number,
    cut?: 'fixed_start',
  ): Promise<void> {
    const runtime = this.runtimes.get(programId);
    if (!runtime || runtime.generation !== generation || !runtime.isRunning) {
      return;
    }

    if (index < 0 || index >= runtime.items.length) {
      if (runtime.loop && runtime.items.length > 0) {
        return this.executeCueAtIndexUnlocked(programId, 0, generation);
      }
      await this.finishBlock(runtime);
      return;
    }

    const cue = runtime.items[index];

    if (
      runtime.scheduledAtMs !== null &&
      cue.clockOffsetSeconds !== undefined
    ) {
      const dueAt = runtime.scheduledAtMs + cue.clockOffsetSeconds * 1000;
      if (dueAt > Date.now()) {
        runtime.timer = setTimeout(
          () => {
            void this.executeCueAtIndex(programId, index, generation);
          },
          Math.min(2_147_483_647, dueAt - Date.now()),
        );
        return;
      }
    }

    runtime.activeIndex = index;
    runtime.waitingForSongEnd = false;
    await this.persistRuntimeState(runtime);
    await this.broadcastFlightUpdate(programId);

    try {
      if (
        runtime.scheduledAtMs !== null &&
        (cue.kind === 'playSong' || (cue.kind === 'instant' && cue.durationMs))
      )
        await (cut
          ? this.programService.stopProgramSongForTimedBlock(programId, cut)
          : this.programService.stopProgramSongForTimedBlock(programId));
      await this.executeCue(programId, cue);
    } catch (err) {
      if (err instanceof AutomationEngineUnavailableError) {
        // Nothing can air until the engine is back: end the block rather than run it silently.
        await this.stop(programId, { flightDriven: true });
        this.programService.broadcastUpdate(programId, {
          type: 'radio_log_cue_failed',
          sequenceId: runtime.sequenceId,
          cueId: cue.id,
          reason: err.reason,
        });
        return;
      }
      console.error(`Flight cue execution failed (${cue.kind})`, err);
      if (runtime.scheduledAtMs !== null) {
        if (
          this.enginesDown.has(programId) ||
          runtime.engineRetry?.index === index
        ) {
          this.holdForEngine(runtime, index, generation);
          return;
        }
        this.metrics.recordRadioLogResult('cue-failed');
        await this.stop(programId, { flightDriven: true });
        this.programService.broadcastUpdate(programId, {
          type: 'radio_log_cue_failed',
          sequenceId: runtime.sequenceId,
          cueId: cue.id,
        });
        return;
      }
    }
    if (runtime.engineRetry) {
      if (runtime.engineRetry.index === index)
        this.metrics.recordRadioLogResult('cue-retried');
      runtime.engineRetry = undefined;
    }

    if (runtime.generation !== generation || !runtime.isRunning) {
      return;
    }

    if (runtime.scheduledAtMs !== null && cue.kind === 'playSong') {
      runtime.waitingForSongEnd = true;
      this.armNextHardCue(runtime);
      return;
    }

    if (
      runtime.scheduledAtMs !== null &&
      cue.kind === 'instant' &&
      cue.durationMs
    ) {
      runtime.cueStartedAt = Date.now();
      this.armTimedClip(runtime);
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

  /**
   * Engine availability as the song engine sees it (#719): it freezes on an outage
   * and calls here on each change. A cue held through the outage is retried as soon
   * as the engine is back, while its grace lasts.
   */
  handleEngineAvailability(programId: string, available: boolean): void {
    if (!available) {
      this.enginesDown.add(programId);
      return;
    }
    this.enginesDown.delete(programId);
    const runtime = this.runtimes.get(programId);
    const retry = runtime?.engineRetry;
    if (!runtime?.isRunning || !retry) return;
    this.clearTimer(runtime);
    void this.executeCueAtIndex(programId, retry.index, runtime.generation);
  }

  /**
   * A timed-block cue failed with the engine unavailable (#719). It waits for the
   * engine: retried when it is back within ENGINE_OUTAGE_GRACE_MS of its due time
   * (a fixed-time cue's clock time, otherwise when it first failed), skipped past it.
   * The block never stops for this.
   */
  private holdForEngine(
    runtime: FlightRuntimeState,
    index: number,
    generation: number,
  ): void {
    const cue = runtime.items[index];
    const dueAt =
      cue.clockOffsetSeconds !== undefined
        ? runtime.scheduledAtMs! + cue.clockOffsetSeconds * 1000
        : runtime.engineRetry?.index === index
          ? runtime.engineRetry.dueAt
          : Date.now();
    runtime.engineRetry = { index, dueAt };
    this.clearTimer(runtime);
    runtime.timer = setTimeout(
      () => {
        const current = this.runtimes.get(runtime.programId);
        if (
          current !== runtime ||
          current.generation !== generation ||
          !current.isRunning ||
          current.engineRetry?.index !== index
        )
          return;
        void this.skipAfterOutage(current, index, generation);
      },
      Math.max(0, dueAt + ENGINE_OUTAGE_GRACE_MS - Date.now()),
    );
  }

  private async skipAfterOutage(
    runtime: FlightRuntimeState,
    index: number,
    generation: number,
  ): Promise<void> {
    const cue = runtime.items[index];
    runtime.engineRetry = undefined;
    runtime.timer = null;
    this.metrics.recordRadioLogResult('cue-skipped');
    if (cue.kind === 'playSong' && typeof cue.songId === 'number') {
      try {
        await this.prisma.asRunRecord.create({
          data: {
            programId: runtime.programId,
            songId: cue.songId,
            state: 'not-aired',
            endReason: 'engine_unavailable',
            at: new Date(),
            // gaulatti/alcantara#726: the rundown shows this cue as skipped, not played.
            flightSequenceId: runtime.sequenceId,
            flightCueId: cue.id,
          },
        });
      } catch (err) {
        this.logger.error(
          `Could not log a skipped cue as not aired for ${runtime.programId}`,
          err,
        );
      }
    }
    this.programService.broadcastUpdate(runtime.programId, {
      type: 'radio_log_cue_skipped',
      sequenceId: runtime.sequenceId,
      cueId: cue.id,
    });
    await this.advance(runtime.programId, generation);
  }

  private armTimedClip(runtime: FlightRuntimeState): void {
    this.clearTimer(runtime);
    const cue = runtime.items[runtime.activeIndex];
    if (
      !cue?.durationMs ||
      runtime.scheduledAtMs === null ||
      runtime.cueStartedAt === undefined
    )
      return;
    const hard = runtime.items.find(
      (item, row) =>
        row > runtime.activeIndex && item.clockOffsetSeconds !== undefined,
    );
    const due = hard
      ? runtime.scheduledAtMs + hard.clockOffsetSeconds! * 1000
      : Infinity;
    const target = runtime.cueStartedAt + cue.durationMs;
    const generation = runtime.generation;
    runtime.timer = setTimeout(
      () => {
        const current = this.runtimes.get(runtime.programId);
        if (
          current !== runtime ||
          current.generation !== generation ||
          !current.isRunning
        )
          return;
        const index =
          due <= target && hard
            ? current.items.findIndex((item) => item.id === hard.id)
            : current.activeIndex + 1;
        if (index <= current.activeIndex) return;
        if (Date.now() < Math.min(target, due)) {
          this.armTimedClip(current);
          return;
        }
        const skipped = this.cuesPassedOver(current, index);
        void (due <= target
          ? this.executeCueAtIndex(
              runtime.programId,
              index,
              generation,
              'fixed_start',
            )
          : this.executeCueAtIndex(runtime.programId, index, generation));
        void this.logCuesSkippedByFixedStart(current, skipped);
      },
      Math.min(2_147_483_647, Math.max(0, Math.min(target, due) - Date.now())),
    );
  }

  /** The cues between the one on air and a fixed start the block jumps to: they never air. */
  private cuesPassedOver(
    runtime: FlightRuntimeState,
    index: number,
  ): FlightCue[] {
    return runtime.items.slice(runtime.activeIndex + 1, index);
  }

  /**
   * The airing walk's W3: a cue a fixed start passed over never aired, but with no as-run row the rundown showed it
   * as played. Each song cue gets a not-aired row naming its cue (`fixed_start`), as an outage skip does (#726). The
   * fixed cue has already been started; a failed write is logged and never holds the block.
   */
  private async logCuesSkippedByFixedStart(
    runtime: FlightRuntimeState,
    cues: FlightCue[],
  ): Promise<void> {
    // Nothing here may reject: the caller does not wait, and the block has already moved on.
    for (const cue of cues) {
      try {
        this.metrics.recordRadioLogResult('cue-skipped');
        this.programService.broadcastUpdate(runtime.programId, {
          type: 'radio_log_cue_skipped',
          sequenceId: runtime.sequenceId,
          cueId: cue.id,
        });
        if (cue.kind === 'playSong' && typeof cue.songId === 'number')
          await this.prisma.asRunRecord.create({
            data: {
              programId: runtime.programId,
              songId: cue.songId,
              state: 'not-aired',
              endReason: 'fixed_start',
              at: new Date(),
              flightSequenceId: runtime.sequenceId,
              flightCueId: cue.id,
            },
          });
      } catch (err) {
        this.logger.error(
          `Could not log a cue passed over by a fixed start as not aired for ${runtime.programId}`,
          err,
        );
      }
    }
  }

  private armNextHardCue(runtime: FlightRuntimeState): void {
    // A block still waiting to start keeps its own wait.
    if (runtime.activeIndex < 0) return;
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
        if (
          Date.now() <
          current.scheduledAtMs! + nextHard.clockOffsetSeconds! * 1000
        ) {
          this.armNextHardCue(current);
          return;
        }
        current.waitingForSongEnd = false;
        current.generation += 1;
        const skipped = this.cuesPassedOver(current, index);
        // The song on air is still playing: the fixed start cuts it.
        void this.executeCueAtIndex(
          current.programId,
          index,
          current.generation,
          'fixed_start',
        );
        void this.logCuesSkippedByFixedStart(current, skipped);
      },
      Math.min(
        2_147_483_647,
        Math.max(
          0,
          runtime.scheduledAtMs +
            nextHard.clockOffsetSeconds! * 1000 -
            Date.now(),
        ),
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
        await this.finishBlock(runtime);
      }
      return;
    }

    await this.executeCueAtIndex(programId, nextIndex, generation);
  }

  private async finishBlock(runtime: FlightRuntimeState): Promise<void> {
    if (runtime.scheduledAtMs === null) {
      await this.stop(runtime.programId, { flightDriven: true });
      return;
    }
    try {
      // Persist the next continuous cursor while the block still owns playout.
      // A concurrent idle snapshot cannot start the interrupted filler again.
      await this.programService.prepareContinuousRotationResume(
        runtime.programId,
      );
      await this.stopRuntime(runtime.programId, true);
      this.programService.resumeContinuousRotation(runtime.programId);
      this.metrics.recordRadioLogResult('completed');
    } catch {
      this.metrics.recordRadioLogResult('resume-failed');
      await this.stop(runtime.programId, { flightDriven: true });
      this.programService.broadcastUpdate(runtime.programId, {
        type: 'radio_rotation_resume_failed',
        sequenceId: runtime.sequenceId,
      });
      this.logger.error(
        'Continuous rotation could not resume after a timed block',
      );
    }
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
        if (this.isClockedLogRunning(programId))
          await this.programService.stopProgramSongForTimedBlock(programId);
        else
          await this.programService.takeProgramSongOffAir(programId, {
            flightDriven: true,
          });
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
      const songDb = await this.programSongDb('cue', programId);
      const song = songDb
        ? await songDb.song.findUnique({ where: { id: cue.songId } })
        : null;
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
    // gaulatti/alcantara#609: with a radio-only program's engine off, a rundown song would only
    // start a local timeline that plays nowhere. It is skipped and logged as not aired instead.
    if (await isRadioOnlyEngineOff(this.prisma, programId)) {
      this.metrics.recordStartRefused('automation_engine_unavailable');
      const runtime = this.runtimes.get(programId);
      await this.prisma.asRunRecord.create({
        data: {
          programId,
          songId: selectedSong.id,
          state: 'not-aired',
          endReason: 'engine_unavailable',
          at: new Date(),
          // gaulatti/alcantara#726: the rundown shows this cue as skipped, not played.
          flightSequenceId: runtime?.sequenceId ?? null,
          flightCueId: runtime ? cue.id : null,
        },
      });
      throw new AutomationEngineUnavailableError();
    }
    if (!this.isClockedLogRunning(programId)) {
      await this.programService.updateProgramAudioBus(
        { songSequence },
        programId,
      );
    }
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
      // Present only on a block made from a daypart clock (gaulatti/alcantara#124).
      ...(seq.clockId != null
        ? {
            daypart: {
              clockId: seq.clockId as number,
              start: seq.daypartStart as string | null,
              outcome: seq.daypartOutcome as string | null,
            },
          }
        : {}),
      updatedAt: seq.updatedAt,
    };
  }
}
