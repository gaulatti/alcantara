import {
  SongExecutionEngine,
  type SongEngineTrackEvent,
} from './song-execution.engine';
import { RadioMetricsService } from './radio-metrics.service';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { PalazzoPlaybackState } from './palazzo-contract';

// Engine side of the dead-air watchdog (dead-air-watchdog.service.ts): what it may act on, and its two steps. The
// harness is the handoff spec's contract Palazzo (song-execution.engine.handoff.spec.ts), trimmed.

const PROGRAM = 'radio-1';

type Song = {
  id: number;
  itemId: string;
  title: string;
  artist: string;
  url: string;
};

const SONGS: Song[] = Array.from({ length: 6 }, (_, i) => ({
  id: 100 + i,
  itemId: `item-${i + 1}`,
  title: `Track ${i + 1}`,
  artist: `Artist ${i + 1}`,
  url: `https://media.test/track-${i + 1}.mp3`,
}));
const MANUAL = {
  id: 200,
  title: 'Manual Pick',
  artist: 'Operator',
  url: 'https://media.test/manual.mp3',
};

function snapshot(
  bootId: string,
  sequence: number,
  track: { id: string; url: string } | null,
  capabilities?: string[],
): PalazzoPlaybackState {
  return {
    ...(capabilities ? { capabilities } : {}),
    schemaVersion: 1,
    instanceId: 'palazzo-a',
    bootId,
    sequence,
    availability: 'available',
    status: track ? 'playing' : 'idle',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: new Date().toISOString(),
    },
    track: track
      ? {
          playbackRequestId: track.id,
          title: null,
          artist: null,
          coverUrl: null,
          url: track.url,
          startedAt: new Date().toISOString(),
        }
      : null,
    intro: null,
    icecast: { connected: true },
    positionSeconds: 1,
    remainingSeconds: null,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
  };
}

type AnnounceAnswer = 'accepted' | 'not_ready' | 'rejected' | 'unsupported';

/**
 * A Palazzo per the contract, seen through RadioService: a song command and
 * a stop flush the announced song; an announcement replaces the previous one;
 * at the current song's end the announced song starts on its own (before the
 * end under overlap), or is withdrawn `not_ready` if it did not resolve.
 */
class FakePalazzo {
  engine!: SongExecutionEngine;
  current: { id: string; url: string } | null = null;
  queued: {
    id: string;
    url: string;
    bumper?: { playbackId: string; url: string };
  } | null = null;
  /** Spots this Palazzo put on air before an announced song (palazzo#50). */
  spots: string[] = [];
  commands: { url: string; id: string }[] = [];
  announced: {
    id: string;
    url: string;
    body: Record<string, unknown>;
    bumper?: { playbackId: string; url: string };
  }[] = [];
  withdrawals = 0;
  older = false;
  answer: (url: string) => AnnounceAnswer = () => 'accepted';
  notReadyAtEnd = false;
  heldAnswers: (() => void)[] = [];
  holdAnswers = false;
  settings: Record<string, unknown> = { bumperEnabled: false };
  /** An announced song whose gate already opened: it can no longer be replaced. */
  onAirEarly: { id: string; url: string } | null = null;

  readonly radioService = {
    getRadioSettings: jest.fn(() => Promise.resolve(this.settings)),
    playInstant: jest.fn().mockResolvedValue(undefined),
    playSong: jest.fn(
      (
        _programId: string,
        url: string,
        _title?: string,
        _artist?: string,
        id?: string,
      ) => {
        this.commands.push({ url, id: id! });
        this.flush();
        this.current = { id: id!, url };
        return Promise.resolve({ ok: true, playbackRequestId: id });
      },
    ),
    announceNext: jest.fn(
      (
        _programId: string,
        song: { playbackId: string; url: string } & Record<string, unknown>,
        bumper?: { playbackId: string; url: string },
      ): Promise<AnnounceAnswer> => {
        if (this.older) return Promise.resolve('unsupported');
        const decide = (): AnnounceAnswer => {
          if (!this.current) return 'rejected';
          const result = this.answer(song.url);
          if (result === 'accepted') {
            this.queued = {
              id: song.playbackId,
              url: song.url,
              ...(bumper ? { bumper } : {}),
            };
          }
          return result;
        };
        this.announced.push({
          id: song.playbackId,
          url: song.url,
          body: song,
          ...(bumper ? { bumper } : {}),
        });
        if (!this.holdAnswers) return Promise.resolve(decide());
        return new Promise((resolve) =>
          this.heldAnswers.push(() => resolve(decide())),
        );
      },
    ),
    withdrawNext: jest.fn(() => {
      this.withdrawals += 1;
      // Too late to replace: a song whose gate opened is on air.
      const removed = this.queued !== null && this.queued !== this.onAirEarly;
      if (removed) this.queued = null;
      return Promise.resolve(removed);
    }),
  };

