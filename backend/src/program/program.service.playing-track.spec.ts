/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test doubles and parsed SSE frames are untyped */
// gaulatti/alcantara#178: a v2 template's state carries the track the song
// engine confirmed on air (an accepted track.started of its own song, the
// as-run log's source), and each change is one playing_track_update signal.
// The real engine runs against a fake Palazzo that follows the pinned
// contract (gaulatti/palazzo#40 for the announced next song).
import { Subject } from 'rxjs';
import { ProgramService } from './program.service';
import {
  projectProgramTemplateSignal,
  projectProgramTemplateState,
} from './program-template.service';
import {
  SongExecutionEngine,
  type SongEngineTrackEvent,
} from '../radio/song-execution.engine';
import { RadioMetricsService } from '../radio/radio-metrics.service';

const PROGRAM = 'radio1';
const NOW = new Date('2026-11-17T12:00:00.000Z');

const SONGS = Array.from({ length: 4 }, (_, i) => ({
  id: 100 + i,
  itemId: `item-${i + 1}`,
  title: `Track ${i + 1}`,
  artist: `Artist ${i + 1}`,
  url: `https://media.test/track-${i + 1}.mp3`,
}));

const v2Manifest = {
  kind: 'alcantara.program-template',
  contractVersion: 2,
  schemaVersion: 2,
  entrypointUrl: 'https://templates.example.test/t/index.js',
  capabilities: [],
  control: {
    signals: ['program_state_snapshot', 'scene_change', 'playing_track_update'],
  },
};
const v1Manifest = { ...v2Manifest, contractVersion: 1, schemaVersion: 1 };

type Track = { id: string; url: string; title?: string; artist?: string };

/** Palazzo per the contract, seen through RadioService. */
class FakePalazzo {
  engine!: SongExecutionEngine;
  current: Track | null = null;
  queued: Track | null = null;
  commands: Track[] = [];
  holdAnswers = false;
  private held: (() => void)[] = [];

  readonly radioService = {
    getRadioSettings: jest.fn(() => Promise.resolve({ bumperEnabled: false })),
    playInstant: jest.fn().mockResolvedValue(undefined),
    playSong: jest.fn(
      (
        _p: string,
        url: string,
        title?: string,
        artist?: string,
        id?: string,
      ) => {
        this.commands.push({ id: id!, url, title, artist });
        this.flush();
        this.current = { id: id!, url, title, artist };
        return Promise.resolve({ ok: true, playbackRequestId: id });
      },
    ),
    announceNext: jest.fn(
      (
        _p: string,
        song: {
          playbackId: string;
          url: string;
          title: string;
          artist: string;
        },
      ) => {
        const decide = () => {
          if (!this.current) return 'rejected';
          this.queued = {
            id: song.playbackId,
            url: song.url,
            title: song.title,
            artist: song.artist,
          };
          return 'accepted';
        };
        if (!this.holdAnswers) return Promise.resolve(decide());
        return new Promise((resolve) =>
          this.held.push(() => resolve(decide())),
        );
      },
    ),
    withdrawNext: jest.fn(() => {
      const removed = this.queued !== null;
      this.queued = null;
      return Promise.resolve(removed);
    }),
  };

  releaseAnswers(): void {
    this.holdAnswers = false;
    for (const release of this.held.splice(0)) release();
  }

  private flush(): void {
    if (this.queued)
      this.event('playout.next_withdrawn', {
        playbackId: this.queued.id,
        reason: 'flushed',
      });
    this.queued = null;
  }

  event(type: string, data: Record<string, unknown>): void {
    this.engine.handlePalazzoEvent(PROGRAM, { type, data } as never);
  }

  /** Palazzo confirms a start; a song command's start carries Palazzo's own metadata. */
  start(track: Track = this.current!): void {
    this.event('track.started', {
      playbackRequestId: track.id,
      url: track.url,
      title: track.title ?? null,
      artist: track.artist ?? null,
    });
  }

