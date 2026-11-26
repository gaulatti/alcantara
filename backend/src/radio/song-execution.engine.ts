import { isDeployCandidate } from '../config/deploy-candidate';
import {
  ActorContext,
  type Actor,
  type ActorFields,
} from '../auth/actor-context';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Inject,
  Optional,
  forwardRef,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PALAZZO_NEXT_BUMPER } from './palazzo-contract';
import type { AnnouncementSkipReason } from './radio-metrics.service';
import { randomUUID } from 'node:crypto';
import { Subject, type Observable } from 'rxjs';
import type { Prisma } from '@prisma/client';
import { PalazzoInstantRefusedException, RadioService } from './radio.service';
import { FlightService } from '../program/flight.service';
import { PrismaService } from '../prisma.service';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import {
  RadioMetricsService,
  type EngineResyncTrigger,
  type HandoffPath,
  type InheritedAdoptionPath,
  type SongQueueActionResult,
  type SongRequestFailureReason,
} from './radio-metrics.service';
import type {
  PalazzoPlaybackState,
  PalazzoProgramStatus,
} from './palazzo-contract';
import {
  activateProgramSongLeaf,
  activeProgramSongLeafId,
  advanceProgramSongSequence,
  collectHighRotationProgramSongLeaves,
  collectProgramSongLeaves,
  countProgramSongLeavesByAudioUrl,
  findUniqueProgramSongLeafById,
  findUniqueProgramSongLeafByAudioUrl,
  normalizeProgramSongSequence,
  programSongSequenceStructure,
  removeProgramSongLeavesInPlace,
  resolveProgramSongLeaf,
  type ProgramSongSequence,
  type ProgramSongSequenceLeafItem,
  type ProgramResolvedSongLeaf,
} from './song-sequence.utils';
import {
  MAX_PROGRAM_SONG_QUEUE_LENGTH,
  filterProgramSongQueueForSequence,
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

import { SongSimilarityService } from './song-similarity.service';
import { CATALOG_ITEM_PREFIX } from './song-similarity.utils';

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
  | ({
      type: 'song_playback_active';
      programId: string;
      playback: SongPlaybackData;
    } & Partial<ActorFields>)
  | ({
      type: 'song_off_air';
      programId: string;
      triggeredAt: string;
    } & Partial<ActorFields>)
  | ({
      type: 'song_queue_update';
      programId: string;
      songQueue: ProgramSongQueueEntry[];
      songSequence?: ProgramSongSequence | null;
    } & Partial<ActorFields>)
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
    }
  | {
      /** Palazzo could not load the song (#175); the engine moved on. */
      type: 'song_request_failed';
      programId: string;
      playbackRequestId: string;
      title: string;
      artist: string;
      reason: SongRequestFailureReason;
      failedAt: string;
    };

/** The engine's read-only account of one program; see getOnAirView. */
export interface SongEngineOnAirView {
  playbackRequestId: string | null;
  songId: number | null;
  /** The catalog song of the announced next song, when it can be told (gaulatti/alcantara#235). */
  nextSongId: number | null;
  next: {
    playbackId: string;
    status: 'pending' | 'accepted' | 'not-announced';
    title: string;
    artist: string;
  } | null;
  mode: ProgramSongSequence['mode'] | null;
  frozen: boolean;
}

export type SongEngineBroadcastFn = (event: SongEngineEvent) => void;

/** Subset of Palazzo telemetry knowledge the engine needs to gate playback. */
export interface PalazzoTelemetrySource {
  isReconciled(programId: string): boolean;
  /**
   * Palazzo's current state on request (#230). Palazzo sends a snapshot only
   * when a stream connects, so the engine asks when it needs the
   * authoritative state. Null when it cannot be read.
   */
  currentState?(programId: string): Promise<PalazzoPlaybackState | null>;
}

/**
 * gaulatti/alcantara#230 watchdog: in an automatic mode the engine reads
 * Palazzo's state every WATCHDOG_INTERVAL_MS. When Palazzo reports nothing on
 * the air on reads at least NO_PLAYBACK_BOUND_MS apart, the engine reconciles
 * from that report: an active song it still believes in is ended and the next
 * one starts; an empty engine starts the sequence. It acts only on Palazzo's
 * own report, never on elapsed time alone.
 *
 * Palazzo's `status` cannot tell a song being prepared from idle: a song
 * command reads 'idle' until the song is on air, for up to Palazzo's request
 * limit (SONG_REQUEST_TIMEOUT_MS, 29 s by default). Every command the engine
 * sends restarts the bound, so the bound sits above that limit with margin:
 * a load either starts or fails inside it. Production since 2026-11-19: the
 * longest load was 1 s and the longest instant 11 s.
 */
/**
 * After a failed song command in an automatic mode, the engine re-reads
 * Palazzo's state and resumes from it after COMMAND_RETRY_BASE_MS, doubling
 * up to COMMAND_RETRY_MAX_MS while commands keep failing (#230). On
 * 2026-11-20 every Palazzo restart unfroze automation about 6 s before Palazzo
 * could play, the first command failed and nothing followed it.
 */
export const COMMAND_RETRY_BASE_MS = 2_000;
/** How long the first announcement after a boot waits for the similarity index (#277). */
export const SIMILARITY_READY_WAIT_MS = 20_000;

/** Sends of one command spot: the first and one retry of a not-ready refusal (gaulatti/alcantara#274). */
const BUMPER_COMMAND_ATTEMPTS = 2;
export const COMMAND_RETRY_MAX_MS = 30_000;
/**
 * A failed catalogue lookup for a track this process did not command is tried
 * up to this many times in all (gaulatti/alcantara#272), 2, 4, 8, 16, 30, 30 and
 * 30 s apart (the command-retry backoff): about two minutes while the database
 * is unreachable or throttled, after which the track is reported once.
 */
export const INHERITED_LOOKUP_ATTEMPTS = 8;

export const WATCHDOG_INTERVAL_MS = 10_000;
export const NO_PLAYBACK_BOUND_MS = 45_000;
/**
 * An announced spot on air (instant.started seen, instant.ended not yet) is
 * playback for the watchdog for at most this long: Palazzo cuts a spot at 60 s
 * (gaulatti/palazzo#50), so past this the watchdog judges as usual even if the
 * spot's end was never received.
 */
export const ANNOUNCED_SPOT_PLAYBACK_MS = 75_000;

/**
 * What a watchdog read of Palazzo shows (#230). Anything on the air (a song,
 * an intro, an instant or the live input) is not a stall. A Palazzo that does
 * not report its live input cannot rule a live show out, so the watchdog
 * holds instead of starting a song under it.
 */
export function watchdogReading(
  state: PalazzoPlaybackState,
): 'on_air' | 'nothing_on_air' | 'unknown' {
  if (state.availability !== 'available') return 'unknown';
  if (
    state.status !== 'idle' ||
    state.intro?.status === 'playing' ||
    state.levels.instant.rms > 0 ||
    state.levels.instant.peak > 0 ||
    state.live?.onAir === true
  )
    return 'on_air';
  if (state.live === undefined) return 'unknown';
  return 'nothing_on_air';
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
  /** The similarity picker started a new artist cycle with this song. */
  cycleReset?: boolean;
  /** The engine already closed this play for the as-run log. */
  asRunClosed?: boolean;
  /**
   * Who picked it, captured when the command arrived: its `track.started`
   * is confirmed later, outside the request, so it is never read then.
   */
  actor?: Actor | null;
  /** Promoted from an announcement: Palazzo started it, no command was sent. */
  promoted?: boolean;
}

/**
 * The next song announced to Palazzo while the active song plays (contract
 * gaulatti/palazzo#40). Palazzo starts it itself at the active song's
 * cue-out; the engine promotes it only if it is still the successor then.
 */
interface NextAnnouncement {
  playbackId: string;
  /** Request ID of the active song it follows. */
  forRequestId: string;
  itemId: string;
  queueEntryId: string | null;
  audioUrl: string;
  title: string;
  artist: string;
  /** `pending` until Palazzo answers; only `accepted` can be promoted. */
  status: 'pending' | 'accepted' | 'not-announced';
  /** When its `track.started` was accepted before promotion. */
  startedAt: number | null;
  /**
   * The accepted announcement this one replaces while its own PUT is
   * unanswered: Palazzo may still start it at the handoff.
   */
  replaces: NextAnnouncement | null;
  /** The spot Palazzo plays before it, when announced with one (palazzo#50). */
  bumper?: BumperChoice | null;
  /**
   * The instant a playlist successor was selected for (the expected end),
   * held through the end: the handoff selects at it again, so it plays this
   * choice. Null for a queue head.
   */
  selectAt?: number | null;
  /**
   * The playlist successor chosen, held as is: the handoff plays this leaf
   * when the announcement is the ended song's own and the leaf is still in
   * the sequence with the same audio (or is a catalog pick).
   */
  leaf?: ProgramResolvedSongLeaf | null;
  /** The similarity pick's cycle reset, applied when the held leaf plays. */
  cycleReset: boolean;
  /**
   * The selection's metric and similarity decision records, applied once when
   * the held leaf plays, as the selection at the end would have recorded them.
   */
  effects: (() => void)[];
}

/** The spot chosen for a bumper slot, once per song (gaulatti/alcantara#232). */
interface BumperChoice {
  /** Request ID of the song whose end is the slot. */
  forRequestId: string;
  /** Index in bumperInstantIds; the sequence advances past it once it is used. */
  index: number;
  instantId: number;
  name: string;
  audioUrl: string;
  playbackId: string;
}

const MAX_PREEMPTED_REQUEST_IDS = 32;
/** How late after the expected end a successor must still be the same to be announced. */

/**
 * Moves every cursor stamp the end's advance wrote (at or after `from`) to
 * `at`, as if the end had happened then. Older stamps are left alone.
 */
function restampSequence(
  sequence: ProgramSongSequence,
  from: number,
  at: number,
): void {
  if (sequence.startedAt >= from) sequence.startedAt = at;
  for (const item of sequence.items) {
    if (item.kind === 'sequence') restampSequence(item.sequence, from, at);
  }
}

interface SongEngineState {
  /** When the first announcement began waiting for the similarity index (#277). */
  similarityWaitSince?: number;
  similarityWaitWarned?: boolean;
  /** The one pending wait for the similarity index, for the song on air (#277). */
  similarityWait?: { timer: NodeJS.Timeout; song: ActiveSong };
  /** A cursor write is in flight: the next advance writes after it (#277). */
  cursorWriteInFlight?: boolean;
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
  /**
   * Request IDs of playing tracks this process did not command, looked up in
   * the catalogue or already reported as unidentified (gaulatti/alcantara#272):
   * each is handled once, however many snapshots name it.
   */
  inheritedLookups: Set<string>;
  /** The request ID of the uncommanded track now withheld, or '' (#272). */
  withheldRequestId: string;
  /** The pending retry of a failed catalogue lookup, and its track (#272). */
  inheritedRetryTimer: ReturnType<typeof setTimeout> | null;
  inheritedRetryRequestId: string;
  /** First watchdog read of Palazzo reporting no playback, or null (#230). */
  noPlaybackSince: number | null;
  /** The pending retry after a failed command, and how many in a row (#230). */
  commandRetryTimer: ReturnType<typeof setTimeout> | null;
  commandRetries: number;
  lastIdleSequence: number | null;
  transitioning: boolean;
  queueBlocked: boolean;
  /** Song that most recently finished; the similarity picker's "current". */
  lastEnded: { songId: number | null; artist: string } | null;
  pendingCycleReset: boolean;
  announcement: NextAnnouncement | null;
  /** Serialises announcement refreshes per program. */
  announcementChain: Promise<void>;
  /** Palazzo boot from the latest snapshot. */
  palazzoBootId: string | null;
  /** The library song of each playback this engine commanded, announced or adopted, newest last. */
  commandedSongs?: Map<string, number>;
  /** Boot of a Palazzo without the next route (404); undefined when supported. */
  nextUnsupportedBootId?: string | null;
  /** Announced songs replaced at the handoff before their start arrived. */
  preemptedRequestIds: string[];
  /** Capabilities from the latest Palazzo snapshot (gaulatti/palazzo#50). */
  palazzoCapabilities?: string[];
  /** The spot chosen for the active song's bumper slot, if any. */
  bumperChoice?: BumperChoice | null;
  /** Song whose missing announcement was already counted, so once per song. */
  skipCountedFor?: string | null;
  /** The announced spot Palazzo has on air, and since when (palazzo#50). */
  announcedSpotOnAir?: { playbackId: string; since: number } | null;
  /** Bumper spots sent and not yet seen on air, by playback ID. */
  bumperSpotsSent?: Map<
    string,
    { name: string; path: 'announced' | 'command' }
  >;
}

const MAX_ENDED_REQUEST_IDS = 128;
/** How often a leaf removal re-reads the row when another write moved it first. */
const REMOVE_LEAVES_ATTEMPTS = 4;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const RADIO_PROGRAM_TYPES = new Set(['radio', 'both']);

/**
 * A Palazzo track start or end the engine accepted. `at` is the time the
 * engine handled the event, not a Palazzo timestamp.
 */
