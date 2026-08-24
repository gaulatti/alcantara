import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RadioService } from './radio.service';
import { FlightService } from '../program/flight.service';
import { PrismaService } from '../prisma.service';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import { RadioMetricsService } from './radio-metrics.service';
import type {
  PalazzoPlaybackState,
  PalazzoProgramStatus,
} from './palazzo-contract';
import {
  normalizeProgramSongSequence,
  resolveProgramSongLeaf,
  type ProgramResolvedSongLeaf,
  type ProgramSongSequence,
  type ProgramSongSequenceLeafItem,
} from './song-sequence.utils';

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
}

export type SongEngineEvent =
  | { type: 'playback_update'; programId: string; playback: SongPlaybackData }
  | {
      type: 'song_playback_active';
      programId: string;
      playback: SongPlaybackData;
    }
  | { type: 'song_off_air'; programId: string; triggeredAt: string }
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
  authoritativeStartedAt: number | null;
  authoritativePositionMs: number | null;
  authoritativeUpdatedAt: number | null;
}

interface SongEngineState {
  sequence: ProgramSongSequence | null;
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
          },
        },
      },
    });
    for (const s of settings) {
      const pid = s.programState.programId;
      if (!s.programState.songSequence || !s.palazzoUrl) continue;
      if (!RADIO_PROGRAM_TYPES.has(s.programState.type)) continue;
      const seq = normalizeProgramSongSequence(s.programState.songSequence);
      if (
        !seq ||
        (seq.mode !== 'autoplay' && seq.mode !== 'shuffle') ||
        !seq.items.length
      )
        continue;

      this.radioProgramIds.add(pid);
      const state = this.ensureState(pid);
      state.sequence = seq;
      state.sequence.startedAt = Date.now();
      this.logger.log(`Booting ${pid}, mode=${seq.mode}, awaiting Palazzo snapshot`);
    }
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
  }

  private isRadioCapable(programId: string): boolean {
    return this.radioProgramIds.has(programId);
  }

  private ensureState(programId: string): SongEngineState {
    let s = this.states.get(programId);
    if (!s) {
      s = {
        sequence: null,
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
    if (state.sequence?.startedAt && seq)
      seq.startedAt = state.sequence.startedAt;
    state.sequence = seq;
    state.busyWithForeignTrack = false;
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

  handleManualSong(
    programId: string,
    audioUrl: string,
    title?: string,
    artist?: string,
    durationMs?: number,
  ): void {
    const state = this.ensureState(programId);
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
      coverUrl: '',
      durationMs: dur,
      startedAt: Date.now(),
      itemId: '',
      authoritativeStartedAt: null,
      authoritativePositionMs: null,
      authoritativeUpdatedAt: null,
    };
    this.emitPlaybackActive(programId, state.activeSong);
    void this.publishNowPlaying(programId, state.activeSong);
    this.startProgress(programId);
    if (!this.isRadioCapable(programId)) {
      // TV-only programs have no Palazzo telemetry; preserve their legacy
      // estimated-duration completion behavior.
      this.setTimer(programId, dur);
    }
    void this.pushCommand(programId, playbackRequestId, audioUrl, title, artist);
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
    this.clearTimer(programId);
    this.stopProgress(programId);
    state.activeSong = null;
    state.pendingRequestIds.clear();
    state.busyWithForeignTrack = false;
    this.emit({
      type: 'song_off_air',
      programId,
      triggeredAt: new Date().toISOString(),
    });
    void this.nowPlayingPublisherService.publishStopped(programId);
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

  handlePalazzoSnapshot(programId: string, snapshot: PalazzoPlaybackState): void {
    if (!this.isRadioCapable(programId)) return;
    const state = this.ensureState(programId);
    const wasReconciled = state.reconciled;
    state.reconciled = true;
    state.frozen = false;

    if (snapshot.status === 'playing' && snapshot.track) {
      this.reconcilePlayingSnapshot(programId, state, snapshot);
    } else {
      this.reconcileIdleSnapshot(programId, state, snapshot, wasReconciled);
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
            url?: string;
          };
        }
      | {
          type: 'track.ended';
          data: {
            playbackRequestId: string;
            title?: string | null;
            artist?: string | null;
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

    const requestId =
      typeof event.data.playbackRequestId === 'string'
        ? event.data.playbackRequestId
        : '';

    if (event.type === 'track.started') {
      if (state.activeSong?.playbackRequestId === requestId) {
        state.activeSong.authoritativeStartedAt = Date.now();
        state.activeSong.authoritativePositionMs = 0;
        state.activeSong.authoritativeUpdatedAt = Date.now();
        this.metrics.recordTrackTransition('adopted');
        this.emitPlaybackUpdate(programId, state.activeSong);
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
    wasReconciled: boolean,
  ): void {
    const requestId = state.activeSong?.playbackRequestId ?? null;

    if (requestId && state.activeSong) {
      // Authoritative idle state while we believe our song is active: the
      // song ended without a lifecycle event reaching us (e.g. SSE loss).
      this.handleAuthoritativeTrackEnded(programId, state, requestId, true);
      return;
    }

    if (state.pendingRequestIds.size) {
      // Commands never started. Drop them and let recovery decide.
      state.pendingRequestIds.clear();
    }

    state.busyWithForeignTrack = false;
    state.lastIdleSequence = snapshot.sequence;

    if (!wasReconciled) {
      // First snapshot after (re)connect: reconcile before deciding anything.
      this.maybeStartSequence(programId);
    }
  }

  private handleAuthoritativeTrackEnded(
    programId: string,
    state: SongEngineState,
    requestId: string,
    fromSnapshot = false,
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
      return;
    }

    this.metrics.recordTrackTransition('advanced');
    this.handleSongEnded(programId);
    state.activeSong = null;
    state.pendingRequestIds.delete(requestId);
    state.songCount++;
    state.busyWithForeignTrack = false;

    void this.maybeBumper(programId).then(() => {
      const st = this.states.get(programId);
      if (!st || st.activeSong || st.frozen) return;

      if (
        st.sequence &&
        (st.sequence.mode === 'autoplay' || st.sequence.mode === 'shuffle')
      ) {
        if (this.maybeStartSequence(programId)) return;
      }

      this.metrics.recordTrackTransition('published-stopped');
      void this.nowPlayingPublisherService.publishStopped(programId);
      this.stopProgress(programId);
      this.emit({
        type: 'song_off_air',
        programId,
        triggeredAt: new Date().toISOString(),
      });
    });
  }

  private maybeStartSequence(programId: string): boolean {
    const state = this.states.get(programId);
    if (!state?.sequence) return false;
    if (state.activeSong || state.pendingRequestIds.size) return false;
    if (state.frozen) return false;
    if (this.isRadioCapable(programId)) {
      if (!state.reconciled) return false;
      if (!this.telemetry?.isReconciled(programId)) return false;
    }
    if (state.busyWithForeignTrack) return false;
    return this.playNext(programId);
  }

  private playNext(programId: string): boolean {
    const state = this.states.get(programId);
    if (!state?.sequence) return false;

    let resolved: ProgramResolvedSongLeaf | null;
    if (state.sequence.mode === 'shuffle') {
      resolved = this.resolveShuffle(programId);
    } else {
      const seq: ProgramSongSequence = {
        ...state.sequence,
        activeItemId: state.sequence.items[0]?.id ?? null,
      };
      resolved = resolveProgramSongLeaf(seq, Date.now());
    }
    if (!resolved?.audioUrl) return false;

    const dur =
      typeof resolved.durationMs === 'number' && resolved.durationMs > 0
        ? resolved.durationMs
        : 300000;
    const playbackRequestId = randomUUID();
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
      authoritativeStartedAt: null,
      authoritativePositionMs: null,
      authoritativeUpdatedAt: null,
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
    );
    this.emitPlaybackActive(programId, state.activeSong);
    void this.publishNowPlaying(programId, state.activeSong);
    this.startProgress(programId);
    if (!this.isRadioCapable(programId)) {
      this.setTimer(programId, dur);
    }
    return true;
  }

  private resolveShuffle(programId: string): ProgramResolvedSongLeaf | null {
    const state = this.states.get(programId);
    if (!state?.sequence) return null;
    const presets = state.sequence.items.filter(
      (item): item is ProgramSongSequenceLeafItem => item.kind === 'preset',
    );
    if (!presets.length) return null;
    const idx = Math.floor(Math.random() * presets.length);
    const p = presets[idx];
    return {
      id: p.id,
      audioUrl: p.audioUrl,
      title: p.title,
      artist: p.artist,
      coverUrl: p.coverUrl,
      durationMs: p.durationMs,
      activePathLabels: [],
    };
  }

  private async pushCommand(
    programId: string,
    playbackRequestId: string,
    audioUrl: string,
    title?: string,
    artist?: string,
  ): Promise<void> {
    const result = await this.radioService.playSong(
      programId,
      audioUrl,
      title,
      artist,
      playbackRequestId,
    );
    const state = this.states.get(programId);
    if (!state) return;
    if (result.ok && result.playbackRequestId) {
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
      state.pendingRequestIds.delete(playbackRequestId);
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
      s.activeSong = null;
      s.pendingRequestIds.clear();
      s.songCount++;
      void this.maybeBumper(programId).then(() => {
        const st = this.states.get(programId);
        if (!st || st.activeSong) return;

        if (
          st.sequence &&
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

  private playbackData(
    programId: string,
    s: ActiveSong,
  ): SongPlaybackData {
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
    };
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