  /** The current song reaches its cue-out and the announced one takes over. */
  endCurrent(options: { overlap?: boolean } = {}): void {
    const ended = this.current!;
    const next = this.queued;
    this.queued = null;
    if (next && options.overlap) this.start(next);
    this.event('track.ended', { playbackRequestId: ended.id, url: ended.url });
    this.current = next;
    if (next && !options.overlap) this.start(next);
  }
}

function harness(templateManifest: Record<string, unknown> = v2Manifest) {
  let programState: Record<string, unknown> = {
    id: 7,
    programId: PROGRAM,
    type: 'radio',
    activeSceneId: null,
    stagedSceneId: null,
    fadeToBlack: false,
    activeScene: null,
    scenes: [],
    templateManifest,
    updatedAt: NOW.toISOString(),
    songSequence: {
      mode: 'autoplay',
      loop: true,
      intervalMs: 500,
      items: SONGS.map((song) => ({
        id: song.itemId,
        kind: 'preset',
        title: song.title,
        artist: song.artist,
        coverUrl: '',
        audioUrl: song.url,
        durationMs: 180_000,
        songId: song.id,
      })),
    },
    songQueue: [],
    songRotation: null,
  };
  const prisma: any = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    songIntro: { findUnique: jest.fn().mockResolvedValue(null) },
    song: { findFirst: jest.fn().mockResolvedValue(null) },
    broadcastSettings: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 1, timeOverrideEnabled: false }),
    },
    programState: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(() => Promise.resolve(programState)),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        programState = { ...programState, ...data };
        return Promise.resolve(programState);
      }),
    },
  };
  const palazzo = new FakePalazzo();
  const engine = new SongExecutionEngine(
    palazzo.radioService as never,
    {
      isClockedLogRunning: jest.fn(() => false),
      handleSongEnded: jest.fn().mockResolvedValue({ ok: true }),
    } as never,
    prisma,
    {
      publishPlayback: jest.fn().mockResolvedValue(undefined),
      publishStopped: jest.fn().mockResolvedValue(undefined),
    } as never,
    new RadioMetricsService(),
  );
  palazzo.engine = engine;
  engine.setPalazzoTelemetry({ isReconciled: () => true });
  engine.registerRadioProgram(PROGRAM);
  engine.handleSequenceUpdated(PROGRAM, programState.songSequence);
  const service = new ProgramService(prisma, {} as never, engine, undefined, {
    observe: jest.fn(),
  } as never);
  const signals: any[] = [];
  service.addEventListener((event) => {
    if (event.data?.type === 'playing_track_update') signals.push(event.data);
  });
  let sequence = 0;
  const idle = () =>
    engine.handlePalazzoSnapshot(PROGRAM, {
      schemaVersion: 1,
      instanceId: 'palazzo-a',
      bootId: 'boot-1',
      sequence: ++sequence,
      availability: 'available',
      status: 'idle',
      liquidsoap: {
        running: true,
        connected: true,
        staleSince: null,
        lastSampleAt: NOW.toISOString(),
      },
      track: null,
      intro: null,
      icecast: { connected: true },
      positionSeconds: 0,
      remainingSeconds: null,
      levels: {
        song: { rms: 0, peak: 0 },
        instant: { rms: 0, peak: 0 },
        output: { rms: 0, peak: 0 },
      },
    } as never);
  const playingTrack = async () =>
    ((await service.getPublicState(PROGRAM)) as Record<string, unknown>)
      .playingTrack;
  return { service, engine, palazzo, signals, idle, playingTrack, prisma };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    jest.advanceTimersByTime(1_000);
    for (let j = 0; j < 60; j += 1) await Promise.resolve();
  }
}

const track = (t: Track, startedAt: string) => ({
  playbackId: t.id,
  title: t.title ?? null,
  artist: t.artist ?? null,
  startedAt,
});

/** Palazzo confirms `t`; returns the playing track the start should show. */
async function confirm(h: ReturnType<typeof harness>, t: Track) {
  const at = new Date().toISOString();
  h.palazzo.start(t);
  await settle();
  return track(t, at);
}

/** The first song is commanded and, unless `confirmed` is false, started. */
async function firstSong(h: ReturnType<typeof harness>, confirmed = true) {
  await h.service.onModuleInit();
  h.idle();
  await settle();
  const song = h.palazzo.current!;
  return { song, onAir: confirmed ? await confirm(h, song) : null };
}