export type SongEngineTrackEvent = {
  programId: string;
  type: 'track.started' | 'track.ended';
  playbackRequestId: string;
  title: string | null;
  artist: string | null;
  url: string | null;
  at: Date;
  /**
   * Present and true only on a `track.ended` the engine inferred: the real
   * end event never arrived and an authoritative idle snapshot ended the song
   * (`at` is the moment the engine advanced), or a playing snapshot reported
   * another track (`endReason: 'superseded'`).
   */
  inferred?: true;
  /**
   * Present only on a `track.ended` the engine sent itself because it ended a
   * started song: `stopped` (operator Stop), `replaced` (a manual pick cut it)
   * `superseded` (a playing snapshot reported another track, also
   * `inferred`) or `preempted` (an announced song that lost the handoff race).
   * `at` is then the moment the engine acted. Never derived from Palazzo's
   * stop-reason label.
   */
  endReason?: SongEngineEndReason;
} & Partial<ActorFields>;

/**
 * Why the engine itself ended a started song; see SongEngineTrackEvent.
 * `preempted` is an announced song Palazzo started at the handoff that was no
 * longer the engine's successor, so the engine replaced it at once.
 */
export type SongEngineEndReason =
  | 'stopped'
  | 'replaced'
  | 'superseded'
  | 'preempted';

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
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly radioProgramIds = new Set<string>();
  private readonly queueMutationLocks = new Map<string, Promise<void>>();
  private readonly rotationMutationLocks = new Map<string, Promise<void>>();
  // Plain Subject: no replay buffer, so late subscribers see only new events.
  private readonly trackEventsSubject = new Subject<SongEngineTrackEvent>();
  /**
   * Palazzo `track.started` and `track.ended` events the engine accepted (an
   * adopted start of the engine's active song, or an advancing end), emitted
   * after the existing handling. Ignored transitions (mismatched, duplicate,
   * frozen, no active song) and starts confirming a command another song
   * already replaced emit nothing. An end inferred from an authoritative idle
   * snapshot is emitted with `inferred: true`. A started song the engine
   * ends itself (Stop, manual cut, superseding snapshot) is closed once with
   * an `endReason`; a later end for it emits nothing. Subscribers run
   * synchronously but are never awaited, and a subscriber error never reaches
   * the engine.
   */
  readonly trackEvents$: Observable<SongEngineTrackEvent> =
    this.trackEventsSubject.asObservable();

  constructor(
    private readonly radioService: RadioService,
    @Inject(forwardRef(() => FlightService))
    private readonly flightService: FlightService,
    private readonly prisma: PrismaService,
    private readonly nowPlayingPublisherService: NowPlayingPublisherService,
    @Inject(forwardRef(() => RadioMetricsService))
    private readonly metrics: RadioMetricsService,
    @Optional() private readonly similarity?: SongSimilarityService,
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
    // A deploy candidate (#223) starts no telemetry and no watchdog.
    if (!isDeployCandidate()) {
      this.watchdog = setInterval(
        () => void this.checkPlayback(),
        WATCHDOG_INTERVAL_MS,
      );
      this.watchdog.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const [programId, state] of this.states) {
      this.clearTimer(programId);
      this.stopProgress(programId);
      if (state.commandRetryTimer) clearTimeout(state.commandRetryTimer);
      state.commandRetryTimer = null;
      this.clearInheritedRetry(state);
      this.clearSimilarityWait(state);
    }
  }

  private clearSimilarityWait(state: SongEngineState): void {
    if (state.similarityWait) clearTimeout(state.similarityWait.timer);
    state.similarityWait = undefined;
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
        inheritedLookups: new Set<string>(),
        withheldRequestId: '',
        inheritedRetryTimer: null,
        inheritedRetryRequestId: '',
        noPlaybackSince: null,
        commandRetryTimer: null,
        commandRetries: 0,
        lastIdleSequence: null,
        transitioning: false,
        queueBlocked: false,
        lastEnded: null,
        pendingCycleReset: false,
        announcement: null,
        announcementChain: Promise.resolve(),
        palazzoBootId: null,
        preemptedRequestIds: [],
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
    this.refreshAnnouncement(programId);
  }

  async prepareContinuousRotationResume(programId: string): Promise<void> {
    const state = this.states.get(programId);
    if (
      !state?.sequence ||
      !['autoplay', 'shuffle'].includes(state.sequence.mode)
    )
      return;
    const next = normalizeProgramSongSequence(state.sequence)!;
    const current = resolveProgramSongLeaf(next);
    if (current) advanceProgramSongSequence(next, current.id);
    await this.persistPlaylistCursorForQueue(programId, next);
  }

  resumeContinuousRotation(programId: string): void {
    const state = this.states.get(programId);
    if (state) state.transitioning = false;
    this.maybeStartSequence(programId);
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
    this.refreshAnnouncement(programId);
  }

  async enqueueSong(
    programId: string,
    itemId: string,
  ): Promise<ProgramSongQueueEntry[]> {
    const actor = ActorContext.current();
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
        this.applyPersistedQueue(
          programId,
          nextQueue,
          'enqueued',
          undefined,
          actor,
        );
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
    const actor = ActorContext.current();
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
        this.applyPersistedQueue(
          programId,
          nextQueue,
          'removed',
          undefined,
          actor,
        );
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
    const actor = ActorContext.current();
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
        this.applyPersistedQueue(
          programId,
          nextQueue,
          'reordered',
          undefined,
          actor,
        );
        return nextQueue;
      } catch (error) {
        this.recordQueueMutationFailure(error);
        throw error;
      }
    });
  }

  /**
   * Removes exactly these leaves from a program's playlist without rewriting the cursor from a
   * stale read (gaulatti/alcantara#327). Under the queue-mutation lock it reads the stored row,
   * takes the sequence the engine holds when that differs from the stored one only by the cursor
   * (so the cursor is the live one), removes the leaves, filters the queue and stores both with
   * one compare-and-swap on the row's `updatedAt`, retried when the row moved. A dry run only
   * reports.
   */
  async removeSongLeaves(
    programId: string,
    leafIds: string[],
    options: { keepRotation: boolean; dryRun: boolean },
  ): Promise<{
    removed: ProgramSongSequenceLeafItem[];
    before: number;
    after: number;
    cursorMovedTo: string | null;
    songSequence: ProgramSongSequence;
    songQueue: ProgramSongQueueEntry[];
  }> {
    const wanted = new Set(leafIds);
    return this.withQueueMutationLock(programId, async () => {
      for (let attempt = 0; attempt < REMOVE_LEAVES_ATTEMPTS; attempt += 1) {
        const row = await this.prisma.programState.findUnique({
          where: { programId },
          select: { songSequence: true, songQueue: true, updatedAt: true },
        });
        if (!row) throw new NotFoundException('Program not found');
        const stored = normalizeProgramSongSequence(row.songSequence);
        if (!stored)
          throw new BadRequestException('The program has no playlist');
        const held = this.states.get(programId)?.sequence ?? null;
        const base = clone(
          held &&
            programSongSequenceStructure(held) ===
              programSongSequenceStructure(stored)
            ? held
            : stored,
        );
        const known = new Set(
          collectProgramSongLeaves(base).map((leaf) => leaf.id),
        );
        const unknown = leafIds.filter((id) => !known.has(id));
        if (unknown.length)
          throw new BadRequestException(
            `Unknown leaf id(s): ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ''}`,
          );
        let cursorMovedTo: string | null = null;
        const active = activeProgramSongLeafId(base);
        if (active && wanted.has(active)) {
          if (!options.keepRotation)
            throw new BadRequestException(
              `Leaf ${active} is the active leaf; set keep_rotation to move the rotation to the next leaf`,
            );
          for (let moves = 0; moves <= known.size; moves += 1) {
            const now = activeProgramSongLeafId(base);
            if (!wanted.has(now as string)) break;
            if (!advanceProgramSongSequence(base, now as string)) break;
          }
          const next = activeProgramSongLeafId(base);
          if (next && wanted.has(next))
            throw new BadRequestException(
              'No leaf is left to move the rotation to',
            );
          cursorMovedTo = next;
        }
        const before = known.size;
        const removed = removeProgramSongLeavesInPlace(base, wanted);
        const queue = filterProgramSongQueueForSequence(
          normalizeProgramSongQueue(row.songQueue),
          base,
        );
        const result = {
          removed,
          before,
          after: before - removed.length,
          cursorMovedTo,
          songSequence: base,
          songQueue: queue,
        };
        if (options.dryRun) return result;
        const { count } = await this.prisma.programState.updateMany({
          where: { programId, updatedAt: row.updatedAt },
          data: {
            songSequence: base as unknown as Prisma.InputJsonValue,
            songQueue: queue as unknown as Prisma.InputJsonValue,
          },
        });
        if (count !== 1) continue;
        // The engine's own cursor may have moved since the read (an operator edit would have
        // moved `updatedAt` and failed the swap): keep the live cursor, drop the leaves.
        const live = this.states.get(programId);
        if (live?.sequence) {
          const current = clone(live.sequence);
          removeProgramSongLeavesInPlace(current, wanted);
          live.sequence = current;
          result.songSequence = current;
        }
        this.updateHighRotationFavoriteMetric();
        return result;
      }
      throw new ConflictException(
        'The playlist kept changing; nothing was removed, try again',
      );
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
    actor: Actor | null = null,
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
      ...ActorContext.eventFields(actor),
    });
    if (
      queue.length &&
      state.sequence &&
      (state.sequence.mode === 'autoplay' || state.sequence.mode === 'shuffle')
    ) {
      this.maybeStartSequence(programId);
    }
    this.refreshAnnouncement(programId);
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
    let automatic = 0;
    for (const programId of this.radioProgramIds) {
      const sequence = this.states.get(programId)?.sequence ?? null;
      favorites += collectHighRotationProgramSongLeaves(sequence).length;
      // The deploy's radio check reads this (#230, deploy/cumulus.sh).
      if (sequence?.mode === 'autoplay' || sequence?.mode === 'shuffle')
        automatic += 1;
    }
    this.metrics.recordHighRotationFavorites(favorites);
    this.metrics.recordAutomaticPrograms(automatic);
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
    this.similarity?.noteSongStarted(programId, song.artist, {
      resetCycle: song.cycleReset === true,
    });
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
    voiceTrack?: {
      instantId: number;
      duckGain?: number;
      fadeInSeconds?: number;
      fadeOutSeconds?: number;
    },
  ): void {
    // Captured now: Palazzo confirms the start later, outside this command.
    const actor = ActorContext.current();
    const state = this.ensureState(programId);
    const playlistSong = findUniqueProgramSongLeafByAudioUrl(
      state.sequence,
      audioUrl,
    );
    const dur =
      typeof durationMs === 'number' && durationMs > 0 ? durationMs : 300000;
    const playbackRequestId = randomUUID();
    state.pendingRequestIds.add(playbackRequestId);
    // A new command restarts the watchdog's bound (#230).
    state.noPlaybackSince = null;
    if (state.activeSong) {
      this.closePlayForAsRun(programId, state.activeSong, 'replaced', actor);
    }
    // Palazzo's song command flushes the announced song as well.
    this.forgetAnnouncement(programId, state, 'replaced', actor);
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
      actor,
    };
    this.rememberSong(state, playbackRequestId, state.activeSong.songId);
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
      voiceTrack,
    );
  }

  handleSongEnded(programId: string): void {
    void this.flightService.handleSongEnded(programId);
  }

  /**
   * Operator Stop (gaulatti/alcantara#173): the sequence halts until the
   * operator acts. An automatic sequence turns manual, cued past the stopped
   * song, and is persisted, so idle snapshots and a restart start nothing.
   * A timed block passes `keepSequence` and resumes the rotation itself. A
   * stop the flight itself drives passes `keepMode`: the rotation keeps its
   * mode and is cued past the stopped song, so it neither halts nor replays.
   */
  handleStopSong(
    programId: string,
    options: { keepSequence?: boolean; keepMode?: boolean } = {},
  ): void {
    const actor = ActorContext.current();
    const state = this.states.get(programId);
    if (!state) {
      void this.nowPlayingPublisherService.publishStopped(programId);
      return;
    }
    if (
      !options.keepSequence &&
      (state.sequence?.mode === 'autoplay' ||
        state.sequence?.mode === 'shuffle')
    ) {
      const halted = normalizeProgramSongSequence(state.sequence)!;
      if (!options.keepMode) halted.mode = 'manual';
      const stopped = state.activeSong;
      // Queue entries and songs picked from outside the playlist never moved
      // the cursor, which already points at the successor.
      if (
        stopped &&
        !stopped.queueEntryId &&
        !stopped.itemId.startsWith(CATALOG_ITEM_PREFIX)
      ) {
        advanceProgramSongSequence(halted, stopped.itemId);
      }
      state.sequence = halted;
      void this.persistPlaylistCursorForQueue(programId, halted).catch(
        (error) =>
          this.logger.error(
            `Could not persist the stopped sequence on ${programId}: ${String(error)}`,
          ),
      );
    }
    const stoppedQueueEntryId = state.activeSong?.queueEntryId ?? null;
    if (state.activeSong) {
      this.closePlayForAsRun(programId, state.activeSong, 'stopped', actor);
    }
    // Palazzo's song stop flushes the announced song as well.
    this.forgetAnnouncement(programId, state, 'stopped', actor);
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
      ...ActorContext.eventFields(actor),
    });
    void this.nowPlayingPublisherService.publishStopped(programId);
    if (stoppedQueueEntryId) {
      this.releaseQueueClaimAfterPlaybackStops(programId, stoppedQueueEntryId);
    }
  }

  /**
   * The library song of a playback this engine commanded, announced or adopted, or null when it has no record of
   * it. The as-run log attributes by this before the audio address, which two songs can share.
   */
  songIdForPlayback(
    programId: string,
    playbackRequestId: string,
  ): number | null {
    return (
      this.states.get(programId)?.commandedSongs?.get(playbackRequestId) ?? null
    );
  }

  private rememberSong(
    state: SongEngineState,
    playbackRequestId: string,
    songId: number | null | undefined,
  ): void {
    if (!songId) return;
    const songs = (state.commandedSongs ??= new Map<string, number>());
    songs.set(playbackRequestId, songId);
    if (songs.size > MAX_ENDED_REQUEST_IDS) {
      songs.delete(songs.keys().next().value as string);
    }
  }

  getPlaybackState(programId: string): SongPlaybackData | null {
    const s = this.states.get(programId)?.activeSong;
    return s ? this.playbackData(programId, s) : null;
  }

  /**
   * What the engine itself knows about a program, for read-only consumers
   * (gaulatti/alcantara#214): the song on air with its playback request ID and
   * song ID, the next song announced to Palazzo, the rotation mode and whether
   * the engine is frozen. Never exposes the playback token or an audio URL.
   * A program the engine has no state for reads as idle, manual-less and
   * unfrozen.
   */
  getOnAirView(programId: string): SongEngineOnAirView {
    const state = this.states.get(programId);
    const active = state?.activeSong ?? null;
    const announced = state?.announcement ?? null;
    return {
      playbackRequestId: active?.playbackRequestId ?? null,
      songId: active?.songId ?? null,
      nextSongId: announced
        ? this.announcedSongId(state?.sequence ?? null, announced.itemId)
        : null,
      next: announced
        ? {
            playbackId: announced.playbackId,
            status: announced.status,
            title: announced.title,
            artist: announced.artist,
          }
        : null,
      mode: state?.sequence?.mode ?? null,
      frozen: state?.frozen ?? false,
    };
  }

  /** The catalog song an announced item is: a catalog entry names it, a playlist leaf carries it. */
  private announcedSongId(
    sequence: ProgramSongSequence | null,
    itemId: string,
  ): number | null {
    if (itemId.startsWith(CATALOG_ITEM_PREFIX)) {
      const id = Number(itemId.slice(CATALOG_ITEM_PREFIX.length));
      return Number.isInteger(id) && id > 0 ? id : null;
    }
    return findUniqueProgramSongLeafById(sequence, itemId)?.songId ?? null;
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
      this.flightService.handleEngineAvailability(programId, false);
    } else if (!unavailable && state.frozen) {
      state.frozen = false;
      state.reconciled = false;
      this.logger.log(`Unfreezing radio automation for ${programId}`);
      this.flightService.handleEngineAvailability(programId, true);
    }
    this.emit({ type: 'radio_leg_status', programId, status });
  }

  /**
   * Reads Palazzo's state and reconciles from it (#230), as a snapshot would:
   * idle with an active song ends it and advances, idle and empty starts the
   * sequence, playing adopts or withholds as usual.
   */
  private async resync(
    programId: string,
    trigger: EngineResyncTrigger,
  ): Promise<void> {
    let snapshot: PalazzoPlaybackState | null = null;
    try {
      snapshot = (await this.telemetry?.currentState?.(programId)) ?? null;
    } catch (error) {
      snapshot = null;
      this.logger.warn(
        `Resync could not read Palazzo state for ${programId} (${errorClass(error)})`,
      );
      this.metrics.recordEngineDegraded('telemetry_state');
    }
    if (!snapshot) {
      this.metrics.recordEngineResync(trigger, 'unavailable');
      return;
    }
    this.metrics.recordEngineResync(
      trigger,
      snapshot.status === 'playing' ? 'playing' : 'resumed',
    );
    this.handlePalazzoSnapshot(programId, snapshot);
  }

  /**
   * The watchdog (#230). Runs every WATCHDOG_INTERVAL_MS; see
   * NO_PLAYBACK_BOUND_MS.
   */
  async checkPlayback(): Promise<void> {
    for (const programId of [...this.radioProgramIds]) {
      const state = this.states.get(programId);
      if (!state) continue;
      const automatic =
        state.sequence?.mode === 'autoplay' ||
        state.sequence?.mode === 'shuffle';
      // A frozen engine or a stale stream: not ours to judge now. A command
      // sent restarts the bound (see pendingRequestIds.add), so a command
      // still pending while Palazzo reports no playback past the bound was
      // lost, and the idle report drops it.
      if (
        !automatic ||
        state.frozen ||
        !this.telemetry?.isReconciled(programId)
      ) {
        state.noPlaybackSince = null;
        continue;
      }
      let snapshot: PalazzoPlaybackState | null = null;
      try {
        snapshot = (await this.telemetry.currentState?.(programId)) ?? null;
      } catch {
        snapshot = null;
      }
      if (!snapshot) {
        this.metrics.recordEngineResync('watchdog', 'unavailable');
        continue;
      }
      const spot = state.announcedSpotOnAir;
      if (spot && Date.now() - spot.since < ANNOUNCED_SPOT_PLAYBACK_MS) {
        // The announced song waits for the spot's end (palazzo#50): a spot on
        // air is playback, not the silence the watchdog recovers from.
        state.noPlaybackSince = null;
        continue;
      }
      const reading = watchdogReading(snapshot);
      if (reading !== 'nothing_on_air') {
        state.noPlaybackSince = null;
        if (reading === 'unknown')
          this.metrics.recordEngineResync('watchdog', 'undecided');
        continue;
      }
      const now = Date.now();
      if (state.noPlaybackSince === null) {
        state.noPlaybackSince = now;
        continue;
      }
      if (now - state.noPlaybackSince < NO_PLAYBACK_BOUND_MS) continue;
      state.noPlaybackSince = null;
      this.logger.warn(
        `Palazzo has reported nothing on the air on ${programId} for ${NO_PLAYBACK_BOUND_MS / 1000} s or more; resuming the rotation`,
      );
      const before = state.activeSong;
      this.handlePalazzoSnapshot(programId, snapshot);
      const idle = this.resumeIdleReason(programId, state, before);
      if (idle) {
        // gaulatti/alcantara#233: a resume that changed nothing looked like a
        // real one, which hid the 2026-11-21 00:28Z stall.
        this.logger.warn(
          `Watchdog resume commanded nothing on ${programId}: ${idle}`,
        );
        this.metrics.recordEngineResync('watchdog', 'resumed_no_command');
      } else {
        this.metrics.recordEngineResync('watchdog', 'resumed');
      }
    }
  }

  /**
   * Why a watchdog resume left the rotation as it was, or null when it acted:
   * a song was commanded or started (a new active song or a pending command),
   * or an accepted end is advancing to the next one.
   */
  private resumeIdleReason(
    programId: string,
    state: SongEngineState,
    before: ActiveSong | null,
  ):
    | 'held_song'
    | 'queue_blocked'
    | 'clocked_log'
    | 'foreign_track'
    | 'no_successor'
    | null {
    if (state.transitioning || state.pendingRequestIds.size) return null;
    if (state.activeSong && state.activeSong !== before) return null;
    if (state.activeSong) return 'held_song';
    if (state.queueBlocked) return 'queue_blocked';
    if (this.flightService.isClockedLogRunning(programId)) return 'clocked_log';
    if (state.busyWithForeignTrack) return 'foreign_track';
    return 'no_successor';
  }

  handlePalazzoSnapshot(
    programId: string,
    snapshot: PalazzoPlaybackState,
  ): void {
    if (!this.isRadioCapable(programId)) return;
    const state = this.ensureState(programId);
    state.reconciled = true;
    state.frozen = false;
    state.palazzoBootId = snapshot.bootId;
    state.palazzoCapabilities = snapshot.capabilities ?? [];

    if (snapshot.status === 'playing' && snapshot.track) {
      // Palazzo plays: a run of failed commands is over (#230).
      state.commandRetries = 0;
      this.reconcilePlayingSnapshot(programId, state, snapshot);
    } else {
      this.reconcileIdleSnapshot(programId, state, snapshot);
    }
  }

  /**
   * Whether a Palazzo instant is one of this engine's bumper spots, sent and not yet started. A read only, for the
   * program bus overlap check (gaulatti/alcantara#242), asked before the event is handled.
   */
  isBumperSpot(programId: string, playbackId: string): boolean {
    return (
      this.states.get(programId)?.bumperSpotsSent?.has(playbackId) ?? false
    );
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
          type: 'playout.request_failed';
          data: { playbackRequestId: string; reason?: string };
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
        }
      | {
          type: 'playout.next_withdrawn';
          data: { playbackId: string; reason: string };
        }
      | {
          type: 'instant.started' | 'instant.ended';
          data: { playbackId: string; programId?: string | null };
        },
  ): void {
    if (!this.isRadioCapable(programId)) return;
    const state = this.states.get(programId);
    if (!state) return;

    if (event.type === 'playout.next_withdrawn') {
      this.handleNextWithdrawn(programId, state, event.data);
      return;
    }

    if (event.type === 'instant.started') {
      this.handleInstantStarted(programId, state, event.data.playbackId);
      return;
    }
    if (event.type === 'instant.ended') {
      if (state.announcedSpotOnAir?.playbackId === event.data.playbackId) {
        state.announcedSpotOnAir = null;
      }
      return;
    }

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
    if (event.type === 'playout.request_failed') {
      this.handleSongRequestFailed(programId, state, event.data);
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
        // A snapshot may already have recorded this start (gaulatti/alcantara#716): the late event
        // then keeps that start and position, and is not recorded again.
        const alreadyStarted = activeSong.authoritativeStartedAt !== null;
        const startedAt = activeSong.authoritativeStartedAt ?? Date.now();
        if (!alreadyStarted) {
          activeSong.authoritativeStartedAt = startedAt;
          activeSong.authoritativePositionMs = 0;
          activeSong.authoritativeUpdatedAt = Date.now();
        }
        // A song on the air ends a run of failed commands (#230).
        state.commandRetries = 0;
        this.metrics.recordTrackTransition('adopted');
        this.recordHighRotationStarted(programId, state, activeSong, startedAt);
        this.emitPlaybackUpdate(programId, activeSong);
        if (!alreadyStarted) {
          this.emitTrackEvent(
            programId,
            event.type,
            requestId,
            event.data,
            false,
            undefined,
            undefined,
            activeSong.actor,
          );
        }
        this.refreshAnnouncement(programId);
      } else if (this.acceptAnnouncedStart(programId, state, requestId)) {
        // The announced song started, under overlap or at the handoff.
      } else if (state.pendingRequestIds.has(requestId)) {
        // A command is confirmed after another song (for example a manual
        // one) replaced it. It is not the engine's song on air, so nothing is
        // emitted for the as-run log.
        this.metrics.recordTrackTransition('adopted');
      } else {
        this.metrics.recordTrackTransition('ignored-mismatch');
      }
      return;
    }

    // track.ended: every other event type returned above, but TypeScript does
    // not narrow `event.data` through the intro branch.
    const ended = event as Extract<typeof event, { type: 'track.ended' }>;
    // A play the engine already closed (superseded) is not closed again.
    const closed = state.activeSong?.asRunClosed === true;
    // Only an accepted end is emitted; ignored ends (duplicate, mismatched,
    // frozen, no active song) must not count as a play downstream.
    if (
      this.handleAuthoritativeTrackEnded(programId, state, requestId) &&
      !closed
    ) {
      this.emitTrackEvent(programId, ended.type, requestId, ended.data);
    }
  }

  private emitTrackEvent(
    programId: string,
    type: SongEngineTrackEvent['type'],
    playbackRequestId: string,
    data: { title?: string | null; artist?: string | null; url?: string },
    inferred = false,
    endReason?: SongEngineEndReason,
    at = new Date(),
    actor: Actor | null = null,
  ): void {
    try {
      this.trackEventsSubject.next({
        programId,
        type,
        playbackRequestId,
        title: typeof data.title === 'string' ? data.title : null,
        artist: typeof data.artist === 'string' ? data.artist : null,
        url: typeof data.url === 'string' ? data.url : null,
        at,
        ...(inferred ? { inferred: true as const } : {}),
        ...(endReason ? { endReason } : {}),
        ...ActorContext.eventFields(actor),
      });
    } catch (error) {
      this.logger.error(
        `Track event subscriber failed on ${programId}: ${String(error)}`,
      );
    }
  }

  /**
   * Palazzo could not load the song it was sent (palazzo#42), so it never went
   * on air: it gets no as-run record, the operator is told, and the sequence
   * moves on as at a natural end. Anything but the active, not yet started
   * song (an unknown request, a duplicate, a song on air) is ignored.
   */
  private handleSongRequestFailed(
    programId: string,
    state: SongEngineState,
    data: { playbackRequestId: string; reason?: string },
  ): void {
    const song = state.activeSong;
    if (
      !song ||
      song.playbackRequestId !== data.playbackRequestId ||
      song.authoritativeStartedAt !== null
    ) {
      this.metrics.recordTrackTransition('ignored-mismatch');
      return;
    }
    const reason: SongRequestFailureReason =
      data.reason === 'timeout' ? 'timeout' : 'other';
    song.asRunClosed = true;
    this.metrics.recordSongRequestFailure(reason);
    this.emit({
      type: 'song_request_failed',
      programId,
      playbackRequestId: song.playbackRequestId,
      title: song.title,
      artist: song.artist,
      reason,
      failedAt: new Date().toISOString(),
    });
    this.handleAuthoritativeTrackEnded(
      programId,
      state,
      song.playbackRequestId,
    );
  }

  /**
   * Closes a started song's play for the as-run log when the engine itself
   * ends it (Stop, manual cut, superseding snapshot), once per play. A song
   * Palazzo never confirmed was not on air and gets no record.
   */
  private closePlayForAsRun(
    programId: string,
    song: ActiveSong,
    endReason: SongEngineEndReason,
    actor: Actor | null = null,
  ): void {
    if (song.authoritativeStartedAt === null || song.asRunClosed) return;
    song.asRunClosed = true;
    this.emitTrackEvent(
      programId,
      'track.ended',
      song.playbackRequestId,
      { title: song.title, artist: song.artist, url: song.audioUrl },
      endReason === 'superseded',
      endReason,
      undefined,
      actor,
    );
  }

  // ---------------------------------------------------------------------
  // Next-song announcement (contract gaulatti/palazzo#40)
  // ---------------------------------------------------------------------

  /**
   * Re-evaluates the announced successor of the active song, serialised per
   * program. Announcing never affects playback: any failure leaves today's
   * handoff by command.
   */
  private refreshAnnouncement(programId: string): void {
    const state = this.states.get(programId);
    if (!state || !this.isRadioCapable(programId)) return;
    state.announcementChain = state.announcementChain
      .then(() => this.updateAnnouncement(programId, state))
      .catch((error: unknown) => {
        this.logger.warn(
          `Next-song announcement skipped on ${programId}: ${String(error)}`,
        );
      });
  }

  private async updateAnnouncement(
    programId: string,
    state: SongEngineState,
  ): Promise<void> {
    const song = state.activeSong;
    // Only while a started song plays; never withdraw during a handoff.
    if (!song || song.authoritativeStartedAt === null || song.asRunClosed) {
      return;
    }
    // The successor is chosen once and held, so it is not chosen while the
    // similarity index is still loading: right after a restart its map is
    // empty, every pick falls back to the playlist cursor, and that choice
    // would air at the end (#277: both restarts of 2026-11-22 replayed the
    // stored cursor song). The announcement waits for the index, never longer
    // than SIMILARITY_READY_WAIT_MS, and never blocks anything: it is run
    // again when the index is ready or the bound passes.
    if (this.similarity && !this.similarity.isReady()) {
      const waitingSince = (state.similarityWaitSince ??= Date.now());
      const left = SIMILARITY_READY_WAIT_MS - (Date.now() - waitingSince);
      if (left > 0) {
        // One pending wait per program, however many callers refresh the
        // announcement meanwhile; a new song replaces it.
        if (state.similarityWait?.song !== song) {
          this.clearSimilarityWait(state);
          const rerun = () => {
            this.clearSimilarityWait(state);
            this.refreshAnnouncement(programId);
          };
          const timer = setTimeout(rerun, left);
          timer.unref();
          state.similarityWait = { timer, song };
          void this.similarity.whenReady().then(() => {
            if (state.similarityWait?.timer === timer) rerun();
          });
        }
        return;
      }
      if (!state.similarityWaitWarned) {
        state.similarityWaitWarned = true;
        this.logger.warn(
          `Similarity index not ready after ${SIMILARITY_READY_WAIT_MS / 1000} s on ${programId}; the next song is announced from the playlist cursor`,
        );
      }
    }
    const found = await this.announceableSuccessor(programId, state, song);
    if (state.activeSong !== song) {
      this.countAnnouncementSkip(state, song, 'superseded');
      return;
    }
    const successor = 'skip' in found ? null : found;
    if ('skip' in found) this.countAnnouncementSkip(state, song, found.skip);
    const current =
      state.announcement?.forRequestId === song.playbackRequestId
        ? state.announcement
        : null;
    // An announced song Palazzo already started is on air: nothing to change.
    if (
      current &&
      (current.startedAt !== null ||
        (current.replaces && current.replaces.startedAt !== null))
    ) {
      return;
    }
    if (!successor) {
      state.announcement = null;
      if (current && (current.status !== 'not-announced' || current.replaces)) {
        await this.radioService.withdrawNext(programId);
      }
      return;
    }
    const { leaf, queueEntryId, bumper, selectAt, cycleReset, effects } =
      successor;
    if (
      current &&
      current.itemId === leaf.id &&
      current.queueEntryId === queueEntryId &&
      current.audioUrl === leaf.audioUrl &&
      (current.bumper?.playbackId ?? null) === (bumper?.playbackId ?? null)
    ) {
      return;
    }
    const announcement: NextAnnouncement = {
      playbackId: randomUUID(),
      forRequestId: song.playbackRequestId,
      itemId: leaf.id,
      queueEntryId,
      audioUrl: leaf.audioUrl,
      title: leaf.title,
      artist: leaf.artist,
      status: 'pending',
      startedAt: null,
      // A refused announcement may still hold the previous one, on air.
      replaces:
        current?.status === 'accepted' ? current : (current?.replaces ?? null),
      bumper,
      selectAt,
      leaf: selectAt === null ? null : leaf,
      cycleReset,
      effects,
    };
    state.announcement = announcement;
    this.rememberSong(state, announcement.playbackId, leaf.songId);
    let result: Awaited<ReturnType<RadioService['announceNext']>>;
    try {
      result = await this.radioService.announceNext(
        programId,
        {
          playbackId: announcement.playbackId,
          url: leaf.audioUrl,
          title: leaf.title,
          artist: leaf.artist,
          coverUrl: leaf.coverUrl,
        },
        bumper
          ? { playbackId: bumper.playbackId, url: bumper.audioUrl }
          : undefined,
      );
    } catch (error) {
      this.logger.warn(
        `Next-song announcement failed on ${programId}: ${String(error)}`,
      );
      result = 'rejected';
    }
    if (state.announcement !== announcement) return;
    announcement.status = result === 'accepted' ? 'accepted' : 'not-announced';
    if (result !== 'accepted')
      this.countAnnouncementSkip(state, song, 'refused');
    if (result === 'unsupported') {
      state.nextUnsupportedBootId = state.palazzoBootId;
    }
    const replaced = announcement.replaces;
    // Accepted: Palazzo replaced the previous announcement.
    if (result === 'accepted') {
      announcement.replaces = null;
      if (bumper) {
        this.rememberBumperSpot(
          state,
          bumper.playbackId,
          bumper.name,
          'announced',
        );
      }
      return;
    }
    // Refused: Palazzo keeps the previous one, so withdraw it now rather than
    // let it play and be preempted audibly at the handoff. If it was too late
    // (its gate already opened, so it is on air) or the outcome is unknown, it
    // stays known: its start is then recorded and the handoff preempts it.
    if (replaced?.startedAt === null) {
      const withdrawn = await this.radioService.withdrawNext(programId);
      if (withdrawn === true) announcement.replaces = null;
    }
  }

  /**
   * The successor to announce, or why there is none. At a bumper slot the
   * successor is announced with the slot's spot when Palazzo lists
   * `next.bumper` (gaulatti/palazzo#50); without it the slot is skipped as
   * before, and the spot plays after the end with the song by command.
   */
  private async announceableSuccessor(
    programId: string,
    state: SongEngineState,
    song: ActiveSong,
  ): Promise<
    | {
        leaf: ProgramResolvedSongLeaf & { audioUrl: string };
        queueEntryId: string | null;
        bumper: BumperChoice | null;
        selectAt: number | null;
        cycleReset: boolean;
        effects: (() => void)[];
      }
    | { skip: AnnouncementSkipReason }
  > {
    if (
      state.nextUnsupportedBootId !== undefined &&
      state.nextUnsupportedBootId === state.palazzoBootId
    ) {
      return { skip: 'unsupported' };
    }
    if (
      state.sequence?.mode !== 'autoplay' &&
      state.sequence?.mode !== 'shuffle'
    ) {
      return { skip: 'not_autoplay' };
    }
    if (this.flightService.isClockedLogRunning(programId)) {
      return { skip: 'clocked_log' };
    }
    const held =
      state.announcement?.forRequestId === song.playbackRequestId
        ? state.announcement.selectAt
        : null;
    const successor = this.peekSuccessor(programId, state, song, held);
    if ('skip' in successor) {
      this.logger.log(
        `Next song not announced on ${programId}: ${successor.skip} (${successor.detail})`,
      );
      return { skip: successor.skip };
    }
    const settings = await this.radioService.getRadioSettings(programId);
    let bumper: BumperChoice | null = null;
    if (
      settings?.bumperEnabled &&
      settings.bumperInterval &&
      settings.bumperInstantIds.length &&
      (state.songCount + 1) % settings.bumperInterval === 0
    ) {
      if (!state.palazzoCapabilities?.includes(PALAZZO_NEXT_BUMPER)) {
        return { skip: 'bumper_slot' };
      }
      bumper = await this.chooseBumper(state, settings, song.playbackRequestId);
      // The slot's spot was not found or has no audio: a separate reason, so
      // the counter tells it from a Palazzo without `next.bumper`.
      if (!bumper) return { skip: 'bumper_unavailable' };
    }
    if (await this.hasIntro(programId, successor.leaf.songId)) {
      return { skip: 'intro' };
    }
    return { ...successor, bumper };
  }

  /**
   * The spot for the bumper slot at the end of `forRequestId`, chosen once per
   * song by the same rule as maybeBumper (sequential or random over
   * bumperInstantIds), so a refreshed announcement keeps its spot. The
   * sequence advances only when the spot is used (consumeBumper).
   */
  private async chooseBumper(
    state: SongEngineState,
    settings: { bumperInstantIds: number[]; bumperMode?: string | null },
    forRequestId: string,
  ): Promise<BumperChoice | null> {
    if (state.bumperChoice?.forRequestId === forRequestId) {
      return state.bumperChoice;
    }
    const ids = settings.bumperInstantIds;
    const index = this.bumperIndex(state, settings);
    const instant = await this.prisma.instant.findUnique({
      where: { id: ids[index] },
    });
    if (!instant?.audioUrl) return null;
    state.bumperChoice = {
      forRequestId,
      index,
      instantId: instant.id,
      name: instant.name,
      audioUrl: instant.audioUrl,
      playbackId: randomUUID(),
    };
    return state.bumperChoice;
  }

  /** The next spot's index in bumperInstantIds, without advancing. */
  private bumperIndex(
    state: SongEngineState,
    settings: { bumperInstantIds: number[]; bumperMode?: string | null },
  ): number {
    const length = settings.bumperInstantIds.length;
    return settings.bumperMode === 'random'
      ? Math.floor(Math.random() * length)
      : state.nextBumperIdx % length;
  }

  /** Counts, once per song, why it was left without an announced successor. */
  private countAnnouncementSkip(
    state: SongEngineState,
    song: ActiveSong,
    reason: AnnouncementSkipReason,
  ): void {
    if (state.skipCountedFor === song.playbackRequestId) return;
    state.skipCountedFor = song.playbackRequestId;
    try {
      this.metrics.recordAnnouncementSkipped(reason);
    } catch {
      // Metrics are best-effort.
    }
  }

  /**
   * What `playNext` will select when `song` ends, without consuming anything:
   * the queue head after `song`'s own entry, or the sequence selection run on
   * a copy of the cursor advanced as the end advances it, with no metrics or
   * similarity decisions recorded. Selection itself is unchanged; the result
   * is a prediction that `playNext` checks at the end.
   */
  private peekSuccessor(
    programId: string,
    state: SongEngineState,
    song: ActiveSong,
    heldSelectAt?: number | null,
  ):
    | {
        leaf: ProgramResolvedSongLeaf & { audioUrl: string };
        queueEntryId: string | null;
        /** The instant a playlist successor was selected for; null for a queue head. */
        selectAt: number | null;
        /** The similarity pick's cycle reset (false for a queue head). */
        cycleReset: boolean;
        /** The selection's deferred metric and decision records. */
        effects: (() => void)[];
      }
    | {
        skip: 'no_successor' | 'queue_head_active';
        detail: string;
      } {
    const { next, hasSuccessor } = this.sequenceAfterEnd(state.sequence, song);
    const head = state.queue.find((entry) => entry.id !== song.queueEntryId);
    if (head) {
      if (head.active) {
        return { skip: 'queue_head_active', detail: 'queue head on air' };
      }
      const leaf = findUniqueProgramSongLeafById(next, head.itemId);
      return leaf?.audioUrl
        ? {
            leaf: leaf as ProgramResolvedSongLeaf & { audioUrl: string },
            queueEntryId: head.id,
            selectAt: null,
            cycleReset: false,
            effects: [],
          }
        : { skip: 'no_successor', detail: 'queue head not resolved' };
    }
    if (!hasSuccessor) {
      return { skip: 'no_successor', detail: 'sequence has no successor' };
    }
    const now = Date.now();
    // Only a started song is announced from (updateAnnouncement).
    // From Palazzo's last position report when there is one: its position is
    // file-relative and its remaining is cut at cue-out, so durationMs ends at
    // cue-out on the file's clock and start + durationMs would be late by the
    // cue-in (#234). Position and remaining together give the real end.
    const reportedEnd =
      song.authoritativePositionMs !== null &&
      song.authoritativeUpdatedAt !== null
        ? song.authoritativeUpdatedAt +
          (song.durationMs - song.authoritativePositionMs)
        : (song.authoritativeStartedAt as number) + song.durationMs;
    // Chosen once, for the expected end, and held: a refresh for the same
    // song selects at the same instant, and the handoff plays this choice
    // (playNext selects at the announcement's `selectAt`). A favourite that
    // comes due between this instant and the real end waits for the next
    // change, rather than every song near a due favourite going unannounced.
    const selectAt = heldSelectAt ?? Math.max(now, reportedEnd);
    const { next: probe } = this.sequenceAfterEnd(state.sequence, song);
    // hasSuccessor implies a sequence.
    restampSequence(probe as ProgramSongSequence, Date.now(), selectAt);
    const view = {
      ...state,
      sequence: probe,
      lastEnded: { songId: song.songId, artist: song.artist },
      pendingCycleReset: false,
    };
    const effects: (() => void)[] = [];
    const leaf = this.selectionView(effects).resolveNextPlaylistSong(
      programId,
      view,
      selectAt,
    );
    if (!leaf?.audioUrl) {
      return { skip: 'no_successor', detail: 'nothing resolves at the end' };
    }
    return {
      leaf: leaf as ProgramResolvedSongLeaf & { audioUrl: string },
      queueEntryId: null,
      selectAt,
      cycleReset: view.pendingCycleReset,
      effects,
    };
  }

  /**
   * This engine's selection code with its metrics and similarity decision
   * log deferred, so a peek runs the exact same selection without recording
   * anything. Each deferred record is pushed to `deferred`, to be applied if
   * that selection is the one played (a held announcement at its handoff).
   */
  private selectionView(deferred: (() => void)[] = []): this {
    const metrics = this.metrics as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const deferredMetrics = new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          (...args: unknown[]) => {
            deferred.push(() => metrics[name](...args));
          },
      },
    );
    const view = Object.create(this) as this;
    Object.defineProperty(view, 'metrics', { value: deferredMetrics });
    const similarity = this.similarity;
    Object.defineProperty(view, 'similarity', {
      value:
        similarity &&
        Object.create(similarity, {
          recordDecision: {
            value: (
              ...args: Parameters<SongSimilarityService['recordDecision']>
            ) => {
              deferred.push(() => similarity.recordDecision(...args));
            },
          },
        }),
    });
    return view;
  }

  /** Whether the song command for this song would carry an intro. */
  private async hasIntro(
    programId: string,
    songId: number | undefined,
  ): Promise<boolean> {
    if (!Number.isInteger(songId) || (songId as number) <= 0) return false;
    const assignment = await this.prisma.songIntro.findUnique({
      where: { songId: songId as number },
      include: {
        instant: { select: { audioUrl: true, volume: true, enabled: true } },
      },
    });
    return Boolean(
      assignment?.programId === programId &&
      assignment.instant.enabled &&
      assignment.instant.audioUrl.trim(),
    );
  }

  /**
   * Accepts the announced song's start while the previous song still plays
   * (overlap) or before promotion, and records it once. A start of an
   * announced song that already lost the handoff race is recorded as started
   * and preempted. Returns false for any other request.
   */
  private acceptAnnouncedStart(
    programId: string,
    state: SongEngineState,
    requestId: string,
  ): boolean {
    const announcement = [
      state.announcement,
      state.announcement?.replaces,
    ].find(
      (candidate) =>
        candidate?.status === 'accepted' &&
        candidate.playbackId === requestId &&
        candidate.startedAt === null,
    );
    if (announcement) {
      announcement.startedAt = Date.now();
      this.metrics.recordTrackTransition('adopted');
      this.emitTrackEvent(programId, 'track.started', requestId, {
        title: announcement.title,
        artist: announcement.artist,
        url: announcement.audioUrl,
      });
      return true;
    }
    const index = state.preemptedRequestIds.indexOf(requestId);
    if (index < 0) return false;
    state.preemptedRequestIds.splice(index, 1);
    this.emitTrackEvent(programId, 'track.started', requestId, {});
    this.emitTrackEvent(
      programId,
      'track.ended',
      requestId,
      {},
      false,
      'preempted',
    );
    return true;
  }

  /**
   * `not_ready` before the handoff is answered like a 422: the next song goes
   * by command. If the engine already promoted the song and it never started,
   * the engine sends it now as today's song command. Other reasons follow the
   * engine's own commands, which already forgot the announcement.
   */
  private handleNextWithdrawn(
    programId: string,
    state: SongEngineState,
    data: { playbackId: string; reason: string },
  ): void {
    if (data.reason !== 'not_ready') return;
    const announcement = state.announcement;
    if (
      announcement?.playbackId === data.playbackId &&
      announcement.startedAt === null
    ) {
      announcement.status = 'not-announced';
      return;
    }
    const song = state.activeSong;
    if (
      !song?.promoted ||
      song.playbackRequestId !== data.playbackId ||
      song.authoritativeStartedAt !== null
    ) {
      return;
    }
    const playbackRequestId = randomUUID();
    state.pendingRequestIds.delete(song.playbackRequestId);
    state.pendingRequestIds.add(playbackRequestId);
    // A new command restarts the watchdog's bound (#230).
    state.noPlaybackSince = null;
    song.playbackRequestId = playbackRequestId;
    song.promoted = false;
    this.rememberSong(state, playbackRequestId, song.songId);
    this.logger.log(
      `Announced song was not ready on ${programId}; commanding it (${playbackRequestId})`,
    );
    void this.pushCommand(
      programId,
      playbackRequestId,
      song.audioUrl,
      song.title,
      song.artist,
      song.coverUrl,
      song.songId ?? undefined,
    );
  }

  /**
   * Forgets the announcement after an operator command that Palazzo answers
   * by flushing it. An announced song that had already started is closed
   * like the active song.
   */
  private forgetAnnouncement(
    programId: string,
    state: SongEngineState,
    endReason: 'stopped' | 'replaced',
    actor: Actor | null = null,
  ): void {
    const announcement = state.announcement;
    state.announcement = null;
    for (const candidate of [announcement, announcement?.replaces]) {
      if (candidate?.startedAt == null) continue;
      this.emitTrackEvent(
        programId,
        'track.ended',
        candidate.playbackId,
        {
          title: candidate.title,
          artist: candidate.artist,
          url: candidate.audioUrl,
        },
        false,
        endReason,
        undefined,
        actor,
      );
    }
  }

  /**
   * Preempts the announcement and the one it replaces, unless Palazzo never
   * queued them. Returns whether an accepted announcement lost the handoff.
   */
  private preemptAnnouncedSongs(
    programId: string,
    state: SongEngineState,
    announcement: NextAnnouncement,
  ): boolean {
    let raced = false;
    for (const candidate of [announcement, announcement.replaces]) {
      if (!candidate || candidate.status === 'not-announced') continue;
      raced ||= candidate.status === 'accepted';
      this.preemptAnnouncedSong(programId, state, candidate);
    }
    return raced;
  }

  /**
   * Records an announced song that lost the handoff: started and preempted,
   * now if its start arrived, or when it arrives.
   */
  private preemptAnnouncedSong(
    programId: string,
    state: SongEngineState,
    announcement: NextAnnouncement,
  ): void {
    if (announcement.startedAt !== null) {
      this.emitTrackEvent(
        programId,
        'track.ended',
        announcement.playbackId,
        {
          title: announcement.title,
          artist: announcement.artist,
          url: announcement.audioUrl,
        },
        false,
        'preempted',
      );
      return;
    }
    state.preemptedRequestIds.push(announcement.playbackId);
    if (state.preemptedRequestIds.length > MAX_PREEMPTED_REQUEST_IDS) {
      state.preemptedRequestIds.shift();
    }
  }

  /** At an end that commands nothing itself, keeps the announced song off air. */
  private releaseAnnouncementAtEnd(programId: string): void {
    const state = this.states.get(programId);
    const announcement = state?.announcement;
    if (!state || !announcement) return;
    state.announcement = null;
    if (announcement.status === 'not-announced' && !announcement.replaces) {
      return;
    }
    this.preemptAnnouncedSongs(programId, state, announcement);
    void Promise.resolve()
      .then(() => this.radioService.withdrawNext(programId))
      .catch((error: unknown) => {
        this.logger.warn(
          `Next-song withdrawal failed on ${programId}: ${String(error)}`,
        );
      });
  }

  /** Counts a handoff; a metrics failure never affects playout. */
  private recordHandoff(path: HandoffPath): void {
    try {
      this.metrics.recordHandoff(path);
    } catch {
      // Metrics are best-effort.
    }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * The playing snapshot is the first sign that the commanded song started: it
   * does what its `track.started` would have, with one inferred as-run start at
   * Palazzo's reported time, else now. A late event adds no second row: the
   * as-run log keeps one per play and state.
   */
  private inferMissedStart(
    programId: string,
    state: SongEngineState,
    song: ActiveSong,
  ): void {
    const startedAt = song.authoritativeStartedAt ?? Date.now();
    song.authoritativeStartedAt = startedAt;
    state.pendingRequestIds.delete(song.playbackRequestId);
    this.recordHighRotationStarted(programId, state, song, startedAt);
    this.emitTrackEvent(
      programId,
      'track.started',
      song.playbackRequestId,
      { title: song.title, artist: song.artist, url: song.audioUrl },
      true,
      undefined,
      new Date(startedAt),
      song.actor,
    );
  }

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
      // No start yet: its event was missed, for example a song commanded while
      // the telemetry stream was reconnecting (gaulatti/alcantara#716).
      const startMissed =
        song.authoritativeStartedAt === null && !song.asRunClosed;
      const startedAt = Date.parse(snapshot.track?.startedAt ?? '');
      if (Number.isFinite(startedAt)) {
        song.authoritativeStartedAt = startedAt;
      }
      song.authoritativePositionMs = Math.round(
        snapshot.positionSeconds * 1000,
      );
      song.authoritativeUpdatedAt = Date.now();
      state.busyWithForeignTrack = false;
      if (startMissed) this.inferMissedStart(programId, state, song);
      this.emitPlaybackUpdate(programId, song);
      return;
    }

    // A track whose end this engine already accepted is not on air: a state
    // read just after the end can still name it (Palazzo's own state lags its
    // journal). Adopting it would hold an ended song and stall the rotation
    // (2026-11-21 00:28Z), so it is read as the idle state it is.
    if (requestId && state.endedRequestIds.includes(requestId)) {
      this.logger.warn(
        `Palazzo's state still names ended playback ${requestId} on ${programId}; reading it as idle`,
      );
      this.reconcileIdleSnapshot(programId, state, {
        ...snapshot,
        status: 'idle',
        track: null,
      });
      return;
    }

    // The announced song Palazzo started itself is expected, not a takeover.
    const announcement = state.announcement;
    if (
      announcement?.status === 'accepted' &&
      announcement.playbackId === requestId
    ) {
      if (announcement.startedAt === null) {
        // Its start event has not arrived: as on adoption (#174), record one
        // inferred start at Palazzo's reported start time, else now.
        // A playing snapshot always reports its track.
        const reported = Date.parse(snapshot.track!.startedAt);
        announcement.startedAt = Number.isFinite(reported)
          ? reported
          : Date.now();
        this.emitTrackEvent(
          programId,
          'track.started',
          requestId,
          {
            title: announcement.title,
            artist: announcement.artist,
            url: announcement.audioUrl,
          },
          true,
          undefined,
          new Date(announcement.startedAt),
        );
      }
      return;
    }

    // Palazzo is playing another track, so the active song is no longer on air.
    if (state.activeSong) {
      this.closePlayForAsRun(programId, state.activeSong, 'superseded');
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

    const playingUrl = snapshot.track?.url ?? '';
    const uniqueLeaf = findUniqueProgramSongLeafByAudioUrl(
      state.sequence,
      playingUrl,
    );
    // The audio is in the sequence more than once, or not as one leaf: the
    // leaf the cursor points at is still the song on air when its audio is the
    // one playing (#277), so its end moves the cursor like any playlist song.
    const cursorLeaf = uniqueLeaf
      ? null
      : this.cursorLeafPlaying(state, playingUrl, null);
    const inheritedSong = uniqueLeaf ?? cursorLeaf;
    if (requestId && inheritedSong?.audioUrl) {
      const path: InheritedAdoptionPath = uniqueLeaf ? 'leaf' : 'cursor_leaf';
      this.metrics.recordInheritedAdoption(path);
      const inheritedQueueEntry =
        state.queue[0]?.active === true &&
        state.queue[0].playbackRequestId === requestId &&
        state.queue[0].itemId === inheritedSong.id
          ? state.queue[0]
          : null;
      this.adoptPlayingTrack(
        programId,
        state,
        snapshot,
        requestId,
        {
          token: `${inheritedSong.id}:${inheritedSong.audioUrl}`,
          audioUrl: inheritedSong.audioUrl,
          artist: inheritedSong.artist,
          title: inheritedSong.title,
          coverUrl: inheritedSong.coverUrl,
          durationMs: inheritedSong.durationMs ?? 300000,
          itemId: inheritedSong.id,
          songId: inheritedSong.songId ?? null,
          queueEntryId: inheritedQueueEntry?.id ?? null,
          highRotation: inheritedSong.highRotation === true,
        },
        undefined,
        `path=${path} urlMatches=${countProgramSongLeavesByAudioUrl(state.sequence, playingUrl)}`,
      );
      return;
    }

    // A track we did not command is playing: withhold every command at once, so
    // there is never double audio, while it is identified (#272). Palazzo is
    // commanded only by Alcantara, so a track this process did not command is
    // one an earlier process commanded or announced: if the catalogue knows
    // its audio it is recorded as our own song, otherwise it stays withheld and
    // is reported once with what Palazzo says is playing.
    state.busyWithForeignTrack = true;
    state.withheldRequestId = requestId;
    if (requestId && !state.inheritedLookups.has(requestId)) {
      state.inheritedLookups.add(requestId);
      if (state.inheritedLookups.size > MAX_ENDED_REQUEST_IDS) {
        state.inheritedLookups.delete(
          state.inheritedLookups.values().next().value as string,
        );
      }
      void this.recogniseInheritedTrack(programId, state, snapshot, requestId);
    }
  }

  /**
   * Looks the playing track up by its audio URL in the song catalogue (#272).
   * Exactly one song must match, and the track must still be the one withheld
   * (not ended, not replaced by another uncommanded track, no active song of
   * our own) when the answer arrives; anything else is left withheld and
   * reported, never recorded as a guess. A FAILED lookup (the database
   * unreachable or throttled) is tried again, INHERITED_LOOKUP_ATTEMPTS times
   * in all, and reported only after the last failure; no match or several
   * matches are final at once.
   */
  private async recogniseInheritedTrack(
    programId: string,
    state: SongEngineState,
    snapshot: PalazzoPlaybackState,
    requestId: string,
    attempt = 1,
    receivedAt = Date.now(),
  ): Promise<void> {
    const url = snapshot.track?.url ?? '';
    let lookupFailed = false;
    let matches: {
      id: number;
      title: string;
      artist: string;
      audioUrl: string;
      coverUrl: string | null;
      durationMs: number | null;
    }[] = [];
    if (url) {
      try {
        matches = await this.prisma.song.findMany({
          where: { audioUrl: url },
          select: {
            id: true,
            title: true,
            artist: true,
            audioUrl: true,
            coverUrl: true,
            durationMs: true,
          },
          take: 2,
        });
      } catch {
        lookupFailed = true;
      }
    }
    // The track ended, another uncommanded track replaced it, or the engine
    // took on a song, while the lookup ran.
    if (!this.stillWithheld(state, requestId)) return;
    if (lookupFailed && attempt < INHERITED_LOOKUP_ATTEMPTS) {
      this.scheduleInheritedRetry(
        programId,
        state,
        snapshot,
        requestId,
        attempt,
        receivedAt,
      );
      return;
    }
    if (matches.length === 1) {
      const song = matches[0];
      // The catalogue knows the song by id: a playlist leaf keeps the audio URL
      // it was saved with, which the catalogue may since have changed (2026-11-22:
      // 0 URL matches for songs that did play from the playlist), so the leaf is
      // found by song id as well. The cursor's leaf wins when it is the song;
      // else the only leaf with that song id; two leaves and none of them the
      // cursor's is not decided here and stays a catalogue song.
      const byCursor = this.cursorLeafPlaying(state, song.audioUrl, song.id);
      const byId = collectProgramSongLeaves(state.sequence).filter(
        (candidate) => candidate.songId === song.id,
      );
      const leaf =
        byCursor ??
        (byId.length === 1 && this.isAutomatic(state) ? byId[0] : null);
      if (leaf) {
        this.metrics.recordInheritedAdoption(byCursor ? 'cursor_leaf' : 'leaf');
        this.adoptPlayingTrack(
          programId,
          state,
          snapshot,
          requestId,
          {
            token: `${leaf.id}:${song.audioUrl}`,
            audioUrl: song.audioUrl,
            artist: song.artist,
            title: song.title,
            coverUrl: song.coverUrl ?? '',
            durationMs: song.durationMs ?? 300000,
            itemId: leaf.id,
            songId: song.id,
            queueEntryId: null,
            highRotation: leaf.highRotation === true,
          },
          Date.now() - receivedAt,
          `path=${byCursor ? 'cursor_leaf' : 'leaf'} urlMatches=${countProgramSongLeavesByAudioUrl(state.sequence, song.audioUrl)} songIdMatches=${byId.length}`,
        );
        return;
      }
      this.metrics.recordInheritedAdoption('catalogue');
      this.adoptPlayingTrack(
        programId,
        state,
        snapshot,
        requestId,
        {
          token: `inherited:${song.id}:${song.audioUrl}`,
          audioUrl: song.audioUrl,
          artist: song.artist,
          title: song.title,
          coverUrl: song.coverUrl ?? '',
          durationMs: song.durationMs ?? 300000,
          // Treated as a song picked from outside the playlist: it never moved
          // the cursor, so its end advances nothing and the successor is the
          // one the cursor already points at, never one song skipped.
          itemId: `${CATALOG_ITEM_PREFIX}${song.id}`,
          songId: song.id,
          queueEntryId: null,
          highRotation: false,
        },
        Date.now() - receivedAt,
        `path=catalogue urlMatches=${countProgramSongLeavesByAudioUrl(state.sequence, song.audioUrl)} songIdMatches=${byId.length}`,
      );
      return;
    }
    this.metrics.recordTrackTransition('unidentified');
    const track = snapshot.track;
    this.logger.warn(
      `Palazzo reports a track on ${programId} the engine cannot identify; withholding new commands: ` +
        JSON.stringify({
          requestId,
          title: this.boundedText(track?.title),
          artist: this.boundedText(track?.artist),
          url: this.boundedText(track?.url),
          startedAt: track?.startedAt ?? null,
          positionSeconds: snapshot.positionSeconds,
          catalogueMatches: matches.length,
          ...(lookupFailed ? { catalogueLookup: 'failed' } : {}),
        }),
    );
  }

  /** Whether `requestId` is still the uncommanded track being withheld. */
  private stillWithheld(state: SongEngineState, requestId: string): boolean {
    return (
      !state.activeSong &&
      state.busyWithForeignTrack &&
      state.withheldRequestId === requestId &&
      !state.endedRequestIds.includes(requestId)
    );
  }

  private scheduleInheritedRetry(
    programId: string,
    state: SongEngineState,
    snapshot: PalazzoPlaybackState,
    requestId: string,
    attempt: number,
    receivedAt: number,
  ): void {
    this.clearInheritedRetry(state);
    const delay = Math.min(
      COMMAND_RETRY_BASE_MS * 2 ** (attempt - 1),
      COMMAND_RETRY_MAX_MS,
    );
    state.inheritedRetryRequestId = requestId;
    state.inheritedRetryTimer = setTimeout(() => {
      state.inheritedRetryTimer = null;
      state.inheritedRetryRequestId = '';
      if (!this.stillWithheld(state, requestId)) return;
      void this.recogniseInheritedTrack(
        programId,
        state,
        snapshot,
        requestId,
        attempt + 1,
        receivedAt,
      );
    }, delay);
    state.inheritedRetryTimer.unref();
  }

  private clearInheritedRetry(state: SongEngineState): void {
    if (state.inheritedRetryTimer) clearTimeout(state.inheritedRetryTimer);
    state.inheritedRetryTimer = null;
    state.inheritedRetryRequestId = '';
  }

  private boundedText(value: string | null | undefined): string | null {
    return typeof value === 'string' ? value.slice(0, 200) : null;
  }

  /**
   * Takes a playing track the engine did not command as its own active song:
   * records its start as inferred at Palazzo's reported time (#174), follows it
   * to its end, publishes now-playing and announces its successor, and sends no
   * command over it. Used for a track matching the program sequence and for
   * one recognised in the catalogue (#272).
   */
  /**
   * The leaf the rotation's cursor points at, when it is the song on air: the
   * same audio, or the same catalogue song. Null for a manual sequence, no
   * cursor leaf, or another song.
   */
  private cursorLeafPlaying(
    state: SongEngineState,
    audioUrl: string,
    songId: number | null,
  ): ProgramResolvedSongLeaf | null {
    const sequence = state.sequence;
    if (
      !sequence ||
      (sequence.mode !== 'autoplay' && sequence.mode !== 'shuffle')
    )
      return null;
    const leaf = resolveProgramSongLeaf(sequence, sequence.startedAt);
    if (!leaf?.audioUrl) return null;
    if (leaf.audioUrl === audioUrl) return leaf;
    return songId !== null && leaf.songId === songId ? leaf : null;
  }

  private isAutomatic(state: SongEngineState): boolean {
    return (
      state.sequence?.mode === 'autoplay' || state.sequence?.mode === 'shuffle'
    );
  }

  private adoptPlayingTrack(
    programId: string,
    state: SongEngineState,
    snapshot: PalazzoPlaybackState,
    requestId: string,
    source: {
      token: string;
      audioUrl: string;
      artist: string;
      title: string;
      coverUrl: string;
      durationMs: number;
      itemId: string;
      songId: number | null;
      queueEntryId: string | null;
      highRotation: boolean;
    },
    lookupMs: number | undefined,
    detail: string,
  ): void {
    const reportedMs = Math.max(0, Math.round(snapshot.positionSeconds * 1000));
    const parsedStartedAt = Date.parse(snapshot.track?.startedAt ?? '');
    // After a catalogue lookup the snapshot is old and Palazzo sends no further
    // one on a healthy connection: the position is derived from the reported
    // start, else the snapshot's position plus the time the lookup took.
    const positionMs =
      lookupMs === undefined
        ? reportedMs
        : Number.isFinite(parsedStartedAt)
          ? Math.max(0, Date.now() - parsedStartedAt)
          : reportedMs + Math.max(0, lookupMs);
    const authoritativeStartedAt = Number.isFinite(parsedStartedAt)
      ? parsedStartedAt
      : Date.now() - positionMs;
    this.rememberSong(state, requestId, source.songId);
    state.activeSong = {
      token: source.token,
      playbackRequestId: requestId,
      audioUrl: source.audioUrl,
      artist: snapshot.track?.artist || source.artist,
      title: snapshot.track?.title || source.title,
      coverUrl: snapshot.track?.coverUrl || source.coverUrl,
      durationMs: source.durationMs,
      startedAt: authoritativeStartedAt,
      itemId: source.itemId,
      songId: source.songId,
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
      queueEntryId: source.queueEntryId,
      highRotation: source.highRotation,
    };
    state.busyWithForeignTrack = false;
    this.logger.log(
      `Adopted inherited Palazzo playback ${requestId} on ${programId} (${detail})`,
    );
    this.metrics.recordTrackTransition('adopted');
    this.recordHighRotationStarted(
      programId,
      state,
      state.activeSong,
      authoritativeStartedAt,
    );
    // The play gets its as-run start once (#174), inferred: at Palazzo's
    // reported start time, or the snapshot time when it reports none.
    this.emitTrackEvent(
      programId,
      'track.started',
      requestId,
      {
        title: state.activeSong.title,
        artist: state.activeSong.artist,
        url: state.activeSong.audioUrl,
      },
      true,
      undefined,
      new Date(Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now()),
    );
    this.emitPlaybackActive(programId, state.activeSong);
    void this.publishNowPlaying(programId, state.activeSong);
    this.startProgress(programId);
    // Its successor is announced as for any started song, so a restart in
    // the middle of a song does not cost a commanded (cold) change at its end.
    this.refreshAnnouncement(programId);
  }

  private reconcileIdleSnapshot(
    programId: string,
    state: SongEngineState,
    snapshot: PalazzoPlaybackState,
  ): void {
    const requestId = state.activeSong?.playbackRequestId ?? null;
    // Palazzo is idle: an announced song that has not started is not queued.
    if (state.announcement?.startedAt === null) state.announcement = null;

    if (
      requestId &&
      state.activeSong &&
      state.endedRequestIds.includes(requestId)
    ) {
      // Palazzo is idle and the song held as active already ended once (it
      // was adopted after its end): its end cannot be accepted again, so drop
      // it and resume, rather than hold it on every idle read.
      const song = state.activeSong;
      this.logger.warn(
        `Dropping ended playback ${requestId} held as active on ${programId}; resuming the rotation`,
      );
      if (!song.asRunClosed) {
        song.asRunClosed = true;
        this.emitTrackEvent(
          programId,
          'track.ended',
          requestId,
          { title: song.title, artist: song.artist, url: song.audioUrl },
          true,
        );
      }
      state.activeSong = null;
      this.stopProgress(programId);
    } else if (requestId && state.activeSong) {
      // Authoritative idle state while we believe our song is active: the
      // song ended without a lifecycle event reaching us (e.g. SSE loss).
      const song = state.activeSong;
      if (
        this.handleAuthoritativeTrackEnded(programId, state, requestId) &&
        !song.asRunClosed
      ) {
        // Close the play for the as-run log at the engine's advance time.
        this.emitTrackEvent(
          programId,
          'track.ended',
          requestId,
          { title: song.title, artist: song.artist, url: song.audioUrl },
          true,
        );
      }
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

  /** Returns true only when the end was accepted and the engine advanced. */
  private handleAuthoritativeTrackEnded(
    programId: string,
    state: SongEngineState,
    requestId: string,
  ): boolean {
    if (!requestId) {
      this.metrics.recordTrackTransition('ignored-mismatch');
      return false;
    }
    if (state.endedRequestIds.includes(requestId)) {
      this.metrics.recordTrackTransition('ignored-duplicate');
      return false;
    }
    state.endedRequestIds.push(requestId);
    if (state.endedRequestIds.length > MAX_ENDED_REQUEST_IDS) {
      state.endedRequestIds.shift();
    }
    if (state.inheritedRetryRequestId === requestId) {
      this.clearInheritedRetry(state);
    }

    if (state.frozen) {
      // Palazzo is unavailable; never advance on a stale event.
      this.metrics.recordTrackTransition('ignored-frozen');
      return false;
    }

    if (!state.activeSong || state.activeSong.playbackRequestId !== requestId) {
      state.pendingRequestIds.delete(requestId);
      this.metrics.recordTrackTransition('ignored-no-active');
      if (!state.activeSong && state.busyWithForeignTrack) {
        state.busyWithForeignTrack = false;
        // #230: Palazzo sends no snapshot on a healthy connection, so waiting
        // for one stalled the rotation until the next reconnect. Read the
        // state now and reconcile from it.
        this.logger.warn(
          `Foreign track ended on ${programId}; reading Palazzo's state to resume`,
        );
        void this.resync(programId, 'foreign_ended');
      }
      return false;
    }

    this.metrics.recordTrackTransition('advanced');
    const endedSong = state.activeSong;
    state.lastEnded = { songId: endedSong.songId, artist: endedSong.artist };
    state.activeSong = null;
    // An authoritative end is a command-reconciliation boundary. Palazzo is
    // idle, so no older command can still legitimately be pending.
    state.pendingRequestIds.clear();
    state.songCount++;
    state.busyWithForeignTrack = false;
    const { next: nextSequence, hasSuccessor } = this.sequenceAfterEnd(
      state.sequence,
      endedSong,
    );
    state.transitioning = true;
    this.logger.log(
      `Authoritative end on ${programId}: source=${endedSong.queueEntryId ? 'queue' : 'playlist'} mode=${nextSequence?.mode ?? 'none'} loop=${nextSequence?.loop ?? false} cursor=${nextSequence?.activeItemId ?? 'none'} successor=${hasSuccessor}`,
    );
    // The cursor moved at this end only for a playlist song: a queue entry or a
    // song picked from outside the playlist never moved it.
    const cursorAdvanced =
      !endedSong.queueEntryId &&
      !endedSong.itemId.startsWith(CATALOG_ITEM_PREFIX) &&
      (nextSequence?.mode === 'autoplay' || nextSequence?.mode === 'shuffle');
    void this.continueAfterAuthoritativeEnd(
      programId,
      endedSong.queueEntryId,
      nextSequence,
      hasSuccessor,
      endedSong.playbackRequestId,
    ).finally(() => {
      // After the successor's command (or its promotion), never before it, and
      // never awaited by it (#277).
      if (cursorAdvanced) void this.persistCursorBestEffort(programId);
    });
    return true;
  }

  /**
   * The sequence after `endedSong` ends, on a copy, and whether it has a
   * successor. Shared by the accepted end and by the announcement's peek, so
   * both see the same cursor.
   */
  private sequenceAfterEnd(
    sequence: ProgramSongSequence | null,
    endedSong: ActiveSong,
  ): { next: ProgramSongSequence | null; hasSuccessor: boolean } {
    const next = sequence ? normalizeProgramSongSequence(sequence) : null;
    const isAutomatic = next?.mode === 'autoplay' || next?.mode === 'shuffle';
    // Queue entries and songs picked from outside the playlist never moved
    // the cursor, which already points at the pending successor.
    const hasSuccessor =
      endedSong.queueEntryId || endedSong.itemId.startsWith(CATALOG_ITEM_PREFIX)
        ? Boolean(isAutomatic && resolveProgramSongLeaf(next))
        : Boolean(
            isAutomatic &&
            next &&
            advanceProgramSongSequence(next, endedSong.itemId),
          );
    return { next, hasSuccessor };
  }

  private async continueAfterAuthoritativeEnd(
    programId: string,
    endedQueueEntryId: string | null,
    nextSequence: ProgramSongSequence | null,
    hasSequenceSuccessor: boolean,
    endedRequestId: string,
  ): Promise<void> {
    if (this.flightService.isClockedLogRunning(programId)) {
      // The log decides what plays next; the announced song must not.
      this.releaseAnnouncementAtEnd(programId);
      try {
        await this.flightService.handleSongEnded(programId);
      } finally {
        const state = this.states.get(programId);
        if (state) state.transitioning = false;
      }
      return;
    }
    this.handleSongEnded(programId);
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

    await this.bumperAtEnd(programId, endedRequestId);
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
      if (this.playNext(programId, true, endedRequestId)) return;
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
      if (this.playNext(programId, true, endedRequestId)) return;
      this.logger.error(
        `Successor could not be resolved on ${programId}: cursor=${state.sequence.activeItemId ?? 'none'}`,
      );
    }

    this.publishStopped(programId);
  }

  /**
   * Writes where the rotation is, so a restart finds it there (#277). The
   * cursor otherwise advances only in memory unless a queue exists, and every
   * boot loaded whatever was stored last: song_475 on 2026-11-22, replayed
   * after each deploy. Best effort and off the song change: a failure is a
   * warning with the cause class and the next advance writes again. The stored
   * sequence is written only if it is the sequence the engine holds apart from
   * the cursor (an operator edit is never overwritten) and only if the row did
   * not change since it was read (the update names its `updatedAt`).
   */
  private async persistCursorBestEffort(programId: string): Promise<void> {
    const state = this.states.get(programId);
    const sequence = state?.sequence;
    if (!state || !sequence || state.cursorWriteInFlight) return;
    if (sequence.mode !== 'autoplay' && sequence.mode !== 'shuffle') return;
    state.cursorWriteInFlight = true;
    try {
      const held = normalizeProgramSongSequence(
        JSON.parse(JSON.stringify(sequence)) as unknown,
      );
      const row = await this.prisma.programState.findUnique({
        where: { programId },
        select: { songSequence: true, updatedAt: true },
      });
      const stored = row
        ? normalizeProgramSongSequence(row.songSequence)
        : null;
      if (
        !row ||
        !held ||
        programSongSequenceStructure(stored) !==
          programSongSequenceStructure(held)
      ) {
        this.metrics.recordCursorWrite('conflict');
        return;
      }
      const { count } = await this.prisma.programState.updateMany({
        where: { programId, updatedAt: row.updatedAt },
        data: { songSequence: held as unknown as Prisma.InputJsonValue },
      });
      this.metrics.recordCursorWrite(count === 1 ? 'succeeded' : 'conflict');
    } catch (error) {
      this.metrics.recordCursorWrite('failed');
      this.logger.warn(
        `Cursor not stored on ${programId}; the next song stores it (${errorClass(error)})`,
      );
    } finally {
      state.cursorWriteInFlight = false;
    }
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
    // Nothing plays next, so the announced song must not either.
    this.releaseAnnouncementAtEnd(programId);
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
    if (this.flightService.isClockedLogRunning(programId)) return false;
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
    const favoriteCount = collectHighRotationProgramSongLeaves(sequence).length;

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

    if (this.similarity && !this.similarity.isReady()) {
      // A song ended before the similarity index finished loading: nothing to
      // wait for here, so the playlist cursor chooses.
      this.logger.warn(
        `Similarity index not ready on ${programId}; the playlist cursor chooses this song`,
      );
    }
    const similarityMode =
      this.similarity?.getSettings(programId).mode ?? 'off';
    if (similarityMode === 'off') {
      return this.resolveCursorPlaylistSong(
        programId,
        state,
        sequence,
        favoriteCount,
        now,
      );
    }
    return this.resolveWithSimilarity(
      programId,
      state,
      sequence,
      favoriteCount,
      similarityMode,
      now,
    );
  }

  /**
   * Similarity picking for `shadow` and `on`. It can never break playout: any
   * failure falls back to the cursor selection exactly as `off` would behave.
   */
  private resolveWithSimilarity(
    programId: string,
    state: SongEngineState,
    sequence: ProgramSongSequence,
    favoriteCount: number,
    mode: 'shadow' | 'on',
    now: number,
  ): ProgramResolvedSongLeaf | null {
    const similarity = this.similarity!;
    let proposal: ReturnType<SongSimilarityService['propose']> | null = null;
    try {
      proposal = similarity.propose(programId, {
        currentSongId: state.lastEnded?.songId ?? null,
        currentArtist: state.lastEnded?.artist ?? '',
        // Favorites are scheduled by the high-rotation quota, never by cursor.
        leaves: collectProgramSongLeaves(sequence).map((leaf) => ({
          leaf,
          blocked: leaf.highRotation === true,
        })),
      });
    } catch (error) {
      this.logger.error(
        `Similarity proposal failed on ${programId}; using the playlist cursor: ${String(error)}`,
      );
    }

    const baseline = (): ProgramResolvedSongLeaf | null =>
      this.resolveCursorPlaylistSong(
        programId,
        state,
        sequence,
        favoriteCount,
        now,
      );

    if (mode === 'shadow') {
      const played = baseline();
      if (proposal) {
        similarity.recordDecision(programId, {
          mode,
          outcome: proposal.result.outcome,
          currentSongId: state.lastEnded?.songId ?? null,
          proposedSongId: proposal.result.chosen?.songId ?? null,
          playedSongId: played?.songId ?? null,
          score: proposal.result.chosen?.score ?? null,
          runnerUps: proposal.result.runnerUps.map((r) => ({
            songId: r.songId,
            score: r.score,
          })),
        });
        this.metrics.recordSimilarityAction('shadow-recorded');
      }
      return played;
    }

    if (proposal?.leaf) {
      if (!proposal.leaf.id.startsWith(CATALOG_ITEM_PREFIX)) {
        activateProgramSongLeaf(sequence, proposal.leaf.id);
      }
      state.pendingCycleReset = proposal.result.cycleReset;
      this.metrics.recordSimilarityAction('selected');
      similarity.recordDecision(programId, {
        mode,
        outcome: 'selected',
        currentSongId: state.lastEnded?.songId ?? null,
        proposedSongId: proposal.leaf.songId ?? null,
        playedSongId: proposal.leaf.songId ?? null,
        score: proposal.result.chosen?.score ?? null,
        runnerUps: proposal.result.runnerUps.map((r) => ({
          songId: r.songId,
          score: r.score,
        })),
      });
      return proposal.leaf;
    }

    const played = baseline();
    if (proposal) {
      const outcome = proposal.result.outcome;
      this.metrics.recordSimilarityAction(
        outcome === 'fallback-no-embedding'
          ? 'fallback-no-embedding'
          : 'fallback-no-candidate',
      );
      similarity.recordDecision(programId, {
        mode,
        outcome,
        currentSongId: state.lastEnded?.songId ?? null,
        proposedSongId: null,
        playedSongId: played?.songId ?? null,
        score: null,
        runnerUps: [],
      });
    }
    return played;
  }

  private resolveCursorPlaylistSong(
    programId: string,
    state: SongEngineState,
    sequence: ProgramSongSequence,
    favoriteCount: number,
    now: number,
  ): ProgramResolvedSongLeaf | null {
    const maxAttempts = collectProgramSongLeaves(sequence).length;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // The engine plays the cursor item by position (#176). Resolving at the
      // cursor's own stamp keeps the shared clock walk from moving past items
      // during time the cursor did not own: a queued song, a manual pick, a
      // pause. The cursor is stamped at every advance, so a natural end gets
      // the same item as before.
      const resolved = resolveProgramSongLeaf(sequence, sequence.startedAt);
      if (!resolved) return null;
      if (!resolved.highRotation) return resolved;

      if (state.rotationHistoryHealthy) {
        const eligibility = getHighRotationEligibility(
          resolved,
          state.rotation,
          favoriteCount,
          now,
        );
        if (eligibility !== 'eligible') {
          this.metrics.recordHighRotationAction('cooldown-skipped');
        }
      }

      if (!advanceProgramSongSequence(sequence, resolved.id)) return null;
    }

    this.logger.error(
      `No legally playable playlist song remains on ${programId}`,
    );
    return null;
  }

  /** The held leaf as the sequence has it now, or null when it is no longer valid. */
  private validHeldLeaf(
    sequence: ProgramSongSequence,
    leaf: ProgramResolvedSongLeaf,
  ): ProgramResolvedSongLeaf | null {
    if (leaf.id.startsWith(CATALOG_ITEM_PREFIX)) return leaf;
    const current = findUniqueProgramSongLeafById(sequence, leaf.id);
    return current?.audioUrl && current.audioUrl === leaf.audioUrl
      ? current
      : null;
  }

  /**
   * Plays the next song. With `handoff` (an accepted end), an accepted
   * announcement that is the song selected here is promoted: the same queue
   * entry and cursor are consumed, and no command is sent because Palazzo
   * already started it.
   */
  private playNext(
    programId: string,
    handoff = false,
    endedRequestId?: string,
  ): boolean {
    // Log ownership also protects against queue claims begun before log start.
    if (this.flightService.isClockedLogRunning(programId)) return true;
    const state = this.states.get(programId);
    if (!state?.sequence) return false;

    if (state.queueBlocked) return false;
    const queueEntry = state.queue[0] ?? null;
    if (queueEntry && !queueEntry.active) {
      const announcedEntry =
        handoff &&
        state.announcement?.status === 'accepted' &&
        state.announcement.queueEntryId === queueEntry.id
          ? state.announcement
          : null;
      const queuePlaybackRequestId = announcedEntry?.playbackId ?? randomUUID();
      state.transitioning = true;
      void this.claimQueueHead(programId, queueEntry.id, queuePlaybackRequestId)
        .then((claimed) => {
          const nextState = this.states.get(programId);
          if (!nextState) return;
          nextState.transitioning = false;
          if (claimed) {
            if (!this.playNext(programId, handoff, endedRequestId)) {
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
    // At a handoff, the playlist successor that was announced is what plays:
    // the held leaf itself, not a new selection, which can differ (state the
    // selection reads changed after the announcement, 2026-11-21 01:51Z). Only
    // the ended song's own announcement (a stale accepted one is never held,
    // as for the spot in bumperAtEnd), and only while the leaf is still valid:
    // in the sequence with the same audio, or a catalog pick. A queue or
    // operator change re-announced or withdrew it before the end.
    const announcedHere =
      handoff &&
      !queueEntry &&
      state.announcement?.status === 'accepted' &&
      state.announcement.forRequestId === endedRequestId
        ? state.announcement
        : null;
    const heldLeaf = announcedHere?.leaf
      ? this.validHeldLeaf(state.sequence, announcedHere.leaf)
      : null;
    if (heldLeaf && announcedHere) {
      if (!heldLeaf.id.startsWith(CATALOG_ITEM_PREFIX)) {
        activateProgramSongLeaf(state.sequence, heldLeaf.id);
      }
      state.pendingCycleReset = announcedHere.cycleReset;
      for (const record of announcedHere.effects.splice(0)) {
        try {
          record();
        } catch {
          // Metrics and the decision log are best-effort.
        }
      }
    }
    const resolved = queueEntry
      ? findUniqueProgramSongLeafById(state.sequence, queueEntry.itemId)
      : (heldLeaf ?? this.resolveNextPlaylistSong(programId, state));
    if (!resolved?.audioUrl) return false;

    const dur =
      typeof resolved.durationMs === 'number' && resolved.durationMs > 0
        ? resolved.durationMs
        : 300000;
    const announced = handoff ? state.announcement : null;
    const promote =
      announced?.status === 'accepted' &&
      announced.itemId === resolved.id &&
      announced.audioUrl === resolved.audioUrl &&
      announced.queueEntryId === (queueEntry?.id ?? null) &&
      (!queueEntry || queueEntry.playbackRequestId === announced.playbackId);
    const startedAt = promote ? announced.startedAt : null;
    const playbackRequestId = promote
      ? announced.playbackId
      : (queueEntry?.playbackRequestId ?? randomUUID());
    this.rememberSong(state, playbackRequestId, resolved.songId);
    if (handoff) {
      state.announcement = null;
      if (promote) {
        this.recordHandoff('preloaded');
      } else if (announced) {
        // Palazzo may already have started an announced song; the command
        // below flushes it.
        const raced = this.preemptAnnouncedSongs(programId, state, announced);
        this.recordHandoff(raced ? 'race_replaced' : 'command');
      } else {
        this.recordHandoff('command');
      }
    }
    if (startedAt === null) {
      state.pendingRequestIds.add(playbackRequestId);
      // A new command restarts the watchdog's bound (#230).
      state.noPlaybackSince = null;
    }
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
      authoritativeStartedAt: startedAt,
      authoritativePositionMs: startedAt === null ? null : 0,
      authoritativeUpdatedAt: startedAt,
      queueEntryId: queueEntry?.id ?? null,
      highRotation: resolved.highRotation === true,
      cycleReset: !queueEntry && state.pendingCycleReset ? true : undefined,
      ...(promote ? { promoted: true } : {}),
    };
    state.pendingCycleReset = false;

    if (promote) {
      this.logger.log(
        `Promoting announced ${resolved.title} by ${resolved.artist} on ${programId} (${playbackRequestId})`,
      );
      if (startedAt !== null) {
        // Its start arrived before promotion and was already recorded.
        this.recordHighRotationStarted(
          programId,
          state,
          state.activeSong,
          startedAt,
        );
        this.refreshAnnouncement(programId);
      }
    } else {
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
    }
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
    voiceTrack?: {
      instantId: number;
      duckGain?: number;
      fadeInSeconds?: number;
      fadeOutSeconds?: number;
    },
  ): Promise<void> {
    const stateBeforeCommand = this.states.get(programId);
    const activeSong = stateBeforeCommand?.activeSong;
    let intro:
      | {
          playbackId: string;
          url: string;
          gain?: number;
          duckGain?: number;
          fadeInSeconds?: number;
          fadeOutSeconds?: number;
        }
      | undefined;
    if (voiceTrack && activeSong?.playbackRequestId === playbackRequestId) {
      try {
        const clip = await this.prisma.instant.findUnique({
          where: { id: voiceTrack.instantId },
          select: { audioUrl: true, volume: true, enabled: true },
        });
        if (!clip?.enabled || !clip.audioUrl.trim())
          throw new Error('voice track unavailable');
        intro = {
          playbackId: `${playbackRequestId}:intro`,
          url: clip.audioUrl,
          gain: clip.volume,
          duckGain: voiceTrack.duckGain,
          fadeInSeconds: voiceTrack.fadeInSeconds,
          fadeOutSeconds: voiceTrack.fadeOutSeconds,
        };
        activeSong.introPlaybackId = intro.playbackId;
        activeSong.introStatus = 'pending';
        this.metrics.recordIntroTransition('submitted');
        this.emitPlaybackUpdate(programId, activeSong);
      } catch {
        this.degradeIntro(programId, activeSong, 'Voice track is unavailable');
      }
    } else if (
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
        this.rememberSong(
          state,
          result.playbackRequestId,
          state.commandedSongs?.get(playbackRequestId),
        );
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
    this.scheduleCommandRetry(programId, state);
  }

  /**
   * A failed command in an automatic mode leaves nothing to start the next
   * song (#230): resume from Palazzo's own state after a backoff. Manual mode
   * stays an operator boundary. The retry stands down when anything else has
   * taken over by then (a song, a pending command, a freeze, a stale stream).
   */
  private scheduleCommandRetry(
    programId: string,
    state: SongEngineState,
  ): void {
    const automatic =
      state.sequence?.mode === 'autoplay' || state.sequence?.mode === 'shuffle';
    if (!automatic || state.commandRetryTimer) return;
    const delay = Math.min(
      COMMAND_RETRY_BASE_MS * 2 ** state.commandRetries,
      COMMAND_RETRY_MAX_MS,
    );
    state.commandRetries += 1;
    this.logger.warn(
      `Retrying the rotation on ${programId} in ${delay / 1000} s from Palazzo's state`,
    );
    state.commandRetryTimer = setTimeout(() => {
      state.commandRetryTimer = null;
      if (
        state.activeSong ||
        state.pendingRequestIds.size ||
        state.frozen ||
        !this.telemetry?.isReconciled(programId)
      )
        return;
      void this.resync(programId, 'command_failed');
    }, delay);
    state.commandRetryTimer.unref?.();
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

  /**
   * The bumper slot at an accepted end. When the ended song's accepted
   * announcement carried the slot's spot, Palazzo plays the spot and then the
   * announced song at the spot's own end (gaulatti/palazzo#50): the spot is
   * used, and nothing is played or waited for here. Otherwise the slot is
   * played as before (maybeBumper).
   */
  private async bumperAtEnd(
    programId: string,
    endedRequestId: string,
  ): Promise<void> {
    const state = this.states.get(programId);
    const announced = state?.announcement;
    // Only the ended song's own announcement: a stale one never suppresses
    // the slot's spot.
    if (
      state &&
      announced?.status === 'accepted' &&
      announced.bumper &&
      announced.forRequestId === endedRequestId
    ) {
      const spot = announced.bumper;
      try {
        const settings = await this.radioService.getRadioSettings(programId);
        const length = settings?.bumperInstantIds.length ?? 0;
        if (length) state.nextBumperIdx = (spot.index + 1) % length;
      } catch (error) {
        // The sequence stays where it was.
        this.logger.warn(
          `Bumper sequence not advanced on ${programId}: radio settings unreadable (${errorClass(error)})`,
        );
        this.metrics.recordEngineDegraded('bumper_settings');
      }
      state.bumperChoice = null;
      this.logger.log(`Bumper: ${spot.name} on ${programId} (announced)`);
      this.recordBumperMetric('announced', 'sent');
      return;
    }
    if (state) state.bumperChoice = null;
    await this.maybeBumper(programId);
  }

  /**
   * A spot Palazzo may put on air, by playback ID, so its instant.started is
   * counted as played whenever it arrives: an announced spot goes on air just
   * before the song's end, before the engine reads that end.
   */
  private rememberBumperSpot(
    state: SongEngineState,
    playbackId: string,
    name: string,
    path: 'announced' | 'command',
  ): void {
    const sent = (state.bumperSpotsSent ??= new Map());
    sent.set(playbackId, { name, path });
    if (sent.size > 16) sent.delete(sent.keys().next().value as string);
  }

  private recordBumperMetric(
    path: 'announced' | 'command',
    result: 'sent' | 'played' | 'failed' | 'retried',
  ): void {
    try {
      this.metrics.recordBumper(path, result);
    } catch {
      // Metrics are best-effort.
    }
  }

  /** Palazzo put a spot on air (instant.started, gaulatti/palazzo#50). */
  private handleInstantStarted(
    programId: string,
    state: SongEngineState,
    playbackId: string,
  ): void {
    const spot = state.bumperSpotsSent?.get(playbackId);
    if (!spot) return;
    state.bumperSpotsSent?.delete(playbackId);
    if (spot.path === 'announced') {
      state.announcedSpotOnAir = { playbackId, since: Date.now() };
    }
    this.recordBumperMetric(spot.path, 'played');
    this.logger.log(`Bumper played: ${spot.name} on ${programId}`);
  }

  /**
   * Today's bumper path, for a Palazzo without `next.bumper` or a slot whose
   * announcement was not accepted: the spot after the end, a fixed 8 s, then
   * the song by command.
   */
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
      const idx = this.bumperIndex(state, settings);
      state.nextBumperIdx = (idx + 1) % ids.length;
      const inst = await this.prisma.instant.findUnique({
        where: { id: ids[idx] },
      });
      if (!inst?.audioUrl) return;
      const playbackRequestId = randomUUID();
      // Known before the send: Palazzo's instant.started can arrive first.
      this.rememberBumperSpot(state, playbackRequestId, inst.name, 'command');
      // gaulatti/alcantara#274: right after a Palazzo restart it refuses an
      // instant (409, automation not ready) for a moment. That one answer is
      // sent again once after COMMAND_RETRY_BASE_MS, with the same playback ID;
      // any other failure, and an outcome with no answer, is final, so a spot
      // can never play twice.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await this.radioService.playInstant(
            programId,
            inst.audioUrl,
            undefined,
            playbackRequestId,
          );
          break;
        } catch (error) {
          const retryable =
            error instanceof PalazzoInstantRefusedException &&
            error.retryable &&
            attempt < BUMPER_COMMAND_ATTEMPTS;
          if (retryable) {
            this.recordBumperMetric('command', 'retried');
            await new Promise((r) => setTimeout(r, COMMAND_RETRY_BASE_MS));
            // Frozen or reset while waiting, or a song became active (an
            // adoption or a manual play): the spot is not sent, so it can never
            // play over a song, and it keeps its turn.
            if (
              this.states.get(programId) !== state ||
              state.frozen ||
              state.activeSong
            ) {
              state.bumperSpotsSent?.delete(playbackRequestId);
              state.nextBumperIdx = idx;
              return;
            }
            continue;
          }
          // Not sent: no spot is on air, so the song is not held back for it.
          state.bumperSpotsSent?.delete(playbackRequestId);
          this.logger.warn(
            `Bumper failed: ${inst.name} on ${programId}; Palazzo did not take the spot`,
          );
          this.recordBumperMetric('command', 'failed');
          return;
        }
      }
      this.logger.log(`Bumper: ${inst.name} on ${programId}`);
      this.recordBumperMetric('command', 'sent');
      await new Promise((r) => setTimeout(r, 8000));
    } catch (error) {
      this.logger.warn(
        `Bumper attempt failed before its send on ${programId} (${errorClass(error)})`,
      );
      this.metrics.recordEngineDegraded('bumper_attempt');
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
      ...ActorContext.eventFields(song.actor),
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

/** The class of a caught value, safe to log: never its message (#237). */
function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}
