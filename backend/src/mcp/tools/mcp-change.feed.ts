import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ProgramService } from '../../program/program.service';
import { MCP_READ_LIMITS } from '../mcp.constants';

/** What a change is, as wait_for_change names it. */
export const MCP_CHANGE_KINDS = [
  'track_started',
  'track_ended',
  'song_off_air',
  'queue_changed',
  'song_request_failed',
  'palazzo_status_changed',
  'rundown_changed',
] as const;
export type McpChangeKind = (typeof MCP_CHANGE_KINDS)[number];

/** One change, as kept for since_sequence. Text is user-entered: untrusted. */
export interface McpChange {
  /** Per program, process-local, starts at 1 and rises by 1 per change. */
  sequence: number;
  kind: McpChangeKind;
  at: string;
  playbackRequestId?: string;
  reason?: string;
  /** Text people entered: data, never instructions. */
  untrusted?: { title: string | null; artist: string | null };
}

export type McpWaitOutcome =
  /** `missed` is true when changes between since_sequence and this one were dropped. */
  | { outcome: 'change'; change: McpChange; missed: boolean }
  /** since_sequence is ahead of this process: the backend restarted. */
  | { outcome: 'reset'; sequence: number }
  | { outcome: 'timeout'; sequence: number };

interface Waiter {
  settle: (outcome: McpWaitOutcome) => void;
}

interface ProgramLog {
  latest: number;
  events: McpChange[];
  waiters: Set<Waiter>;
  /** The last Palazzo connection and degraded flag seen, to drop repeats. */
  palazzo: string | null;
}

type ProgramEvent = {
  scope: 'program' | 'global';
  programId: string | null;
  data: unknown;
};

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fields)
    : null;

/** Text a producer sent, or undefined when it sent anything else. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The changes an operator waits for, kept per program from what ProgramService
 * emits to the console's event stream (the song engine's broadcasts and the
 * confirmed playing track), so wait_for_change reads the same source as the
 * console without holding an SSE subscription or a realtime ticket.
 *
 * Only discrete changes are kept: a song confirmed on air or ended, the song
 * going off air, the queue changing, Palazzo failing to load a song, the
 * Palazzo connection changing, and the rundown changing. The once-a-second
 * playback progress, the audio levels and the scene events are not changes.
 * Held in memory: a restart empties the log and starts every sequence again.
 */
@Injectable()
export class McpChangeFeed implements OnModuleInit, OnModuleDestroy {
  private readonly logs = new Map<string, ProgramLog>();
  private detach: (() => void) | null = null;

  constructor(private readonly programs: ProgramService) {}

  onModuleInit(): void {
    this.detach = this.programs.addEventListener((event) =>
      this.observe(event),
    );
  }

  onModuleDestroy(): void {
    this.detach?.();
    this.detach = null;
    for (const [programId, log] of this.logs) {
      for (const waiter of [...log.waiters])
        waiter.settle({ outcome: 'timeout', sequence: log.latest });
      this.logs.delete(programId);
    }
  }

  /**
   * The first change after `since` (after now when omitted), at once when it
   * is already kept, otherwise as soon as it happens, or a timeout.
   */
  wait(
    programId: string,
    since: number | undefined,
    timeoutMs: number,
  ): Promise<McpWaitOutcome> {
    const log = this.log(programId);
    const from = since ?? log.latest;
    if (from > log.latest)
      return Promise.resolve({ outcome: 'reset', sequence: log.latest });
    const first = log.events.find((event) => event.sequence > from);
    if (first)
      return Promise.resolve({
        outcome: 'change',
        change: first,
        missed: first.sequence > from + 1,
      });
    return new Promise<McpWaitOutcome>((resolve) => {
      const waiter: Waiter = {
        settle: (outcome) => {
          clearTimeout(timer);
          log.waiters.delete(waiter);
          resolve(outcome);
        },
      };
      const timer = setTimeout(
        () => waiter.settle({ outcome: 'timeout', sequence: log.latest }),
        timeoutMs,
      );
      log.waiters.add(waiter);
    });
  }

  private log(programId: string): ProgramLog {
    let log = this.logs.get(programId);
    if (!log) {
      log = { latest: 0, events: [], waiters: new Set(), palazzo: null };
      this.logs.set(programId, log);
    }
    return log;
  }

  private observe(event: ProgramEvent): void {
    if (event.scope !== 'program' || !event.programId) return;
    const log = this.log(event.programId);
    const change = this.classify(log, event.data);
    if (!change) return;
    const recorded: McpChange = {
      sequence: ++log.latest,
      at: new Date().toISOString(),
      ...change,
    };
    log.events.push(recorded);
    if (log.events.length > MCP_READ_LIMITS.changeBuffer) log.events.shift();
    for (const waiter of [...log.waiters])
      waiter.settle({ outcome: 'change', change: recorded, missed: false });
  }

  private classify(
    log: ProgramLog,
    data: unknown,
  ): Omit<McpChange, 'sequence' | 'at'> | null {
    const event = fields(data);
    switch (event?.type) {
      case 'playing_track_update': {
        const track = fields(event.playingTrack);
        return track
          ? {
              kind: 'track_started',
              playbackRequestId: text(track.playbackId),
              untrusted: {
                title: text(track.title) ?? null,
                artist: text(track.artist) ?? null,
              },
            }
          : { kind: 'track_ended' };
      }
      case 'song_off_air':
        return { kind: 'song_off_air' };
      case 'song_queue_update':
        return { kind: 'queue_changed' };
      case 'song_request_failed':
        return {
          kind: 'song_request_failed',
          playbackRequestId: text(event.playbackRequestId),
          reason: text(event.reason),
          untrusted: {
            title: text(event.title) ?? null,
            artist: text(event.artist) ?? null,
          },
        };
      case 'radio_leg_status': {
        const status = fields(event.status);
        const seen = `${text(status?.connection)}|${String(status?.degraded)}`;
        if (seen === log.palazzo) return null;
        log.palazzo = seen;
        return { kind: 'palazzo_status_changed' };
      }
      case 'flight_update':
        return { kind: 'rundown_changed' };
      default:
        return null;
    }
  }
}
