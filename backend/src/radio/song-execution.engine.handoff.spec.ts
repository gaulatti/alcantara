import { Prisma } from '@prisma/client';
import {
  SIMILARITY_READY_WAIT_MS,
  SongExecutionEngine,
  ANNOUNCED_START_GRACE_MS,
} from './song-execution.engine';
import { Logger } from '@nestjs/common';
import { RadioMetricsService } from './radio-metrics.service';
import { AsRunService } from '../as-run/as-run.service';
import {
  PalazzoInstantRefusedException,
  type RadioService,
} from './radio.service';
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
    undefined,
    options.lease as never,
  );
  palazzo.engine = engine;
  engine.setPalazzoTelemetry({ isReconciled: () => true });
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

  // The radio desk's walk 4: "Status delayed / No live clock" flashed once at a gapless handoff.
  it('does not call a promoted song stale while its start is on its way', async () => {
    const h = harness();
    await onAir(h);

    // The ending song's end arrives before the next song's start, as Palazzo can send them.
    h.engine.handlePalazzoEvent(PROGRAM, {
      type: 'track.ended',
      data: { playbackRequestId: h.palazzo.current!.id },
    });
    for (let j = 0; j < 60; j += 1) await Promise.resolve();

    expect(h.engine.getPlaybackState(PROGRAM)).toMatchObject({
      audioUrl: SONGS[1].url,
      telemetryStale: false,
    });
    // A start that never comes is still reported stale after the window.
    jest.advanceTimersByTime(16_000);
    expect(h.engine.getPlaybackState(PROGRAM)?.telemetryStale).toBe(true);
  });

  // The radio walk: the desk named the song behind a jingle as on air while the jingle played.
  it('says a jingle is chosen, then that it is on in front of the promoted song, then nothing', async () => {
    const h = harness({ capabilities: ['next.bumper'] });
    h.palazzo.settings = {
      bumperEnabled: true,
      bumperInterval: 1,
      bumperInstantIds: [1],
      bumperMode: 'sequential',
    };
    await onAir(h);
    const next = h.palazzo.queued!;
    const spot = { playbackId: next.bumper!.playbackId };
    const playback = () => h.engine.getPlaybackState(PROGRAM)!;
    expect(playback().jingleNext).toEqual({ name: 'Bumper' });
    expect(playback()).not.toHaveProperty('jingle');

    // The spot starts just before the ending song's end: that song is still on air.
    h.palazzo.event('instant.started', spot);
    expect(playback()).not.toHaveProperty('jingle');

    h.palazzo.event('track.ended', {
      playbackRequestId: h.palazzo.current!.id,
    });
    for (let j = 0; j < 60; j += 1) await Promise.resolve();
    expect(playback().audioUrl).toBe(SONGS[1].url);
    expect(playback().jingle).toEqual({ name: 'Bumper' });

    h.palazzo.event('instant.ended', spot);
    expect(playback()).not.toHaveProperty('jingle');
  });

  it.each([false, true])(
    'tells the desk of a commanded jingle, and that it is over unless a song replaced it (%s)',
    async (replaced) => {
      const h = harness();
      h.palazzo.settings = {
        bumperEnabled: true,
        bumperInterval: 1,
        bumperInstantIds: [1],
        bumperMode: 'sequential',
      };
      const jingles: (string | null)[] = [];
      h.engine.setBroadcastHandler((event) => {
        if (event.type === 'jingle_command') jingles.push(event.name);
      });
      await onAir(h);
      const state = h.engine['states'].get(PROGRAM)!;
      const song = state.activeSong;
      // Between two songs, as the commanded spot runs: nothing active.
      state.activeSong = null;
      const done = h.engine['maybeBumper'](PROGRAM);
      for (let j = 0; j < 60; j += 1) await Promise.resolve();
      expect(jingles).toEqual(['Bumper']);
      if (replaced) state.activeSong = song;
      await jest.advanceTimersByTimeAsync(8_000);
      await done;
      expect(jingles).toEqual(replaced ? ['Bumper'] : ['Bumper', null]);
    },
  );

  // gaulatti/alcantara#879 air audit: a Palazzo restart cut "mid-song" and the as-run log read like a natural end.
  describe('a Palazzo restart under a song', () => {
    const watch = (h: ReturnType<typeof harness>) => {
      const ends: { reason?: string; inferred?: true; at: Date }[] = [];
      const cuts: { title: string; cutAtMs: number }[] = [];
      h.engine.trackEvents$.subscribe((event) => {
        if (event.type === 'track.ended')
          ends.push({
            reason: event.endReason,
            inferred: event.inferred,
            at: event.at,
          });
      });
      h.engine.setBroadcastHandler((event) => {
        if (event.type === 'playout_restart_cut') cuts.push(event);
      });
      return { ends, cuts };
    };
    const heard = (h: ReturnType<typeof harness>, seconds: number) =>
      h.palazzo.event('playback.position', {
        playbackRequestId: h.palazzo.current!.id,
        positionSeconds: seconds,
        remainingSeconds: 180 - seconds,
      });

    it('closes the song as cut where it was last heard, tells the desk, and moves on', async () => {
      const h = harness();
      const seen = watch(h);
      await onAir(h);
      heard(h, 115);
      const lastHeard = Date.now();
      jest.advanceTimersByTime(8_000);
      h.palazzo.stop();
      h.idle('boot-2');
      await settle();

      expect(seen.cuts).toMatchObject([
        { title: SONGS[0].title, cutAtMs: 115_000 },
      ]);
      expect(seen.ends).toEqual([
        {
          reason: 'playout_restart',
          inferred: true,
          at: new Date(lastHeard),
        },
      ]);
      // Not sent again from the start: the rotation goes on with the next song.
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[1].url]);
    });

    it('takes a song with only seconds left, or an idle read of the same process, as an ordinary end', async () => {
      for (const [seconds, boot] of [
        [172, 'boot-2'],
        [115, 'boot-1'],
      ] as const) {
        const h = harness();
        const seen = watch(h);
        await onAir(h);
        heard(h, seconds);
        h.palazzo.stop();
        h.idle(boot);
        await settle();
        expect(seen.cuts).toEqual([]);
        expect(seen.ends.map((end) => end.reason)).toEqual([undefined]);
      }
    });

    it('claims no cut for a song Palazzo never reported a position for, or still plays', async () => {
      // Nothing on air when Palazzo restarted.
      const quiet = harness();
      const nothing = watch(quiet);
      quiet.idle();
      quiet.engine['states'].get(PROGRAM)!.activeSong = null;
      quiet.idle('boot-2');
      await settle();
      expect(nothing.cuts).toEqual([]);

      // Commanded, and the restart came before Palazzo reported it at all.
      const silent = harness();
      const seen = watch(silent);
      silent.idle();
      await settle();
      silent.palazzo.stop();
      silent.idle('boot-2');
      await settle();
      expect(seen.cuts).toEqual([]);

      const kept = harness();
      const still = watch(kept);
      await onAir(kept);
      heard(kept, 60);
      kept.playing(kept.palazzo.current!, 'boot-2');
      await settle();
      expect(still.cuts).toEqual([]);
      expect(still.ends).toEqual([]);
    });
  });

  it('accepts the announced start under overlap and records one start and one end per song', async () => {
    const h = harness();
    const store = asRunStore();
    const asRun = new AsRunService(
      store.prisma as unknown as PrismaService,
      { teamId: 0 } as never,
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

  // Yakko's pre-read of #804's Play Next fix: an announced queue head is claimed under the announcement's ID at the
  // handoff. An announcement is not a song command, so that ID is never marked as sent and the head is promoted, not
  // dropped as a stale claim.
  it('promotes an announced queue head at the handoff without marking its ID as sent', async () => {
    const h = harness();
    await onAir(h);
    const [entry] = await h.engine.enqueueSong(PROGRAM, SONGS[4].itemId);
    await settle();
    const announcedId = h.palazzo.announced[h.palazzo.announced.length - 1].id;
    h.palazzo.endCurrent();
    await settle();
    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(h.engine.getPlaybackState(PROGRAM)).toEqual(
      expect.objectContaining({
        audioUrl: SONGS[4].url,
        queueEntryId: entry.id,
      }),
    );
    const state = (
      h.engine as unknown as {
        states: Map<string, { sentRequestIds?: Set<string> }>;
      }
    ).states.get(PROGRAM)!;
    expect(state.sentRequestIds?.has(announcedId) ?? false).toBe(false);
    expect(
      h.metrics.snapshot().songQueueActions['stale-claim-dropped'],
    ).toBeUndefined();
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
        { teamId: 0 } as never,
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
        { teamId: 0 } as never,
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
        { teamId: 0 } as never,
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
        { teamId: 0 } as never,
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
        { teamId: 0 } as never,
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

  describe('only an order-determined successor is announced', () => {
    function withDurations(h: ReturnType<typeof harness>, startedAt: number) {
      h.engine.handleSequenceUpdated(PROGRAM, {
        ...h.sequence(),
        startedAt,
        items: (h.sequence().items as Record<string, unknown>[]).map(
          (entry) => ({ ...entry, durationMs: 6000 }),
        ),
      });
    }

    it('announces after a normal operator start, the item the end selects', async () => {
      const h = harness();
      withDurations(h, Date.now());
      await onAir(h);
      expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
      h.palazzo.endCurrent();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    });

    it('announces the item the end selects even when the song outlasts the playlist timing', async () => {
      const h = harness();
      withDurations(h, Date.now());
      h.idle();
      await settle();
      // An operator takes a playlist song on air with a longer duration than
      // the playlist's own items.
      h.engine.handleManualSong(
        PROGRAM,
        SONGS[2].url,
        SONGS[2].title,
        SONGS[2].artist,
        190_000,
      );
      await settle();
      h.palazzo.start();
      await settle();
      expect(urls(h.palazzo.announced)).toEqual([SONGS[3].url]);
      jest.setSystemTime(Date.now() + 190_000);
      h.palazzo.endCurrent();
      await settle();
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    });

    it('announces through a nested sequence whose cursor the end advances', async () => {
      const h = harness();
      const items = h.sequence().items as Record<string, unknown>[];
      h.engine.handleSequenceUpdated(PROGRAM, {
        ...h.sequence(),
        startedAt: Date.now(),
        items: [
          {
            id: 'block',
            kind: 'sequence',
            label: 'Block',
            sequence: {
              mode: 'autoplay',
              loop: false,
              intervalMs: 500,
              startedAt: Date.now(),
              items: items
                .slice(0, 3)
                .map((entry) => ({ ...entry, durationMs: 6000 })),
            },
          },
          ...items.slice(3).map((entry) => ({ ...entry, durationMs: 6000 })),
        ],
      });
      await onAir(h);
      expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
      h.palazzo.endCurrent();
      await settle();
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    });

    it('announces the cursor item after a queued song, even on an epoch-anchored playlist (#176)', async () => {
      const h = harness();
      // Before #176 the song after a queued one was chosen by elapsed time
      // from the playlist stamp and was not announced. It is now the cursor
      // item by position, so it is order-determined and announced.
      withDurations(h, 0);
      await onAir(h);
      await h.engine.enqueueSong(PROGRAM, SONGS[5].itemId);
      await settle();
      h.palazzo.endCurrent();
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[5].url);
      expect(h.palazzo.announced.at(-1)?.url).toBe(SONGS[1].url);
      jest.setSystemTime(Date.now() + 6000);
      h.palazzo.endCurrent();
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 2 });
    });

    it('holds the successor chosen for the expected end even when a favourite comes due before a late end', async () => {
      const h = harness();
      const items = (h.sequence().items as Record<string, unknown>[]).map(
        (entry, i) => ({ ...entry, durationMs: 6000, highRotation: i === 0 }),
      );
      h.engine.handleSequenceUpdated(PROGRAM, {
        ...h.sequence(),
        startedAt: Date.now(),
        items,
      });
      // The favorite plays first and is recorded at its start.
      await onAir(h);
      const favoritePlayedAt = Date.now();
      expect(h.palazzo.current?.url).toBe(SONGS[0].url);
      // The next song starts 20 s before the favorite is due again (30 min):
      // it is not due at that song's expected end (6 s later).
      jest.setSystemTime(favoritePlayedAt + 30 * 60_000 - 20_000);
      h.palazzo.endCurrent();
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
      // The successor chosen for its expected end is announced.
      expect(h.palazzo.announced.at(-1)?.url).toBe(SONGS[2].url);
      // It ends a minute late, after the favorite came due: the held choice
      // plays, with no command, and the favorite waits for the next change.
      jest.setSystemTime(favoritePlayedAt + 30 * 60_000 + 60_000);
      h.palazzo.endCurrent();
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[2].url);
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 2 });
      expect(h.palazzo.announced.at(-1)?.url).toBe(SONGS[0].url);
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
          { teamId: 0 } as never,
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

    it('too late to replace: an announced song already on air is recorded as started and preempted', async () => {
      const h = harness();
      const store = asRunStore();
      const asRun = new AsRunService(
        store.prisma as unknown as PrismaService,
        { teamId: 0 } as never,
        h.engine,
      );
      asRun.onModuleInit();
      await onAir(h);
      const first = h.palazzo.current!;
      const announced = h.palazzo.queued!;
      // At the cue-out the announced song's gate opens: Palazzo refuses the
      // re-announcement (422) and cannot withdraw it.
      h.palazzo.onAirEarly = announced;
      h.palazzo.answer = () => 'not_ready';
      await h.engine.enqueueSong(PROGRAM, SONGS[4].itemId);
      await settle();
      expect(h.palazzo.withdrawals).toBe(1);
      expect(h.palazzo.queued).toEqual(announced);
      // Its start arrives after the DELETE, then the previous song ends.
      h.palazzo.endCurrent();
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[4].url]);
      expect(h.metrics.snapshot().handoffs).toEqual({ race_replaced: 1 });
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
        store.rows.filter((row) => row.playbackRequestId === first.id),
      ).toHaveLength(2);
    });

    it('keeps a not-withdrawn announcement through a further change and withdraws it with the successor', async () => {
      const h = harness();
      await onAir(h);
      h.palazzo.onAirEarly = h.palazzo.queued;
      h.palazzo.answer = () => 'not_ready';
      const [entry] = await h.engine.enqueueSong(PROGRAM, SONGS[3].itemId);
      await settle();
      await h.engine.removeQueuedSong(PROGRAM, entry.id);
      await settle();
      h.engine.handleSequenceUpdated(PROGRAM, {
        ...h.sequence(),
        mode: 'manual',
      });
      await settle();
      // Refused re-announcements each tried a withdrawal; the last one goes
      // with the successor.
      expect(h.palazzo.withdrawals).toBe(3);
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
          { teamId: 0 } as never,
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
        isReady: () => true,
        whenReady: () => Promise.resolve(),
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

  // gaulatti/alcantara#232: at a bumper slot, a Palazzo that lists
  // next.bumper is given the successor with the slot's spot; it plays the spot
  // and the song at the spot's end, so there is no fixed sleep and no cold
  // command. Without the capability the slot stays today's path.
  describe('bumper slot (alcantara#232)', () => {
    const BUMPERS = {
      bumperEnabled: true,
      bumperInterval: 2,
      bumperInstantIds: [1, 2],
      bumperMode: 'sequential',
    };
    const metricLine = (h: ReturnType<typeof harness>, prefix: string) =>
      h.metrics
        .render()
        .split('\n')
        .filter((line) => line.startsWith(prefix));

    it('announces the successor with the spot, records the spot from Palazzo, and never sleeps or commands', async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      await onAir(h);
      // Song 1 ends on an ordinary change; song 2's end is the bumper slot.
      expect(h.palazzo.announced[0].bumper).toBeUndefined();
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.announced).toHaveLength(2);
      const spot = h.palazzo.announced[1].bumper!;
      expect(spot.url).toBe('https://media.test/bumper.mp3');
      expect(h.prisma.instant.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
      });

      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.spots).toEqual(['https://media.test/bumper.mp3']);
      expect(h.palazzo.radioService.playInstant).not.toHaveBeenCalled();
      // Only the first song was ever commanded; song 3 started from its deck.
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[2].url);
      expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 2 });
      expect(metricLine(h, 'alcantara_radio_bumpers_total')).toEqual([
        'alcantara_radio_bumpers_total{path="announced",result="sent"} 1',
        'alcantara_radio_bumpers_total{path="announced",result="played"} 1',
        'alcantara_radio_bumpers_total{path="command",result="sent"} 0',
        'alcantara_radio_bumpers_total{path="command",result="played"} 0',
        'alcantara_radio_bumpers_total{path="command",result="failed"} 0',
        'alcantara_radio_bumpers_total{path="command",result="retried"} 0',
      ]);
      // The sequence moved past the spot used: the next slot (song 4's end)
      // is announced with spot 2.
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.announced.at(-1)!.bumper).toBeDefined();
      expect(h.prisma.instant.findUnique).toHaveBeenLastCalledWith({
        where: { id: 2 },
      });
      // An instant Alcantara did not send changes nothing.
      h.palazzo.event('instant.started', { playbackId: 'someone-else' });
      h.palazzo.event('instant.ended', { playbackId: 'someone-else' });
      expect(
        metricLine(
          h,
          'alcantara_radio_bumpers_total{path="announced",result="played"}',
        ),
      ).toEqual([
        'alcantara_radio_bumpers_total{path="announced",result="played"} 1',
      ]);
    });

    it("keeps today's path without the capability: no announcement at the slot, the spot, 8 s, then the song by command", async () => {
      const h = harness();
      h.palazzo.settings = BUMPERS;
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.announced).toHaveLength(1);
      expect(
        metricLine(
          h,
          'alcantara_radio_announcement_skipped_total{reason="bumper_slot"}',
        ),
      ).toEqual([
        'alcantara_radio_announcement_skipped_total{reason="bumper_slot"} 1',
      ]);

      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
      const spotId = h.palazzo.radioService.playInstant.mock
        .calls[0][3] as string;
      await jest.advanceTimersByTimeAsync(8_000);
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url, SONGS[2].url]);
      expect(h.metrics.snapshot().handoffs).toEqual({
        preloaded: 1,
        command: 1,
      });
      h.palazzo.event('instant.started', { playbackId: spotId });
      expect(
        metricLine(h, 'alcantara_radio_bumpers_total{path="command"'),
      ).toEqual([
        'alcantara_radio_bumpers_total{path="command",result="sent"} 1',
        'alcantara_radio_bumpers_total{path="command",result="played"} 1',
        'alcantara_radio_bumpers_total{path="command",result="failed"} 0',
        'alcantara_radio_bumpers_total{path="command",result="retried"} 0',
      ]);
    });

    it("falls back to today's path when the announcement with the spot is refused", async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      h.palazzo.answer = (url) =>
        url === SONGS[2].url ? 'rejected' : 'accepted';
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.announced[1].bumper).toBeDefined();
      expect(
        metricLine(
          h,
          'alcantara_radio_announcement_skipped_total{reason="refused"}',
        ),
      ).toEqual([
        'alcantara_radio_announcement_skipped_total{reason="refused"} 1',
      ]);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.spots).toEqual([]);
      expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(8_000);
      await settle();
      expect(urls(h.palazzo.commands).at(-1)).toBe(SONGS[2].url);
    });

    it('keeps the spot chosen for a slot when the announcement is refreshed', async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      const calls = h.prisma.instant.findUnique.mock.calls.length;
      const announced = h.palazzo.announced.length;
      h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
      await settle();
      // Same successor and same spot: nothing is re-announced or re-chosen.
      expect(h.palazzo.announced).toHaveLength(announced);
      expect(h.prisma.instant.findUnique.mock.calls.length).toBe(calls);
    });

    it('skips a slot whose spot has no audio, and plays no spot at its end', async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      h.prisma.instant.findUnique.mockResolvedValue({
        id: 1,
        name: 'Silent',
        audioUrl: '',
      });
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.announced).toHaveLength(1);
      expect(
        metricLine(
          h,
          'alcantara_radio_announcement_skipped_total{reason="bumper_unavailable"}',
        ),
      ).toEqual([
        'alcantara_radio_announcement_skipped_total{reason="bumper_unavailable"} 1',
      ]);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.radioService.playInstant).not.toHaveBeenCalled();
      expect(urls(h.palazzo.commands).at(-1)).toBe(SONGS[2].url);
    });

    it('counts a slot whose spot is not found as bumper_unavailable, not bumper_slot', async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      h.prisma.instant.findUnique.mockResolvedValue(null);
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.announced).toHaveLength(1);
      expect(
        metricLine(
          h,
          'alcantara_radio_announcement_skipped_total{reason="bumper',
        ),
      ).toEqual([
        'alcantara_radio_announcement_skipped_total{reason="bumper_slot"} 0',
        'alcantara_radio_announcement_skipped_total{reason="bumper_unavailable"} 1',
      ]);
    });

    it('keeps the spot sequence where it was when the settings cannot be read at the end, or list no spot', async () => {
      for (const atEnd of ['throws', 'empty', 'none'] as const) {
        const h = harness({ capabilities: ['next.bumper'] });
        h.palazzo.settings = BUMPERS;
        await onAir(h);
        h.palazzo.endCurrent();
        await settle();
        expect(h.palazzo.announced[1].bumper).toBeDefined();
        if (atEnd === 'throws')
          h.palazzo.radioService.getRadioSettings.mockRejectedValueOnce(
            new Error('settings unavailable'),
          );
        else if (atEnd === 'empty')
          h.palazzo.settings = { ...BUMPERS, bumperInstantIds: [] };
        else
          h.palazzo.radioService.getRadioSettings.mockResolvedValueOnce(
            null as never,
          );
        h.palazzo.endCurrent();
        await settle();
        expect(h.palazzo.spots).toHaveLength(1);
        expect(
          (
            h.engine as unknown as {
              states: Map<string, { nextBumperIdx: number }>;
            }
          ).states.get(PROGRAM)!.nextBumperIdx,
        ).toBe(0);
      }
    });

    it("never lets another song's accepted spot announcement suppress the slot: the old path plays", async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.announced[1].bumper).toBeDefined();
      // The announcement is made stale: it belongs to some other song.
      const states = (
        h.engine as unknown as {
          states: Map<string, { announcement: { forRequestId: string } }>;
        }
      ).states;
      states.get(PROGRAM)!.announcement.forRequestId = 'another-song';
      h.palazzo.queued = null;
      h.palazzo.endCurrent();
      await settle();
      // The old path: the spot by instant command, counted under `command`.
      expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
      expect(
        h.metrics
          .render()
          .split('\n')
          .filter((line) => line.startsWith('alcantara_radio_bumpers_total')),
      ).toContain(
        'alcantara_radio_bumpers_total{path="command",result="sent"} 1',
      );
    });

    it('treats a 50 s announced spot on air as playback: the watchdog neither resyncs nor commands over it', async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      const next = h.palazzo.queued!;
      expect(next.bumper).toBeDefined();
      // Palazzo idle while the spot plays: no song on air.
      h.engine.setPalazzoTelemetry({
        isReconciled: () => true,
        // Idle, no live input, and the spot's level reading 0 (a quiet
        // passage, or a level that lags): the watchdog's 'nothing on air'.
        currentState: () =>
          Promise.resolve({
            ...snapshot('boot-1', 99, null, ['next.bumper']),
            live: { onAir: false },
          }),
      } as never);
      const ended = h.palazzo.current!;
      h.palazzo.queued = null;
      h.palazzo.event('track.ended', {
        playbackRequestId: ended.id,
        url: ended.url,
      });
      h.palazzo.event('instant.started', {
        playbackId: next.bumper!.playbackId,
      });
      await settle();
      // Watchdog reads at 0, 10, … 50 s: without the guard the 45 s bound
      // would pass and the rotation would be resumed over the spot.
      await h.engine.checkPlayback();
      for (let t = 0; t < 50; t += 10) {
        jest.setSystemTime(Date.now() + 10_000);
        await h.engine.checkPlayback();
      }
      await settle();
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      expect(h.metrics.render()).toContain(
        'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="resumed"} 0',
      );
      // The spot ends and the announced song starts: one preloaded handoff.
      h.palazzo.event('instant.ended', { playbackId: next.bumper!.playbackId });
      h.palazzo.current = next;
      h.palazzo.start(next);
      await settle();
      expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[2].url);
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      // Past the bound, a spot whose end never arrived no longer holds the watchdog.
      const states = (
        h.engine as unknown as {
          states: Map<string, { announcedSpotOnAir: unknown }>;
        }
      ).states;
      expect(states.get(PROGRAM)!.announcedSpotOnAir).toBeNull();
    });

    it('lets the watchdog judge again once an announced spot has been on air past the bound', async () => {
      const h = harness({ capabilities: ['next.bumper'] });
      h.palazzo.settings = BUMPERS;
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      const next = h.palazzo.queued!;
      h.engine.setPalazzoTelemetry({
        isReconciled: () => true,
        currentState: () =>
          Promise.resolve({
            ...snapshot('boot-1', 99, null, ['next.bumper']),
            live: { onAir: false },
          }),
      } as never);
      const ended = h.palazzo.current!;
      h.palazzo.queued = null;
      h.palazzo.event('track.ended', {
        playbackRequestId: ended.id,
        url: ended.url,
      });
      h.palazzo.event('instant.started', {
        playbackId: next.bumper!.playbackId,
      });
      // Another instant's end does not clear the spot.
      h.palazzo.event('instant.ended', { playbackId: 'someone-else' });
      await settle();
      jest.setSystemTime(Date.now() + 76_000);
      await h.engine.checkPlayback();
      jest.setSystemTime(Date.now() + 46_000);
      await h.engine.checkPlayback();
      await settle();
      expect(h.metrics.render()).toContain(
        'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="resumed"} 1',
      );
    });

    it('logs and counts a command spot only once Palazzo took it; a failed send is counted failed and the song is not held for 8 s', async () => {
      const h = harness();
      h.palazzo.settings = BUMPERS;
      const log = jest.spyOn(
        (h.engine as unknown as { logger: { log: () => void } }).logger,
        'log',
      );
      const warn = jest.spyOn(
        (h.engine as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      );
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      h.palazzo.radioService.playInstant.mockRejectedValueOnce(
        new Error('Palazzo is restarting'),
      );
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
      // No 8 s wait: the song is commanded within settle()'s 4 s.
      expect(urls(h.palazzo.commands).at(-1)).toBe(SONGS[2].url);
      expect(
        metricLine(h, 'alcantara_radio_bumpers_total{path="command"'),
      ).toEqual([
        'alcantara_radio_bumpers_total{path="command",result="sent"} 0',
        'alcantara_radio_bumpers_total{path="command",result="played"} 0',
        'alcantara_radio_bumpers_total{path="command",result="failed"} 1',
        'alcantara_radio_bumpers_total{path="command",result="retried"} 0',
      ]);
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^Bumper: /));
      expect(warn).toHaveBeenCalledWith(
        `Bumper failed: Bumper on ${PROGRAM}; Palazzo did not take the spot`,
      );
      // A late instant.started for the spot that was never sent counts nothing.
      const spotId = h.palazzo.radioService.playInstant.mock
        .calls[0][3] as string;
      h.palazzo.event('instant.started', { playbackId: spotId });
      expect(
        metricLine(
          h,
          'alcantara_radio_bumpers_total{path="command",result="played"}',
        ),
      ).toEqual([
        'alcantara_radio_bumpers_total{path="command",result="played"} 0',
      ]);
    });

    describe('a spot Palazzo refused as not ready (alcantara#274)', () => {
      const refused = () => new PalazzoInstantRefusedException(true);
      const retriedCount = (h: ReturnType<typeof harness>) =>
        metricLine(
          h,
          'alcantara_radio_bumpers_total{path="command",result="retried"}',
        );

      it('retries once with the same playback id, plays it, advances the index once and the song follows', async () => {
        const h = harness();
        h.palazzo.settings = BUMPERS;
        await onAir(h);
        h.palazzo.endCurrent();
        await settle();
        h.palazzo.radioService.playInstant.mockRejectedValueOnce(refused());
        h.palazzo.endCurrent();
        await settle();
        const calls = h.palazzo.radioService.playInstant.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[1][1]).toBe(calls[0][1]);
        expect(calls[1][3]).toBe(calls[0][3]);
        expect(retriedCount(h)).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="retried"} 1',
        ]);
        expect(
          metricLine(
            h,
            'alcantara_radio_bumpers_total{path="command",result="sent"}',
          ),
        ).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="sent"} 1',
        ]);
        expect(
          metricLine(
            h,
            'alcantara_radio_bumpers_total{path="command",result="failed"}',
          ),
        ).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="failed"} 0',
        ]);
        await jest.advanceTimersByTimeAsync(8_000);
        await settle();
        expect(urls(h.palazzo.commands).at(-1)).toBe(SONGS[2].url);
      });

      it('a spot refused on every attempt logs once, counts one failure, keeps the song on time and consumes the slot', async () => {
        const h = harness();
        h.palazzo.settings = BUMPERS;
        const warn = jest.spyOn(
          (h.engine as unknown as { logger: { warn: () => void } }).logger,
          'warn',
        );
        await onAir(h);
        h.palazzo.endCurrent();
        await settle();
        h.palazzo.radioService.playInstant
          .mockRejectedValueOnce(refused())
          .mockRejectedValueOnce(refused());
        h.palazzo.endCurrent();
        await settle();
        expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(2);
        expect(retriedCount(h)).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="retried"} 1',
        ]);
        expect(
          metricLine(
            h,
            'alcantara_radio_bumpers_total{path="command",result="failed"}',
          ),
        ).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="failed"} 1',
        ]);
        expect(
          warn.mock.calls.filter((c) =>
            /^Bumper failed/.test(String((c as unknown[])[0])),
          ),
        ).toHaveLength(1);
        expect(urls(h.palazzo.commands).at(-1)).toBe(SONGS[2].url);
      });

      it('does not retry a refusal that is not retryable', async () => {
        const h = harness();
        h.palazzo.settings = BUMPERS;
        await onAir(h);
        h.palazzo.endCurrent();
        await settle();
        h.palazzo.radioService.playInstant.mockRejectedValueOnce(
          new PalazzoInstantRefusedException(false),
        );
        h.palazzo.endCurrent();
        await settle();
        expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
        expect(retriedCount(h)).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="retried"} 0',
        ]);
      });

      it('does not retry an unknown outcome such as a timeout', async () => {
        const h = harness();
        h.palazzo.settings = BUMPERS;
        await onAir(h);
        h.palazzo.endCurrent();
        await settle();
        h.palazzo.radioService.playInstant.mockRejectedValueOnce(
          new Error('timeout'),
        );
        h.palazzo.endCurrent();
        await settle();
        expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
        expect(retriedCount(h)).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="retried"} 0',
        ]);
      });

      it('sends nothing more and restores the slot when Palazzo freezes during the wait', async () => {
        const h = harness();
        h.palazzo.settings = BUMPERS;
        await onAir(h);
        h.palazzo.endCurrent();
        await settle();
        h.palazzo.radioService.playInstant.mockImplementationOnce(() => {
          const state = (
            h.engine as unknown as {
              states: Map<string, { frozen?: boolean }>;
            }
          ).states.get(PROGRAM);
          if (state) state.frozen = true;
          return Promise.reject(refused());
        });
        h.palazzo.endCurrent();
        await settle();
        expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
        const state = (
          h.engine as unknown as {
            states: Map<string, { nextBumperIdx?: number }>;
          }
        ).states.get(PROGRAM);
        expect(state?.nextBumperIdx).toBe(0);
      });

      it('sends nothing more, counts no failure and restores the slot when a song became active during the wait', async () => {
        const h = harness();
        h.palazzo.settings = BUMPERS;
        await onAir(h);
        h.palazzo.endCurrent();
        await settle();
        h.palazzo.radioService.playInstant.mockImplementationOnce(() => {
          const state = (
            h.engine as unknown as {
              states: Map<string, { activeSong: unknown }>;
            }
          ).states.get(PROGRAM);
          if (state)
            state.activeSong = {
              token: 'adopted',
              playbackRequestId: 'adopted',
              audioUrl: SONGS[1].url,
              artist: 'A',
              title: 'T',
              coverUrl: '',
              durationMs: 200_000,
              startedAt: Date.now(),
              itemId: 'adopted',
              songId: null,
              introPlaybackId: null,
              introStatus: 'none',
              introFailureReason: null,
              authoritativeStartedAt: Date.now(),
              authoritativePositionMs: 0,
              authoritativeUpdatedAt: Date.now(),
              queueEntryId: null,
              highRotation: false,
            };
          return Promise.reject(refused());
        });
        h.palazzo.endCurrent();
        await settle();
        expect(h.palazzo.radioService.playInstant).toHaveBeenCalledTimes(1);
        expect(
          metricLine(
            h,
            'alcantara_radio_bumpers_total{path="command",result="failed"}',
          ),
        ).toEqual([
          'alcantara_radio_bumpers_total{path="command",result="failed"} 0',
        ]);
        const state = (
          h.engine as unknown as {
            states: Map<string, { nextBumperIdx?: number }>;
          }
        ).states.get(PROGRAM);
        expect(state?.nextBumperIdx).toBe(0);
      });
    });

    it('remembers at most 16 spots awaiting their start', () => {
      const h = harness();
      const engine = h.engine as unknown as {
        rememberBumperSpot: (
          state: { bumperSpotsSent?: Map<string, unknown> },
          id: string,
          name: string,
          path: string,
        ) => void;
      };
      const state: { bumperSpotsSent?: Map<string, unknown> } = {};
      for (let i = 0; i < 17; i += 1)
        engine.rememberBumperSpot(state, `spot-${i}`, 'Spot', 'command');
      expect(state.bumperSpotsSent!.size).toBe(16);
      expect(state.bumperSpotsSent!.has('spot-0')).toBe(false);
    });

    // gaulatti/alcantara#234: the successor's clock probes use Palazzo's
    // last position report when there is one (its remaining is cut at
    // cue-out), else the start plus the duration; both still announce.
    it('works out the successor with or without a position report', async () => {
      const h = harness();
      await onAir(h);
      const states = (
        h.engine as unknown as {
          states: Map<
            string,
            {
              activeSong: {
                authoritativePositionMs: number | null;
                authoritativeUpdatedAt: number | null;
              };
            }
          >;
        }
      ).states;
      states.get(PROGRAM)!.activeSong.authoritativePositionMs = null;
      states.get(PROGRAM)!.activeSong.authoritativeUpdatedAt = null;
      h.palazzo.answer = () => 'accepted';
      h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
      await settle();
      expect(urls(h.palazzo.announced)).toContain(SONGS[1].url);
    });

    it('labels the new counters with bounded values only', () => {
      const h = harness();
      h.metrics.recordAnnouncementSkipped('bogus' as never);
      h.metrics.recordBumper('bogus' as never, 'sent');
      h.metrics.recordBumper('announced', 'bogus' as never);
      for (const reason of [
        'bumper_slot',
        'bumper_unavailable',
        'intro',
        'clocked_log',
        'no_successor',
        'queue_head_active',
        'not_autoplay',
        'unsupported',
        'superseded',
        'refused',
      ])
        expect(
          metricLine(
            h,
            `alcantara_radio_announcement_skipped_total{reason="${reason}"}`,
          ),
        ).toEqual([
          `alcantara_radio_announcement_skipped_total{reason="${reason}"} 0`,
        ]);
      expect(
        metricLine(h, 'alcantara_radio_bumpers_total').every((line) =>
          line.endsWith(' 0'),
        ),
      ).toBe(true);
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
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(
          catalog.some((s) => s.id === where.id)
            ? { id: where.id, assetId: null }
            : null,
        ),
      ),
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

// gaulatti/alcantara#233 and the 2026-11-21 01:13Z restart: a backend restart
// in the middle of a song, and a watchdog resume that changes nothing.
describe('restart adoption and watchdog resumes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('announces the successor of a song adopted mid-song at boot, so its end is a preloaded handoff with no command', async () => {
    const h = harness();
    // As in production, the sequence loaded (and its refresh ran) well
    // before the first snapshot named the inherited track.
    await settle();
    const inherited = { id: 'inherited-before-restart', url: SONGS[0].url };
    h.palazzo.current = inherited;
    h.playing(inherited);
    await settle();
    expect(h.engine.getOnAirView(PROGRAM).playbackRequestId).toBe(inherited.id);
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);

    h.palazzo.endCurrent();
    await settle();
    expect(h.palazzo.commands).toEqual([]);
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
  });

  it('counts a watchdog resume that commands nothing as resumed_no_command and says why', async () => {
    const h = harness({ clockedLog: () => true });
    const warn = jest.spyOn(
      (h.engine as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    );
    h.idle();
    await settle();
    h.engine.setPalazzoTelemetry({
      isReconciled: () => true,
      currentState: () =>
        Promise.resolve({
          ...snapshot('boot-1', 99, null),
          live: { onAir: false },
        }),
    } as never);
    await h.engine.checkPlayback();
    jest.setSystemTime(Date.now() + 46_000);
    await h.engine.checkPlayback();
    await settle();
    expect(h.palazzo.commands).toEqual([]);
    const rendered = h.metrics.render();
    expect(rendered).toContain(
      'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="resumed_no_command"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="resumed"} 0',
    );
    expect(warn).toHaveBeenCalledWith(
      `Watchdog resume commanded nothing on ${PROGRAM}: clocked_log`,
    );
  });

  it('counts a watchdog resume that commands a song as resumed', async () => {
    const h = harness();
    h.idle();
    await settle();
    h.palazzo.stop();
    h.engine.setPalazzoTelemetry({
      isReconciled: () => true,
      currentState: () =>
        Promise.resolve({
          ...snapshot('boot-1', 99, null),
          live: { onAir: false },
        }),
    } as never);
    const before = h.palazzo.commands.length;
    await h.engine.checkPlayback();
    jest.setSystemTime(Date.now() + 46_000);
    await h.engine.checkPlayback();
    await settle();
    expect(h.palazzo.commands.length).toBeGreaterThan(before);
    const rendered = h.metrics.render();
    expect(rendered).toContain(
      'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="resumed"} 1',
    );
    expect(rendered).toContain(
      'alcantara_radio_engine_resyncs_total{trigger="watchdog",result="resumed_no_command"} 0',
    );
  });

  it('names the reason a resume left the rotation as it was', () => {
    const h = harness();
    const engine = h.engine as unknown as {
      resumeIdleReason: (
        programId: string,
        state: Record<string, unknown>,
        before: unknown,
      ) => string | null;
    };
    const song = { playbackRequestId: 'held' };
    const base = {
      transitioning: false,
      pendingRequestIds: new Set<string>(),
      activeSong: null,
      queueBlocked: false,
      busyWithForeignTrack: false,
    };
    const reason = (state: Record<string, unknown>, before: unknown = null) =>
      engine.resumeIdleReason(PROGRAM, { ...base, ...state }, before);
    expect(reason({ transitioning: true })).toBeNull();
    expect(reason({ pendingRequestIds: new Set(['cmd']) })).toBeNull();
    expect(reason({ activeSong: song })).toBeNull();
    expect(reason({ activeSong: song }, song)).toBe('held_song');
    expect(reason({ queueBlocked: true })).toBe('queue_blocked');
    expect(reason({ busyWithForeignTrack: true })).toBe('foreign_track');
    expect(reason({})).toBe('no_successor');
  });
});

