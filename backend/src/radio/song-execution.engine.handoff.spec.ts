import { Prisma } from '@prisma/client';
import { SongExecutionEngine } from './song-execution.engine';
import { RadioMetricsService } from './radio-metrics.service';
import { AsRunService } from '../as-run/as-run.service';
import type { RadioService } from './radio.service';
import type { FlightService } from '../program/flight.service';
import type { PrismaService } from '../prisma.service';
import type { NowPlayingPublisherService } from './now-playing-publisher.service';
import type { PalazzoPlaybackState } from './palazzo-contract';

// Engine side of gaulatti/palazzo#40: the next song is announced while the
// current one plays, Palazzo starts it itself, and the engine promotes it.
// The fake Palazzo behaves as the pinned contract describes; nothing here
// depends on Palazzo's implementation.

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
): PalazzoPlaybackState {
  return {
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
  queued: { id: string; url: string } | null = null;
  commands: { url: string; id: string }[] = [];
  announced: { id: string; url: string; body: Record<string, unknown> }[] = [];
  withdrawals = 0;
  older = false;
  answer: (url: string) => AnnounceAnswer = () => 'accepted';
  notReadyAtEnd = false;
  heldAnswers: (() => void)[] = [];
  holdAnswers = false;
  settings: Record<string, unknown> = { bumperEnabled: false };

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
      ): Promise<AnnounceAnswer> => {
        if (this.older) return Promise.resolve('unsupported');
        const decide = (): AnnounceAnswer => {
          if (!this.current) return 'rejected';
          const result = this.answer(song.url);
          if (result === 'accepted') {
            this.queued = { id: song.playbackId, url: song.url };
          }
          return result;
        };
        this.announced.push({ id: song.playbackId, url: song.url, body: song });
        if (!this.holdAnswers) return Promise.resolve(decide());
        return new Promise((resolve) =>
          this.heldAnswers.push(() => resolve(decide())),
        );
      },
    ),
    withdrawNext: jest.fn(() => {
      this.withdrawals += 1;
      this.queued = null;
      return Promise.resolve();
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
    if (next && options.overlap) this.start(next);
    this.event('track.ended', {
      playbackRequestId: ended.id,
      url: ended.url,
    });
    this.current = next;
    if (next && !options.overlap) this.start(next);
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
  } = {},
) {
  const items = options.items ?? SONGS;
  let programState = {
    programId: PROGRAM,
    type: 'radio',
    songSequence: {
      mode: 'autoplay',
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
  };
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
  );
  palazzo.engine = engine;
  engine.setPalazzoTelemetry({ isReconciled: () => true });
  engine.registerRadioProgram(PROGRAM);
  engine.handleSequenceUpdated(PROGRAM, programState.songSequence);
  let snapshotSequence = 0;
  const idle = (bootId = 'boot-1') =>
    engine.handlePalazzoSnapshot(
      PROGRAM,
      snapshot(bootId, ++snapshotSequence, null),
    );
  const playing = (track: { id: string; url: string }, bootId = 'boot-1') =>
    engine.handlePalazzoSnapshot(
      PROGRAM,
      snapshot(bootId, ++snapshotSequence, track),
    );
  const sequence = () => programState.songSequence;
  return { engine, palazzo, metrics, prisma, flight, idle, playing, sequence };
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

describe('next-song announcement and handoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('announces the successor when the active song starts and hands off without a command', async () => {
    const h = harness();
    await onAir(h);

    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(h.palazzo.announced).toHaveLength(1);
    const announcement = h.palazzo.announced[0];
    expect(announcement.body).toEqual({
      playbackId: announcement.id,
      url: SONGS[1].url,
      title: SONGS[1].title,
      artist: SONGS[1].artist,
      coverUrl: '',
    });

    h.palazzo.endCurrent();
    await settle();

    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    // The promoted song announces its own successor once it plays.
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url, SONGS[2].url]);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
  });

  it('accepts the announced start under overlap and records one start and one end per song', async () => {
    const h = harness();
    const store = asRunStore();
    const asRun = new AsRunService(
      store.prisma as unknown as PrismaService,
      h.engine,
    );
    asRun.onModuleInit();
    const events: string[] = [];
    const subscription = h.engine.trackEvents$.subscribe((event) =>
      events.push(`${event.type}:${event.url}`),
    );
    await onAir(h);

    for (let n = 0; n < 4; n += 1) {
      jest.setSystemTime(Date.now() + 180_000);
      h.palazzo.endCurrent({ overlap: n % 2 === 0 });
      await settle();
    }
    asRun.onModuleDestroy();
    subscription.unsubscribe();

    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 4 });
    // Overlap: the next start before the previous end; otherwise end, then start.
    expect(events).toEqual([
      `track.started:${SONGS[0].url}`,
      `track.started:${SONGS[1].url}`,
      `track.ended:${SONGS[0].url}`,
      `track.ended:${SONGS[1].url}`,
      `track.started:${SONGS[2].url}`,
      `track.started:${SONGS[3].url}`,
      `track.ended:${SONGS[2].url}`,
      `track.ended:${SONGS[3].url}`,
      `track.started:${SONGS[4].url}`,
    ]);
    const byId = new Map<string, string[]>();
    for (const row of store.rows) {
      byId.set(row.playbackRequestId, [
        ...(byId.get(row.playbackRequestId) ?? []),
        row.state,
      ]);
    }
    // Five songs on air; the last is still playing.
    expect([...byId.values()]).toEqual([
      ['started', 'ended'],
      ['started', 'ended'],
      ['started', 'ended'],
      ['started', 'ended'],
      ['started'],
    ]);
  });

  it('re-announces when the queue changes and promotes the queued song through its claim', async () => {
    const h = harness();
    await onAir(h);

    const [entry] = await h.engine.enqueueSong(PROGRAM, SONGS[4].itemId);
    await settle();
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url, SONGS[4].url]);

    // Reordering an unchanged queue keeps the announcement.
    await h.engine.reorderSongQueue(PROGRAM, [entry.id]);
    await settle();
    expect(h.palazzo.announced).toHaveLength(2);

    h.palazzo.endCurrent();
    await settle();

    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(h.engine.getPlaybackState(PROGRAM)).toEqual(
      expect.objectContaining({
        audioUrl: SONGS[4].url,
        queueEntryId: entry.id,
      }),
    );
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
  });

  it('withdraws when the successor goes away and announces again when it returns', async () => {
    const h = harness();
    await onAir(h);

    h.engine.handleSequenceUpdated(PROGRAM, {
      ...h.sequence(),
      mode: 'manual',
    });
    await settle();
    expect(h.palazzo.withdrawals).toBe(1);
    expect(h.palazzo.queued).toBeNull();

    // Nothing announced: no second withdrawal.
    h.engine.handleSequenceUpdated(PROGRAM, {
      ...h.sequence(),
      mode: 'manual',
    });
    await settle();
    expect(h.palazzo.withdrawals).toBe(1);

    h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
    await settle();
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url, SONGS[1].url]);
    expect(h.palazzo.announced[0].id).not.toBe(h.palazzo.announced[1].id);
  });

  describe('does not announce', () => {
    it('when a bumper is due after the song', async () => {
      const h = harness();
      h.palazzo.settings = {
        bumperEnabled: true,
        bumperInterval: 1,
        bumperInstantIds: [1],
        bumperMode: 'sequential',
      };
      await onAir(h);
      expect(h.palazzo.announced).toEqual([]);
    });

    it('when the successor has an intro', async () => {
      const h = harness({ intro: SONGS[1].id });
      await onAir(h);
      expect(h.palazzo.announced).toEqual([]);
    });

    it('while a clocked flight log runs', async () => {
      let clocked = false;
      const h = harness({ clockedLog: () => clocked });
      await onAir(h);
      expect(h.palazzo.announced).toHaveLength(1);

      clocked = true;
      h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
      await settle();
      expect(h.palazzo.withdrawals).toBe(1);
    });

    it('when there is no successor', async () => {
      const h = harness({ loop: false, items: SONGS.slice(0, 1) });
      await onAir(h);
      expect(h.palazzo.announced).toEqual([]);
    });

    it('when the queue head is already claimed', async () => {
      const h = harness();
      await onAir(h);
      h.engine.handleQueueUpdated(PROGRAM, [
        {
          id: 'entry-x',
          itemId: SONGS[3].itemId,
          enqueuedAt: 1,
          active: true,
          playbackRequestId: 'other',
        },
      ]);
      await settle();
      expect(h.palazzo.withdrawals).toBe(1);
    });

    it('when the queue head no longer resolves to a playable song', async () => {
      const h = harness();
      await onAir(h);
      h.engine.handleQueueUpdated(PROGRAM, [
        { id: 'entry-x', itemId: 'missing', enqueuedAt: 1 },
      ]);
      await settle();
      expect(h.palazzo.withdrawals).toBe(1);
    });

    it('to an older Palazzo, until its boot changes', async () => {
      const h = harness();
      h.palazzo.older = true;
      await onAir(h);
      expect(h.palazzo.announced).toHaveLength(0);
      expect(h.palazzo.radioService.announceNext).toHaveBeenCalledTimes(1);

      h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
      await settle();
      expect(h.palazzo.radioService.announceNext).toHaveBeenCalledTimes(1);

      // A new boot may be a newer Palazzo.
      h.palazzo.older = false;
      h.playing(h.palazzo.current!, 'boot-2');
      h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
      await settle();
      expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
    });
  });

  describe('operator commands after an announcement', () => {
    it('manual pick: today command, the announced song never plays', async () => {
      const h = harness();
      await onAir(h);
      const announced = h.palazzo.queued!;

      h.engine.handleManualSong(
        PROGRAM,
        MANUAL.url,
        MANUAL.title,
        MANUAL.artist,
        180_000,
      );
      await settle();

      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, MANUAL.url]);
      expect(h.palazzo.queued).toBeNull();
      h.palazzo.start();
      await settle();
      // A late start of the flushed song is not the engine's.
      h.palazzo.start(announced);
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(MANUAL.url);
      // The manual song announces the playlist successor again.
      expect(h.palazzo.announced.at(-1)?.id).not.toBe(announced.id);
    });

    it('stop: the announced song never plays and nothing is announced', async () => {
      const h = harness();
      await onAir(h);

      h.palazzo.stop();
      h.engine.handleStopSong(PROGRAM);
      await settle();

      expect(h.palazzo.queued).toBeNull();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      expect(h.engine.getPlaybackState(PROGRAM)).toBeNull();
      expect(h.palazzo.withdrawals).toBe(0);
    });

    it('skip to the announced song itself: today command under a new ID', async () => {
      const h = harness();
      await onAir(h);
      const announced = h.palazzo.queued!;

      h.engine.handleManualSong(
        PROGRAM,
        SONGS[1].url,
        SONGS[1].title,
        SONGS[1].artist,
        180_000,
      );
      await settle();

      const skip = h.palazzo.commands[1];
      expect(skip.url).toBe(SONGS[1].url);
      expect(skip.id).not.toBe(announced.id);
    });

    it('closes an announced song that already started under overlap', async () => {
      const h = harness();
      const store = asRunStore();
      const asRun = new AsRunService(
        store.prisma as unknown as PrismaService,
        h.engine,
      );
      asRun.onModuleInit();
      await onAir(h);
      const announced = h.palazzo.queued!;
      h.palazzo.start(announced);
      await settle();

      h.palazzo.stop();
      h.engine.handleStopSong(PROGRAM);
      await settle();
      asRun.onModuleDestroy();

      expect(
        store.rows
          .filter((row) => row.playbackRequestId === announced.id)
          .map((row) => [row.state, row.endReason]),
      ).toEqual([
        ['started', null],
        ['ended', 'stopped'],
      ]);
    });
  });

  describe('the end race', () => {
    it('commands the chosen song at once and records the announced one as started and preempted, never counted', async () => {
      const h = harness();
      const store = asRunStore();
      const asRun = new AsRunService(
        store.prisma as unknown as PrismaService,
        h.engine,
      );
      asRun.onModuleInit();
      await onAir(h);
      const first = h.palazzo.current!;
      const announced = h.palazzo.queued!;

      // A last-moment queue change: its announcement is still unanswered
      // when the song ends, so Palazzo starts the one it already had.
      h.palazzo.holdAnswers = true;
      await h.engine.enqueueSong(PROGRAM, SONGS[4].itemId);
      await settle();
      jest.setSystemTime(Date.now() + 180_000);
      h.palazzo.endCurrent();
      await settle();

      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[4].url]);
      expect(h.metrics.snapshot().handoffs).toEqual({ race_replaced: 1 });
      h.palazzo.releaseAnswers();
      h.palazzo.start();
      await settle();
      asRun.onModuleDestroy();

      expect(
        store.rows
          .filter((row) => row.playbackRequestId === announced.id)
          .map((row) => [row.state, row.endReason]),
      ).toEqual([
        ['started', null],
        ['ended', 'preempted'],
      ]);
      expect(
        store.rows.filter(
          (row) => row.playbackRequestId === first.id && row.state === 'ended',
        ),
      ).toHaveLength(1);
      const sx = await asRun.export(PROGRAM, { format: 'soundexchange' });
      expect(sx).not.toContain(SONGS[1].title);
      expect(sx).toContain(`${SONGS[0].title},,,,1`);
    });

    it('records a start that arrives after the replacing command as started and preempted', async () => {
      const h = harness();
      const store = asRunStore();
      const asRun = new AsRunService(
        store.prisma as unknown as PrismaService,
        h.engine,
      );
      asRun.onModuleInit();
      await onAir(h);
      const announced = h.palazzo.queued!;
      h.palazzo.holdAnswers = true;
      await h.engine.enqueueSong(PROGRAM, SONGS[4].itemId);
      await settle();

      // Palazzo has not yet started the announced song when the end arrives.
      h.palazzo.queued = null;
      h.palazzo.endCurrent();
      await settle();
      h.palazzo.start(announced);
      await settle();
      asRun.onModuleDestroy();

      expect(
        store.rows
          .filter((row) => row.playbackRequestId === announced.id)
          .map((row) => [row.state, row.endReason]),
      ).toEqual([
        ['started', null],
        ['ended', 'preempted'],
      ]);
      expect(h.metrics.snapshot().handoffs).toEqual({ race_replaced: 1 });
    });

    it('keeps at most the latest preempted announcements', async () => {
      const h = harness();
      await onAir(h);
      const preempted: string[] = [];
      for (let n = 0; n < 40; n += 1) {
        h.palazzo.holdAnswers = true;
        h.engine.handleSequenceUpdated(PROGRAM, {
          ...h.sequence(),
          mode: 'manual',
        });
        await settle();
        h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
        await settle();
        preempted.push(h.palazzo.announced.at(-1)!.id);
        h.palazzo.queued = null;
        h.palazzo.endCurrent();
        await settle();
        h.palazzo.releaseAnswers();
        h.palazzo.start();
        await settle();
      }
      expect(h.metrics.snapshot().handoffs).toEqual({ command: 40 });

      const recorded: string[] = [];
      const subscription = h.engine.trackEvents$.subscribe((event) =>
        recorded.push(event.playbackRequestId),
      );
      // The oldest preempted IDs were dropped; the latest are still known.
      h.palazzo.start({ id: preempted[0], url: SONGS[1].url });
      h.palazzo.start({ id: preempted[39], url: SONGS[1].url });
      subscription.unsubscribe();
      expect(recorded).toEqual([preempted[39], preempted[39]]);
    });
  });

  describe('an announced song that is late or unreachable', () => {
    it('422: the current song is untouched and the next goes by command at its end', async () => {
      const h = harness();
      h.palazzo.answer = () => 'not_ready';
      await onAir(h);
      expect(h.palazzo.queued).toBeNull();

      h.palazzo.endCurrent();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
      expect(h.metrics.snapshot().handoffs).toEqual({ command: 1 });
    });

    it('not_ready withdrawal before the end: the next goes by command', async () => {
      const h = harness();
      await onAir(h);
      h.palazzo.event('playout.next_withdrawn', {
        playbackId: h.palazzo.queued!.id,
        reason: 'not_ready',
      });
      h.palazzo.queued = null;

      h.palazzo.endCurrent();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
    });

    it('not_ready withdrawal after promotion: the next is commanded at once', async () => {
      const h = harness();
      await onAir(h);
      const announced = h.palazzo.queued!;

      // The end arrives first and the engine promotes before the withdrawal.
      h.palazzo.queued = null;
      h.palazzo.endCurrent();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      h.palazzo.event('playout.next_withdrawn', {
        playbackId: announced.id,
        reason: 'not_ready',
      });
      await settle();

      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
      expect(h.palazzo.commands[1].id).not.toBe(announced.id);
      h.palazzo.start();
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    });

    it('ignores withdrawals for other reasons or other songs', async () => {
      const h = harness();
      await onAir(h);
      h.palazzo.event('playout.next_withdrawn', {
        playbackId: h.palazzo.queued!.id,
        reason: 'replaced',
      });
      h.palazzo.event('playout.next_withdrawn', {
        playbackId: 'unknown',
        reason: 'not_ready',
      });
      h.palazzo.endCurrent();
      await settle();
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    });

    it('not_ready at the end itself: the next goes by command', async () => {
      const h = harness();
      await onAir(h);
      h.palazzo.notReadyAtEnd = true;
      h.palazzo.endCurrent();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
    });
  });

  describe('snapshots', () => {
    it('a playing snapshot of the announced song does not supersede the current one', async () => {
      const h = harness();
      await onAir(h);
      h.playing(h.palazzo.queued!);
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[0].url);
      h.palazzo.endCurrent();
      await settle();
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    });

    it('a snapshot of the announced song is its inferred start when the event is missing', async () => {
      const h = harness();
      const store = asRunStore();
      const asRun = new AsRunService(
        store.prisma as unknown as PrismaService,
        h.engine,
      );
      asRun.onModuleInit();
      await onAir(h);
      const announced = h.palazzo.queued!;
      // Overlap began, but the start event was lost; the snapshot shows it.
      h.playing(announced);
      h.playing(announced);
      await settle();
      // The late real start adds nothing.
      h.palazzo.start(announced);
      h.palazzo.endCurrent();
      await settle();
      asRun.onModuleDestroy();

      expect(
        store.rows
          .filter((row) => row.playbackRequestId === announced.id)
          .map((row) => [row.state, row.inferred]),
      ).toEqual([['started', true]]);
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    });

    it('a snapshot without a start time infers the start now', async () => {
      const h = harness();
      const events: { inferred?: boolean; at: Date }[] = [];
      const subscription = h.engine.trackEvents$.subscribe((event) =>
        events.push(event),
      );
      await onAir(h);
      const state = snapshot('boot-1', 99, h.palazzo.queued);
      state.track!.startedAt = 'not a time';
      h.engine.handlePalazzoSnapshot(PROGRAM, state);
      subscription.unsubscribe();
      expect(events.at(-1)).toEqual(
        expect.objectContaining({ inferred: true, at: new Date(Date.now()) }),
      );
    });

    it('an idle snapshot drops an announcement that never started', async () => {
      const h = harness();
      await onAir(h);
      h.palazzo.queued = null;
      h.palazzo.current = null;
      h.idle();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
      expect(h.metrics.snapshot().handoffs).toEqual({ command: 1 });
    });

    it("counts a promoted song once when #168's inferred end and a late real end both arrive", async () => {
      const h = harness();
      const store = asRunStore();
      const asRun = new AsRunService(
        store.prisma as unknown as PrismaService,
        h.engine,
      );
      asRun.onModuleInit();
      await onAir(h);
      h.palazzo.endCurrent({ overlap: true });
      await settle();
      const promoted = h.palazzo.current!;

      // The promoted song's end is lost; Palazzo later reports idle.
      h.palazzo.current = null;
      h.palazzo.queued = null;
      h.idle();
      await settle();
      h.palazzo.event('track.ended', { playbackRequestId: promoted.id });
      await settle();
      asRun.onModuleDestroy();

      const ended = store.rows.filter(
        (row) => row.playbackRequestId === promoted.id && row.state === 'ended',
      );
      expect(ended).toEqual([expect.objectContaining({ inferred: true })]);
    });
  });

  describe('ends that command nothing themselves', () => {
    it('withdraws the announced song when nothing follows', async () => {
      const h = harness();
      await onAir(h);
      h.engine.handleSequenceUpdated(PROGRAM, {
        ...h.sequence(),
        items: [],
      });
      // The withdrawal of the previous refresh is still pending.
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.withdrawals).toBeGreaterThanOrEqual(1);
      expect(h.palazzo.commands).toHaveLength(1);
    });

    it('withdraws when a clocked log takes over at the end', async () => {
      let clocked = false;
      const h = harness({ clockedLog: () => clocked });
      await onAir(h);
      clocked = true;
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.withdrawals).toBe(1);
      expect(h.metrics.snapshot().handoffs).toEqual({});
    });
  });

  describe('compatibility', () => {
    async function runSession(h: ReturnType<typeof harness>) {
      await onAir(h);
      for (let n = 0; n < 5; n += 1) {
        h.palazzo.endCurrent();
        await settle();
        if (h.palazzo.commands.length > n + 1) {
          h.palazzo.start();
          await settle();
        }
      }
      return h.palazzo.radioService.playSong.mock.calls.map((call) => {
        const args = call as unknown[];
        return [
          args[0],
          args[1],
          args[2],
          args[3],
          typeof args[4],
          args[5],
          args[6],
        ];
      });
    }

    it('a session with no announcement accepted sends exactly the commands of today', async () => {
      const today = harness();
      delete (
        today.palazzo.radioService as Partial<typeof today.palazzo.radioService>
      ).announceNext;
      const rejected = harness();
      rejected.palazzo.answer = () => 'rejected';

      const expected = SONGS.map((song) => [
        PROGRAM,
        song.url,
        song.title,
        song.artist,
        'string',
        '',
        undefined,
      ]);
      expect(await runSession(today)).toEqual(expected);
      expect(await runSession(rejected)).toEqual(expected);
      expect(rejected.metrics.snapshot().handoffs).toEqual({ command: 5 });
    });

    it('an older Palazzo (404) gets exactly the commands of today and one announcement attempt', async () => {
      const older = harness();
      older.palazzo.older = true;
      const commands = await runSession(older);

      expect(commands).toEqual(
        SONGS.map((song) => [
          PROGRAM,
          song.url,
          song.title,
          song.artist,
          'string',
          '',
          undefined,
        ]),
      );
      expect(older.palazzo.radioService.announceNext).toHaveBeenCalledTimes(1);
      expect(older.palazzo.radioService.withdrawNext).not.toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('exposes the two counters with bounded labels only', async () => {
      const h = harness();
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();

      const text = h.metrics.render();
      const lines = text
        .split('\n')
        .filter((line) =>
          /^alcantara_radio_(next_announcements|handoffs)_total/.test(line),
        );
      expect(lines).toEqual([
        'alcantara_radio_next_announcements_total{result="accepted"} 0',
        'alcantara_radio_next_announcements_total{result="not_ready"} 0',
        'alcantara_radio_next_announcements_total{result="rejected"} 0',
        'alcantara_radio_next_announcements_total{result="unsupported"} 0',
        'alcantara_radio_next_announcements_total{result="withdrawn"} 0',
        'alcantara_radio_handoffs_total{path="preloaded"} 1',
        'alcantara_radio_handoffs_total{path="command"} 0',
        'alcantara_radio_handoffs_total{path="race_replaced"} 0',
      ]);
      h.metrics.recordHandoff('other' as never);
      h.metrics.recordNextAnnouncement('other' as never);
      h.metrics.recordNextAnnouncement('accepted');
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
      expect(h.metrics.snapshot().nextAnnouncements).toEqual({ accepted: 1 });
    });

    it('a metrics failure never affects the handoff', async () => {
      const metrics = new RadioMetricsService();
      metrics.recordHandoff = () => {
        throw new Error('metrics down');
      };
      const h = harness({ metrics });
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    });
  });

  describe('edge cases', () => {
    it('an operator pick during the announcement lookup announces nothing for the replaced song', async () => {
      const h = harness();
      h.idle();
      await settle();
      let releaseSettings!: () => void;
      h.palazzo.radioService.getRadioSettings.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSettings = () => resolve(h.palazzo.settings);
          }),
      );
      h.palazzo.start();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      // The lookup is waiting; the operator takes another song on air.
      h.engine.handleManualSong(
        PROGRAM,
        MANUAL.url,
        MANUAL.title,
        MANUAL.artist,
        180_000,
      );
      releaseSettings();
      await settle();
      expect(h.palazzo.announced).toEqual([]);
    });

    it.each(['not_ready', 'rejected'] as const)(
      'withdraws the accepted announcement at once when a re-announcement is refused (%s)',
      async (answer) => {
        const h = harness();
        const store = asRunStore();
        const asRun = new AsRunService(
          store.prisma as unknown as PrismaService,
          h.engine,
        );
        asRun.onModuleInit();
        await onAir(h);
        const accepted = h.palazzo.queued!;
        h.palazzo.answer = () => answer;
        await h.engine.enqueueSong(PROGRAM, SONGS[3].itemId);
        await settle();

        // Palazzo kept the accepted one queued after the refused PUT; the
        // engine withdraws it right away, so it never plays.
        expect(h.palazzo.withdrawals).toBe(1);
        expect(h.palazzo.queued).toBeNull();
        h.palazzo.endCurrent();
        await settle();
        asRun.onModuleDestroy();

        expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[3].url]);
        expect(h.metrics.snapshot().handoffs).toEqual({ command: 1 });
        expect(
          store.rows.filter((row) => row.playbackRequestId === accepted.id),
        ).toEqual([]);
        // Nothing left to withdraw afterwards.
        h.palazzo.start();
        await settle();
        h.engine.handleSequenceUpdated(PROGRAM, {
          ...h.sequence(),
          mode: 'manual',
        });
        await settle();
        expect(h.palazzo.withdrawals).toBe(1);
      },
    );

    it('a failed lookup announces nothing and the handoff goes by command', async () => {
      const h = harness();
      h.palazzo.radioService.getRadioSettings.mockRejectedValueOnce(
        new Error('database unavailable'),
      );
      await onAir(h);
      expect(h.palazzo.announced).toEqual([]);
      h.palazzo.endCurrent();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
    });

    it('withdraws the accepted announcement when the re-announcement fails outright', async () => {
      const h = harness();
      await onAir(h);
      h.palazzo.radioService.announceNext.mockRejectedValueOnce(
        new Error('connection refused'),
      );
      await h.engine.enqueueSong(PROGRAM, SONGS[3].itemId);
      await settle();
      expect(h.palazzo.withdrawals).toBe(1);
      expect(h.palazzo.queued).toBeNull();
    });

    it('keeps an announced song that already started, and closes it at the handoff', async () => {
      for (const clockedAtEnd of [false, true]) {
        let clocked = false;
        const h = harness({ clockedLog: () => clocked });
        const store = asRunStore();
        const asRun = new AsRunService(
          store.prisma as unknown as PrismaService,
          h.engine,
        );
        asRun.onModuleInit();
        await onAir(h);
        const accepted = h.palazzo.queued!;
        // A re-announcement is in flight when the accepted song starts under
        // overlap; the re-announcement is then refused.
        h.palazzo.holdAnswers = true;
        h.palazzo.answer = () => 'not_ready';
        await h.engine.enqueueSong(PROGRAM, SONGS[3].itemId);
        await settle();
        h.palazzo.start(accepted);
        await settle();
        h.palazzo.releaseAnswers();
        await settle();
        expect(h.palazzo.withdrawals).toBe(0);
        // Once it started nothing is re-announced.
        await h.engine.enqueueSong(PROGRAM, SONGS[4].itemId);
        await settle();
        expect(h.palazzo.announced).toHaveLength(2);

        clocked = clockedAtEnd;
        h.palazzo.queued = null;
        h.palazzo.endCurrent();
        await settle();
        asRun.onModuleDestroy();
        expect(
          store.rows
            .filter((row) => row.playbackRequestId === accepted.id)
            .map((row) => [row.state, row.endReason]),
        ).toEqual([
          ['started', null],
          ['ended', 'preempted'],
        ]);
      }
    });

    it('an end that commands nothing leaves a not-announced successor alone', async () => {
      const h = harness();
      h.palazzo.answer = () => 'not_ready';
      await onAir(h);
      h.engine.handleSequenceUpdated(PROGRAM, { ...h.sequence(), items: [] });
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.withdrawals).toBe(0);
    });

    it('a failed withdrawal at the end is logged and changes nothing else', async () => {
      let clocked = false;
      const h = harness({ clockedLog: () => clocked });
      await onAir(h);
      h.palazzo.radioService.withdrawNext.mockRejectedValueOnce(
        new Error('palazzo down'),
      );
      clocked = true;
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.radioService.withdrawNext).toHaveBeenCalledTimes(1);
    });

    it('commands a promoted song without a catalog ID when it was not ready', async () => {
      const h = harness({ withoutSongId: SONGS[1].itemId });
      await onAir(h);
      const announced = h.palazzo.queued!;
      h.palazzo.queued = null;
      h.palazzo.endCurrent();
      await settle();
      h.palazzo.event('playout.next_withdrawn', {
        playbackId: announced.id,
        reason: 'not_ready',
      });
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
    });

    it('peeks with the similarity picker without recording a decision', async () => {
      const similarity = {
        getSettings: () => ({ mode: 'shadow' }),
        propose: jest.fn(() => ({
          result: {
            outcome: 'fallback-no-candidate',
            chosen: null,
            runnerUps: [],
            cycleReset: false,
          },
          leaf: null,
        })),
        recordDecision: jest.fn(),
        noteSongStarted: jest.fn(),
      };
      const h = harness({ similarity });
      await onAir(h);
      expect(h.palazzo.announced).toHaveLength(1);
      const decisionsBeforeEnd = similarity.recordDecision.mock.calls.length;
      h.palazzo.endCurrent();
      await settle();

      // Only the real selection at the end records a decision.
      expect(similarity.recordDecision).toHaveBeenCalledTimes(
        decisionsBeforeEnd + 1,
      );
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
// In-memory as-run store with the migration's unique key.
// ---------------------------------------------------------------------------

type Row = {
  id: number;
  programId: string;
  songId: number | null;
  assetId: string | null;
  state: string;
  at: Date;
  createdAt: Date;
  playbackRequestId: string;
  inferred: boolean;
  reviewFlag: string | null;
  endReason: string | null;
};

function asRunStore() {
  const rows: Row[] = [];
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) => key === 'at' || row[key as keyof Row] === value,
    );
  const catalog = [
    ...SONGS.map((song) => ({ ...song, audioUrl: song.url })),
    { ...MANUAL, audioUrl: MANUAL.url },
  ];
  const prisma = {
    asRunRecord: {
      create: jest.fn(
        ({
          data,
        }: {
          data: Omit<Row, 'id' | 'createdAt' | 'endReason'> & {
            endReason?: string;
          };
        }) => {
          if (
            rows.some(
              (row) =>
                row.programId === data.programId &&
                row.playbackRequestId === data.playbackRequestId &&
                row.state === data.state,
            )
          ) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError(
                'Unique constraint failed',
                {
                  code: 'P2002',
                  clientVersion: 'test',
                },
              ),
            );
          }
          const row: Row = {
            endReason: null,
            ...data,
            id: rows.length + 1,
            createdAt: data.at,
          };
          rows.push(row);
          return Promise.resolve(row);
        },
      ),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((row) => matches(row, where))),
      ),
    },
    song: {
      findFirst: jest.fn(({ where }: { where: { audioUrl?: string } }) => {
        const song = catalog.find((s) => s.audioUrl === where.audioUrl);
        return Promise.resolve(song ? { id: song.id, assetId: null } : null);
      }),
      findMany: jest.fn(({ where }: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          catalog
            .filter((s) => where.id.in.includes(s.id))
            .map((s) => ({ id: s.id, title: s.title, artist: s.artist })),
        ),
      ),
    },
    mediaAsset: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return { rows, prisma };
}