describe('playing track in the v2 template state', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('appears only once Palazzo confirms the start, in the state and in one signal', async () => {
    const h = harness();
    const { song } = await firstSong(h, false);
    // Commanded, not confirmed: not on air yet.
    expect(h.palazzo.commands).toHaveLength(1);
    expect(await h.playingTrack()).toBeUndefined();
    expect(h.signals).toEqual([]);

    const expected = await confirm(h, song);
    expect(expected).toMatchObject({
      title: SONGS[0].title,
      artist: SONGS[0].artist,
    });
    expect(await h.playingTrack()).toEqual(expected);
    expect(h.signals).toEqual([
      {
        type: 'playing_track_update',
        programId: PROGRAM,
        playingTrack: expected,
        updatedAt: expected.startedAt,
      },
    ]);
  });

  it('does not show the announced next song before its start is accepted, under overlap too', async () => {
    const h = harness();
    const first = await firstSong(h);
    const announced = h.palazzo.queued!;
    expect(announced.url).toBe(SONGS[1].url);
    // Announced and accepted by Palazzo, not started: the first song is still the one on air.
    expect(await h.playingTrack()).toEqual(first.onAir);

    // B starts under A: B is on air from its accepted start, and A's later end changes nothing.
    jest.setSystemTime(Date.now() + 180_000);
    const at = new Date().toISOString();
    h.palazzo.endCurrent({ overlap: true });
    await settle();
    const onAir = track(announced, at);
    expect(onAir).toMatchObject({
      title: SONGS[1].title,
      artist: SONGS[1].artist,
    });
    expect(await h.playingTrack()).toEqual(onAir);
    expect(h.signals.map((s) => s.playingTrack?.playbackId)).toEqual([
      first.song.id,
      announced.id,
    ]);
  });

  it('clears at a natural end and shows the announced song from its own start', async () => {
    const h = harness();
    await firstSong(h);
    const announced = h.palazzo.queued!;
    h.signals.length = 0;

    // The end and the next start arrive apart: nothing is on air in between.
    h.palazzo.queued = null;
    const endedAt = new Date().toISOString();
    h.palazzo.endCurrent();
    expect(await h.playingTrack()).toBeUndefined();
    expect(h.signals).toEqual([
      { type: 'playing_track_update', programId: PROGRAM, updatedAt: endedAt },
    ]);
    h.palazzo.current = announced;
    expect(await h.playingTrack()).toBeUndefined();
    expect(await h.playingTrack()).not.toEqual(
      expect.objectContaining({ playbackId: announced.id }),
    );
    const onAir = await confirm(h, announced);
    expect(await h.playingTrack()).toEqual(onAir);
    expect(h.signals).toHaveLength(2);
  });

  it('clears on an operator stop, once', async () => {
    const h = harness();
    await firstSong(h);
    h.signals.length = 0;
    const stoppedAt = new Date().toISOString();
    h.engine.handleStopSong(PROGRAM);
    await settle();
    expect(await h.playingTrack()).toBeUndefined();
    expect(h.signals).toEqual([
      {
        type: 'playing_track_update',
        programId: PROGRAM,
        updatedAt: stoppedAt,
      },
    ]);
    // Palazzo's own end for the stopped song changes nothing more.
    h.palazzo.event('track.ended', {
      playbackRequestId: h.palazzo.current!.id,
    });
    expect(h.signals).toHaveLength(1);
  });

  it('clears on a manual cut and shows the picked song from its confirmed start', async () => {
    const h = harness();
    await firstSong(h);
    h.signals.length = 0;
    h.engine.handleManualSong(
      PROGRAM,
      'https://media.test/manual.mp3',
      'Manual Pick',
      'Operator',
    );
    await settle();
    expect(await h.playingTrack()).toBeUndefined();
    expect(h.signals).toHaveLength(1);

    const manual = h.palazzo.current!;
    expect(manual.url).toBe('https://media.test/manual.mp3');
    const onAir = await confirm(h, manual);
    expect(await h.playingTrack()).toEqual(onAir);
    expect(h.signals).toHaveLength(2);
  });

  it('shows a preempted announced song as it started and clears it when the engine replaces it', async () => {
    const h = harness();
    await firstSong(h);
    const announced = h.palazzo.queued!;
    // A last-moment queue change is unanswered at the end, so Palazzo starts the song it had.
    h.palazzo.holdAnswers = true;
    await h.engine.enqueueSong(PROGRAM, SONGS[3].itemId);
    await settle();
    h.signals.length = 0;
    h.palazzo.endCurrent();
    await settle();
    h.palazzo.releaseAnswers();
    await settle();

    const replacement = h.palazzo.current!;
    expect(replacement.url).toBe(SONGS[3].url);
    // The previous song's end, the announced song's start and its preemption.
    expect(h.signals.map((s) => s.playingTrack?.playbackId ?? null)).toEqual([
      null,
      announced.id,
      null,
    ]);
    expect(await h.playingTrack()).toBeUndefined();
    const onAir = await confirm(h, replacement);
    expect(await h.playingTrack()).toEqual(onAir);
  });

  it('never shows a song Palazzo could not load', async () => {
    const h = harness();
    const { song } = await firstSong(h, false);
    h.palazzo.event('playout.request_failed', {
      playbackRequestId: song.id,
      reason: 'timeout',
    });
    await settle();
    expect(await h.playingTrack()).toBeUndefined();
    expect(h.signals).toEqual([]);
  });

  it('gives a page loaded mid-song the playing track in its first state and in later state-bearing signals', async () => {
    const h = harness();
    const { onAir } = await firstSong(h);
    jest.setSystemTime(Date.now() + 60_000);
    const out: any[] = [];
    const sub = h.service
      .getEventStream(PROGRAM)
      .subscribe((m) => out.push(JSON.parse(m.data)));
    await settle();
    expect(out[0]).toMatchObject({
      type: 'program_state_snapshot',
      schemaVersion: 2,
      state: { playingTrack: onAir },
    });

    h.service.broadcastUpdate(PROGRAM, {
      type: 'scene_change',
      programId: PROGRAM,
      state: { id: 7, programId: PROGRAM },
    });
    expect(out.at(-1).state.playingTrack).toEqual(onAir);

    const stoppedAt = new Date().toISOString();
    h.engine.handleStopSong(PROGRAM);
    await settle();
    const cleared = out.filter((e) => e.type === 'playing_track_update');
    expect(cleared).toEqual([
      {
        type: 'playing_track_update',
        programId: PROGRAM,
        schemaVersion: 2,
        updatedAt: stoppedAt,
      },
    ]);
    h.service.broadcastUpdate(PROGRAM, {
      type: 'scene_change',
      programId: PROGRAM,
      state: { id: 7, programId: PROGRAM },
    });
    expect(out.at(-1).state).not.toHaveProperty('playingTrack');
    sub.unsubscribe();
  });

  it('leaves v1 templates and manifests without the signal unaffected', async () => {
    const h = harness(v1Manifest);
    await firstSong(h);
    expect(h.signals).toHaveLength(1);
    const state = (await h.service.getPublicState(PROGRAM)) as Record<
      string,
      unknown
    >;
    expect(state.schemaVersion).toBe(1);
    expect(state).not.toHaveProperty('playingTrack');
    const out: any[] = [];
    const sub = h.service
      .getEventStream(PROGRAM)
      .subscribe((m) => out.push(JSON.parse(m.data)));
    await settle();
    h.engine.handleStopSong(PROGRAM);
    h.service.broadcastUpdate(PROGRAM, {
      type: 'scene_change',
      programId: PROGRAM,
      state: { id: 7, programId: PROGRAM },
    });
    expect(out[0].state).not.toHaveProperty('playingTrack');
    expect(out.map((e) => e.type)).toEqual([
      'program_state_snapshot',
      'scene_change',
    ]);
    sub.unsubscribe();

    const signal = {
      type: 'playing_track_update',
      programId: PROGRAM,
      updatedAt: NOW.toISOString(),
    };
    expect(
      projectProgramTemplateSignal(signal, v1Manifest as never),
    ).toBeNull();
    expect(
      projectProgramTemplateSignal(signal, {
        ...v2Manifest,
        control: { signals: ['program_state_snapshot'] },
      } as never),
    ).toBeNull();
  });

  it('projects the field only for v2 and only when it is a track', () => {
    const value = { id: 1, programId: PROGRAM, version: 3 };
    const playing = {
      playbackId: 'p1',
      title: 'T',
      artist: 'A',
      startedAt: NOW.toISOString(),
    };
    expect(
      projectProgramTemplateState(
        { ...value, playingTrack: playing },
        { contractVersion: 2 },
      ),
    ).toMatchObject({ playingTrack: playing });
    expect(
      projectProgramTemplateState(
        { ...value, playingTrack: 'p1' },
        { contractVersion: 2 },
      ),
    ).not.toHaveProperty('playingTrack');
    expect(
      projectProgramTemplateState(
        { ...value, playingTrack: playing },
        { contractVersion: 1 },
      ),
    ).not.toHaveProperty('playingTrack');
  });

  it('stops following the engine when the module is destroyed', async () => {
    const trackEvents$ = new Subject<SongEngineTrackEvent>();
    const prisma: any = {
      programState: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const service = new ProgramService(
      prisma,
      {} as never,
      { setBroadcastHandler: jest.fn(), trackEvents$ } as never,
      undefined,
      { observe: jest.fn() } as never,
    );
    const seen: any[] = [];
    service.addEventListener((event) => seen.push(event.data));
    await service.onModuleInit();
    const started: SongEngineTrackEvent = {
      programId: PROGRAM,
      type: 'track.started',
      playbackRequestId: 'p1',
      title: null,
      artist: null,
      url: null,
      at: NOW,
    };
    trackEvents$.next(started);
    await settle();
    // A start without an audio URL has no song record to read a cover from.
    expect(seen).toEqual([
      expect.objectContaining({
        playingTrack: {
          playbackId: 'p1',
          title: null,
          artist: null,
          startedAt: NOW.toISOString(),
        },
      }),
    ]);
    service.onModuleDestroy();
    service.onModuleDestroy();
    trackEvents$.next({ ...started, type: 'track.ended' });
    await settle();
    expect(seen).toHaveLength(1);
  });
});