// 2026-11-21 01:13Z–01:30Z: the process running 9c896f2 announced nothing.
// Production's settings: shuffle, similarity on (catalog pool, threshold 0.5,
// window 30 s), 12 favourites (one due every 30 min), bumper interval 2. The
// four clock probes (now, end, end+1m, end+10m) disagreed whenever a
// favourite came due inside that 14-min window, about 45% of songs, and with
// the other skips almost nothing was announced. The successor is now chosen
// once, for the expected end, and held through the end.
describe('the successor chosen for the expected end, with production settings', () => {
  const T0 = Date.parse('2026-11-21T01:21:18.568Z');
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  const PRODUCTION_BUMPERS = {
    bumperEnabled: true,
    bumperInterval: 2,
    bumperInstantIds: [1, 2],
    bumperMode: 'sequential',
  };
  const FAVOURITE = SONGS[5];
  const leafOf = (song: Song) => ({
    id: song.itemId,
    kind: 'preset',
    songId: song.id,
    title: song.title,
    artist: song.artist,
    coverUrl: '',
    audioUrl: song.url,
    durationMs: 180_000,
  });
  /**
   * Similarity as production runs it (`on`, catalog pool): a pure pick, the
   * song after the current one among the non-favourites, the first at start.
   */
  const similarityOn = () => ({
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    getSettings: () => ({
      mode: 'on',
      pool: 'catalog',
      threshold: 0.5,
      windowSeconds: 30,
    }),
    propose: jest.fn(
      (_programId: string, input: { currentSongId: number | null }) => {
        const index = SONGS.findIndex(
          (song) => song.id === input.currentSongId,
        );
        const pick = SONGS[(index + 1) % 5];
        return {
          result: {
            outcome: 'selected',
            chosen: { songId: pick.id, itemId: pick.itemId, score: 0.8 },
            runnerUps: [],
            cycleReset: false,
          },
          leaf: leafOf(pick),
        };
      },
    ),
    recordDecision: jest.fn(),
    noteSongStarted: jest.fn(),
  });
  const production = (
    lastFavouritePlay?: number,
    similarity: ReturnType<typeof similarityOn> = similarityOn(),
  ) => {
    const h = harness({
      mode: 'shuffle',
      similarity,
      capabilities: ['next.bumper'],
      favoriteItemId: FAVOURITE.itemId,
    });
    h.palazzo.settings = PRODUCTION_BUMPERS;
    const state = (
      h.engine as unknown as {
        states: Map<string, { rotation: { history: unknown[] } }>;
      }
    ).states.get(PROGRAM)!;
    state.rotation.history =
      lastFavouritePlay === undefined
        ? []
        : [
            {
              requestId: 'earlier-favourite',
              songKey: `song:${FAVOURITE.id}`,
              itemId: FAVOURITE.itemId,
              playedAt: lastFavouritePlay,
            },
          ];
    return h;
  };
  const skipped = (h: ReturnType<typeof harness>) =>
    h.metrics
      .render()
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('alcantara_radio_announcement_skipped_total{') &&
          !line.endsWith(' 0'),
      );
  // onAir: the first song is commanded at T0 + 4 s and starts there, so its
  // expected end is T0 + 184 s.
  const EXPECTED_END = T0 + 4_000 + 180_000;
  const DUE_AFTER = 30 * 60_000;

  it('announces the similarity pick, and the slot with its spot, when no favourite comes due', async () => {
    const h = production(T0 - 5 * 60_000);
    await onAir(h);
    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
    h.palazzo.endCurrent();
    await settle();
    // The second song's end is the slot: announced with the spot.
    expect(h.palazzo.announced.at(-1)?.url).toBe(SONGS[2].url);
    expect(h.palazzo.announced.at(-1)?.bumper).toBeDefined();
    expect(skipped(h)).toEqual([]);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
  });

  // #277: right after a restart the similarity index is still loading, every
  // pick falls back to the stored cursor, and that held choice aired at the
  // end (the cursor song replayed after both restarts of 2026-11-22).
  describe('while the similarity index is still loading (#277)', () => {
    const notReady = () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const similarity = similarityOn();
      let ready = false;
      similarity.isReady.mockImplementation(() => ready);
      similarity.whenReady.mockImplementation(() => gate);
      return {
        similarity,
        becomeReady: () => {
          ready = true;
          release();
        },
      };
    };

    it('announces nothing until the index is ready, then announces the similarity pick', async () => {
      const gate = notReady();
      const h = production(T0 - 5 * 60_000, gate.similarity);
      await onAir(h);
      expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
      expect(h.palazzo.announced).toEqual([]);
      // Only the first song's own selection ran; no successor was peeked.
      const proposals = gate.similarity.propose.mock.calls.length;
      gate.becomeReady();
      await settle();
      expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
      expect(gate.similarity.propose.mock.calls.length).toBeGreaterThan(
        proposals,
      );
    });

    it('keeps one pending wait however many times the announcement is refreshed meanwhile, and clears it on destroy', async () => {
      const gate = notReady();
      const h = production(T0 - 5 * 60_000, gate.similarity);
      await onAir(h);
      const engine = h.engine as unknown as {
        refreshAnnouncement: (programId: string) => void;
        states: Map<string, { similarityWait?: { timer: unknown } }>;
      };
      const before = gate.similarity.whenReady.mock.calls.length;
      for (let i = 0; i < 12; i += 1) engine.refreshAnnouncement(PROGRAM);
      await settle();
      const timer = engine.states.get(PROGRAM)!.similarityWait?.timer;
      expect(timer).toBeDefined();
      // 12 refreshes registered at most one more readiness callback.
      expect(
        gate.similarity.whenReady.mock.calls.length - before,
      ).toBeLessThanOrEqual(1);
      gate.becomeReady();
      await settle();
      // The wait fired once: one re-run beyond the callers' own, then cleared.
      expect(engine.states.get(PROGRAM)!.similarityWait).toBeUndefined();
      expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
      const gate2 = notReady();
      const h2 = production(T0 - 5 * 60_000, gate2.similarity);
      await onAir(h2);
      const e2 = h2.engine as unknown as {
        states: Map<string, { similarityWait?: { timer: unknown } }>;
      };
      expect(e2.states.get(PROGRAM)!.similarityWait).toBeDefined();
      h2.engine.onModuleDestroy();
      expect(e2.states.get(PROGRAM)!.similarityWait).toBeUndefined();
    });

    it('announces from the cursor and warns once when the index is not ready after the bound', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const gate = notReady();
      const h = production(T0 - 5 * 60_000, gate.similarity);
      await onAir(h);
      expect(h.palazzo.announced).toEqual([]);
      jest.advanceTimersByTime(SIMILARITY_READY_WAIT_MS);
      await settle();
      expect(h.palazzo.announced.length).toBeGreaterThan(0);
      expect(
        warn.mock.calls.filter((call) =>
          /Similarity index not ready after 20 s/.test(String(call[0])),
        ),
      ).toHaveLength(1);
      warn.mockRestore();
    });

    it('does not delay the song change: a song that ends inside the window is commanded from the cursor with a warning', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const gate = notReady();
      const h = production(T0 - 5 * 60_000, gate.similarity);
      await onAir(h);
      h.palazzo.endCurrent();
      await settle();
      expect(h.palazzo.commands.length).toBeGreaterThanOrEqual(2);
      expect(
        warn.mock.calls.some((call) =>
          /Similarity index not ready on radio-1; the playlist cursor chooses this song/.test(
            String(call[0]),
          ),
        ),
      ).toBe(true);
      warn.mockRestore();
    });
  });

  it('chooses and announces a favourite that comes due inside the song', async () => {
    const h = production(T0 + 120_000 - DUE_AFTER);
    await onAir(h);
    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(urls(h.palazzo.announced)).toEqual([FAVOURITE.url]);
    h.palazzo.endCurrent();
    await settle();
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(FAVOURITE.url);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    expect(skipped(h)).toEqual([]);
  });

  it('does not choose a favourite due one second after the expected end, holds that choice through a late end, and makes the favourite the next successor', async () => {
    const h = production(EXPECTED_END + 1_000 - DUE_AFTER);
    await onAir(h);
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
    // The song ends 6 s late, after the favourite came due.
    jest.setSystemTime(EXPECTED_END + 6_000);
    h.palazzo.endCurrent();
    await settle();
    // The held choice is what plays: promoted, no command.
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    // The favourite is the next song's successor, at the bumper slot.
    expect(h.palazzo.announced.at(-1)?.url).toBe(FAVOURITE.url);
    expect(h.palazzo.announced.at(-1)?.bumper).toBeDefined();
    expect(skipped(h)).toEqual([]);
  });

  it('selects at the held instant for a refresh of the same song', async () => {
    const h = production(EXPECTED_END + 1_000 - DUE_AFTER);
    await onAir(h);
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
    // Late in the song, past the favourite's due time, a sequence refresh
    // re-runs the announcement: the choice stands, nothing is re-sent.
    jest.setSystemTime(EXPECTED_END + 2_000);
    h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
    await settle();
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
  });

  it('rules out 9c896f2: a commanded song with no position report selects at start + duration, as before', async () => {
    const h = production(T0 - 5 * 60_000);
    const engine = h.engine as unknown as {
      resolveNextPlaylistSong: (...args: unknown[]) => unknown;
    };
    const selection = jest.spyOn(engine, 'resolveNextPlaylistSong');
    await onAir(h);
    // The command's own selection (no held instant), then the announcement's
    // one evaluation, at the expected end: start + durationMs.
    expect(selection.mock.calls.map((call) => call[2])).toEqual([
      undefined,
      EXPECTED_END,
    ]);
  });

  it('holds only the announcement of the song that ended, never a stale one', async () => {
    for (const stale of [false, true]) {
      jest.setSystemTime(T0);
      const h = production(T0 - 5 * 60_000);
      const engine = h.engine as unknown as {
        resolveNextPlaylistSong: (...args: unknown[]) => unknown;
        states: Map<
          string,
          { announcement: { forRequestId: string; selectAt: number } | null }
        >;
      };
      await onAir(h);
      const announcement = engine.states.get(PROGRAM)!.announcement!;
      expect(announcement.selectAt).toBe(EXPECTED_END);
      // An accepted announcement left from another song is never held.
      if (stale) announcement.forRequestId = 'another-song';
      const selection = jest.spyOn(engine, 'resolveNextPlaylistSong');
      jest.setSystemTime(EXPECTED_END + 6_000);
      h.palazzo.endCurrent();
      await settle();
      // Held: the handoff selects nothing, and the first selection after the
      // end is the next song's announcement, at its expected end. Stale: the
      // handoff selects anew, at now.
      expect(selection.mock.calls[0][2]).toBe(
        stale ? undefined : EXPECTED_END + 6_000 + 180_000,
      );
    }
  });

  it('plays the announced song when a new selection at the end would pick another (2026-11-21 01:51Z)', async () => {
    const similarity = similarityOn();
    const h = production(T0 - 5 * 60_000, similarity);
    await onAir(h);
    expect(urls(h.palazzo.announced)).toEqual([SONGS[1].url]);
    // What the selection reads changed after the announcement (at 01:51Z the
    // process had booted three minutes earlier): a new selection would now
    // pick Track 4.
    similarity.propose.mockImplementation(() => ({
      result: {
        outcome: 'selected',
        chosen: { songId: SONGS[3].id, itemId: SONGS[3].itemId, score: 0.9 },
        runnerUps: [],
        cycleReset: false,
      },
      leaf: leafOf(SONGS[3]),
    }));
    const decisions = similarity.recordDecision.mock.calls.length;
    h.palazzo.endCurrent();
    await settle();
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    expect(urls(h.palazzo.commands)).toEqual([SONGS[0].url]);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
    // The held selection's own decision is recorded once, at the handoff,
    // with the song that played; the next announcement's peek records none.
    expect(similarity.recordDecision.mock.calls.slice(decisions)).toEqual([
      [
        PROGRAM,
        expect.objectContaining({
          outcome: 'selected',
          playedSongId: SONGS[1].id,
        }),
      ],
    ]);
  });

  it('holds a catalog pick as is', async () => {
    // A catalog pick (outside the sequence) is held as is.
    const catalog = similarityOn();
    catalog.propose.mockImplementation(() => ({
      result: {
        outcome: 'selected',
        chosen: { songId: 900, itemId: 'catalog:900', score: 0.7 },
        runnerUps: [],
        cycleReset: true,
      },
      leaf: {
        ...leafOf(SONGS[4]),
        id: 'catalog:900',
        songId: 900,
        audioUrl: 'https://media.test/catalog-900.mp3',
      },
    }));
    const h = harness({ mode: 'shuffle', similarity: catalog });
    await onAir(h);
    expect(h.palazzo.announced.at(-1)?.url).toBe(
      'https://media.test/catalog-900.mp3',
    );
    h.palazzo.endCurrent();
    await settle();
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(
      'https://media.test/catalog-900.mp3',
    );
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
  });

  it('holds a sequence song only while it is in the sequence with the same audio', () => {
    const h = harness();
    const engine = h.engine as unknown as {
      validHeldLeaf: (sequence: unknown, leaf: unknown) => unknown;
    };
    const sequence = h.sequence() as { items: { id: string }[] };
    const leaf = { id: SONGS[1].itemId, audioUrl: SONGS[1].url };
    expect(engine.validHeldLeaf(sequence, leaf)).toMatchObject(leaf);
    expect(
      engine.validHeldLeaf(sequence, {
        ...leaf,
        audioUrl: 'https://media.test/other.mp3',
      }),
    ).toBeNull();
    expect(
      engine.validHeldLeaf(
        {
          ...sequence,
          items: sequence.items.filter((item) => item.id !== leaf.id),
        },
        leaf,
      ),
    ).toBeNull();
    const catalog = { id: 'catalog:900', audioUrl: 'https://media.test/c.mp3' };
    expect(engine.validHeldLeaf(sequence, catalog)).toBe(catalog);
  });

  it('still plays the held song when a deferred record throws', async () => {
    const similarity = similarityOn();
    const h = harness({ mode: 'shuffle', similarity });
    await onAir(h);
    similarity.recordDecision.mockImplementation(() => {
      throw new Error('decision log down');
    });
    h.palazzo.endCurrent();
    await settle();
    expect(h.engine.getPlaybackState(PROGRAM)?.audioUrl).toBe(SONGS[1].url);
    expect(h.metrics.snapshot().handoffs).toEqual({ preloaded: 1 });
  });

  it('names the reason when nothing resolves, when the sequence has no successor, and when the queue head is on air or unresolved', () => {
    const h = harness();
    const engine = h.engine as unknown as {
      peekSuccessor: (
        programId: string,
        state: Record<string, unknown>,
        song: Record<string, unknown>,
      ) => { skip?: string; detail?: string };
      selectionView: () => { resolveNextPlaylistSong: () => unknown };
    };
    const song = {
      itemId: SONGS[0].itemId,
      queueEntryId: null,
      authoritativeStartedAt: Date.now(),
      authoritativePositionMs: null,
      authoritativeUpdatedAt: null,
      durationMs: 180_000,
      songId: SONGS[0].id,
      artist: SONGS[0].artist,
    };
    const state = (extra: Record<string, unknown>) => ({
      sequence: h.sequence(),
      queue: [],
      ...extra,
    });
    expect(
      engine.peekSuccessor(
        PROGRAM,
        state({ queue: [{ id: 'q1', itemId: SONGS[1].itemId, active: true }] }),
        song,
      ),
    ).toEqual({ skip: 'queue_head_active', detail: 'queue head on air' });
    expect(
      engine.peekSuccessor(
        PROGRAM,
        state({ queue: [{ id: 'q1', itemId: 'missing', active: false }] }),
        song,
      ),
    ).toEqual({ skip: 'no_successor', detail: 'queue head not resolved' });
    expect(
      engine.peekSuccessor(PROGRAM, state({ sequence: null }), song),
    ).toEqual({ skip: 'no_successor', detail: 'sequence has no successor' });
    jest
      .spyOn(engine, 'selectionView')
      .mockReturnValue({ resolveNextPlaylistSong: () => null });
    expect(engine.peekSuccessor(PROGRAM, state({}), song)).toEqual({
      skip: 'no_successor',
      detail: 'nothing resolves at the end',
    });
  });
});

