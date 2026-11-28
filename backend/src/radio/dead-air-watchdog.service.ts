import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  PlayoutLease,
  startWhenActive,
} from '../playout/playout-lease.service';
import { WebrtcService } from '../webrtc/webrtc.service';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import {
  RadioOutputConfidenceService,
  type DeadAirStatus,
} from './radio-output-confidence.service';
import { RadioMetricsService, type DeadAirStep } from './radio-metrics.service';
import { RadioService } from './radio.service';
import {
  SongExecutionEngine,
  type DeadAirEngineHold,
} from './song-execution.engine';

/** Quiet this long, with audio expected, before the first step (20× the longest real quiet run, 1 s). */
export const DEAD_AIR_ACT_MS = 20_000;
/** Each later step waits this long after the previous step's song actually started. */
export const DEAD_AIR_STEP_WAIT_MS = 20_000;
/** Episodes per program per rolling hour; past this the watchdog goes straight to giving up. */
export const DEAD_AIR_EPISODES_PER_HOUR = 3;
export const DEAD_AIR_TICK_MS = 5_000;
const HOUR_MS = 3_600_000;
/** Playback ids the watchdog played again, kept so one is never played again twice. */
const REPLAYED_KEPT = 20;

/** Why the next step waits. Every guard fails closed: a reading it cannot make holds. */
export type DeadAirHold =
  | DeadAirEngineHold
  | 'palazzo_unread'
  | 'palazzo_degraded'
  | 'not_playing'
  | 'other_track'
  | 'live_on_air'
  | 'live_unknown'
  | 'spot_or_intro'
  | 'mixer_unread'
  | 'mixer_muted'
  | 'calls_unread'
  | 'guest_live'
  | 'host_mic_live'
  | 'changed';

interface Episode {
  startedAt: number;
  step: DeadAirStep | null;
  /** When the last step was sent. */
  stepAt: number;
  /** The playback that was silent when the last step was taken. */
  stepRequestId: string | null;
  /** Every step taken in this episode, for the give-up line. */
  taken: DeadAirStep[];
  gaveUp: boolean;
  held: DeadAirHold | null;
}

interface Watch {
  episode: Episode | null;
  /** Episode start times within the last hour. */
  episodes: number[];
  replayed: string[];
  busy: boolean;
}

/** What a guard check saw, for the one log line before an on-air action. */
interface Seen {
  lease: string;
  mode: string;
  quietForMs: number;
  liveOnAir: string;
  guestsLive: string;
  hostMics: string;
  mixer: string;
  request: string;
}

/**
 * The dead-air watchdog for an unattended station: when the output is silent while audio is expected, it recovers
 * by itself with the smallest step first. It plays the silent song again from its start, then moves on to the next
 * song, then gives up and says so loudly on the desk and in the metrics. It never acts while a guest or the host
 * microphone may be on air, while this instance is a standby, while the rotation is stopped, frozen or manual, while
 * the mixer is muted, or while the telemetry cannot tell silence from a lost reading. Before every on-air action it
 * logs one line with what it saw.
 */