// gaulatti/alcantara#179: the playing track carries the song record's stored
// cover, only when it is a public https URL.
describe('playing track cover', () => {
  const COVER = 'https://cdn.example.test/covers/track-1.jpg';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Starts the first song with the song record returning `coverUrl`. */
  async function startWithCover(coverUrl: unknown) {
    const h = harness();
    h.prisma.song.findFirst.mockResolvedValue({ coverUrl });
    const first = await firstSong(h);
    return { h, ...first };
  }

  it('carries a valid stored cover on the snapshot, the state and playing_track_update', async () => {
    const { h, song, onAir } = await startWithCover(COVER);
    const expected = { ...onAir, coverUrl: COVER };
    expect(h.prisma.song.findFirst).toHaveBeenCalledWith({
      where: { audioUrl: song.url },
      select: { coverUrl: true },
    });
    expect(await h.playingTrack()).toEqual(expected);
    expect(h.signals).toEqual([
      {
        type: 'playing_track_update',
        programId: PROGRAM,
        playingTrack: expected,
        updatedAt: onAir!.startedAt,
      },
    ]);
    const out: any[] = [];
    const sub = h.service
      .getEventStream(PROGRAM)
      .subscribe((m) => out.push(JSON.parse(m.data)));
    await settle();
    expect(out[0].state.playingTrack).toEqual(expected);
    h.service.broadcastUpdate(PROGRAM, {
      type: 'scene_change',
      programId: PROGRAM,
      state: { id: 7, programId: PROGRAM },
    });
    expect(out.at(-1).state.playingTrack).toEqual(expected);
    sub.unsubscribe();
  });

  it.each([
    ['plain http', 'http://cdn.example.test/c.jpg'],
    ['malformed', 'not a url'],
    ['empty', ''],
    ['padded', ` ${COVER}`],
    ['not a string', 42],
    ['credentials', 'https://user:secret@cdn.example.test/c.jpg'],
    ['IPv4 loopback', 'https://127.0.0.1/c.jpg'],
    ['IPv6 loopback', 'https://[::1]/c.jpg'],
    ['localhost name', 'https://cover.localhost/c.jpg'],
    ['private 10/8', 'https://10.0.0.8/c.jpg'],
    ['private 172.16/12', 'https://172.16.4.2/c.jpg'],
    ['private 192.168/16', 'https://192.168.1.20/c.jpg'],
    ['IPv6 unique local', 'https://[fd00::5]/c.jpg'],
    ['IPv4-mapped private', 'https://[::ffff:10.0.0.8]/c.jpg'],
    ['IPv4 link-local', 'https://169.254.169.254/c.jpg'],
    ['IPv6 link-local', 'https://[fe80::1]/c.jpg'],
    ['bare hostname', 'https://media/c.jpg'],
    ['bare hostname with a trailing dot', 'https://media./c.jpg'],
  ])('omits a %s cover', async (_name, coverUrl) => {
    const { h, onAir } = await startWithCover(coverUrl);
    expect(await h.playingTrack()).toEqual(onAir);
    expect(h.signals[0].playingTrack).not.toHaveProperty('coverUrl');
  });

  it.each([
    ['a public IPv4 address', 'https://93.184.216.34/c.jpg'],
    ['a fully qualified name', 'https://cdn.example.test./c.jpg'],
  ])('keeps a cover on %s exactly as stored', async (_name, coverUrl) => {
    const { h } = await startWithCover(coverUrl);
    expect(await h.playingTrack()).toMatchObject({ coverUrl });
  });

  it('omits the cover when the song record is missing or the lookup fails', async () => {
    // No song record has the accepted audio URL.
    const miss = harness();
    const missed = await firstSong(miss);
    expect(miss.prisma.song.findFirst).toHaveBeenCalledTimes(1);
    expect(await miss.playingTrack()).toEqual(missed.onAir);
    // The record exists but stores no cover.
    const empty = await startWithCover(null);
    expect(await empty.h.playingTrack()).toEqual(empty.onAir);

    const h = harness();
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    h.prisma.song.findFirst.mockRejectedValue(
      new Error('database unavailable'),
    );
    const { onAir } = await firstSong(h);
    expect(await h.playingTrack()).toEqual(onAir);
    expect(warn).toHaveBeenCalledWith(
      '[ProgramService] Cover lookup failed for a playing track: Error: database unavailable',
    );
  });

  it('shows no cover for an announced song until its start is accepted', async () => {
    const { h, song, onAir } = await startWithCover(COVER);
    const announced = h.palazzo.queued!;
    expect(await h.playingTrack()).toEqual({ ...onAir, coverUrl: COVER });
    expect(
      h.prisma.song.findFirst.mock.calls.map(
        ([args]: any[]) => args.where.audioUrl,
      ),
    ).toEqual([song.url]);
    expect(h.signals).toHaveLength(1);

    h.prisma.song.findFirst.mockResolvedValue({
      coverUrl: 'https://cdn.example.test/covers/track-2.jpg',
    });
    const at = new Date().toISOString();
    h.palazzo.endCurrent({ overlap: true });
    await settle();
    expect(await h.playingTrack()).toEqual({
      ...track(announced, at),
      coverUrl: 'https://cdn.example.test/covers/track-2.jpg',
    });
  });

  it('applies an end that arrives during the cover lookup after the start', async () => {
    const h = harness();
    let release!: (value: unknown) => void;
    h.prisma.song.findFirst.mockReturnValue(
      new Promise((resolve) => (release = resolve)),
    );
    const { song } = await firstSong(h, false);
    h.palazzo.start(song);
    h.engine.handleStopSong(PROGRAM);
    expect(h.signals).toEqual([]);
    release({ coverUrl: COVER });
    await settle();
    expect(h.signals.map((s) => s.playingTrack?.coverUrl ?? null)).toEqual([
      COVER,
      null,
    ]);
    expect(await h.playingTrack()).toBeUndefined();
  });
});