// An accepted successor that never airs left no trace: the as-run only has songs that started.
describe('an announced song that never airs', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** The reasons counted so far, after the watchdog's tick past the grace. */
  async function counted(h: ReturnType<typeof harness>) {
    jest.advanceTimersByTime(ANNOUNCED_START_GRACE_MS + 1);
    await h.engine.checkPlayback();
    await settle();
    return Object.fromEntries(
      [
        ...h.metrics
          .render()
          .matchAll(
            /^alcantara_radio_announced_not_aired_total\{reason="(\w+)"\} (\d+)$/gm,
          ),
      ]
        .filter(([, , value]) => value !== '0')
        .map(([, reason, value]) => [reason, Number(value)]),
    );
  }
  const logged = () =>
    (Logger.prototype.log as jest.Mock).mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('Announced song never aired'));

  it('counts nothing across ordinary handoffs, and renders every reason from zero', async () => {
    const h = harness();
    expect(
      h.metrics
        .render()
        .match(/^alcantara_radio_announced_not_aired_total\{/gm),
    ).toHaveLength(8);
    await onAir(h);
    for (let n = 0; n < 3; n += 1) {
      h.palazzo.endCurrent({ overlap: n === 1 });
      await settle();
    }
    expect(await counted(h)).toEqual({});
    expect(logged()).toEqual([]);
  });

  it('counts a Stop as operator, logged once with the playback ID', async () => {
    const h = harness();
    await onAir(h);
    const announced = h.palazzo.queued!;
    h.palazzo.stop();
    h.engine.handleStopSong(PROGRAM);
    await settle();
    // Within the grace a start could still arrive.
    await h.engine.checkPlayback();
    expect(logged()).toEqual([]);
    expect(await counted(h)).toEqual({ operator: 1 });
    expect(await counted(h)).toEqual({ operator: 1 });
    expect(logged()).toEqual([
      `Announced song never aired on ${PROGRAM}: operator (${announced.id})`,
    ]);
  });

  it('counts a replaced announcement as superseded', async () => {
    const h = harness();
    await onAir(h);
    const first = h.palazzo.queued!.id;
    h.engine.handleQueueUpdated(PROGRAM, [
      { id: 'q1', itemId: SONGS[3].itemId, enqueuedAt: 1 },
    ]);
    await settle();
    expect(h.palazzo.queued!.id).not.toBe(first);
    expect(await counted(h)).toEqual({ superseded: 1 });
  });

  it('counts a promoted song with no start as no_start, and a late start as aired', async () => {
    const h = harness();
    await onAir(h);
    h.palazzo.queued = null;
    h.palazzo.endCurrent();
    await settle();
    expect(await counted(h)).toEqual({ no_start: 1 });

    const late = harness();
    await onAir(late);
    const announced = late.palazzo.queued!;
    late.palazzo.queued = null;
    late.palazzo.endCurrent();
    await settle();
    late.palazzo.start(announced);
    await settle();
    expect(await counted(late)).toEqual({});
  });

  it('counts a song Palazzo could not ready as not_ready, before the end or after promotion', async () => {
    for (const afterPromotion of [false, true]) {
      const h = harness();
      await onAir(h);
      const announced = h.palazzo.queued!;
      h.palazzo.queued = null;
      if (afterPromotion) {
        h.palazzo.endCurrent();
        await settle();
      }
      h.palazzo.event('playout.next_withdrawn', {
        playbackId: announced.id,
        reason: 'not_ready',
      });
      await settle();
      expect(await counted(h)).toEqual({ not_ready: 1 });
    }
  });

  it('counts an announcement Palazzo dropped by going idle', async () => {
    const h = harness();
    await onAir(h);
    h.palazzo.queued = null;
    h.palazzo.current = null;
    h.idle();
    await settle();
    expect(await counted(h)).toMatchObject({ palazzo_idle: 1 });
  });

  it('counts a successor the engine withdraws, and one an end releases', async () => {
    const withdrawn = harness();
    await onAir(withdrawn);
    withdrawn.engine.handleQueueUpdated(PROGRAM, [
      { id: 'entry-x', itemId: 'missing', enqueuedAt: 1 },
    ]);
    await settle();
    expect(await counted(withdrawn)).toEqual({ withdrawn: 1 });

    let clocked = false;
    const released = harness({ clockedLog: () => clocked });
    await onAir(released);
    clocked = true;
    released.palazzo.queued = null;
    released.palazzo.endCurrent();
    await settle();
    expect(await counted(released)).toEqual({ released: 1 });
  });
});