  releaseAnswers(): void {
    this.holdAnswers = false;
    for (const release of this.heldAnswers.splice(0)) release();
  }

  private flush(): void {
    if (this.queued) {
      this.event('playout.next_withdrawn', {
        playbackId: this.queued.id,
        reason: 'flushed',
      });
    }
    this.queued = null;
  }

  stop(): void {
    this.flush();
    this.current = null;
  }

  event(type: string, data: Record<string, unknown>): void {
    this.engine.handlePalazzoEvent(PROGRAM, { type, data } as never);
  }

  start(track = this.current!): void {
    this.event('track.started', {
      playbackRequestId: track.id,
      url: track.url,
    });
  }

  /** The current song reaches its cue-out. */
  endCurrent(options: { overlap?: boolean } = {}): void {
    const ended = this.current!;
    const next = this.queued;
    this.queued = null;
    if (next && this.notReadyAtEnd) {
      this.event('playout.next_withdrawn', {
        playbackId: next.id,
        reason: 'not_ready',
      });
      this.event('track.ended', { playbackRequestId: ended.id });
      this.current = null;
      return;
    }
    if (next && options.overlap && !next.bumper) this.start(next);
    this.event('track.ended', {
      playbackRequestId: ended.id,
      url: ended.url,
    });
    this.current = next;
    // With a spot announced, the spot plays first and the song at its end.
    if (next?.bumper) {
      this.spots.push(next.bumper.url);
      this.event('instant.started', { playbackId: next.bumper.playbackId });
      this.event('instant.ended', { playbackId: next.bumper.playbackId });
    }
    if (next && (!options.overlap || next.bumper)) this.start(next);
  }
}

function harness(
  options: {
    loop?: boolean;
    items?: Song[];
    clockedLog?: () => boolean;
    metrics?: RadioMetricsService;
    intro?: number;
    similarity?: unknown;
    withoutSongId?: string;
    capabilities?: string[];
    mode?: 'autoplay' | 'shuffle';
    favoriteItemId?: string;
    lease?: { current: string };
  } = {},
) {
  const items = options.items ?? SONGS;
  let programState = {
    programId: PROGRAM,
    type: 'radio',
    songSequence: {
      mode: options.mode ?? 'autoplay',
      loop: options.loop ?? true,
      intervalMs: 500,
      items: items.map((song) => ({
        id: song.itemId,
        kind: 'preset',
        title: song.title,
        artist: song.artist,
        coverUrl: '',
        audioUrl: song.url,
        durationMs: 180_000,
        ...(song.itemId === options.withoutSongId ? {} : { songId: song.id }),
        ...(song.itemId === options.favoriteItemId
          ? { highRotation: true }
          : {}),
      })),
    } as Record<string, unknown>,
    songQueue: [] as unknown[],
    songRotation: null as unknown,
  };
  const prisma = {
    songIntro: {
      findUnique: jest.fn(({ where }: { where: { songId: number } }) =>
        Promise.resolve(
          where.songId === options.intro
            ? {
                programId: PROGRAM,
                instant: {
                  audioUrl: 'https://media.test/intro.mp3',
                  volume: 1,
                  enabled: true,
                },
              }
            : null,
        ),
      ),
    },
    instant: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        name: 'Bumper',
        audioUrl: 'https://media.test/bumper.mp3',
      }),
    },
    programState: {
      findUnique: jest.fn(() => Promise.resolve(programState)),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        programState = { ...programState, ...data };
        return Promise.resolve(programState);
      }),
    },
  };
  const palazzo = new FakePalazzo();
  const metrics = options.metrics ?? new RadioMetricsService();
  const flight = {
    isClockedLogRunning: jest.fn(() => options.clockedLog?.() ?? false),
    handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
    handleEngineAvailability: jest.fn(),
  };
  let reconciled = true;
  const engine = new SongExecutionEngine(
    palazzo.radioService as unknown as RadioService,
    flight as unknown as FlightService,
    prisma as unknown as PrismaService,
    {
      publishPlayback: jest.fn().mockResolvedValue(undefined),
      publishStopped: jest.fn().mockResolvedValue(undefined),
    } as unknown as NowPlayingPublisherService,
    metrics,
    options.similarity as never,
    undefined,
    options.lease as never,
  );
  palazzo.engine = engine;
  engine.setPalazzoTelemetry({ isReconciled: () => reconciled });
  engine.registerRadioProgram(PROGRAM);
  engine.handleSequenceUpdated(PROGRAM, programState.songSequence);
  let snapshotSequence = 0;
  const idle = (bootId = 'boot-1') =>
    engine.handlePalazzoSnapshot(
      PROGRAM,
      snapshot(bootId, ++snapshotSequence, null, options.capabilities),
    );
  const playing = (track: { id: string; url: string }, bootId = 'boot-1') =>
    engine.handlePalazzoSnapshot(
      PROGRAM,
      snapshot(bootId, ++snapshotSequence, track, options.capabilities),
    );
  const sequence = () => programState.songSequence;
  const setReconciled = (value: boolean) => {
    reconciled = value;
  };
  return {
    engine,
    palazzo,
    metrics,
    prisma,
    flight,
    idle,
    playing,
    sequence,
    setReconciled,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    jest.advanceTimersByTime(1_000);
    for (let j = 0; j < 60; j += 1) await Promise.resolve();
  }
}

