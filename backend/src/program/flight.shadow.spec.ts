import { Logger } from '@nestjs/common';
import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';

// The rundown shadow (gaulatti/alcantara#123, slice A) through the real executor with fake time: each wait the run
// begins is compared with what the pure resolver says should be on air. The fixture is flight.lifecycle.spec's.
function fixture() {
  const state: any = {
    id: 1,
    programId: 'news',
    type: 'radio',
    // A working station: its playout engine is enabled (#609).
    radioSettings: { enabled: true, palazzoUrl: 'http://palazzo:3100' },
    activeFlightSequenceId: 7,
  };
  let sequence: any = {
    id: 7,
    programStateId: 1,
    name: 'Rundown',
    items: [{ id: 'wait', kind: 'wait', durationMs: 1000 }],
    loop: false,
    isRunning: false,
    activeItemId: null,
    scheduledAt: null,
    publishedAt: null,
    lastStartedAt: null,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let scene: any = {
    id: 3,
    metadata: '{"title":{"text":"Old","color":"red"},"remove":true}',
  };
  const song = {
    id: 5,
    enabled: true,
    audioUrl: 'https://media.example/song.mp3',
    artist: 'Artist',
    title: 'Song',
    coverUrl: null,
    durationMs: 1000,
    asset: { labels: [{ labelId: 'music', position: 0 }] },
  };
  const prisma: any = {
    asRunRecord: { findMany: jest.fn().mockResolvedValue([]) },
    programState: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.programId === 'news' ? state : null,
      ),
      update: jest.fn(async ({ data }: any) => Object.assign(state, data)),
    },
    flightSequence: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        where?.scheduledAt ? [] : [sequence],
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === sequence.id ? sequence : null,
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === sequence.id ? sequence : null,
      ),
      findUniqueOrThrow: jest.fn(async () => sequence),
      create: jest.fn(async ({ data }: any) => {
        sequence = { ...sequence, ...data };
        return sequence;
      }),
      update: jest.fn(async ({ data }: any) => {
        sequence = { ...sequence, ...data };
        return sequence;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (
          where?.isRunning !== undefined &&
          where.isRunning !== sequence.isRunning
        )
          return { count: 0 };
        if (where?.scheduledAt?.not === null && !sequence.scheduledAt)
          return { count: 0 };
        if (
          where?.revision !== undefined &&
          where.revision !== sequence.revision
        )
          return { count: 0 };
        if (where?.lastStartedAt === null && sequence.lastStartedAt)
          return { count: 0 };
        sequence = {
          ...sequence,
          ...data,
          ...(data.revision
            ? { revision: sequence.revision + data.revision.increment }
            : {}),
        };
        return { count: 1 };
      }),
      delete: jest.fn(),
    },
    song: {
      findUnique: jest.fn(async () => song),
      findMany: jest.fn(async () => [song]),
    },
    instant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 12,
          enabled: true,
          audioUrl: 'https://media.example/ident.mp3',
        },
      ]),
    },
    scene: {
      findUnique: jest.fn(async () => scene),
      update: jest.fn(async ({ data }: any) => {
        scene = { ...scene, ...data };
        return scene;
      }),
    },
    mediaLabel: {
      findMany: jest.fn().mockResolvedValue([{ id: 'music', name: 'Music' }]),
      findUnique: jest.fn().mockResolvedValue({ id: 'music', name: 'Music' }),
    },
  };
  const programs: any = {
    broadcastUpdate: jest.fn(),
    takeProgramSongOffAir: jest.fn(),
    stopProgramSongForTimedBlock: jest.fn(),
    prepareContinuousRotationResume: jest.fn(),
    resumeContinuousRotation: jest.fn(),
    activateScene: jest.fn(),
    updateProgramAudioBus: jest.fn(),
    takeCatalogSongOnAir: jest.fn(),
    playInstant: jest.fn(),
    getProgramIdsByAssignedScene: jest
      .fn()
      .mockResolvedValue(['news', 'sports']),
    getProgramAudioBus: jest.fn().mockResolvedValue({
      mixerSettings: {
        mainMasterVolume: 1,
        mixerChannels: [
          { id: 'song', volume: 1, muted: false, solo: false },
          { id: 'instants', volume: 1, muted: false, solo: false },
        ],
      },
    }),
  };
  const metrics = new RadioMetricsService();
  const service = new FlightService(prisma, programs, metrics, noRecorder(), {
    teamId: 0,
  } as never);
  return {
    service,
    prisma,
    programs,
    metrics,
    state,
    sequence: () => sequence,
    scene: () => scene,
  };
}


