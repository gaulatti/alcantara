import {
  BadRequestException,
  Injectable,
  Logger,
  Inject,
  forwardRef,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { RadioService } from './radio.service';
import { FlightService } from '../program/flight.service';
import { PrismaService } from '../prisma.service';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import {
  RadioMetricsService,
  type SongQueueActionResult,
} from './radio-metrics.service';
import type {
  PalazzoPlaybackState,
  PalazzoProgramStatus,
} from './palazzo-contract';
import {
  activateProgramSongLeaf,
  advanceProgramSongSequence,
  collectHighRotationProgramSongLeaves,
  collectProgramSongLeaves,
  findUniqueProgramSongLeafById,
  findUniqueProgramSongLeafByAudioUrl,
  normalizeProgramSongSequence,
  resolveProgramSongLeaf,
  type ProgramSongSequence,
  type ProgramResolvedSongLeaf,
} from './song-sequence.utils';
import {
  MAX_PROGRAM_SONG_QUEUE_LENGTH,
  normalizeProgramSongQueue,
  type ProgramSongQueueEntry,
} from './song-queue.utils';
import {
  getHighRotationEligibility,
  normalizeProgramSongRotation,
  recordHighRotationPlay,
  selectHighRotationCandidate,
  type ProgramSongRotationState,
} from './song-rotation.utils';

export interface SongPlaybackData {
  token: string;
  audioUrl: string;
  title: string;
  artist: string;
  coverUrl: string;
  durationMs: number;
  isPlaying: boolean;
  positionMs: number;
  progress: number;
  startedAt: string;
  updatedAt: string;
  telemetryStale: boolean;
  introStatus: IntroPlaybackStatus;
  introFailureReason: string | null;
  queueEntryId: string | null;
}

export type IntroPlaybackStatus =
  | 'none'
  | 'pending'
  | 'playing'
  | 'completed'
  | 'degraded';

export type SongEngineEvent =
  | { type: 'playback_update'; programId: string; playback: SongPlaybackData }
  | {
      type: 'song_playback_active';
      programId: string;
      playback: SongPlaybackData;
    }
  | { type: 'song_off_air'; programId: string; triggeredAt: string }
  | {
      type: 'song_queue_update';
      programId: string;
      songQueue: ProgramSongQueueEntry[];
      songSequence?: ProgramSongSequence | null;
    }
  | {
      type: 'radio_leg_status';
      programId: string;
      status: PalazzoProgramStatus;
    }
  | {
      type: 'audio_levels';
      programId: string;
      levels: PalazzoPlaybackState['levels'];
      sampledAt: string;
    };

export type SongEngineBroadcastFn = (event: SongEngineEvent) => void;

/** Subset of Palazzo telemetry knowledge the engine needs to gate playback. */
export interface PalazzoTelemetrySource {
  isReconciled(programId: string): boolean;
}

interface ActiveSong {
  token: string;
  playbackRequestId: string;
  audioUrl: string;
  artist: string;
  title: string;
  coverUrl: string;
  durationMs: number;
  startedAt: number;
  itemId: string;
  songId: number | null;
  introPlaybackId: string | null;
  introStatus: IntroPlaybackStatus;
  introFailureReason: string | null;
  authoritativeStartedAt: number | null;
  authoritativePositionMs: number | null;
  authoritativeUpdatedAt: number | null;
  queueEntryId: string | null;
  highRotation: boolean;
}

interface SongEngineState {
  sequence: ProgramSongSequence | null;
  queue: ProgramSongQueueEntry[];
  rotation: ProgramSongRotationState;
  rotationHistoryHealthy: boolean;
  activeSong: ActiveSong | null;
  pendingRequestIds: Set<string>;
  endedRequestIds: string[];
  /** Duration timer kept only for TV-only programs without Palazzo telemetry. */
  timer: ReturnType<typeof setTimeout> | null;
  progressInterval: ReturnType<typeof setInterval> | null;
  songCount: number;
  nextBumperIdx: number;
  frozen: boolean;
  reconciled: boolean;
  busyWithForeignTrack: boolean;
  lastIdleSequence: number | null;
  transitioning: boolean;
  queueBlocked: boolean;
}

const MAX_ENDED_REQUEST_IDS = 128;
const RADIO_PROGRAM_TYPES = new Set(['radio', 'both']);

/**
 * Drives radio automation from authoritative Palazzo playback state.
 *
 * Song completion is only ever triggered by a Palazzo `track.ended` event (or
 * an authoritative idle snapshot after a reconnect) whose playback request ID
 * matches the command this engine issued. Estimated media duration is used
 * solely to interpolate UI progress between authoritative updates.
 */
@Injectable()
export class SongExecutionEngine implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SongExecutionEngine.name);
  private readonly states = new Map<string, SongEngineState>();
  private broadcast: SongEngineBroadcastFn | null = null;
  private telemetry: PalazzoTelemetrySource | null = null;
  private readonly radioProgramIds = new Set<string>();
  private readonly queueMutationLocks = new Map<string, Promise<void>>();
  private readonly rotationMutationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly radioService: RadioService,
    @Inject(forwardRef(() => FlightService))
    private readonly flightService: FlightService,
    private readonly prisma: PrismaService,
    private readonly nowPlayingPublisherService: NowPlayingPublisherService,
    @Inject(forwardRef(() => RadioMetricsService))
    private readonly metrics: RadioMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const settings = await this.prisma.radioSettings.findMany({
      where: { enabled: true },
      select: {
        palazzoUrl: true,
        programState: {
          select: {
            programId: true,
            type: true,
            songSequence: true,
            songQueue: true,
            songRotation: true,
          },
        },
      },
    });
    for (const s of settings) {
      const pid = s.programState.programId;
      if (!s.palazzoUrl) continue;
      if (!RADIO_PROGRAM_TYPES.has(s.programState.type)) continue;
      const seq = normalizeProgramSongSequence(s.programState.songSequence);
      this.radioProgramIds.add(pid);
      const state = this.ensureState(pid);
      state.sequence = seq;
      state.queue = normalizeProgramSongQueue(s.programState.songQueue);
      state.rotation = normalizeProgramSongRotation(
        s.programState.songRotation,
      );
      this.updateQueueDepthMetric();
      if (
        !seq ||
        (seq.mode !== 'autoplay' && seq.mode !== 'shuffle') ||
        !seq.items.length
      )
        continue;
      seq.startedAt = Date.now();
      this.logger.log(
        `Booting ${pid}, mode=${seq.mode}, awaiting Palazzo snapshot`,
      );
    }
    this.updateHighRotationFavoriteMetric();
  }

  onModuleDestroy(): void {
    for (const programId of this.states.keys()) {
      this.clearTimer(programId);
      this.stopProgress(programId);
    }
  }

  /** Registered by the telemetry supervisor for every radio-capable program. */
  registerRadioProgram(programId: string): void {
    this.radioProgramIds.add(programId);
    this.updateHighRotationFavoriteMetric();
  }

  private isRadioCapable(programId: string): boolean {
    return this.radioProgramIds.has(programId);
  }

  private ensureState(programId: string): SongEngineState {
    let s = this.states.get(programId);
    if (!s) {
      s = {
        sequence: null,
        queue: [],
        rotation: normalizeProgramSongRotation(null),
        rotationHistoryHealthy: true,
        activeSong: null,
        pendingRequestIds: new Set<string>(),
        endedRequestIds: [],
        timer: null,
        progressInterval: null,
        songCount: 0,
        nextBumperIdx: 0,
        frozen: false,
        reconciled: false,
        busyWithForeignTrack: false,
        lastIdleSequence: null,
        transitioning: false,
        queueBlocked: false,
      };
      this.states.set(programId, s);
    }
    return s;
  }

  setBroadcastHandler(handler: SongEngineBroadcastFn): void {
    this.broadcast = handler;
  }

  setPalazzoTelemetry(source: PalazzoTelemetrySource): void {
    this.telemetry = source;
  }

  handleSequenceUpdated(programId: string, rawSequence: unknown): void {
    const seq = normalizeProgramSongSequence(rawSequence);
    const state = this.ensureState(programId);
    if (state.activeSong && state.sequence?.startedAt && seq)
      seq.startedAt = state.sequence.startedAt;
    state.sequence = seq;
    this.updateHighRotationFavoriteMetric();
    if (
      seq &&
      (seq.mode === 'autoplay' || seq.mode === 'shuffle') &&
      seq.items.length &&
      !state.activeSong &&
      !state.pendingRequestIds.size
    ) {
      this.maybeStartSequence(programId);
    }
  }

  handleQueueUpdated(programId: string, rawQueue: unknown): void {
    const state = this.ensureState(programId);
    state.queue = normalizeProgramSongQueue(rawQueue);
    state.queueBlocked = false;
    this.updateQueueDepthMetric();
    if (
      state.queue.length &&
      state.sequence &&
      (state.sequence.mode === 'autoplay' || state.sequence.mode === 'shuffle')
    ) {
      this.maybeStartSequence(programId);
    }
  }

  async enqueueSong(
    programId: string,
    itemId: string,
  ): Promise<ProgramSongQueueEntry[]> {
    return this.withQueueMutationLock(programId, async () => {
      try {
        const normalizedItemId = itemId.trim();
        if (!normalizedItemId) {
          throw new BadRequestException('itemId is required');
        }
        const persisted = await this.readQueueState(programId);
        const sequence = normalizeProgramSongSequence(persisted.songSequence);
        const song = findUniqueProgramSongLeafById(sequence, normalizedItemId);
        if (!song?.audioUrl) {
          throw new BadRequestException(
            'Queued song must reference one playable playlist item',
          );
        }
        const queue = normalizeProgramSongQueue(persisted.songQueue);
        if (queue.length >= MAX_PROGRAM_SONG_QUEUE_LENGTH) {
          throw new BadRequestException(
            `Play Next queue is limited to ${MAX_PROGRAM_SONG_QUEUE_LENGTH} entries`,
          );
        }
        const nextQueue = [
          ...queue,
          {
            id: randomUUID(),
            itemId: normalizedItemId,
            enqueuedAt: Date.now(),
          },
        ];
        await this.persistQueue(programId, nextQueue);
        this.applyPersistedQueue(programId, nextQueue, 'enqueued');
        return nextQueue;
      } catch (error) {
        this.recordQueueMutationFailure(error);
        throw error;
      }
    });
  }

  async removeQueuedSong(
    programId: string,
    entryId: string,
  ): Promise<ProgramSongQueueEntry[]> {
    return this.withQueueMutationLock(programId, async () => {
      try {
        const normalizedEntryId = entryId.trim();
        if (!normalizedEntryId) {
          throw new BadRequestException('queue entry ID is required');
        }
        const persisted = await this.readQueueState(programId);
        const queue = normalizeProgramSongQueue(persisted.songQueue);
        if (queue.find((entry) => entry.id === normalizedEntryId)?.active) {
          throw new BadRequestException(
            'The playing queue entry cannot be removed before it ends',
          );
        }
        const nextQueue = queue.filter(
          (entry) => entry.id !== normalizedEntryId,
        );
        if (nextQueue.length === queue.length) {
          throw new NotFoundException('Queued song not found');
        }
        await this.persistQueue(programId, nextQueue);
        this.applyPersistedQueue(programId, nextQueue, 'removed');
        return nextQueue;
      } catch (error) {
        this.recordQueueMutationFailure(error);
        throw error;
      }
    });
  }

  async reorderSongQueue(
    programId: string,
    entryIds: string[],
  ): Promise<ProgramSongQueueEntry[]> {
    return this.withQueueMutationLock(programId, async () => {
      try {
        if (
          !Array.isArray(entryIds) ||
          entryIds.some((id) => typeof id !== 'string')
        ) {
          throw new BadRequestException(
            'entryIds must be an array of queue entry IDs',
          );
        }
        const persisted = await this.readQueueState(programId);
        const queue = normalizeProgramSongQueue(persisted.songQueue);
        const normalizedIds = entryIds.map((id) => id.trim());
        const requested = new Set(normalizedIds);
        const activeQueueEntryId =
          queue.find((entry) => entry.active)?.id ??
          this.states.get(programId)?.activeSong?.queueEntryId ??
          null;
        if (
          normalizedIds.some((id) => !id) ||
          requested.size !== normalizedIds.length ||
          normalizedIds.length !== queue.length ||
          queue.some((entry) => !requested.has(entry.id))
        ) {
          throw new BadRequestException(
            'entryIds must contain every queued entry exactly once',
          );
        }
        if (activeQueueEntryId && normalizedIds[0] !== activeQueueEntryId) {
          throw new BadRequestException(
            'The playing queue entry must remain first until it ends',
          );
        }
        const byId = new Map(queue.map((entry) => [entry.id, entry]));
        const nextQueue = normalizedIds.map((id) => byId.get(id)!);
        await this.persistQueue(programId, nextQueue);
        this.applyPersistedQueue(programId, nextQueue, 'reordered');
        return nextQueue;
      } catch (error) {
        this.recordQueueMutationFailure(error);
        throw error;
      }
    });
  }

  private async withQueueMutationLock<T>(
    programId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.queueMutationLocks.get(programId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.queueMutationLocks.set(programId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.queueMutationLocks.get(programId) === tail) {
        this.queueMutationLocks.delete(programId);
      }
    }
  }

  private async readQueueState(programId: string): Promise<{
    type: string;
    songSequence: unknown;
    songQueue: unknown;
  }> {
    const state = await this.prisma.programState.findUnique({
      where: { programId },
      select: { type: true, songSequence: true, songQueue: true },
    });
    if (!state) throw new NotFoundException('Program not found');
    if (!RADIO_PROGRAM_TYPES.has(state.type)) {
      throw new BadRequestException(
        'Play Next is available only for Radio and Simulcast programs',
      );
    }
    return state;
  }

  private async persistQueue(
    programId: string,
    queue: ProgramSongQueueEntry[],
  ): Promise<void> {
    await this.prisma.programState.update({
      where: { programId },
      data: { songQueue: queue as unknown as Prisma.InputJsonValue },
    });
  }

  private applyPersistedQueue(
    programId: string,
    queue: ProgramSongQueueEntry[],
    result: SongQueueActionResult,
    songSequence?: ProgramSongSequence | null,
  ): void {
    const state = this.ensureState(programId);
    state.queue = queue;
    state.queueBlocked = false;
    this.metrics.recordSongQueueAction(result);
    this.updateQueueDepthMetric();
    this.emit({
      type: 'song_queue_update',
      programId,
      songQueue: queue,
      ...(songSequence !== undefined ? { songSequence } : {}),
    });
    if (
      queue.length &&
      state.sequence &&
      (state.sequence.mode === 'autoplay' || state.sequence.mode === 'shuffle')
    ) {
      this.maybeStartSequence(programId);
    }
  }

  private async claimQueueHead(
    programId: string,
    entryId: string,
    playbackRequestId: string,
  ): Promise<boolean> {
    return this.withQueueMutationLock(programId, async () => {
      const persisted = await this.readQueueState(programId);
      const queue = normalizeProgramSongQueue(persisted.songQueue);
      const head = queue[0] ?? null;
      if (!head || head.id !== entryId) {
        this.handleQueueUpdated(programId, queue);
        return false;
      }
      if (head.active) {
        this.handleQueueUpdated(programId, queue);
        return head.playbackRequestId === playbackRequestId;
      }
      const nextQueue = [
        { ...head, active: true, playbackRequestId },
        ...queue.slice(1),
      ];
      await this.persistQueue(programId, nextQueue);
      this.applyPersistedQueue(programId, nextQueue, 'claimed');
      return true;
    });
  }

  private async releaseQueueClaim(
    programId: string,
    entryId: string,
  ): Promise<void> {
    await this.withQueueMutationLock(programId, async () => {
      const persisted = await this.readQueueState(programId);
      const queue = normalizeProgramSongQueue(persisted.songQueue);
      const claimedEntry = queue.find((entry) => entry.id === entryId);
      if (!claimedEntry?.active) {
        this.handleQueueUpdated(programId, queue);
        return;
      }
      const nextQueue = queue.map((entry) =>
        entry.id === entryId
          ? {
              id: entry.id,
              itemId: entry.itemId,
              enqueuedAt: entry.enqueuedAt,
            }
          : entry,
      );
      await this.persistQueue(programId, nextQueue);
      this.applyPersistedQueue(programId, nextQueue, 'released');
    });
  }

  private releaseQueueClaimAfterPlaybackStops(
    programId: string,
    entryId: string,
    blockQueueAfterRelease = false,
  ): void {
    const state = this.states.get(programId);
    if (state) state.transitioning = true;
    void this.releaseQueueClaim(programId, entryId)
      .then(() => {
        const nextState = this.states.get(programId);
        if (nextState) {
          nextState.transitioning = false;
          nextState.queueBlocked = blockQueueAfterRelease;
        }
      })
      .catch((error) => {
        this.blockQueueAfterPersistenceFailure(programId, error, false);
      });
  }

  private updateQueueDepthMetric(): void {
    let depth = 0;
    for (const programId of this.radioProgramIds) {
      depth += this.states.get(programId)?.queue.length ?? 0;
    }
    this.metrics.recordSongQueueDepth(depth);
  }

  private updateHighRotationFavoriteMetric(): void {
    let favorites = 0;
    for (const programId of this.radioProgramIds) {
      favorites += collectHighRotationProgramSongLeaves(
        this.states.get(programId)?.sequence ?? null,
      ).length;
    }
    this.metrics.recordHighRotationFavorites(favorites);
  }

  private async withRotationMutationLock<T>(
    programId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.rotationMutationLocks.get(programId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.rotationMutationLocks.set(programId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.rotationMutationLocks.get(programId) === tail) {
        this.rotationMutationLocks.delete(programId);
      }
    }
  }

  private recordHighRotationStarted(
    programId: string,
    state: SongEngineState,
    song: ActiveSong,
    playedAt: number,
  ): void {
    if (!song.highRotation || !song.itemId) return;
    const recorded = recordHighRotationPlay(
      state.rotation,
      { id: song.itemId, songId: song.songId ?? undefined },
      song.playbackRequestId,
      playedAt,
    );
    state.rotation = recorded.state;
    if (!recorded.added) return;

    void this.withRotationMutationLock(programId, async () => {
      try {
        const current = this.states.get(programId);
        if (!current) return;
        await this.prisma.programState.update({
          where: { programId },
          data: {
            songRotation: current.rotation as unknown as Prisma.InputJsonValue,
          },
        });
        current.rotationHistoryHealthy = true;
        this.metrics.recordHighRotationAction('played');
      } catch (error) {
        const current = this.states.get(programId);
        if (current) current.rotationHistoryHealthy = false;
        this.metrics.recordHighRotationAction('history-persistence-failed');
        this.logger.error(
          `High rotation history persistence failed on ${programId}; automatic favorites are suspended: ${String(error)}`,
        );
      }
    });
  }

  private recordQueueMutationFailure(error: unknown): void {
    this.metrics.recordSongQueueAction(
      error instanceof BadRequestException || error instanceof NotFoundException
        ? 'rejected'
        : 'persistence-failed',
    );
  }

  handleManualSong(
    programId: string,
    audioUrl: string,
    title?: string,
    artist?: string,
    durationMs?: number,
    coverUrl?: string,
    songId?: number,
  ): void {
    const state = this.ensureState(programId);
    const playlistSong = findUniqueProgramSongLeafByAudioUrl(
      state.sequence,
      audioUrl,
    );
    const dur =
      typeof durationMs === 'number' && durationMs > 0 ? durationMs : 300000;
    const playbackRequestId = randomUUID();
    state.pendingRequestIds.add(playbackRequestId);
    state.activeSong = {
      token: `${Date.now()}:${audioUrl}`,
      playbackRequestId,
      audioUrl,
      artist: artist || '',
      title: title || '',
      coverUrl: coverUrl || '',
      durationMs: dur,
      startedAt: Date.now(),
      itemId: playlistSong?.id ?? '',
      songId:
        Number.isInteger(songId) && (songId as number) > 0 ? songId! : null,
      introPlaybackId: null,
      introStatus: 'none',
      introFailureReason: null,
      authoritativeStartedAt: null,
      authoritativePositionMs: null,
      authoritativeUpdatedAt: null,
      queueEntryId: null,
      highRotation: playlistSong?.highRotation === true,
    };
    this.emitPlaybackActive(programId, state.activeSong);
    void this.publishNowPlaying(programId, state.activeSong);
    this.startProgress(programId);
    if (!this.isRadioCapable(programId)) {
      // TV-only programs have no Palazzo telemetry; preserve their legacy
      // estimated-duration completion behavior.
      this.setTimer(programId, dur);
    }
    void this.pushCommand(
      programId,
      playbackRequestId,
      audioUrl,
      title,
      artist,
      coverUrl,
      Number.isInteger(songId) && (songId as number) > 0 ? songId : undefined,
    );
  }

  handleSongEnded(programId: string): void {
    void this.flightService.handleSongEnded(programId);
  }

  handleStopSong(programId: string): void {
    const state = this.states.get(programId);
    if (!state) {
      void this.nowPlayingPublisherService.publishStopped(programId);
      return;
    }
    const stoppedQueueEntryId = state.activeSong?.queueEntryId ?? null;
    this.clearTimer(programId);
    this.stopProgress(programId);
    state.activeSong = null;
    state.pendingRequestIds.clear();
    state.busyWithForeignTrack = false;
    state.transitioning = false;
    this.emit({
      type: 'song_off_air',
      programId,
      triggeredAt: new Date().toISOString(),
    });
    void this.nowPlayingPublisherService.publishStopped(programId);
    if (stoppedQueueEntryId) {
      this.releaseQueueClaimAfterPlaybackStops(programId, stoppedQueueEntryId);
    }
  }

  getPlaybackState(programId: string): SongPlaybackData | null {
    const s = this.states.get(programId)?.activeSong;
    return s ? this.playbackData(programId, s) : null;
  }

  // ---------------------------------------------------------------------
  // Palazzo telemetry entry points
  // ---------------------------------------------------------------------

  handlePalazzoStatus(programId: string, status: PalazzoProgramStatus): void {
    if (!this.isRadioCapable(programId)) return;
    const state = this.ensureState(programId);
    const unavailable =
      status.connection === 'unavailable' ||
      status.connection === 'instance-mismatch' ||
      status.connection === 'instance-conflict';
    if (unavailable && !state.frozen) {
      state.frozen = true;
      this.logger.warn(
        `Freezing radio automation for ${programId}: Palazzo ${status.connection}`,
      );
    } else if (!unavailable && state.frozen) {
      state.frozen = false;
      state.reconciled = false;
      this.logger.log(`Unfreezing radio automation for ${programId}`);
    }
    this.emit({ type: 'radio_leg_status', programId, status });
  }

  handlePalazzoSnapshot(
    programId: string,
    snapshot: PalazzoPlaybackState,
  ): void {
    if (!this.isRadioCapable(programId)) return;
    const state = this.ensureState(programId);
    state.reconciled = true;
    state.frozen = false;

    if (snapshot.status === 'playing' && snapshot.track) {
      this.reconcilePlayingSnapshot(programId, state, snapshot);
    } else {
      this.reconcileIdleSnapshot(programId, state, snapshot);
    }
  }

  handlePalazzoEvent(
    programId: string,
    event:
      | {
          type: 'track.started';
          data: {
            playbackRequestId: string;
            title?: string | null;
            artist?: string | null;
            coverUrl?: string | null;
            url?: string;
          };
        }
      | {
          type: 'track.ended';
          data: {
            playbackRequestId: string;
            title?: string | null;
            artist?: string | null;
            coverUrl?: string | null;
            url?: string;
          };
        }
      | {
          type: 'playback.position';
          data: {
            playbackRequestId?: string | null;
            positionSeconds?: number;
            remainingSeconds?: number | null;
            status?: string;
          };
        }
      | {
          type: 'audio.levels';
          data: PalazzoPlaybackState['levels'];
        }
      | {
          type: 'intro.started' | 'intro.ended' | 'intro.failed';
          data: {
            programId: string;
            playbackId: string;
            parentPlaybackId: string;
            failureReason?: string;
            reason?: string;
          };
        },
  ): void {
    if (!this.isRadioCapable(programId)) return;
    const state = this.states.get(programId);
    if (!state) return;

    if (event.type === 'audio.levels') {
      this.emit({
        type: 'audio_levels',
        programId,
        levels: event.data,
        sampledAt: new Date().toISOString(),
      });
      return;
    }

    if (event.type === 'playback.position') {
      this.applyAuthoritativePosition(programId, state, event.data);
      return;
    }

    if (
      event.type === 'intro.started' ||
      event.type === 'intro.ended' ||
      event.type === 'intro.failed'
    ) {
      this.handleIntroEvent(programId, state, event);
      return;
    }

    const requestId =
      'playbackRequestId' in event.data &&
      typeof event.data.playbackRequestId === 'string'
        ? event.data.playbackRequestId
        : '';

    if (event.type === 'track.started') {
      const activeSong = state.activeSong;
      if (activeSong?.playbackRequestId === requestId) {
        // The command is no longer pending once Palazzo confirms playback.
        // Leaving successful request IDs here permanently blocks the next
        // automatic song because maybeStartSequence treats any pending ID as
        // an in-flight command.
        state.pendingRequestIds.delete(requestId);
        if (!activeSong.coverUrl && typeof event.data.coverUrl === 'string') {
          activeSong.coverUrl = event.data.coverUrl;
        }
        activeSong.authoritativeStartedAt = Date.now();
        activeSong.authoritativePositionMs = 0;
        activeSong.authoritativeUpdatedAt = Date.now();
        this.metrics.recordTrackTransition('adopted');
        this.recordHighRotationStarted(
          programId,
          state,
          activeSong,
          activeSong.authoritativeStartedAt,
        );
        this.emitPlaybackUpdate(programId, activeSong);
      } else if (state.pendingRequestIds.has(requestId)) {
        // A command is confirmed before the engine optimistically activated it.
        this.metrics.recordTrackTransition('adopted');
      } else {
        this.metrics.recordTrackTransition('ignored-mismatch');
      }
      return;
    }

    // track.ended
    this.handleAuthoritativeTrackEnded(programId, state, requestId);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private reconcilePlayingSnapshot(
    programId: string,
    state: SongEngineState,
    snapshot: PalazzoPlaybackState,
  ): void {
    const requestId = snapshot.track?.playbackRequestId ?? '';
    if (state.activeSong && state.activeSong.playbackRequestId === requestId) {
      const song = state.activeSong;
      this.reconcileIntroSnapshot(song, snapshot);
      if (!song.coverUrl && snapshot.track?.coverUrl) {
        song.coverUrl = snapshot.track.coverUrl;
      }
      const startedAt = Date.parse(snapshot.track?.startedAt ?? '');
      if (Number.isFinite(startedAt)) {
        song.authoritativeStartedAt = startedAt;
      }
      song.authoritativePositionMs = Math.round(
        snapshot.positionSeconds * 1000,
      );
      song.authoritativeUpdatedAt = Date.now();
      state.busyWithForeignTrack = false;
      this.emitPlaybackUpdate(programId, song);
      return;
    }

    if (state.pendingRequestIds.has(requestId)) {
      // Palazzo confirms a command the engine has not correlated yet. Adopt it
      // if there is no newer active song.
      if (!state.activeSong) {
        this.logger.log(
          `Adopting confirmed Palazzo playback ${requestId} on ${programId} from snapshot`,
        );
      }
      state.pendingRequestIds.delete(requestId);
      state.busyWithForeignTrack = false;
      return;
    }

    const inheritedSong = findUniqueProgramSongLeafByAudioUrl(
      state.sequence,
      snapshot.track?.url ?? '',
    );
    if (requestId && inheritedSong?.audioUrl) {
      const inheritedQueueEntry =
        state.queue[0]?.active === true &&
        state.queue[0].playbackRequestId === requestId &&
        state.queue[0].itemId === inheritedSong.id
          ? state.queue[0]
          : null;
      const positionMs = Math.max(
        0,
        Math.round(snapshot.positionSeconds * 1000),
      );
      const parsedStartedAt = Date.parse(snapshot.track?.startedAt ?? '');
      const authoritativeStartedAt = Number.isFinite(parsedStartedAt)
        ? parsedStartedAt
        : Date.now() - positionMs;
      state.activeSong = {
        token: `${inheritedSong.id}:${inheritedSong.audioUrl}`,
        playbackRequestId: requestId,
        audioUrl: inheritedSong.audioUrl,
        artist: snapshot.track?.artist || inheritedSong.artist,
        title: snapshot.track?.title || inheritedSong.title,
        coverUrl: snapshot.track?.coverUrl || inheritedSong.coverUrl,
        durationMs: inheritedSong.durationMs ?? 300000,
        startedAt: authoritativeStartedAt,
        itemId: inheritedSong.id,
        songId: inheritedSong.songId ?? null,
        introPlaybackId: snapshot.intro?.playbackId ?? null,
        introStatus:
          snapshot.intro?.status === 'playing'
            ? 'playing'
            : snapshot.intro?.status === 'failed'
              ? 'degraded'
              : 'none',
        introFailureReason: this.boundedFailureReason(
          snapshot.intro?.failureReason,
        ),
        authoritativeStartedAt,
        authoritativePositionMs: positionMs,
        authoritativeUpdatedAt: Date.now(),
        queueEntryId: inheritedQueueEntry?.id ?? null,
        highRotation: inheritedSong.highRotation === true,
      };
      state.busyWithForeignTrack = false;
      this.logger.log(
        `Adopted inherited Palazzo playback ${requestId} on ${programId}`,
      );
      this.metrics.recordTrackTransition('adopted');
      this.recordHighRotationStarted(
        programId,
        state,
        state.activeSong,
        authoritativeStartedAt,
      );
      this.emitPlaybackActive(programId, state.activeSong);
      void this.publishNowPlaying(programId, state.activeSong);
      this.startProgress(programId);
      return;
    }

    // A track we did not command is playing. Never advance or publish
    // anything from foreign playback; just avoid double audio.
    if (!state.busyWithForeignTrack) {
      state.busyWithForeignTrack = true;
      this.logger.warn(
        `Palazzo reports a foreign track on ${programId}; withholding new commands`,
      );
    }
  }

  private reconcileIdleSnapshot(
    programId: string,
    state: SongEngineState,
    snapshot: PalazzoPlaybackState,
  ): void {
    const requestId = state.activeSong?.playbackRequestId ?? null;

    if (requestId && state.activeSong) {
      // Authoritative idle state while we believe our song is active: the
      // song ended without a lifecycle event reaching us (e.g. SSE loss).
      this.handleAuthoritativeTrackEnded(programId, state, requestId);
      return;
    }

    if (state.pendingRequestIds.size) {
      // Commands never started. Drop them and let recovery decide.
      state.pendingRequestIds.clear();
    }

    state.busyWithForeignTrack = false;
    state.lastIdleSequence = snapshot.sequence;

    // An idle authoritative snapshot is also the recovery boundary after a
    // restart adopted an already-playing track as foreign. Auto modes may
    // resume here; manual mode remains an explicit operator boundary.
    this.maybeStartSequence(programId);
  }

  private handleAuthoritativeTrackEnded(
    programId: string,
    state: SongEngineState,
    requestId: string,
  ): void {
    if (!requestId) {
      this.metrics.recordTrackTransition('ignored-mismatch');
      return;
    }
    if (state.endedRequestIds.includes(requestId)) {
      this.metrics.recordTrackTransition('ignored-duplicate');
      return;
    }
    state.endedRequestIds.push(requestId);
    if (state.endedRequestIds.length > MAX_ENDED_REQUEST_IDS) {
      state.endedRequestIds.shift();
    }

    if (state.frozen) {
      // Palazzo is unavailable; never advance on a stale event.
      this.metrics.recordTrackTransition('ignored-frozen');
      return;
    }

    if (!state.activeSong || state.activeSong.playbackRequestId !== requestId) {
      state.pendingRequestIds.delete(requestId);
      this.metrics.recordTrackTransition('ignored-no-active');
      if (!state.activeSong && state.busyWithForeignTrack) {
        state.busyWithForeignTrack = false;
        this.logger.warn(
          `Foreign track ended on ${programId}; awaiting an authoritative idle snapshot`,
        );
      }
      return;
    }

    this.metrics.recordTrackTransition('advanced');
    this.handleSongEnded(programId);
    const endedSong = state.activeSong;
    state.activeSong = null;
    // An authoritative end is a command-reconciliation boundary. Palazzo is
    // idle, so no older command can still legitimately be pending.
    state.pendingRequestIds.clear();
    state.songCount++;
    state.busyWithForeignTrack = false;
    const nextSequence = state.sequence
      ? normalizeProgramSongSequence(state.sequence)
      : null;
    const isAutomatic =
      nextSequence?.mode === 'autoplay' || nextSequence?.mode === 'shuffle';
    const hasSuccessor = endedSong.queueEntryId
      ? Boolean(isAutomatic && resolveProgramSongLeaf(nextSequence))
      : Boolean(
          isAutomatic &&
          nextSequence &&
          advanceProgramSongSequence(nextSequence, endedSong.itemId),
        );
    state.transitioning = true;
    this.logger.log(
      `Authoritative end on ${programId}: source=${endedSong.queueEntryId ? 'queue' : 'playlist'} mode=${nextSequence?.mode ?? 'none'} loop=${nextSequence?.loop ?? false} cursor=${nextSequence?.activeItemId ?? 'none'} successor=${hasSuccessor}`,
    );
    void this.continueAfterAuthoritativeEnd(
      programId,
      endedSong.queueEntryId,
      nextSequence,
      hasSuccessor,
    );
  }

  private async continueAfterAuthoritativeEnd(
    programId: string,
    endedQueueEntryId: string | null,
    nextSequence: ProgramSongSequence | null,
    hasSequenceSuccessor: boolean,
  ): Promise<void> {
    let cursorPersisted = false;
    try {
      if (endedQueueEntryId) {
        await this.withQueueMutationLock(programId, async () => {
          const persisted = await this.readQueueState(programId);
          const queue = normalizeProgramSongQueue(persisted.songQueue);
          const nextQueue = queue.filter(
            (entry) => entry.id !== endedQueueEntryId,
          );
          await this.persistQueue(programId, nextQueue);
          this.applyPersistedQueue(programId, nextQueue, 'consumed');
        });
      } else {
        const state = this.states.get(programId);
        if (state) state.sequence = nextSequence;
        if (state?.queue.length && nextSequence) {
          await this.persistPlaylistCursorForQueue(programId, nextSequence);
          cursorPersisted = true;
        }
      }
    } catch (error) {
      this.blockQueueAfterPersistenceFailure(programId, error);
      return;
    }

    await this.maybeBumper(programId);
    const state = this.states.get(programId);
    if (!state || state.activeSong || state.frozen) return;

    if (state.queue.length) {
      try {
        if (!endedQueueEntryId && !cursorPersisted && nextSequence) {
          await this.persistPlaylistCursorForQueue(programId, nextSequence);
        }
      } catch (error) {
        this.blockQueueAfterPersistenceFailure(programId, error);
        return;
      }
      state.transitioning = false;
      if (this.playNext(programId)) return;
      state.queueBlocked = true;
      this.logger.error(
        `Queued playlist item could not be resolved on ${programId}; stopping without falling through`,
      );
      this.publishStopped(programId);
      return;
    }

    state.transitioning = false;
    if (
      state.sequence &&
      hasSequenceSuccessor &&
      (state.sequence.mode === 'autoplay' || state.sequence.mode === 'shuffle')
    ) {
      // This callback originates from an authoritative Palazzo end event;
      // the general reconciliation/pending guards have already been
      // satisfied above. Dispatch the resolved successor directly.
      if (this.playNext(programId)) return;
      this.logger.error(
        `Successor could not be resolved on ${programId}: cursor=${state.sequence.activeItemId ?? 'none'}`,
      );
    }

    this.publishStopped(programId);
  }

  private async persistPlaylistCursorForQueue(
    programId: string,
    sequence: ProgramSongSequence,
  ): Promise<void> {
    await this.withQueueMutationLock(programId, async () => {
      await this.prisma.programState.update({
        where: { programId },
        data: {
          songSequence: sequence as unknown as Prisma.InputJsonValue,
        },
      });
      const state = this.ensureState(programId);
      state.sequence = sequence;
      this.applyPersistedQueue(
        programId,
        state.queue,
        'cursor-persisted',
        sequence,
      );
    });
  }

  private blockQueueAfterPersistenceFailure(
    programId: string,
    error: unknown,
    publishStopped = true,
  ): void {
    const state = this.states.get(programId);
    if (state) {
      state.transitioning = false;
      state.queueBlocked = true;
    }
    this.metrics.recordSongQueueAction('persistence-failed');
    this.logger.error(
      `Play Next persistence failed on ${programId}; stopping safely: ${String(error)}`,
    );
    if (publishStopped) this.publishStopped(programId);
  }

  private publishStopped(programId: string): void {
    this.metrics.recordTrackTransition('published-stopped');
    void this.nowPlayingPublisherService.publishStopped(programId);
    this.stopProgress(programId);
    this.emit({
      type: 'song_off_air',
      programId,
      triggeredAt: new Date().toISOString(),
    });
  }

  private maybeStartSequence(programId: string): boolean {
    const state = this.states.get(programId);
    if (!state?.sequence) return false;
    if (state.sequence.mode !== 'autoplay' && state.sequence.mode !== 'shuffle')
      return false;
    if (state.activeSong || state.pendingRequestIds.size) return false;
    if (state.frozen) return false;
    if (state.transitioning || state.queueBlocked) return false;
    if (this.isRadioCapable(programId)) {
      if (!state.reconciled) return false;
      if (!this.telemetry?.isReconciled(programId)) return false;
    }
    if (state.busyWithForeignTrack) return false;
    return this.playNext(programId);
  }

  private resolveNextPlaylistSong(
    programId: string,
    state: SongEngineState,
    now = Date.now(),
  ): ProgramResolvedSongLeaf | null {
    const sequence = state.sequence;
    if (!sequence) return null;

    if (state.rotationHistoryHealthy) {
      const highRotation = selectHighRotationCandidate(
        sequence,
        state.rotation,
        now,
      );
      if (highRotation.song) {
        activateProgramSongLeaf(sequence, highRotation.song.id);
        this.metrics.recordHighRotationAction('selected');
        return highRotation.song;
      }
      if (highRotation.status === 'quota-unmet') {
        this.metrics.recordHighRotationAction('quota-unmet');
      }
    }

    const maxAttempts = collectProgramSongLeaves(sequence).length;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const resolved = resolveProgramSongLeaf(sequence, now);
      if (!resolved) return null;
      if (!resolved.highRotation) return resolved;

      if (state.rotationHistoryHealthy) {
        const eligibility = getHighRotationEligibility(
          resolved,
          state.rotation,
          now,
        );
        if (eligibility !== 'eligible') {
          this.metrics.recordHighRotationAction(
            eligibility === 'cooldown'
              ? 'cooldown-skipped'
              : 'daily-cap-skipped',
          );
        }
      }

      if (!advanceProgramSongSequence(sequence, resolved.id)) return null;
    }

    this.logger.error(
      `No legally playable playlist song remains on ${programId}`,
    );
    return null;
  }

  private playNext(programId: string): boolean {
    const state = this.states.get(programId);
    if (!state?.sequence) return false;

    if (state.queueBlocked) return false;
    const queueEntry = state.queue[0] ?? null;
    if (queueEntry && !queueEntry.active) {
      const queuePlaybackRequestId = randomUUID();
      state.transitioning = true;
      void this.claimQueueHead(programId, queueEntry.id, queuePlaybackRequestId)
        .then((claimed) => {
          const nextState = this.states.get(programId);
          if (!nextState) return;
          nextState.transitioning = false;
          if (claimed) {
            if (!this.playNext(programId)) {
              this.logger.error(
                `Claimed Play Next item could not be resolved on ${programId}; stopping without falling through`,
              );
              this.publishStopped(programId);
              this.releaseQueueClaimAfterPlaybackStops(
                programId,
                queueEntry.id,
                true,
              );
            }
            return;
          }
          this.maybeStartSequence(programId);
        })
        .catch((error) => {
          this.blockQueueAfterPersistenceFailure(programId, error);
        });
      return true;
    }
    const resolved = queueEntry
      ? findUniqueProgramSongLeafById(state.sequence, queueEntry.itemId)
      : this.resolveNextPlaylistSong(programId, state);
    if (!resolved?.audioUrl) return false;

    const dur =
      typeof resolved.durationMs === 'number' && resolved.durationMs > 0
        ? resolved.durationMs
        : 300000;
    const playbackRequestId = queueEntry?.playbackRequestId ?? randomUUID();
    state.pendingRequestIds.add(playbackRequestId);
    state.activeSong = {
      token: `${resolved.id}:${resolved.audioUrl}`,
      playbackRequestId,
      audioUrl: resolved.audioUrl,
      artist: resolved.artist,
      title: resolved.title,
      coverUrl: resolved.coverUrl,
      durationMs: dur,
      startedAt: Date.now(),
      itemId: resolved.id,
      songId: resolved.songId ?? null,
      introPlaybackId: null,
      introStatus: 'none',
      introFailureReason: null,
      authoritativeStartedAt: null,
      authoritativePositionMs: null,
      authoritativeUpdatedAt: null,
      queueEntryId: queueEntry?.id ?? null,
      highRotation: resolved.highRotation === true,
    };

    this.logger.log(
      `Commanding ${resolved.title} by ${resolved.artist} on ${programId} (${playbackRequestId})`,
    );
    void this.pushCommand(
      programId,
      playbackRequestId,
      resolved.audioUrl,
      resolved.title,
      resolved.artist,
      resolved.coverUrl,
      resolved.songId,
    );
    this.emitPlaybackActive(programId, state.activeSong);
    void this.publishNowPlaying(programId, state.activeSong);
    this.startProgress(programId);
    if (!this.isRadioCapable(programId)) {
      this.setTimer(programId, dur);
    }
    return true;
  }

  private async pushCommand(
    programId: string,
    playbackRequestId: string,
    audioUrl: string,
    title?: string,
    artist?: string,
    coverUrl?: string,
    songId?: number,
  ): Promise<void> {
    const stateBeforeCommand = this.states.get(programId);
    const activeSong = stateBeforeCommand?.activeSong;
    let intro: { playbackId: string; url: string; gain?: number } | undefined;
    if (
      activeSong?.playbackRequestId === playbackRequestId &&
      Number.isInteger(songId) &&
      (songId as number) > 0
    ) {
      try {
        const assignment = await this.prisma.songIntro.findUnique({
          where: { songId: songId as number },
          include: {
            instant: {
              select: { audioUrl: true, volume: true, enabled: true },
            },
          },
        });
        if (assignment?.programId === programId) {
          if (
            assignment.instant.enabled &&
            assignment.instant.audioUrl.trim()
          ) {
            intro = {
              playbackId: `${playbackRequestId}:intro`,
              url: assignment.instant.audioUrl,
              gain: assignment.instant.volume,
            };
            activeSong.introPlaybackId = intro.playbackId;
            activeSong.introStatus = 'pending';
            activeSong.introFailureReason = null;
            this.metrics.recordIntroTransition('submitted');
            this.emitPlaybackUpdate(programId, activeSong);
          } else {
            this.degradeIntro(
              programId,
              activeSong,
              'Assigned intro is unavailable',
            );
          }
        } else if (assignment) {
          this.degradeIntro(
            programId,
            activeSong,
            'Assigned intro belongs to another program',
          );
        }
      } catch (error) {
        this.logger.error(
          `Intro lookup failed on ${programId}: ${String(error)}`,
        );
        this.degradeIntro(
          programId,
          activeSong,
          'Intro assignment lookup failed',
        );
      }
    }
    if (
      this.states.get(programId)?.activeSong?.playbackRequestId !==
      playbackRequestId
    ) {
      return;
    }
    let result: Awaited<ReturnType<RadioService['playSong']>>;
    try {
      result = await this.radioService.playSong(
        programId,
        audioUrl,
        title,
        artist,
        playbackRequestId,
        coverUrl,
        intro,
      );
    } catch (error) {
      this.logger.error(
        `Palazzo command errored on ${programId} (${playbackRequestId}): ${String(error)}`,
      );
      this.handleCommandFailure(programId, playbackRequestId);
      return;
    }
    const state = this.states.get(programId);
    if (!state) return;
    if (result.ok && result.playbackRequestId) {
      if (intro && state.activeSong?.playbackRequestId === playbackRequestId) {
        if (result.introPlaybackId === intro.playbackId) {
          state.activeSong.introPlaybackId = result.introPlaybackId;
          this.metrics.recordIntroTransition('accepted');
        } else {
          this.degradeIntro(
            programId,
            state.activeSong,
            'Palazzo did not accept the assigned intro',
          );
        }
      }
      // Adopt Palazzo's authoritative request ID when it generated its own.
      if (result.playbackRequestId !== playbackRequestId) {
        state.pendingRequestIds.delete(playbackRequestId);
        state.pendingRequestIds.add(result.playbackRequestId);
        if (state.activeSong?.playbackRequestId === playbackRequestId) {
          state.activeSong.playbackRequestId = result.playbackRequestId;
        }
      }
      return;
    }
    if (!result.ok) {
      this.logger.error(
        `Palazzo command failed on ${programId} (${playbackRequestId}); clearing pending command`,
      );
      this.handleCommandFailure(programId, playbackRequestId);
    }
  }

  private handleCommandFailure(
    programId: string,
    playbackRequestId: string,
  ): void {
    const state = this.states.get(programId);
    if (!state) return;
    state.pendingRequestIds.delete(playbackRequestId);
    if (
      !this.isRadioCapable(programId) ||
      state.activeSong?.playbackRequestId !== playbackRequestId
    ) {
      return;
    }
    const failedQueueEntryId = state.activeSong.queueEntryId;
    state.activeSong = null;
    this.stopProgress(programId);
    this.metrics.recordTrackTransition('command-failed');
    void this.nowPlayingPublisherService.publishStopped(programId);
    this.emit({
      type: 'song_off_air',
      programId,
      triggeredAt: new Date().toISOString(),
    });
    if (failedQueueEntryId) {
      this.releaseQueueClaimAfterPlaybackStops(programId, failedQueueEntryId);
    }
  }

  /**
   * Legacy estimated-duration completion for TV-only programs. Radio-capable
   * programs never call this; they advance only on authoritative Palazzo
   * track end events.
   */
  private setTimer(programId: string, durationMs: number): void {
    const state = this.states.get(programId);
    if (!state) return;
    this.clearTimer(programId);
    state.timer = setTimeout(() => {
      const s = this.states.get(programId);
      if (!s) return;
      this.handleSongEnded(programId);
      const endedSong = s.activeSong;
      s.activeSong = null;
      s.pendingRequestIds.clear();
      s.songCount++;
      const hasSuccessor =
        s.sequence?.mode === 'autoplay' || s.sequence?.mode === 'shuffle'
          ? advanceProgramSongSequence(s.sequence, endedSong?.itemId)
          : false;
      void this.maybeBumper(programId).then(() => {
        const st = this.states.get(programId);
        if (!st || st.activeSong) return;

        if (
          st.sequence &&
          hasSuccessor &&
          (st.sequence.mode === 'autoplay' || st.sequence.mode === 'shuffle')
        ) {
          if (this.maybeStartSequence(programId)) return;
        }

        void this.nowPlayingPublisherService.publishStopped(programId);
      });
    }, durationMs);
  }

  private clearTimer(programId: string): void {
    const state = this.states.get(programId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private async maybeBumper(programId: string): Promise<void> {
    try {
      const settings = await this.radioService.getRadioSettings(programId);
      if (
        !settings?.bumperEnabled ||
        !settings.bumperInterval ||
        !settings.bumperInstantIds.length
      )
        return;
      const state = this.states.get(programId);
      if (!state || state.songCount % settings.bumperInterval !== 0) return;
      const ids = settings.bumperInstantIds;
      const idx =
        settings.bumperMode === 'random'
          ? Math.floor(Math.random() * ids.length)
          : state.nextBumperIdx % ids.length;
      state.nextBumperIdx = (idx + 1) % ids.length;
      const inst = await this.prisma.instant.findUnique({
        where: { id: ids[idx] },
      });
      if (!inst?.audioUrl) return;
      this.logger.log(`Bumper: ${inst.name} on ${programId}`);
      const playbackRequestId = randomUUID();
      await this.radioService.playInstant(
        programId,
        inst.audioUrl,
        undefined,
        playbackRequestId,
      );
      await new Promise((r) => setTimeout(r, 8000));
    } catch {
      /* silent */
    }
  }

  private applyAuthoritativePosition(
    programId: string,
    state: SongEngineState,
    data: {
      playbackRequestId?: string | null;
      positionSeconds?: number;
      remainingSeconds?: number | null;
      status?: string;
    },
  ): void {
    const song = state.activeSong;
    if (!song) return;
    if (
      data.playbackRequestId &&
      data.playbackRequestId !== song.playbackRequestId
    ) {
      return;
    }
    if (typeof data.positionSeconds === 'number' && data.positionSeconds >= 0) {
      song.authoritativePositionMs = Math.round(data.positionSeconds * 1000);
      song.authoritativeUpdatedAt = Date.now();
    }
    if (
      typeof data.remainingSeconds === 'number' &&
      data.remainingSeconds >= 0
    ) {
      song.durationMs = Math.max(
        (song.authoritativePositionMs ?? 0) + data.remainingSeconds * 1000,
        song.authoritativePositionMs ?? 0,
      );
    }
    this.emitPlaybackUpdate(programId, song);
  }

  private startProgress(programId: string): void {
    const state = this.states.get(programId);
    if (!state) return;
    this.stopProgress(programId);
    state.progressInterval = setInterval(() => {
      const s = this.states.get(programId);
      if (s?.activeSong)
        this.emit({
          type: 'playback_update',
          programId,
          playback: this.playbackData(programId, s.activeSong),
        });
    }, 250);
  }

  private stopProgress(programId: string): void {
    const state = this.states.get(programId);
    if (state?.progressInterval) {
      clearInterval(state.progressInterval);
      state.progressInterval = null;
    }
  }

  private playbackData(programId: string, s: ActiveSong): SongPlaybackData {
    const now = Date.now();
    let positionMs: number;
    let startedAt = s.startedAt;

    if (
      s.authoritativeStartedAt !== null &&
      s.authoritativePositionMs !== null &&
      s.authoritativeUpdatedAt !== null
    ) {
      startedAt = s.authoritativeStartedAt;
      const interpolated =
        s.authoritativePositionMs + (now - s.authoritativeUpdatedAt);
      positionMs = Math.max(0, interpolated);
    } else {
      positionMs = Math.max(0, now - s.startedAt);
    }
    const pos = Math.min(positionMs, s.durationMs);
    return {
      token: s.token,
      audioUrl: s.audioUrl,
      title: s.title,
      artist: s.artist,
      coverUrl: s.coverUrl,
      durationMs: s.durationMs,
      isPlaying: true,
      positionMs: pos,
      progress: s.durationMs > 0 ? Math.min(pos / s.durationMs, 1) : 0,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
      telemetryStale:
        this.isRadioCapable(programId) &&
        (s.authoritativeUpdatedAt === null ||
          now - s.authoritativeUpdatedAt > 15_000),
      introStatus: s.introStatus,
      introFailureReason: s.introFailureReason,
      queueEntryId: s.queueEntryId,
    };
  }

  private reconcileIntroSnapshot(
    song: ActiveSong,
    snapshot: PalazzoPlaybackState,
  ): void {
    const intro = snapshot.intro;
    if (!intro || intro.parentPlaybackId !== song.playbackRequestId) return;
    song.introPlaybackId = intro.playbackId;
    song.introStatus = intro.status === 'playing' ? 'playing' : 'degraded';
    song.introFailureReason = this.boundedFailureReason(intro.failureReason);
  }

  private handleIntroEvent(
    programId: string,
    state: SongEngineState,
    event: {
      type: 'intro.started' | 'intro.ended' | 'intro.failed';
      data: {
        programId: string;
        playbackId: string;
        parentPlaybackId: string;
        failureReason?: string;
        reason?: string;
      };
    },
  ): void {
    const song = state.activeSong;
    if (
      !song ||
      event.data.programId !== programId ||
      event.data.parentPlaybackId !== song.playbackRequestId ||
      (song.introPlaybackId && event.data.playbackId !== song.introPlaybackId)
    ) {
      this.metrics.recordIntroTransition('ignored-mismatch');
      return;
    }
    song.introPlaybackId = event.data.playbackId;
    if (event.type === 'intro.started') {
      song.introStatus = 'playing';
      song.introFailureReason = null;
      this.metrics.recordIntroTransition('started');
    } else if (event.type === 'intro.ended') {
      song.introStatus = 'completed';
      song.introFailureReason = null;
      this.metrics.recordIntroTransition('ended');
    } else {
      song.introStatus = 'degraded';
      song.introFailureReason =
        this.boundedFailureReason(
          event.data.failureReason ?? event.data.reason,
        ) ?? 'Intro playback failed';
      this.metrics.recordIntroTransition('failed');
    }
    this.emitPlaybackUpdate(programId, song);
  }

  private degradeIntro(
    programId: string,
    song: ActiveSong,
    reason: string,
  ): void {
    song.introStatus = 'degraded';
    song.introFailureReason = this.boundedFailureReason(reason);
    this.metrics.recordIntroTransition('failed');
    this.emitPlaybackUpdate(programId, song);
  }

  private boundedFailureReason(value: unknown): string | null {
    return typeof value === 'string' && value.trim()
      ? value.trim().slice(0, 200)
      : null;
  }

  private publishNowPlaying(
    programId: string,
    song: ActiveSong,
  ): Promise<void> {
    return this.nowPlayingPublisherService.publishPlayback(
      programId,
      this.playbackData(programId, song),
    );
  }

  private emitPlaybackActive(programId: string, song: ActiveSong): void {
    this.emit({
      type: 'song_playback_active',
      programId,
      playback: this.playbackData(programId, song),
    });
  }

  private emitPlaybackUpdate(programId: string, song: ActiveSong): void {
    this.emit({
      type: 'playback_update',
      programId,
      playback: this.playbackData(programId, song),
    });
  }

  private emit(event: SongEngineEvent): void {
    try {
      this.broadcast?.(event);
    } catch (e) {
      this.logger.error(`Broadcast error: ${e}`);
    }
  }
}