/** Start the session: the first song by command, started by Palazzo. */
async function onAir(h: ReturnType<typeof harness>) {
  h.idle();
  await settle();
  h.palazzo.start();
  await settle();
}

const urls = (list: { url: string }[]) => list.map((entry) => entry.url);

function endedEvents(h: ReturnType<typeof harness>) {
  const ended: SongEngineTrackEvent[] = [];
  h.engine.trackEvents$.subscribe((event) => {
    if (event.type === 'track.ended') ended.push(event);
  });
  return ended;
}

describe('the engine side of the dead-air watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-27T03:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('names the playlist song on air in an automatic rotation, and lists the radio programs', async () => {
    const h = harness({ mode: 'shuffle' });
    expect(h.engine.deadAirPrograms()).toEqual([PROGRAM]);
    expect(h.engine.deadAirTarget('other')).toEqual({
      ok: false,
      reason: 'no_song',
    });
    // Commanded, not yet confirmed by Palazzo: the command is still pending.
    h.idle();
    await settle();
    expect(h.engine.deadAirTarget(PROGRAM)).toEqual({
      ok: false,
      reason: 'busy',
    });
    const startedAt = Date.now();
    h.palazzo.start();
    await settle();
    const target = h.engine.deadAirTarget(PROGRAM);
    // startedAt is when Palazzo confirmed the start, not when this read was made.
    expect(target).toEqual({
      ok: true,
      mode: 'shuffle',
      playbackRequestId: h.palazzo.current!.id,
      startedAt,
      replayable: true,
    });
  });

  it('plays the silent song again from its start, keeping the rotation, and closes its play as dead_air', async () => {
    const h = harness();
    const ended = endedEvents(h);
    await onAir(h);
    const silent = h.palazzo.current!;

    expect(h.engine.resendForDeadAir(PROGRAM, 'another-play')).toBeNull();
    const replay = h.engine.resendForDeadAir(PROGRAM, silent.id);
    await settle();

    expect(replay).not.toBeNull();
    expect(replay).not.toBe(silent.id);
    expect(h.palazzo.commands.map((command) => command.url)).toEqual([
      SONGS[0].url,
      SONGS[0].url,
    ]);
    expect(h.palazzo.commands[1].id).toBe(replay);
    expect(ended).toEqual([
      expect.objectContaining({
        playbackRequestId: silent.id,
        endReason: 'dead_air',
      }),
    ]);
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[0].url);
    expect(h.sequence()).toMatchObject({ mode: 'autoplay' });
  });

  it('moves past the silent song with a command for the next one, never promoting the announced song Palazzo never started', async () => {
    const h = harness({ mode: 'autoplay' });
    const ended = endedEvents(h);
    await onAir(h);
    const silent = h.palazzo.current!;
    expect(h.palazzo.queued?.url).toBe(SONGS[1].url);

    expect(h.engine.advanceForDeadAir(PROGRAM, 'another-play')).toBe(false);
    expect(h.engine.advanceForDeadAir(PROGRAM, silent.id)).toBe(true);
    await settle();

    expect(h.palazzo.commands.map((command) => command.url)).toEqual([
      SONGS[0].url,
      SONGS[1].url,
    ]);
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    expect(ended).toEqual([
      expect.objectContaining({
        playbackRequestId: silent.id,
        endReason: 'dead_air',
      }),
    ]);
    expect(h.sequence()).toMatchObject({ mode: 'autoplay' });
  });

  it('does not replay a song that is not the playlist own, and only advances past it', async () => {
    const h = harness();
    await onAir(h);
    h.engine.handleManualSong(PROGRAM, MANUAL.url, MANUAL.title, MANUAL.artist);
    await settle();
    h.palazzo.start();
    await settle();
    const manual = h.palazzo.current!;
    expect(h.engine.deadAirTarget(PROGRAM)).toMatchObject({
      ok: true,
      playbackRequestId: manual.id,
      replayable: false,
    });
    expect(h.engine.resendForDeadAir(PROGRAM, manual.id)).toBeNull();
    expect(h.engine.advanceForDeadAir(PROGRAM, manual.id)).toBe(true);
  });

  it('never acts on a standby, a manual or stopped rotation, a frozen or unreconciled engine, or a clocked log', async () => {
    const lease = { current: 'active' };
    let clocked = false;
    const h = harness({ lease, clockedLog: () => clocked });
    await onAir(h);
    const id = h.palazzo.current!.id;
    const reason = () =>
      (h.engine.deadAirTarget(PROGRAM) as { reason?: string }).reason;

    lease.current = 'standby';
    expect(reason()).toBe('standby');
    expect(h.engine.resendForDeadAir(PROGRAM, id)).toBeNull();
    expect(h.engine.advanceForDeadAir(PROGRAM, id)).toBe(false);
    lease.current = 'active';

    h.setReconciled(false);
    expect(reason()).toBe('unreconciled');
    h.setReconciled(true);

    clocked = true;
    expect(reason()).toBe('clocked_log');
    clocked = false;

    h.engine.handlePalazzoStatus(PROGRAM, {
      connection: 'unavailable',
    } as never);
    expect(reason()).toBe('frozen');
    h.engine.handlePalazzoStatus(PROGRAM, { connection: 'connected' } as never);
    // Unfreezing asks for a reconciliation first.
    expect(reason()).toBe('unreconciled');
    h.playing(h.palazzo.current!);
    await settle();
    expect(h.engine.deadAirTarget(PROGRAM)).toMatchObject({ ok: true });

    // The operator's Stop turns the rotation manual: an explicit stop is never undone.
    h.engine.handleStopSong(PROGRAM);
    expect(reason()).toBe('not_automatic');
  });

  it('waits while a command is pending or the rotation is between songs', async () => {
    const h = harness();
    await onAir(h);
    const id = h.palazzo.current!.id;
    // A take sent and not yet started by Palazzo.
    h.engine.handleManualSong(PROGRAM, MANUAL.url, MANUAL.title, MANUAL.artist);
    expect(h.engine.deadAirTarget(PROGRAM)).toEqual({
      ok: false,
      reason: 'busy',
    });
    await settle();
    h.palazzo.start();
    await settle();
    expect(h.engine.resendForDeadAir(PROGRAM, id)).toBeNull();
    h.palazzo.endCurrent();
    expect(h.engine.deadAirTarget(PROGRAM)).toMatchObject({ ok: false });
  });

  it('waits while an intro plays over the song, and when the rotation has nothing on air', async () => {
    const h = harness({ loop: false, items: [SONGS[0]] });
    await onAir(h);
    const id = h.palazzo.current!.id;
    h.palazzo.event('intro.started', {
      programId: PROGRAM,
      playbackId: 'intro-1',
      parentPlaybackId: id,
    });
    expect(h.engine.deadAirTarget(PROGRAM)).toEqual({ ok: false, reason: 'busy' });
    h.palazzo.event('intro.ended', {
      programId: PROGRAM,
      playbackId: 'intro-1',
      parentPlaybackId: id,
    });
    expect(h.engine.deadAirTarget(PROGRAM)).toMatchObject({ ok: true });
    // The only song ends and the rotation does not loop: it ends, and a rotation that ended is not automatic.
    h.palazzo.endCurrent();
    await settle();
    expect(h.engine.deadAirTarget(PROGRAM)).toEqual({ ok: false, reason: 'not_automatic' });
  });

  it('has no song to judge when the automatic rotation has nothing it can play', async () => {
    const h = harness({ items: [] });
    h.idle();
    await settle();
    expect(h.engine.deadAirTarget(PROGRAM)).toEqual({ ok: false, reason: 'no_song' });
  });

  it('plays a song with no library id again without inventing one', async () => {
    const h = harness({ withoutSongId: SONGS[0].itemId });
    await onAir(h);
    const replay = h.engine.resendForDeadAir(PROGRAM, h.palazzo.current!.id);
    await settle();
    expect(replay).not.toBeNull();
    // The eighth argument of RadioService.playSong is the library song id.
    expect((h.palazzo.radioService.playSong.mock.calls[1] as unknown[])[7]).toBeUndefined();
  });
});

