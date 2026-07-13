import { Injectable, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { RadioService } from './radio.service';
import { FlightService } from '../program/flight.service';
import { PrismaService } from '../prisma.service';
import {
  normalizeProgramSongSequence,
  resolveProgramSongLeaf,
  type ProgramSongSequence,
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
  updatedAt: string;
}

export type SongEngineEvent =
  | { type: 'playback_update'; programId: string; playback: SongPlaybackData }
  | { type: 'song_playback_active'; programId: string; playback: SongPlaybackData }
  | { type: 'song_off_air'; programId: string; triggeredAt: string };

export type SongEngineBroadcastFn = (event: SongEngineEvent) => void;

interface ActiveSong {
  token: string;
  audioUrl: string;
  artist: string;
  title: string;
  coverUrl: string;
  durationMs: number;
  startedAt: number;
  itemId: string;
}

interface SongEngineState {
  sequence: ProgramSongSequence | null;
  activeSong: ActiveSong | null;
  timer: ReturnType<typeof setTimeout> | null;
  progressInterval: ReturnType<typeof setInterval> | null;
  songCount: number;
  nextBumperIdx: number;
}

@Injectable()
export class SongExecutionEngine implements OnModuleInit {
  private readonly logger = new Logger(SongExecutionEngine.name);
  private readonly states = new Map<string, SongEngineState>();
  private broadcast: SongEngineBroadcastFn | null = null;

  constructor(
    private readonly radioService: RadioService,
    @Inject(forwardRef(() => FlightService))
    private readonly flightService: FlightService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const settings = await this.prisma.radioSettings.findMany({
      where: { enabled: true },
      select: {
        palazzoUrl: true,
        programState: { select: { programId: true, songSequence: true } },
      },
    });
    for (const s of settings) {
      const pid = s.programState.programId;
      if (!s.programState.songSequence || !s.palazzoUrl) continue;
      const seq = normalizeProgramSongSequence(s.programState.songSequence);
      if (!seq || (seq.mode !== 'autoplay' && seq.mode !== 'shuffle') || !seq.items.length) continue;

      const state = this.ensureState(pid);
      state.sequence = seq;
      state.sequence.startedAt = Date.now();
      this.logger.log(`Booting ${pid}, mode=${seq.mode}`);
      this.playNext(pid);
    }
  }

  setBroadcastHandler(handler: SongEngineBroadcastFn): void { this.broadcast = handler; }

  handleSequenceUpdated(programId: string, rawSequence: unknown): void {
    const seq = normalizeProgramSongSequence(rawSequence);
    const state = this.ensureState(programId);
    if (state.sequence?.startedAt && seq) seq.startedAt = state.sequence.startedAt;
    state.sequence = seq;
    if (seq && (seq.mode === 'autoplay' || seq.mode === 'shuffle') && seq.items.length && !state.activeSong) {
      this.playNext(programId);
    }
  }

  handleManualSong(programId: string, audioUrl: string, title?: string, artist?: string, durationMs?: number): void {
    const state = this.ensureState(programId);
    this.clearTimer(programId);
    const dur = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 300000;
    state.activeSong = { token: `${Date.now()}:${audioUrl}`, audioUrl, artist: artist || '', title: title || '', coverUrl: '', durationMs: dur, startedAt: Date.now(), itemId: '' };
    this.emitPlaybackActive(programId, state.activeSong);
    this.startProgress(programId);
    this.setTimer(programId, dur);
  }

  handleSongEnded(programId: string): void {
    void this.flightService.handleSongEnded(programId);
  }

  handleStopSong(programId: string): void {
    const state = this.states.get(programId);
    if (!state) return;
    this.clearTimer(programId);
    this.stopProgress(programId);
    state.activeSong = null;
    this.emit({ type: 'song_off_air', programId, triggeredAt: new Date().toISOString() });
  }

  getPlaybackState(programId: string): SongPlaybackData | null {
    const s = this.states.get(programId)?.activeSong;
    return s ? this.playbackData(s) : null;
  }

  private ensureState(programId: string): SongEngineState {
    let s = this.states.get(programId);
    if (!s) { s = { sequence: null, activeSong: null, timer: null, progressInterval: null, songCount: 0, nextBumperIdx: 0 }; this.states.set(programId, s); }
    return s;
  }

  private playNext(programId: string): void {
    const state = this.states.get(programId);
    if (!state?.sequence) return;

    let resolved;
    if (state.sequence.mode === 'shuffle') {
      resolved = this.resolveShuffle(programId);
    } else {
      const seq: ProgramSongSequence = { ...state.sequence, activeItemId: state.sequence.items[0]?.id ?? null };
      resolved = resolveProgramSongLeaf(seq, Date.now());
    }
    if (!resolved?.audioUrl) return;

    const dur = typeof resolved.durationMs === 'number' && resolved.durationMs > 0 ? resolved.durationMs : 300000;
    state.activeSong = { token: `${resolved.id}:${resolved.audioUrl}`, audioUrl: resolved.audioUrl, artist: resolved.artist, title: resolved.title, coverUrl: resolved.coverUrl, durationMs: dur, startedAt: Date.now(), itemId: resolved.id };

    this.logger.log(`Playing ${resolved.title} by ${resolved.artist} on ${programId}`);
    void this.pushSong(programId, resolved.audioUrl, resolved.title, resolved.artist);
    this.emitPlaybackActive(programId, state.activeSong);
    this.startProgress(programId);
    this.setTimer(programId, dur);
  }

  private resolveShuffle(programId: string): { audioUrl?: string; title?: string; artist?: string; durationMs?: number; id: string; coverUrl: string } | null {
    const state = this.states.get(programId);
    if (!state?.sequence) return null;
    const presets = state.sequence.items.filter((i: any) => i.kind === 'preset');
    if (!presets.length) return null;
    const idx = Math.floor(Math.random() * presets.length);
    const p = presets[idx];
    return { id: p.id, audioUrl: (p as any).audioUrl, title: (p as any).title, artist: (p as any).artist, coverUrl: (p as any).coverUrl, durationMs: (p as any).durationMs };
  }

  private setTimer(programId: string, durationMs: number): void {
    const state = this.states.get(programId);
    if (!state) return;
    state.timer = setTimeout(() => {
      const s = this.states.get(programId);
      if (!s) return;
      this.handleSongEnded(programId);
      s.activeSong = null;
      s.songCount++;
      void this.maybeBumper(programId).then(() => {
        const st = this.states.get(programId);
        if (st?.sequence && (st.sequence.mode === 'autoplay' || st.sequence.mode === 'shuffle')) {
          this.playNext(programId);
        }
      });
    }, durationMs);
  }

  private clearTimer(programId: string): void {
    const state = this.states.get(programId);
    if (state?.timer) { clearTimeout(state.timer); state.timer = null; }
  }

  private async maybeBumper(programId: string): Promise<void> {
    try {
      const settings = await this.radioService.getRadioSettings(programId);
      if (!settings?.bumperEnabled || !settings.bumperInterval || !settings.bumperInstantIds.length) return;
      const state = this.states.get(programId);
      if (!state || state.songCount % settings.bumperInterval !== 0) return;
      const ids = settings.bumperInstantIds;
      const idx = settings.bumperMode === 'random' ? Math.floor(Math.random() * ids.length) : state.nextBumperIdx % ids.length;
      state.nextBumperIdx = (idx + 1) % ids.length;
      const inst = await this.prisma.instant.findUnique({ where: { id: ids[idx] } });
      if (!inst?.audioUrl) return;
      this.logger.log(`Bumper: ${inst.name} on ${programId}`);
      void this.pushSong(programId, inst.audioUrl, inst.name);
      await new Promise(r => setTimeout(r, 8000));
    } catch { /* silent */ }
  }

  private startProgress(programId: string): void {
    const state = this.states.get(programId);
    if (!state) return;
    this.stopProgress(programId);
    state.progressInterval = setInterval(() => {
      const s = this.states.get(programId);
      if (s?.activeSong) this.emit({ type: 'playback_update', programId, playback: this.playbackData(s.activeSong) });
    }, 250);
  }

  private stopProgress(programId: string): void {
    const state = this.states.get(programId);
    if (state?.progressInterval) { clearInterval(state.progressInterval); state.progressInterval = null; }
  }

  private async pushSong(programId: string, url: string, title?: string, artist?: string): Promise<void> {
    try { await this.radioService.playSong(programId, url, title, artist); } catch (e) { this.logger.error(`Push failed: ${e}`); }
  }

  private playbackData(s: ActiveSong): SongPlaybackData {
    const elapsed = Math.max(0, Date.now() - s.startedAt);
    const pos = Math.min(elapsed, s.durationMs);
    return { token: s.token, audioUrl: s.audioUrl, title: s.title, artist: s.artist, coverUrl: s.coverUrl, durationMs: s.durationMs, isPlaying: true, positionMs: pos, progress: s.durationMs > 0 ? Math.min(pos / s.durationMs, 1) : 0, updatedAt: new Date().toISOString() };
  }

  private emitPlaybackActive(programId: string, song: ActiveSong): void {
    this.emit({ type: 'song_playback_active', programId, playback: this.playbackData(song) });
  }

  private emit(event: SongEngineEvent): void {
    try { this.broadcast?.(event); } catch (e) { this.logger.error(`Broadcast error: ${e}`); }
  }
}
