import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { PalazzoPlaybackState } from './palazzo-contract';
import { RadioMetricsService } from './radio-metrics.service';

/**
 * Two sources audible on a radio program's bus at once (gaulatti/alcantara#242). Detection only: the detector
 * observes the Palazzo events the engine has already handled, and it never sends a command or changes what the
 * engine does. Two shapes are raised once they last longer than the allowance:
 * - `song_song`: two song requests started and not yet ended (Palazzo sums both decks on one bus);
 * - `spot_song`: a bumper spot of the engine on air while a song is.
 * An intro (it plays over its song by design), an operator's cartwall instant and the live input are not sources.
 */
export type ProgramBusOverlapKind = 'song_song' | 'spot_song';

/**
 * Longer than the event jitter of a normal song change (Palazzo emits `track.ended` 3 to 100 ms after the next
 * start), and shorter than the ~7 s a spot overlapped a song on 2026-11-21 at 08:10Z. Alcantara announces every
 * song with an overlap of 0 today (the analysis does not measure one); a change that sends a real overlap must
 * add it here.
 */
export const PROGRAM_BUS_OVERLAP_ALLOWANCE_MS = 3_000;

export type ProgramBusEvent =
  | {
      type: 'track.started' | 'track.ended';
      data: { playbackRequestId: string };
    }
  | { type: 'instant.started' | 'instant.ended'; data: { playbackId: string } }
  | { type: string; data?: unknown };

type Overlap = { timer: ReturnType<typeof setTimeout> | null; raised: boolean };

type Bus = {
  /** Song requests started and not yet ended, oldest first. */
  songs: Map<string, number>;
  /** The engine's bumper spot on air, if any. */
  spot: string | null;
  overlaps: Partial<Record<ProgramBusOverlapKind, Overlap>>;
};

@Injectable()
export class ProgramBusOverlapDetector implements OnModuleDestroy {
  private readonly logger = new Logger(ProgramBusOverlapDetector.name);
  private readonly buses = new Map<string, Bus>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: RadioMetricsService,
  ) {}

  onModuleDestroy(): void {
    for (const programId of [...this.buses.keys()]) this.reset(programId);
  }

  /**
   * One Palazzo event, after the engine handled it. `spot` is whether an `instant.started` is one of the engine's
   * bumper spots, read before the engine handled it. Never throws.
   */
  observe(programId: string, event: ProgramBusEvent, spot = false): void {
    try {
      const bus = this.bus(programId);
      if (event.type === 'track.started') {
        const id = (event.data as { playbackRequestId: string })
          .playbackRequestId;
        if (!bus.songs.has(id)) bus.songs.set(id, Date.now());
      } else if (event.type === 'track.ended') {
        const id = (event.data as { playbackRequestId: string })
          .playbackRequestId;
        // An end for a request never seen to start closes the oldest song: decks end in start order, and a
        // missed or renamed start must not leave a song open (the 2026-11-23 as-run artifacts).
        if (!bus.songs.delete(id)) {
          const oldest = bus.songs.keys().next();
          if (!oldest.done) bus.songs.delete(oldest.value);
        }
      } else if (event.type === 'instant.started') {
        if (!spot) return;
        bus.spot = (event.data as { playbackId: string }).playbackId;
      } else if (event.type === 'instant.ended') {
        if (bus.spot !== (event.data as { playbackId: string }).playbackId)
          return;
        bus.spot = null;
      } else {
        return;
      }
      this.evaluate(programId, bus);
    } catch (error) {
      this.logger.warn(
        `Program bus overlap check skipped an event on ${programId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** A snapshot is Palazzo's whole state: the bus restarts from its one track, and nothing is raised. */
  snapshot(programId: string, state: PalazzoPlaybackState): void {
    this.reset(programId);
    if (state.status === 'playing' && state.track) {
      this.bus(programId).songs.set(state.track.playbackRequestId, Date.now());
    }
  }

  /** Forgets a program's bus (a disconnect, a gap or a stopped client): an overlap on it ends unraised. */
  reset(programId: string): void {
    const bus = this.buses.get(programId);
    if (!bus) return;
    for (const kind of Object.keys(bus.overlaps) as ProgramBusOverlapKind[]) {
      this.end(bus, kind);
    }
    this.buses.delete(programId);
  }

  private bus(programId: string): Bus {
    let bus = this.buses.get(programId);
    if (!bus) {
      bus = { songs: new Map(), spot: null, overlaps: {} };
      this.buses.set(programId, bus);
    }
    return bus;
  }

  private evaluate(programId: string, bus: Bus): void {
    this.track(programId, bus, 'song_song', bus.songs.size >= 2);
    this.track(
      programId,
      bus,
      'spot_song',
      bus.spot !== null && bus.songs.size >= 1,
    );
  }

  private track(
    programId: string,
    bus: Bus,
    kind: ProgramBusOverlapKind,
    overlapping: boolean,
  ): void {
    if (!overlapping) {
      this.end(bus, kind);
      return;
    }
    if (bus.overlaps[kind]) return;
    const overlap: Overlap = { timer: null, raised: false };
    overlap.timer = setTimeout(() => {
      overlap.timer = null;
      overlap.raised = true;
      this.raise(programId, bus, kind);
    }, PROGRAM_BUS_OVERLAP_ALLOWANCE_MS);
    overlap.timer.unref?.();
    bus.overlaps[kind] = overlap;
  }

  private end(bus: Bus, kind: ProgramBusOverlapKind): void {
    const overlap = bus.overlaps[kind];
    if (!overlap) return;
    if (overlap.timer) clearTimeout(overlap.timer);
    if (overlap.raised) this.metrics.setProgramBusOverlapActive(kind, -1);
    delete bus.overlaps[kind];
  }

  private raise(
    programId: string,
    bus: Bus,
    kind: ProgramBusOverlapKind,
  ): void {
    this.metrics.recordProgramBusOverlap(kind);
    this.metrics.setProgramBusOverlapActive(kind, 1);
    const songs = [...bus.songs.keys()];
    // The song that came on air last is the one to review: the later of two songs, or the song under a spot.
    const later = songs[songs.length - 1];
    this.logger.warn(
      kind === 'song_song'
        ? `Two songs on air together on ${programId} for over ${PROGRAM_BUS_OVERLAP_ALLOWANCE_MS / 1000} s: ${songs.join(', ')}`
        : `A spot and a song on air together on ${programId} for over ${PROGRAM_BUS_OVERLAP_ALLOWANCE_MS / 1000} s: spot ${bus.spot}, song ${later}`,
    );
    void this.flag(programId, later);
  }

  /** Marks the later song's as-run start for review. A failed or missing row is logged and counted only. */
  private async flag(
    programId: string,
    playbackRequestId: string,
  ): Promise<void> {
    try {
      const { count } = await this.prisma.asRunRecord.updateMany({
        where: {
          programId,
          playbackRequestId,
          state: 'started',
          reviewFlag: null,
        },
        data: { reviewFlag: 'overlap' },
      });
      this.metrics.recordProgramBusOverlapFlag(
        count > 0 ? 'flagged' : 'missing',
      );
    } catch (error) {
      this.metrics.recordProgramBusOverlapFlag('failed');
      this.logger.warn(
        `As-run overlap flag for ${playbackRequestId} on ${programId} was not stored: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