describe('the rundown shadow', () => {
  const active: FlightService[] = [];
  const setup = () => {
    const f = fixture();
    active.push(f.service);
    f.sequence().publishedAt = new Date();
    // The program's scene follows a scene cue, as the real program service does.
    f.programs.activateScene.mockImplementation(async (sceneId: number) => {
      f.state.activeSceneId = sceneId;
    });
    f.programs.onAirSongId = jest.fn(() => null);
    return f;
  };
  const flush = () => jest.advanceTimersByTimeAsync(0);
  const shadow = async (metrics: RadioMetricsService) =>
    Object.fromEntries(
      (await metrics.render())
        .split('\n')
        .filter((line) => line.startsWith('alcantara_rundown_shadow_total{'))
        .map((line) => {
          const [, field, result, count] = /field="(\w+)",result="(\w+)"\} (\d+)/.exec(line)!;
          return [`${field}:${result}`, Number(count)];
        }),
    );
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00Z'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const service of active.splice(0)) service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('agrees on the cue, the scene and the song at every wait of a sequence the executor runs as the resolver says', async () => {
    const f = setup();
    f.sequence().items = [
      { id: 'scene', kind: 'scene', sceneId: 4 },
      { id: 'first', kind: 'wait', durationMs: 10_000 },
      { id: 'second', kind: 'wait', durationMs: 5_000 },
    ];
    await f.service.start('news');
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    await flush();
    const counts = await shadow(f.metrics);
    expect(counts).toMatchObject({ 'cue:agree': 2, 'scene:agree': 2, 'song:agree': 2 });
    expect(counts).toMatchObject({ 'cue:disagree': 0, 'scene:disagree': 0, 'song:disagree': 0, 'cue:unsupported': 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('records a disagreement, and logs it with ids only, when the program is not where the resolver says', async () => {
    const f = setup();
    f.programs.activateScene.mockImplementation(async () => undefined);
    f.state.activeSceneId = 8;
    f.sequence().items = [
      { id: 'scene', kind: 'scene', sceneId: 4 },
      { id: 'hold', kind: 'wait', durationMs: 10_000 },
    ];
    await f.service.start('news');
    await flush();
    expect(await shadow(f.metrics)).toMatchObject({ 'cue:agree': 1, 'scene:disagree': 1 });
    expect(warn).toHaveBeenCalledWith('Rundown shadow disagrees on scene for program news, sequence 7, cue hold');
  });

  it('leaves the song out of a wait that follows a song cue, and compares it at the next', async () => {
    const f = setup();
    f.programs.onAirSongId.mockReturnValue(5);
    f.sequence().items = [
      { id: 'song', kind: 'playSong', songId: 5 },
      { id: 'first', kind: 'wait', durationMs: 400 },
      { id: 'second', kind: 'wait', durationMs: 400 },
    ];
    await f.service.start('news');
    await flush();
    expect(await shadow(f.metrics)).toMatchObject({ 'cue:agree': 1, 'song:agree': 0, 'song:disagree': 0 });
    await jest.advanceTimersByTimeAsync(400);
    await flush();
    expect(await shadow(f.metrics)).toMatchObject({ 'cue:agree': 2, 'song:agree': 1 });
  });

  it("counts a run the resolver does not model once, and compares nothing after it: an operator's Go, a clocked log", async () => {
    const f = setup();
    f.sequence().items = [
      { id: 'first', kind: 'wait', durationMs: 10_000 },
      { id: 'second', kind: 'wait', durationMs: 10_000 },
      { id: 'third', kind: 'wait', durationMs: 10_000 },
    ];
    await f.service.start('news');
    await flush();
    await f.service.go('news');
    await flush();
    await f.service.go('news');
    await flush();
    expect(await shadow(f.metrics)).toMatchObject({
      'cue:agree': 1,
      'cue:unsupported': 1,
      'scene:unsupported': 1,
      'song:unsupported': 1,
      'cue:disagree': 0,
    });

    const clocked = setup();
    Object.assign(clocked.sequence(), {
      scheduledAt: new Date(),
      items: [{ id: 'song', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 }],
    });
    await clocked.service.start('news');
    await flush();
    expect(await shadow(clocked.metrics)).toMatchObject({ 'cue:unsupported': 1, 'cue:agree': 0, 'cue:disagree': 0 });
  });

  it('stops comparing a run whose state cannot be read, counted once and logged by error class', async () => {
    const f = setup();
    f.sequence().items = [
      { id: 'first', kind: 'wait', durationMs: 10_000 },
      { id: 'second', kind: 'wait', durationMs: 10_000 },
    ];
    const read = f.prisma.programState.findUnique.getMockImplementation();
    f.prisma.programState.findUnique.mockImplementation(async (args: any) =>
      args?.select?.activeSceneId ? Promise.reject(new TypeError('db down')) : read(args),
    );
    await f.service.start('news');
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(await shadow(f.metrics)).toMatchObject({ 'cue:unsupported': 1, 'cue:agree': 0 });
    expect(warn).toHaveBeenCalledWith('Rundown shadow not compared for program news: TypeError');
  });

  it('logs a failure that is not an error as unknown', async () => {
    const f = setup();
    f.sequence().items = [{ id: 'first', kind: 'wait', durationMs: 10_000 }];
    const read = f.prisma.programState.findUnique.getMockImplementation();
    f.prisma.programState.findUnique.mockImplementation(async (args: any) =>
      args?.select?.activeSceneId ? Promise.reject('not an error') : read(args),
    );
    await f.service.start('news');
    await flush();
    expect(warn).toHaveBeenCalledWith('Rundown shadow not compared for program news: unknown');
  });

  it('drops a shadow count outside its bounded labels', () => {
    const metrics = new RadioMetricsService();
    metrics.recordRundownShadow('position', 'agree');
    metrics.recordRundownShadow('cue', 'maybe');
    expect(metrics.render()).not.toMatch(/field="position"|result="maybe"/);
    expect(metrics.render()).toContain('alcantara_rundown_shadow_total{field="cue",result="agree"} 0');
  });

  it('compares nothing when the run moves on before the scene is read', async () => {
    const f = setup();
    f.sequence().items = [{ id: 'first', kind: 'wait', durationMs: 10_000 }];
    let release!: () => void;
    const read = f.prisma.programState.findUnique.getMockImplementation();
    f.prisma.programState.findUnique.mockImplementation(async (args: any) =>
      args?.select?.activeSceneId ? new Promise((resolve) => (release = () => resolve(read(args)))) : read(args),
    );
    await f.service.start('news');
    await flush();
    await f.service.stop('news');
    release();
    await flush();
    expect(await shadow(f.metrics)).toMatchObject({ 'cue:agree': 0, 'cue:disagree': 0, 'cue:unsupported': 0 });
  });
});