@Injectable()
export class DeadAirWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadAirWatchdogService.name);
  private readonly watches = new Map<string, Watch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly engine: SongExecutionEngine,
    private readonly confidence: RadioOutputConfidenceService,
    private readonly telemetry: PalazzoRadioTelemetryService,
    private readonly radio: RadioService,
    private readonly webrtc: WebrtcService,
    private readonly metrics: RadioMetricsService,
    @Optional() private readonly lease?: PlayoutLease,
  ) {}

  onModuleInit(): void {
    this.metrics.recordDeadAirUnrecoveredPrograms(0);
    void startWhenActive(this.lease, () => {
      if (this.stopped) return;
      this.timer = setInterval(() => void this.tick(), DEAD_AIR_TICK_MS);
      this.timer.unref();
    });
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every radio program. Exposed for tests, which drive the clock. */
  async tick(now = Date.now()): Promise<void> {
    const programs = new Set(this.engine.deadAirPrograms());
    for (const programId of [...this.watches.keys()])
      if (!programs.has(programId)) this.forget(programId);
    for (const programId of programs) {
      const watch = this.watchOf(programId);
      if (watch.busy) continue;
      watch.busy = true;
      try {
        await this.judge(programId, watch, now);
      } catch (error) {
        // A failed pass acts on nothing; the next one starts over from fresh readings.
        this.logger.error(
          `Dead-air watchdog pass failed on ${programId}: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      } finally {
        watch.busy = false;
      }
    }
  }

  private async judge(
    programId: string,
    watch: Watch,
    now: number,
  ): Promise<void> {
    const reading = this.confidence.get(programId, now);
    const episode = watch.episode;
    if (reading.state === 'audible' || !reading.expectedAudio) {
      // Heard again (recovered), or nothing is expected any more (a stop): the episode ends either way.
      if (episode?.step && reading.state === 'audible' && !episode.gaveUp)
        this.metrics.recordDeadAirStep(episode.step, 'recovered');
      if (episode?.gaveUp)
        this.logger.log(
          `Dead air on ${programId} ended: the radio is heard again`,
        );
      this.endEpisode(programId, watch);
      return;
    }
    // Unknown or unavailable is a lost reading, not dead air; checking is not yet 10 s of quiet.
    if (
      reading.state !== 'silent' ||
      reading.quietForMs === null ||
      reading.quietForMs < DEAD_AIR_ACT_MS
    )
      return;
    if (episode?.gaveUp) return;

    let current = episode;
    if (!current) {
      watch.episodes = watch.episodes.filter((at) => now - at < HOUR_MS);
      watch.episodes.push(now);
      current = {
        startedAt: now,
        step: null,
        stepAt: now,
        stepRequestId: null,
        taken: [],
        gaveUp: false,
        held: null,
      };
      watch.episode = current;
      this.publish(programId, current);
    }

    const target = this.engine.deadAirTarget(programId);
    if (current.step !== null) {
      // The last step's effect is judged from when its song actually started, never from when it was sent.
      const base =
        target.ok && target.playbackRequestId !== current.stepRequestId
          ? Math.max(current.stepAt, target.startedAt)
          : current.stepAt;
      if (now - base < DEAD_AIR_STEP_WAIT_MS) return;
    }

    const capped = watch.episodes.length > DEAD_AIR_EPISODES_PER_HOUR;
    let step: DeadAirStep =
      capped || current.step === 'advance'
        ? 'give_up'
        : current.step === 'resend'
          ? 'advance'
          : 'resend';
    if (
      step === 'resend' &&
      target.ok &&
      (!target.replayable || watch.replayed.includes(target.playbackRequestId))
    )
      step = 'advance';
    if (step === 'give_up') {
      this.giveUp(programId, current, reading.quietForMs, capped);
      return;
    }

    const { hold, seen } = await this.guards(
      programId,
      target,
      reading.quietForMs,
    );
    if (hold) {
      this.hold(programId, current, step, hold, seen);
      return;
    }
    const requestId = seen.request;
    this.logger.warn(
      `Dead air on ${programId}: ${step} (${this.describe(seen)}, guards=ok)`,
    );
    if (current.step)
      this.metrics.recordDeadAirStep(current.step, 'still_silent');
    if (step === 'resend') {
      const replay = this.engine.resendForDeadAir(programId, requestId);
      if (!replay) {
        this.hold(programId, current, step, 'changed', seen);
        return;
      }
      watch.replayed = [...watch.replayed, replay].slice(-REPLAYED_KEPT);
    } else if (!this.engine.advanceForDeadAir(programId, requestId)) {
      this.hold(programId, current, step, 'changed', seen);
      return;
    }
    current.step = step;
    current.taken.push(step);
    current.stepAt = now;
    current.stepRequestId = requestId;
    current.held = null;
    this.publish(programId, current);
  }

  /**
   * Every guard, read fresh just before acting. Returns the first that holds, and what was seen for the log line.
   */
  private async guards(
    programId: string,
    target: ReturnType<SongExecutionEngine['deadAirTarget']>,
    quietForMs: number,
  ): Promise<{ hold: DeadAirHold | null; seen: Seen }> {
    const seen: Seen = {
      lease: this.lease?.current ?? 'none',
      mode: target.ok ? target.mode : 'n/a',
      quietForMs,
      liveOnAir: 'unread',
      guestsLive: 'unread',
      hostMics: 'unread',
      mixer: 'unread',
      request: target.ok ? target.playbackRequestId : 'none',
    };
    if (!target.ok) return { hold: target.reason, seen };

    let snapshot: Awaited<
      ReturnType<PalazzoRadioTelemetryService['currentState']>
    > = null;
    try {
      snapshot = await this.telemetry.currentState(programId);
    } catch {
      snapshot = null;
    }
    if (!snapshot) return { hold: 'palazzo_unread', seen };
    seen.liveOnAir = String(snapshot.live?.onAir ?? 'absent');
    if (snapshot.availability !== 'available')
      return { hold: 'palazzo_degraded', seen };
    // A live reading Palazzo did not give is unknown, never off: a live voice could be on air.
    if (snapshot.live?.onAir === true) return { hold: 'live_on_air', seen };
    if (snapshot.live === undefined) return { hold: 'live_unknown', seen };
    if (snapshot.status !== 'playing') return { hold: 'not_playing', seen };
    if (snapshot.track?.playbackRequestId !== target.playbackRequestId)
      return { hold: 'other_track', seen };
    if (
      snapshot.intro?.status === 'playing' ||
      snapshot.levels.instant.rms > 0 ||
      snapshot.levels.instant.peak > 0
    )
      return { hold: 'spot_or_intro', seen };

    try {
      const mixer = await this.radio.getMixer(programId);
      const muted =
        mixer.songMuted || mixer.songVolume === 0 || mixer.mainVolume === 0;
      seen.mixer = muted ? 'muted' : 'ok';
      // A closed fader or a mute is the operator's choice: reported, never touched.
      if (muted) return { hold: 'mixer_muted', seen };
    } catch {
      return { hold: 'mixer_unread', seen };
    }

    try {
      const presence = await this.webrtc.onAirPresence(programId);
      seen.guestsLive = String(presence.guestsLive);
      seen.hostMics = String(presence.hostMics);
      if (presence.guestsLive > 0) return { hold: 'guest_live', seen };
      if (presence.hostMics > 0) return { hold: 'host_mic_live', seen };
    } catch {
      return { hold: 'calls_unread', seen };
    }
    // The engine is asked again last: a take, a stop or a handover can land while the reads above were made.
    const again = this.engine.deadAirTarget(programId);
    if (!again.ok) return { hold: again.reason, seen };
    if (again.playbackRequestId !== target.playbackRequestId)
      return { hold: 'changed', seen };
    seen.lease = this.lease?.current ?? 'none';
    return { hold: null, seen };
  }

  private hold(
    programId: string,
    episode: Episode,
    step: DeadAirStep,
    hold: DeadAirHold,
    seen: Seen,
  ): void {
    if (episode.held === hold) return;
    // Once per reason per episode, so a long hold is one line and one count, not one every pass.
    episode.held = hold;
    this.metrics.recordDeadAirStep(step, 'held');
    this.logger.warn(
      `Dead air on ${programId}: ${step} held by ${hold} (${this.describe(seen)})`,
    );
    this.publish(programId, episode);
  }

  private giveUp(
    programId: string,
    episode: Episode,
    quietForMs: number,
    capped: boolean,
  ): void {
    if (episode.step)
      this.metrics.recordDeadAirStep(episode.step, 'still_silent');
    this.metrics.recordDeadAirStep('give_up', 'still_silent');
    episode.step = 'give_up';
    episode.gaveUp = true;
    episode.held = null;
    this.logger.error(
      `DEAD AIR on ${programId}: could not recover (quiet_for_ms=${quietForMs}, steps=${episode.taken.join('+') || 'none'}, ${capped ? `more than ${DEAD_AIR_EPISODES_PER_HOUR} episodes this hour` : 'every step taken left the air silent'}). Nothing more is tried until the radio is heard again.`,
    );
    this.publish(programId, episode);
    this.recount();
  }

  private endEpisode(programId: string, watch: Watch): void {
    if (!watch.episode) return;
    watch.episode = null;
    this.confidence.setDeadAir(programId, null);
    this.recount();
  }

  private forget(programId: string): void {
    this.watches.delete(programId);
    this.confidence.setDeadAir(programId, null);
    this.recount();
  }

  private publish(programId: string, episode: Episode): void {
    const status: DeadAirStatus = {
      step: episode.step,
      gaveUp: episode.gaveUp,
      held: episode.held,
      since: new Date(episode.startedAt).toISOString(),
    };
    this.confidence.setDeadAir(programId, status);
  }

  private recount(): void {
    this.metrics.recordDeadAirUnrecoveredPrograms(
      [...this.watches.values()].filter((watch) => watch.episode?.gaveUp)
        .length,
    );
  }

  private describe(seen: Seen): string {
    return `quiet_for_ms=${seen.quietForMs}, lease=${seen.lease}, mode=${seen.mode}, live_on_air=${seen.liveOnAir}, guests_live=${seen.guestsLive}, host_mics=${seen.hostMics}, mixer=${seen.mixer}, request=${seen.request}`;
  }

  private watchOf(programId: string): Watch {
    let watch = this.watches.get(programId);
    if (!watch) {
      watch = { episode: null, episodes: [], replayed: [], busy: false };
      this.watches.set(programId, watch);
    }
    return watch;
  }
}
