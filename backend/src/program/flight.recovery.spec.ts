import { RadioMetricsService } from '../radio/radio-metrics.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { FlightService } from './flight.service';

/**
 * A manually started rundown resumes its timer after a backend restart
 * (gaulatti/alcantara#123 slice B). Recovery restores the timer only: it
 * never executes a cue and never takes a scene or a song.
 */
describe('manual rundown recovery on backend start', () => {
  const NOW = new Date('2026-11-28T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const SONG = {
    id: 5,
    durationMs: 30_000,
    audioUrl: 'https://media.example.test/song.mp3',
  };
  const WAITS = [
    { id: 'scene', kind: 'scene', sceneId: 3 },
    { id: 'hold', kind: 'wait', durationMs: 60_000 },
    { id: 'next', kind: 'scene', sceneId: 4 },
    { id: 'tail', kind: 'wait', durationMs: 10_000 },
  ];
  const SONGS = [
    { id: 'play', kind: 'playSong', songId: 5 },
    { id: 'end', kind: 'waitForSongEnd' },
    { id: 'after', kind: 'wait', durationMs: 5_000 },
  ];

  const services: FlightService[] = [];
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    for (const service of services.splice(0)) service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function setup(
    over: Record<string, unknown> = {},
    options: {
      activeSceneId?: number | null;
      onAirSongId?: number | null;
      activeSequenceId?: number | null;
      lease?: { whenActive: (start: () => unknown) => Promise<void> };
    } = {},
  ) {
    const row: any = {
      id: 7,
      programStateId: 1,
      name: 'Evening',
      items: WAITS,
      loop: false,
      isRunning: true,
      activeItemId: 'hold',
      scheduledAt: null,
      lastStartedAt: ago(20_000),
      programState: {
        programId: 'tv',
        activeSceneId:
          options.activeSceneId === undefined ? 3 : options.activeSceneId,
        activeFlightSequenceId:
          options.activeSequenceId === undefined ? 7 : options.activeSequenceId,
      },
      ...over,
    };
    const prisma: any = {
      flightSequence: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(async ({ where }: any) =>
          where.scheduledAt === null && row.isRunning ? [row] : [],
        ),
        update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      },
      programState: {
        findUnique: jest.fn(async () => ({
          activeFlightSequenceId: row.programState.activeFlightSequenceId,
        })),
      },
      song: { findMany: jest.fn().mockResolvedValue([SONG]) },
    };
    // Every way the program or the engine could be driven: none may be called by recovery.
    const drive = {
      activateScene: jest.fn(),
      takeCatalogSongOnAir: jest.fn(),
      takeProgramSongOffAir: jest.fn(),
      stopProgramSongForTimedBlock: jest.fn(),
      playInstant: jest.fn(),
      updateProgramAudioBus: jest.fn(),
      updateScene: jest.fn(),
    };
    const program: any = {
      ...drive,
      broadcastUpdate: jest.fn(),
      onAirSongId: jest.fn(() =>
        options.onAirSongId === undefined ? null : options.onAirSongId,
      ),
    };
    const managed = new ManagedMetricsService();
    const service = new FlightService(
      prisma,
      program,
      new RadioMetricsService(),
      noRecorder(),
      { teamId: 0 } as never,
      options.lease as never,
      managed,
    );
    services.push(service);
    const executed = jest.spyOn(service as any, 'executeCue');
    const run = jest.spyOn(service as any, 'executeCueAtIndex');
    const untouched = () => {
      expect(executed).not.toHaveBeenCalled();
      for (const call of Object.values(drive))
        expect(call).not.toHaveBeenCalled();
    };
    const counts = async () => {
      const text = await managed.render('');
      return Object.fromEntries(
        [
          ...text.matchAll(
            /^alcantara_rundown_recovery_total\{result="([^"]+)"[^}]*\} (\d+)$/gm,
          ),
        ].map((match) => [match[1], Number(match[2])]),
      );
    };
    const runtime = () => (service as any).runtimes.get('tv');
    return {
      service,
      prisma,
      program,
      row,
      run,
      executed,
      untouched,
      counts,
      runtime,
    };
  }
  const only = (result: string) => ({
    resumed: 0,
    finished: 0,
    diverged: 0,
    skipped_unsupported: 0,
    failed: 0,
    [result]: 1,
  });

  it('exposes every recovery result from zero', async () => {
    const f = setup({ isRunning: false });
    expect(await f.counts()).toEqual({
      resumed: 0,
      finished: 0,
      diverged: 0,
      skipped_unsupported: 0,
      failed: 0,
    });
  });

  it('resumes a wait at the same cue and fires the next cue at the original time', async () => {
    const f = setup();
    f.run.mockResolvedValue(undefined);
    await f.service.onModuleInit();
    f.untouched();
    expect(f.runtime()).toMatchObject({ activeIndex: 1, isRunning: true });
    // 20 s of the 60 s wait had passed: the next cue is due 40 s after the restart.
    await jest.advanceTimersByTimeAsync(39_999);
    expect(f.run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledWith('tv', 2, expect.any(Number));
    expect(await f.counts()).toEqual(only('resumed'));
    expect(f.program.broadcastUpdate).toHaveBeenCalledWith(
      'tv',
      expect.objectContaining({ type: 'flight_update', activeSequenceId: 7 }),
    );
  });

  it('resumes a song wait for the rest of the song, leaving the engine to end it first', async () => {
    const f = setup(
      { items: SONGS, activeItemId: 'end', lastStartedAt: ago(10_000) },
      { onAirSongId: 5 },
    );
    f.run.mockResolvedValue(undefined);
    await f.service.onModuleInit();
    f.untouched();
    expect(f.runtime()).toMatchObject({
      activeIndex: 1,
      waitingForSongEnd: true,
    });
    // 20 s of song left, then the grace before the fallback moves on by itself.
    await jest.advanceTimersByTimeAsync(29_999);
    expect(f.run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledWith('tv', 2, expect.any(Number));
  });

  it('moves on at once when the engine reports the song ended', async () => {
    const f = setup(
      { items: SONGS, activeItemId: 'end', lastStartedAt: ago(10_000) },
      { onAirSongId: 5 },
    );
    f.run.mockResolvedValue(undefined);
    await f.service.onModuleInit();
    await f.service.handleSongEnded('tv');
    expect(f.run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another scene is on Program', {}, { activeSceneId: 9 }, 1],
    ['the operator had moved on', { activeItemId: 'next' }, {}, 2],
    [
      'another song is on air',
      { items: SONGS, activeItemId: 'end', lastStartedAt: ago(10_000) },
      { onAirSongId: 99 },
      1,
    ],
  ])(
    'records diverged and re-takes nothing when %s',
    async (_why, over, options, index) => {
      const f = setup(over, options);
      await f.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(600_000);
      f.untouched();
      expect(f.run).not.toHaveBeenCalled();
      // The rundown stays where the executor left it: the operator's next Go continues from there.
      expect(f.runtime()).toMatchObject({
        activeIndex: index,
        isRunning: true,
        timer: null,
        waitingForSongEnd: false,
      });
      expect(f.row.isRunning).toBe(true);
      expect(await f.counts()).toEqual(only('diverged'));
    },
  );

  it('marks a rundown finished when its last cue has passed', async () => {
    const f = setup({ lastStartedAt: ago(70_000), activeItemId: 'tail' });
    await f.service.onModuleInit();
    f.untouched();
    expect(f.row.isRunning).toBe(false);
    expect(f.runtime()).toBeUndefined();
    expect(await f.counts()).toEqual(only('finished'));
  });

  it('resumes a loop started less than one loop ago, and not an older one', async () => {
    const young = setup({ loop: true });
    young.run.mockResolvedValue(undefined);
    await young.service.onModuleInit();
    expect(await young.counts()).toEqual(only('resumed'));

    const old = setup({ loop: true, lastStartedAt: ago(70_000) });
    await old.service.onModuleInit();
    old.untouched();
    expect(old.row.isRunning).toBe(false);
    expect(await old.counts()).toEqual(only('skipped_unsupported'));
  });

  it.each([
    ['no recorded start', { lastStartedAt: null }, {}],
    [
      'a clock-time cue',
      {
        items: [
          {
            id: 'hold',
            kind: 'wait',
            durationMs: 60_000,
            clockOffsetSeconds: 5,
          },
        ],
      },
      {},
    ],
    ['no longer the active rundown', {}, { activeSequenceId: 8 }],
  ])(
    'skips a running row with %s and marks it not running',
    async (_why, over, options) => {
      const f = setup(over, options);
      await f.service.onModuleInit();
      f.untouched();
      expect(f.row.isRunning).toBe(false);
      expect(f.runtime()).toBeUndefined();
      expect(await f.counts()).toEqual(only('skipped_unsupported'));
    },
  );

  it('records a failure, marks the row not running and logs only the error class', async () => {
    const f = setup({ items: SONGS });
    f.prisma.song.findMany.mockRejectedValue(new TypeError('secret detail'));
    const logged = jest
      .spyOn((f.service as any).logger, 'error')
      .mockImplementation(() => {});
    await f.service.onModuleInit();
    f.untouched();
    expect(f.row.isRunning).toBe(false);
    expect(await f.counts()).toEqual(only('failed'));
    expect(logged).toHaveBeenCalledWith('Rundown recovery failed: TypeError');
  });

  it('records a failed lookup of running rundowns, and a failed write while failing', async () => {
    const lookup = setup();
    const quiet = () =>
      jest
        .spyOn((lookup.service as any).logger, 'error')
        .mockImplementation(() => {});
    quiet();
    lookup.prisma.flightSequence.findMany.mockRejectedValue('offline');
    await lookup.service.onModuleInit();
    expect(await lookup.counts()).toEqual(only('failed'));

    const write = setup({ lastStartedAt: ago(70_000) });
    const logged = jest
      .spyOn((write.service as any).logger, 'error')
      .mockImplementation(() => {});
    write.prisma.flightSequence.update.mockRejectedValue(
      new Error('read-only'),
    );
    await write.service.onModuleInit();
    expect(await write.counts()).toEqual(only('failed'));
    expect(logged).toHaveBeenCalledWith('Rundown recovery failed: Error');
    expect(write.runtime()).toBeUndefined();
  });

  it('recovers only once this instance holds the playout lease', async () => {
    let activate!: () => unknown;
    const f = setup(
      {},
      {
        lease: {
          whenActive: (start) => {
            activate = start;
            return Promise.resolve();
          },
        },
      },
    );
    f.run.mockResolvedValue(undefined);
    await f.service.onModuleInit();
    expect(f.prisma.flightSequence.findMany).not.toHaveBeenCalled();
    expect(f.runtime()).toBeUndefined();
    expect((await f.counts()).resumed).toBe(0);
    await activate();
    expect(await f.counts()).toEqual(only('resumed'));
  });

  it('leaves a rundown an operator already started again', async () => {
    const f = setup();
    (f.service as any).runtimes.set('tv', { timer: null, sequenceId: 7 });
    await f.service.onModuleInit();
    expect(await f.counts()).toMatchObject({ resumed: 0, failed: 0 });
    expect(f.row.isRunning).toBe(true);
  });
});
