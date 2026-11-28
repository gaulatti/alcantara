import { Logger } from '@nestjs/common';
import {
  DEAD_AIR_ACT_MS,
  DEAD_AIR_STEP_WAIT_MS,
  DEAD_AIR_TICK_MS,
  DeadAirWatchdogService,
} from './dead-air-watchdog.service';
import { RadioMetricsService } from './radio-metrics.service';
import { RadioOutputConfidenceService } from './radio-output-confidence.service';
import type { PalazzoPlaybackState } from './palazzo-contract';
import type { DeadAirTarget } from './song-execution.engine';

const PROGRAM = 'radio-demo.fm';
const T0 = Date.parse('2026-11-27T03:00:00.000Z');

function playing(
  requestId: string,
  over: Partial<PalazzoPlaybackState> = {},
): PalazzoPlaybackState {
  return {
    schemaVersion: 1,
    instanceId: 'palazzo-a',
    bootId: 'boot-1',
    sequence: 1,
    availability: 'available',
    status: 'playing',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: null,
    },
    icecast: { connected: true },
    track: {
      playbackRequestId: requestId,
      title: null,
      artist: null,
      coverUrl: null,
      url: 'https://media.test/a.mp3',
      startedAt: new Date(T0).toISOString(),
    },
    intro: null,
    positionSeconds: 30,
    remainingSeconds: 120,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
    live: { onAir: false },
    ...over,
  };
}

function setup() {
  const metrics = new RadioMetricsService();
  const confidence = new RadioOutputConfidenceService(metrics);
  let song = 'play-1';
  let startedAt = T0;
  let target: DeadAirTarget | null = null;
  const engine = {
    deadAirPrograms: jest.fn(() => [PROGRAM]),
    deadAirTarget: jest.fn(
      (): DeadAirTarget =>
        target ?? {
          ok: true,
          mode: 'shuffle',
          playbackRequestId: song,
          startedAt,
          replayable: true,
        },
    ),
    resendForDeadAir: jest.fn((_p: string, id: string): string | null => {
      if (id !== song) return null;
      song = `replay-of-${id}`;
      return song;
    }),
    advanceForDeadAir: jest.fn((_p: string, id: string) => {
      if (id !== song) return false;
      song = `next-after-${id}`;
      return true;
    }),
  };
  let snapshot:
    | PalazzoPlaybackState
    | null
    | (() => PalazzoPlaybackState | null) = null;
  const telemetry = {
    currentState: jest.fn(() =>
      Promise.resolve(
        typeof snapshot === 'function'
          ? snapshot()
          : (snapshot ?? playing(song)),
      ),
    ),
  };
  let mixer: Record<string, unknown> | Error = {
    songMuted: false,
    songVolume: 1,
    mainVolume: 1,
  };
  // gaulatti/alcantara#20: never called; a configured radio filler must not matter to the watchdog's steps.
  const prepareRecoveryPlaylist = jest.fn();
  const radio = {
    prepareRecoveryPlaylist,
    getMixer: jest.fn(() =>
      mixer instanceof Error ? Promise.reject(mixer) : Promise.resolve(mixer),
    ),
  };
  let presence: { guestsLive: number; hostMics: number } | Error = {
    guestsLive: 0,
    hostMics: 0,
  };
  const webrtc = {
    onAirPresence: jest.fn(() =>
      presence instanceof Error
        ? Promise.reject(presence)
        : Promise.resolve(presence),
    ),
  };
  const lease = {
    current: 'active',
    whenActive: jest.fn((start: () => void) => start()),
  };
  const watchdog = new DeadAirWatchdogService(
    engine as never,
    confidence,
    telemetry as never,
    radio as never,
    webrtc as never,
    metrics,
    lease as never,
  );

  // The output confidence as the engine feeds it: connected, a song playing, and a level sample every second.
  confidence.observe({
    type: 'radio_leg_status',
    programId: PROGRAM,
    status: { connection: 'connected' },
  } as never);
  confidence.observe({
    type: 'playback_update',
    programId: PROGRAM,
    playback: { isPlaying: true },
  } as never);
  let clock = T0;
  const level = (at: number, rms: number) =>
    confidence.observe({
      type: 'audio_levels',
      programId: PROGRAM,
      sampledAt: new Date(at).toISOString(),
      levels: { output: { rms, peak: rms } },
    } as never);
  /** Quiet (or sound) until `ms` after T0, one sample a second, with a watchdog pass every 5 s. */
  const run = async (until: number, rms = 0) => {
    while (clock < T0 + until) {
      clock += 1_000;
      level(clock, rms);
      if ((clock - T0) % DEAD_AIR_TICK_MS === 0) await watchdog.tick(clock);
    }
  };
  const steps = () =>
    metrics
      .render()
      .split('\n')
      .filter(
        (line) => /^alcantara_radio_dead_air_/.test(line) && !/ 0$/.test(line),
      );
  return {
    prepareRecoveryPlaylist,
    watchdog,
    engine,
    confidence,
    telemetry,
    radio,
    webrtc,
    metrics,
    lease,
    level,
    run,
    steps,
    now: () => clock,
    setSong: (id: string, at: number) => {
      song = id;
      startedAt = at;
    },
    song: () => song,
    setTarget: (value: DeadAirTarget | null) => {
      target = value;
    },
    setSnapshot: (value: typeof snapshot) => {
      snapshot = value;
    },
    setMixer: (value: typeof mixer) => {
      mixer = value;
    },
    setPresence: (value: typeof presence) => {
      presence = value;
    },
    status: () => confidence.get(PROGRAM, clock).deadAir,
  };
}