// alcantara#873: the old instance frees the playout lease at shutdown, after its engine stopped. A command already in
// flight must not reach Palazzo after that: the new instance drives playout.
describe('after the playout lease is released', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  const BUMPER_EVERY_SONG = {
    bumperEnabled: true,
    bumperInterval: 1,
    bumperInstantIds: [1],
    bumperMode: 'sequential',
  };

  async function run(after: string, scenario: 'bumper' | 'clocked-log') {
    const lease = { current: 'active' };
    let clocked = false;
    const h = harness({ lease, clockedLog: () => clocked });
    if (scenario === 'clocked-log') {
      await onAir(h);
      expect(h.palazzo.announced).toHaveLength(1);
    } else {
      h.palazzo.settings = BUMPER_EVERY_SONG;
      await onAir(h);
    }
    const sent = () => ({
      songs: h.palazzo.radioService.playSong.mock.calls.length,
      announcements: h.palazzo.radioService.announceNext.mock.calls.length,
      withdrawals: h.palazzo.radioService.withdrawNext.mock.calls.length,
      spots: h.palazzo.radioService.playInstant.mock.calls.length,
    });
    const before = sent();
    lease.current = after;
    if (scenario === 'clocked-log') {
      // A clocked log takes over at the end: the engine withdraws the announced song.
      clocked = true;
    } else {
      // The sequence changes, then the song ends with a bumper due.
      h.engine.handleSequenceUpdated(PROGRAM, h.sequence());
      await settle();
    }
    h.palazzo.endCurrent();
    await settle();
    await jest.advanceTimersByTimeAsync(30_000);
    await settle();
    return { before, after: sent() };
  }

  it.each(['bumper', 'clocked-log'] as const)(
    'drives playout while the lease is held (%s)',
    async (scenario) => {
      const { before, after } = await run('active', scenario);
      expect(after).not.toEqual(before);
    },
  );

  it.each(['bumper', 'clocked-log'] as const)(
    'commands nothing once the lease is released (%s)',
    async (scenario) => {
      const { before, after } = await run('standby', scenario);
      expect(after).toEqual(before);
    },
  );
});