describe('DeadAirWatchdogService', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('exposes every step and result at zero before anything happens', () => {
    const h = setup();
    h.watchdog.onModuleInit();
    h.watchdog.onModuleDestroy();
    const lines = h.metrics
      .render()
      .split('\n')
      .filter((line) => line.startsWith('alcantara_radio_dead_air_'));
    expect(lines).toEqual([
      ...['resend', 'advance', 'give_up'].flatMap((step) =>
        ['recovered', 'still_silent', 'held'].map(
          (result) =>
            `alcantara_radio_dead_air_steps_total{step="${step}",result="${result}"} 0`,
        ),
      ),
      'alcantara_radio_dead_air_unrecovered_programs 0',
    ]);
  });

  it('waits for 20 s of quiet, then plays the song again, logging what it saw first, and counts the recovery', async () => {
    const h = setup();
    // 10 s of quiet is silent, but the first step waits for 20 s.
    await h.run(DEAD_AIR_ACT_MS - DEAD_AIR_TICK_MS);
    expect(h.confidence.get(PROGRAM, h.now()).state).toBe('silent');
    expect(h.engine.resendForDeadAir).not.toHaveBeenCalled();
    expect(h.status()).toBeNull();

    // Quiet began with the first sample at T0 + 1 s, so the pass at T0 + 20 s sees 19 s: still waiting.
    await h.run(DEAD_AIR_ACT_MS);
    expect(h.engine.resendForDeadAir).not.toHaveBeenCalled();
    await h.run(DEAD_AIR_ACT_MS + DEAD_AIR_TICK_MS);
    expect(h.engine.resendForDeadAir).toHaveBeenCalledWith(PROGRAM, 'play-1');
    expect(warn).toHaveBeenCalledWith(
      `Dead air on ${PROGRAM}: resend (quiet_for_ms=24000, lease=active, mode=shuffle, live_on_air=false, guests_live=0, host_mics=0, mixer=ok, request=play-1, guards=ok)`,
    );
    expect(h.status()).toEqual({
      step: 'resend',
      gaveUp: false,
      held: null,
      since: new Date(T0 + 25_000).toISOString(),
    });

    await h.run(DEAD_AIR_ACT_MS + 2 * DEAD_AIR_TICK_MS, 0.08);
    expect(h.steps()).toEqual([
      'alcantara_radio_dead_air_steps_total{step="resend",result="recovered"} 1',
    ]);
    expect(h.status()).toBeNull();
    expect(h.engine.advanceForDeadAir).not.toHaveBeenCalled();
  });

  it('acts at exactly 20 s of quiet and not a sample before', async () => {
    const h = setup();
    // The first quiet sample is at T0 + 1 s, so 20 s of quiet is reached at T0 + 21 s; passes run every 5 s.
    await h.run(20_000);
    expect(h.engine.resendForDeadAir).not.toHaveBeenCalled();
    await h.watchdog.tick(T0 + 20_999);
    expect(h.engine.resendForDeadAir).not.toHaveBeenCalled();
    h.level(T0 + 21_000, 0);
    await h.watchdog.tick(T0 + 21_000);
    expect(h.engine.resendForDeadAir).toHaveBeenCalledTimes(1);
  });

  it('then moves on to the next song 20 s after the replay started, then gives up loudly 20 s after that, and does nothing more', async () => {
    const h = setup();
    await h.run(25_000);
    expect(h.song()).toBe('replay-of-play-1');
    // The replay starts 3 s after it was sent: the wait runs from that start.
    h.setSong('replay-of-play-1', T0 + 28_000);
    await h.run(45_000);
    expect(h.engine.advanceForDeadAir).not.toHaveBeenCalled();
    await h.run(50_000);
    expect(h.engine.advanceForDeadAir).toHaveBeenCalledWith(
      PROGRAM,
      'replay-of-play-1',
    );
    expect(h.status()).toMatchObject({ step: 'advance', gaveUp: false });

    // The next song never starts: the wait runs from when the step was sent.
    await h.run(65_000);
    expect(h.status()).toMatchObject({ step: 'advance', gaveUp: false });
    await h.run(70_000);
    expect(h.status()).toMatchObject({
      step: 'give_up',
      gaveUp: true,
      held: null,
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^DEAD AIR on radio-demo\.fm: could not recover \(quiet_for_ms=\d+, steps=resend\+advance, every step taken left the air silent\)/,
      ),
    );
    expect(h.steps()).toEqual([
      'alcantara_radio_dead_air_steps_total{step="resend",result="still_silent"} 1',
      'alcantara_radio_dead_air_steps_total{step="advance",result="still_silent"} 1',
      'alcantara_radio_dead_air_steps_total{step="give_up",result="still_silent"} 1',
      'alcantara_radio_dead_air_unrecovered_programs 1',
    ]);

    await h.run(200_000);
    expect(h.engine.resendForDeadAir).toHaveBeenCalledTimes(1);
    expect(h.engine.advanceForDeadAir).toHaveBeenCalledTimes(1);

    // Heard again: the banner and the gauge clear, and give_up is not counted as recovered.
    await h.run(205_000, 0.1);
    expect(h.status()).toBeNull();
    expect(log).toHaveBeenCalledWith(
      `Dead air on ${PROGRAM} ended: the radio is heard again`,
    );
    expect(h.steps()).not.toContain(
      'alcantara_radio_dead_air_unrecovered_programs 1',
    );
    expect(h.steps().filter((line) => line.includes('recovered'))).toEqual([]);
    // Every step ran, up to giving up, and none prepared or replaced a recovery playlist.
    expect(h.prepareRecoveryPlaylist).not.toHaveBeenCalled();
  });

  it.each([
    [
      'live_on_air',
      (h: ReturnType<typeof setup>) =>
        h.setSnapshot(playing('play-1', { live: { onAir: true } })),
    ],
    [
      'live_unknown',
      (h: ReturnType<typeof setup>) =>
        h.setSnapshot(playing('play-1', { live: undefined })),
    ],
    [
      'palazzo_unread',
      (h: ReturnType<typeof setup>) => h.setSnapshot(() => null),
    ],
    [
      'palazzo_degraded',
      (h: ReturnType<typeof setup>) =>
        h.setSnapshot(playing('play-1', { availability: 'degraded' })),
    ],
    [
      'not_playing',
      (h: ReturnType<typeof setup>) =>
        h.setSnapshot(playing('play-1', { status: 'idle' })),
    ],
    [
      'other_track',
      (h: ReturnType<typeof setup>) => h.setSnapshot(playing('someone-else')),
    ],
    [
      'spot_or_intro',
      (h: ReturnType<typeof setup>) =>
        h.setSnapshot(
          playing('play-1', { intro: { status: 'playing' } as never }),
        ),
    ],
    [
      'spot_or_intro',
      (h: ReturnType<typeof setup>) =>
        h.setSnapshot(
          playing('play-1', {
            levels: {
              song: { rms: 0, peak: 0 },
              instant: { rms: 0, peak: 0.2 },
              output: { rms: 0, peak: 0 },
            },
          }),
        ),
    ],
    [
      'mixer_muted',
      (h: ReturnType<typeof setup>) =>
        h.setMixer({ songMuted: true, songVolume: 1, mainVolume: 1 }),
    ],
    [
      'mixer_muted',
      (h: ReturnType<typeof setup>) =>
        h.setMixer({ songMuted: false, songVolume: 0, mainVolume: 1 }),
    ],
    [
      'mixer_muted',
      (h: ReturnType<typeof setup>) =>
        h.setMixer({ songMuted: false, songVolume: 1, mainVolume: 0 }),
    ],
    [
      'mixer_unread',
      (h: ReturnType<typeof setup>) => h.setMixer(new Error('mixer')),
    ],
    [
      'guest_live',
      (h: ReturnType<typeof setup>) =>
        h.setPresence({ guestsLive: 1, hostMics: 0 }),
    ],
    [
      'host_mic_live',
      (h: ReturnType<typeof setup>) =>
        h.setPresence({ guestsLive: 0, hostMics: 1 }),
    ],
    [
      'calls_unread',
      (h: ReturnType<typeof setup>) => h.setPresence(new Error('livekit')),
    ],
    [
      'standby',
      (h: ReturnType<typeof setup>) =>
        h.setTarget({ ok: false, reason: 'standby' }),
    ],
    [
      'not_automatic',
      (h: ReturnType<typeof setup>) =>
        h.setTarget({ ok: false, reason: 'not_automatic' }),
    ],
  ])(
    'holds on %s: nothing is sent, the hold is counted and logged once, and the desk is told',
    async (hold, arrange) => {
      const h = setup();
      arrange(h);
      await h.run(60_000);
      expect(h.engine.resendForDeadAir).not.toHaveBeenCalled();
      expect(h.engine.advanceForDeadAir).not.toHaveBeenCalled();
      expect(h.radio).not.toHaveProperty('updateMixer');
      expect(h.status()).toMatchObject({
        step: null,
        gaveUp: false,
        held: hold,
      });
      const expectedStep = 'resend';
      expect(h.steps()).toEqual([
        `alcantara_radio_dead_air_steps_total{step="${expectedStep}",result="held"} 1`,
      ]);
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes(`held by ${hold}`),
        ),
      ).toHaveLength(1);
    },
  );

  it('holds when the song changes between its reads and the act, and when the engine refuses the step', async () => {
    const h = setup();
    // The engine's second read, just before acting, names another song.
    let reads = 0;
    h.engine.deadAirTarget.mockImplementation(() => {
      reads += 1;
      return {
        ok: true,
        mode: 'autoplay',
        playbackRequestId: reads % 2 === 0 ? 'taken-meanwhile' : 'play-1',
        startedAt: T0,
        replayable: true,
      };
    });
    await h.run(25_000);
    expect(h.status()).toMatchObject({ held: 'changed' });
    expect(h.engine.resendForDeadAir).not.toHaveBeenCalled();

    const g = setup();
    g.engine.resendForDeadAir.mockReturnValue(null);
    await g.run(25_000);
    expect(g.status()).toMatchObject({ step: null, held: 'changed' });

    const a = setup();
    a.setTarget({
      ok: true,
      mode: 'shuffle',
      playbackRequestId: 'play-1',
      startedAt: T0,
      replayable: false,
    });
    a.engine.advanceForDeadAir.mockReturnValue(false);
    await a.run(25_000);
    expect(a.status()).toMatchObject({ step: null, held: 'changed' });
  });

  it('skips the replay for a song it may not play again, and for a song that is already a replay', async () => {
    const h = setup();
    h.setTarget({
      ok: true,
      mode: 'shuffle',
      playbackRequestId: 'play-1',
      startedAt: T0,
      replayable: false,
    });
    await h.run(25_000);
    expect(h.engine.resendForDeadAir).not.toHaveBeenCalled();
    expect(h.engine.advanceForDeadAir).toHaveBeenCalledWith(PROGRAM, 'play-1');

    // A replay that sounded, then went quiet again (a hidden track): it is moved past, never replayed again.
    const g = setup();
    await g.run(25_000);
    g.setSong('replay-of-play-1', T0 + 26_000);
    await g.run(30_000, 0.1);
    expect(g.status()).toBeNull();
    await g.run(60_000);
    expect(g.engine.resendForDeadAir).toHaveBeenCalledTimes(1);
    expect(g.engine.advanceForDeadAir).toHaveBeenCalledWith(
      PROGRAM,
      'replay-of-play-1',
    );
  });

  it('goes straight to giving up on a fourth episode within the hour', async () => {
    const h = setup();
    let at = 0;
    for (let episode = 1; episode <= 3; episode += 1) {
      at += 25_000;
      await h.run(at);
      expect(h.engine.resendForDeadAir).toHaveBeenCalledTimes(episode);
      h.setSong(`fresh-${episode}`, T0 + at);
      at += 5_000;
      await h.run(at, 0.1);
    }
    await h.run(at + 25_000);
    expect(h.engine.resendForDeadAir).toHaveBeenCalledTimes(3);
    expect(h.status()).toMatchObject({ step: 'give_up', gaveUp: true });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('steps=none, more than 3 episodes this hour'),
    );
  });

  it('does nothing on a lost reading, and ends the episode without a recovery when nothing is expected any more', async () => {
    const h = setup();
    // No samples for 15 s: unknown, never silent.
    await h.watchdog.tick(T0 + 60_000);
    expect(h.confidence.get(PROGRAM, T0 + 60_000).state).toBe('unknown');
    expect(h.status()).toBeNull();

    const g = setup();
    g.engine.resendForDeadAir.mockReturnValue(null);
    await g.run(25_000);
    expect(g.status()).not.toBeNull();
    g.confidence.observe({ type: 'song_off_air', programId: PROGRAM } as never);
    await g.watchdog.tick(g.now());
    expect(g.status()).toBeNull();
    expect(g.steps()).toEqual([
      'alcantara_radio_dead_air_steps_total{step="resend",result="held"} 1',
    ]);
  });

  it('forgets a program that is no longer radio, skips a program still being judged, and survives a failed pass', async () => {
    const h = setup();
    await h.run(25_000);
    expect(h.status()).not.toBeNull();
    h.engine.deadAirPrograms.mockReturnValue([]);
    await h.watchdog.tick(h.now());
    expect(h.status()).toBeNull();

    const g = setup();
    let release!: () => void;
    g.telemetry.currentState.mockImplementation(
      () =>
        new Promise((resolve) => (release = () => resolve(playing('play-1')))),
    );
    await g.run(20_000);
    g.level(T0 + 21_000, 0);
    const first = g.watchdog.tick(T0 + 21_000);
    await Promise.resolve();
    await g.watchdog.tick(T0 + 21_000);
    expect(g.telemetry.currentState).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(g.engine.resendForDeadAir).toHaveBeenCalledTimes(1);

    const f = setup();
    await f.run(20_000);
    f.level(T0 + 21_000, 0);
    f.engine.deadAirTarget.mockImplementation(() => {
      throw new TypeError('boom');
    });
    await expect(f.watchdog.tick(T0 + 21_000)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      `Dead-air watchdog pass failed on ${PROGRAM}: TypeError`,
    );
    f.engine.deadAirTarget.mockImplementation(() => {
      throw 'not an error';
    });
    await f.watchdog.tick(T0 + 21_000);
    expect(error).toHaveBeenCalledWith(
      `Dead-air watchdog pass failed on ${PROGRAM}: unknown`,
    );
  });

  it('runs every 5 s once this instance holds the lease, stops on shutdown, and never starts after it', async () => {
    jest.useFakeTimers();
    try {
      const h = setup();
      const tick = jest.spyOn(h.watchdog, 'tick').mockResolvedValue(undefined);
      h.watchdog.onModuleInit();
      expect(h.lease.whenActive).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(DEAD_AIR_TICK_MS * 2);
      expect(tick).toHaveBeenCalledTimes(2);
      h.watchdog.onModuleDestroy();
      jest.advanceTimersByTime(DEAD_AIR_TICK_MS * 2);
      expect(tick).toHaveBeenCalledTimes(2);

      // A lease granted after shutdown starts nothing; with no lease service it starts at once.
      let grant!: () => void;
      const late = setup();
      late.lease.whenActive.mockImplementation((start: () => void) => {
        grant = start;
      });
      const lateTick = jest
        .spyOn(late.watchdog, 'tick')
        .mockResolvedValue(undefined);
      late.watchdog.onModuleInit();
      late.watchdog.onModuleDestroy();
      grant();
      jest.advanceTimersByTime(DEAD_AIR_TICK_MS * 2);
      expect(lateTick).not.toHaveBeenCalled();
      late.watchdog.onModuleDestroy();

      const bare = new DeadAirWatchdogService(
        { deadAirPrograms: () => [] } as never,
        h.confidence,
        {} as never,
        {} as never,
        {} as never,
        h.metrics,
      );
      const bareTick = jest.spyOn(bare, 'tick').mockResolvedValue(undefined);
      bare.onModuleInit();
      jest.advanceTimersByTime(DEAD_AIR_TICK_MS);
      expect(bareTick).toHaveBeenCalledTimes(1);
      bare.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('logs the lease as none where there is no lease service', async () => {
    const h = setup();
    const bare = new DeadAirWatchdogService(
      h.engine as never,
      h.confidence,
      h.telemetry as never,
      h.radio as never,
      h.webrtc as never,
      h.metrics,
    );
    await h.run(20_000);
    h.level(T0 + 21_000, 0);
    await bare.tick(T0 + 21_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lease=none'));
    void DEAD_AIR_STEP_WAIT_MS;
  });

  it('holds when Palazzo cannot be read at all, or the engine says no on its last read', async () => {
    const h = setup();
    h.telemetry.currentState.mockRejectedValue(new Error('unreachable'));
    await h.run(25_000);
    expect(h.status()).toMatchObject({ held: 'palazzo_unread' });

    const g = setup();
    let reads = 0;
    g.engine.deadAirTarget.mockImplementation(() => {
      reads += 1;
      return reads % 2 === 1
        ? {
            ok: true,
            mode: 'shuffle',
            playbackRequestId: 'play-1',
            startedAt: T0,
            replayable: true,
          }
        : { ok: false, reason: 'busy' };
    });
    await g.run(25_000);
    expect(g.status()).toMatchObject({ held: 'busy' });
    expect(g.engine.resendForDeadAir).not.toHaveBeenCalled();
  });

  it('judges a step from when it was sent while its song is not on air yet', async () => {
    const h = setup();
    await h.run(25_000);
    expect(h.engine.resendForDeadAir).toHaveBeenCalledTimes(1);
    // The replay is commanded but not confirmed: the engine has no song to name.
    h.setTarget({ ok: false, reason: 'no_song' });
    await h.run(40_000);
    expect(h.status()).toMatchObject({ step: 'resend', held: null });
    await h.run(45_000);
    expect(h.status()).toMatchObject({ step: 'resend', held: 'no_song' });
  });

  it('has nothing to end while the radio is heard', async () => {
    const h = setup();
    await h.run(30_000, 0.1);
    expect(h.status()).toBeNull();
    expect(h.steps()).toEqual([]);
  });

  it('records Object for each dependency whose module is not loaded yet', () => {
    jest.isolateModules(() => {
      for (const path of [
        './song-execution.engine',
        './radio-output-confidence.service',
        './palazzo-telemetry.service',
        './radio.service',
        '../webrtc/webrtc.service',
        './radio-metrics.service',
        '../playout/playout-lease.service',
      ])
        jest.doMock(path, () => ({}));
      const { DeadAirWatchdogService: Isolated } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./dead-air-watchdog.service') as {
          DeadAirWatchdogService: new (...args: never[]) => unknown;
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual(
        Array(7).fill(Object),
      );
    });
    for (const path of [
      './song-execution.engine',
      './radio-output-confidence.service',
      './palazzo-telemetry.service',
      './radio.service',
      '../webrtc/webrtc.service',
      './radio-metrics.service',
      '../playout/playout-lease.service',
    ])
      jest.dontMock(path);
  });
});
