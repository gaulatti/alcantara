import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';
import type {
  FlightCue,
  FlightRuntimeState,
  FlightSequence,
} from './flight.types';

describe('FlightService song cues', () => {
  it('takes the catalog song on air after persisting the manual cue sequence', async () => {
    const song = {
      id: 101,
      audioUrl: 'https://example.test/song.mp3',
      title: 'Fictional song',
      artist: 'Fictional artist',
      coverUrl: 'https://example.test/cover.jpg',
      durationMs: 180_000,
      enabled: true,
    };
    const prisma = {
      song: { findUnique: jest.fn().mockResolvedValue(song) },
    };
    const programService = {
      updateProgramAudioBus: jest.fn().mockResolvedValue(undefined),
      takeCatalogSongOnAir: jest.fn(),
    };
    const service = new FlightService(
      prisma as any,
      programService as any,
      new RadioMetricsService(),
    );

    await (service as any).executePlaySongCue('radio-1', {
      id: 'cue-1',
      kind: 'playSong',
      songId: 101,
    });

    expect(programService.updateProgramAudioBus).toHaveBeenCalledWith(
      {
        songSequence: expect.objectContaining({
          mode: 'manual',
          activeItemId: expect.any(String),
          items: [expect.objectContaining({ songId: 101 })],
        }),
      },
      'radio-1',
    );
    expect(programService.takeCatalogSongOnAir).toHaveBeenCalledWith(
      'radio-1',
      song,
      undefined,
    );
    expect(
      programService.updateProgramAudioBus.mock.invocationCallOrder[0],
    ).toBeLessThan(
      programService.takeCatalogSongOnAir.mock.invocationCallOrder[0],
    );
  });
});

describe('FlightService clocked logs', () => {
  it('persists, preflights, and publishes a future radio hour at its expected revision', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000);
    scheduledAt.setUTCSeconds(0, 0);
    const cues = [
      { id: 'slot-1', kind: 'playSong', songId: 101, clockOffsetSeconds: 0 },
    ];
    const record = {
      id: 7,
      programStateId: 1,
      name: 'Next hour',
      items: cues,
      loop: false,
      isRunning: false,
      activeItemId: null,
      scheduledAt,
      publishedAt: null as Date | null,
      lastStartedAt: null,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, programId: 'radio-1', type: 'radio' }),
      },
      flightSequence: {
        create: jest.fn().mockResolvedValue(record),
        findFirst: jest.fn().mockImplementation(async () => record),
        updateMany: jest.fn().mockImplementation(async ({ data }) => {
          record.publishedAt = data.publishedAt;
          record.revision += 1;
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn().mockImplementation(async () => record),
      },
      song: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 101,
            enabled: true,
            audioUrl: 'https://media.test/song.mp3',
            durationMs: 120_000,
          },
        ]),
      },
      instant: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const metrics = new RadioMetricsService();
    const service = new FlightService(prisma, {} as any, metrics);
    await service.createFlightSequence('radio-1', {
      name: 'Next hour',
      scheduledAt: scheduledAt.toISOString(),
      items: cues,
    });
    expect((await service.preflightFlightSequence('radio-1', 7)).ready).toBe(
      true,
    );
    const published = await service.publishFlightSequence('radio-1', 7, 1);
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(published.revision).toBe(2);
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="published"} 1',
    );
  });

  it('rejects malformed clock fields and unavailable audio before publication', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000);
    scheduledAt.setUTCSeconds(0, 0);
    const record = {
      id: 7,
      programStateId: 1,
      name: 'Next hour',
      items: [
        { id: 'slot-1', kind: 'playSong', songId: 101, clockOffsetSeconds: 0 },
      ],
      loop: false,
      scheduledAt,
      revision: 1,
    };
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, programId: 'radio-1', type: 'radio' }),
      },
      flightSequence: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(record),
        updateMany: jest.fn(),
      },
      song: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 101,
            enabled: false,
            audioUrl: 'https://media.test/song.mp3',
          },
        ]),
      },
      instant: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = new FlightService(
      prisma,
      {} as any,
      new RadioMetricsService(),
    );
    await expect(
      service.createFlightSequence('radio-1', {
        name: 'Bad hour',
        scheduledAt: scheduledAt.toISOString(),
        items: [
          {
            id: 'slot-1',
            kind: 'playSong',
            songId: '101',
            clockOffsetSeconds: 0,
          },
        ],
      }),
    ).rejects.toThrow('songId must be a nonnegative integer');
    await expect(
      service.publishFlightSequence('radio-1', 7, 1),
    ).rejects.toThrow('song unavailable');
    expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
  });
});

describe('FlightService tag generation and live log edits', () => {
  function setup() {
    const record: Omit<FlightSequence, 'createdAt' | 'updatedAt'> = {
      id: 7,
      programStateId: 1,
      name: 'Next hour',
      scheduledAt: new Date(Date.now() + 3600000),
      revision: 1,
      publishedAt: null,
      lastStartedAt: null,
      loop: false,
      isRunning: false,
      activeItemId: null,
      items: [
        { id: 'now', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
        { id: 'later', kind: 'playSong', songId: 2 },
        { id: 'hard', kind: 'playSong', songId: 3, clockOffsetSeconds: 1800 },
      ],
    };
    const songs = [1, 2, 3].map((id) => ({
      id,
      artist: `Artist ${id}`,
      enabled: true,
      audioUrl: `https://media.test/${id}.mp3`,
      durationMs: 180000,
      asset: { labels: [{ labelId: 'music', position: id }] },
    }));
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, programId: 'radio-1', type: 'radio' }),
      },
      flightSequence: {
        findFirst: jest.fn().mockResolvedValue(record),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest
          .fn()
          .mockImplementation(({ data }: { data: { items?: FlightCue[] } }) => {
            if (data.items) record.items = data.items;
            record.revision++;
            return Promise.resolve({ count: 1 });
          }),
        findUniqueOrThrow: jest
          .fn()
          .mockImplementation(() => Promise.resolve(record)),
      },
      song: { findMany: jest.fn().mockResolvedValue(songs) },
      instant: { findMany: jest.fn().mockResolvedValue([]) },
      mediaLabel: {
        findMany: jest.fn().mockResolvedValue([{ id: 'music', name: 'Music' }]),
        findUnique: jest.fn().mockResolvedValue({ id: 'music', name: 'Music' }),
      },
    };
    const metrics = new RadioMetricsService();
    const service = new FlightService(
      prisma as unknown as PrismaService,
      {} as ProgramService,
      metrics,
    );
    return { record, prisma, metrics, service };
  }
  it('preflights a scoped tag preview and saves concrete IDs through the existing revision boundary', async () => {
    const { service, prisma, record, metrics } = setup();
    const { items } = await service.generateTaggedLog('radio-1', 7, {
      revision: 1,
      rules: {
        slots: [{ labelId: 'music', count: 2, clockOffsetSeconds: 0 }],
        artistSeparation: 1,
      },
    });
    expect(prisma.flightSequence.findFirst).toHaveBeenCalledWith({
      where: { id: 7, programStateId: 1 },
    });
    const query = prisma.song.findMany.mock.calls[0] as unknown as [
      {
        where: { asset: { labels: { some: { labelId: { in: string[] } } } } };
      },
    ];
    expect(query[0].where.asset.labels.some.labelId.in).toEqual(['music']);
    expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
    await service.updateFlightSequence('radio-1', 7, { revision: 1, items });
    expect(record.items.map((cue) => cue.songId)).toEqual([1, 2]);
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="edited"} 1',
    );
    prisma.mediaLabel.findMany.mockResolvedValue([]);
    expect((await service.preflightFlightSequence('radio-1', 7)).ready).toBe(
      true,
    );
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="generated"} 1',
    );
  });
  it('refuses generation for published logs, stale revisions, and programs without a radio leg', async () => {
    const { service, record, prisma, metrics } = setup();
    record.publishedAt = new Date();
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 1 }),
    ).rejects.toThrow('unaired draft');
    record.publishedAt = null;
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 0 }),
    ).rejects.toThrow('log changed');
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'tv' });
    await expect(
      service.generateTaggedLog('radio-1', 7, { revision: 1 }),
    ).rejects.toThrow('radio leg');
    expect(prisma.song.findMany).not.toHaveBeenCalled();
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="generation-failed"} 3',
    );
  });
  it('locks the played prefix and keeps a hard timer bound to the cue after future edits', async () => {
    jest.useFakeTimers();
    const { service, record, prisma } = setup();
    record.publishedAt = new Date();
    record.lastStartedAt = new Date();
    record.isRunning = true;
    const runtime: FlightRuntimeState = {
      sequenceId: 7,
      programId: 'radio-1',
      items: record.items,
      loop: false,
      activeIndex: 0,
      isRunning: true,
      generation: 1,
      timer: null,
      waitingForSongEnd: true,
      startedAt: Date.now(),
      scheduledAtMs: Date.now(),
    };
    const internals = service as unknown as {
      runtimes: Map<string, FlightRuntimeState>;
      executeCueAtIndex: (
        programId: string,
        index: number,
        generation: number,
      ) => Promise<void>;
    };
    internals.runtimes.set('radio-1', runtime);
    const execute = jest
      .spyOn(internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    try {
      await expect(
        service.updateFlightSequence('radio-1', 7, {
          revision: 1,
          items: [{ ...record.items[0], songId: 2 }, ...record.items.slice(1)],
        }),
      ).rejects.toThrow('played log');
      expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
      await service.updateFlightSequence('radio-1', 7, {
        revision: 1,
        items: [record.items[0], record.items[2]],
      });
      expect(runtime.items.map((item) => item.id)).toEqual(['now', 'hard']);
      jest.advanceTimersByTime(1800000);
      expect(execute).toHaveBeenCalledWith('radio-1', 1, 2);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });
  it('refuses rewriting stopped history and rescheduling a published hour', async () => {
    const { service, record } = setup();
    record.publishedAt = new Date();
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        revision: 1,
        scheduledAt: null,
      }),
    ).rejects.toThrow('published log');
    record.lastStartedAt = new Date();
    await expect(
      service.updateFlightSequence('radio-1', 7, { revision: 1, items: [] }),
    ).rejects.toThrow('stopped log');
  });
  it('previews fillers without writing, then preserves filler markers and the hour boundary through save and preflight', async () => {
    const { service, record, prisma, metrics } = setup();
    const items: FlightCue[] = [
      record.items[0],
      { id: 'end-content', kind: 'stopSong', clockOffsetSeconds: 400 },
    ];
    const preview = await service.fillRundown('radio-1', 7, {
      revision: 1,
      items,
      rules: { labelId: 'music', artistSeparation: 0 },
    });
    expect(prisma.flightSequence.findFirst).toHaveBeenCalledWith({
      where: { id: 7, programStateId: 1 },
    });
    expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
    expect(
      preview.items
        .filter((cue) => cue.isFiller && cue.kind === 'playSong')
        .map((cue) => cue.songId),
    ).toEqual([2, 3]);
    expect(preview.items.at(-1)).toMatchObject({
      kind: 'stopSong',
      clockOffsetSeconds: 400,
    });
    await service.updateFlightSequence('radio-1', 7, {
      revision: 1,
      items: preview.items,
    });
    expect(record.items.filter((cue) => cue.isFiller)).toHaveLength(2);
    expect((await service.preflightFlightSequence('radio-1', 7)).ready).toBe(
      true,
    );
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="filled"} 1',
    );
    record.publishedAt = new Date();
    await expect(
      service.fillRundown('radio-1', 7, {
        revision: 2,
        items,
        rules: { labelId: 'music', artistSeparation: 0 },
      }),
    ).rejects.toThrow('unpublished');
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="fill-failed"} 1',
    );
  });
  it('rejects stale filler previews, missing tags, and malformed filler markers', async () => {
    const { service, prisma } = setup();
    const input = {
      revision: 0,
      items: [
        { id: 'content', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
      ],
      rules: { labelId: 'music', artistSeparation: 0 },
    };
    await expect(service.fillRundown('radio-1', 7, input)).rejects.toThrow(
      'changed',
    );
    prisma.mediaLabel.findUnique.mockResolvedValue(null);
    await expect(
      service.fillRundown('radio-1', 7, { ...input, revision: 1 }),
    ).rejects.toThrow('tag no longer exists');
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        revision: 1,
        items: [{ ...input.items[0], isFiller: 'true' }],
      }),
    ).rejects.toThrow('isFiller must be boolean');
  });
  it('keeps a declared clip timer tied to the edited next fixed cue', () => {
    jest.useFakeTimers();
    const { service } = setup();
    const runtime: FlightRuntimeState = {
      sequenceId: 7,
      programId: 'radio-1',
      items: [
        {
          id: 'clip',
          kind: 'instant',
          instantId: 9,
          durationMs: 60000,
          clockOffsetSeconds: 0,
        },
        { id: 'hard', kind: 'playSong', songId: 2, clockOffsetSeconds: 30 },
      ],
      loop: false,
      activeIndex: 0,
      isRunning: true,
      generation: 5,
      timer: null,
      waitingForSongEnd: false,
      startedAt: Date.now(),
      scheduledAtMs: Date.now(),
      cueStartedAt: Date.now(),
    };
    const internals = service as unknown as {
      runtimes: Map<string, FlightRuntimeState>;
      armTimedClip: (runtime: FlightRuntimeState) => void;
      executeCueAtIndex: (
        programId: string,
        index: number,
        generation: number,
      ) => Promise<void>;
    };
    internals.runtimes.set('radio-1', runtime);
    const execute = jest
      .spyOn(internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    try {
      internals.armTimedClip(runtime);
      runtime.items = [
        runtime.items[0],
        { id: 'follow', kind: 'playSong', songId: 3 },
        { ...runtime.items[1], clockOffsetSeconds: 40 },
      ];
      internals.armTimedClip(runtime);
      jest.advanceTimersByTime(30000);
      expect(execute).not.toHaveBeenCalled();
      jest.advanceTimersByTime(10000);
      expect(execute).toHaveBeenCalledWith('radio-1', 2, 5);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });
});

describe('continuous rotation around timed blocks', () => {
  function setup() {
    const metrics = new RadioMetricsService();
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, activeFlightSequenceId: 7 }),
      },
      flightSequence: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      song: {
        findUnique: jest.fn().mockResolvedValue({
          id: 101,
          enabled: true,
          audioUrl: 'https://example.test/song.mp3',
          title: 'Content',
          artist: 'Fictional',
          durationMs: 1000,
          coverUrl: null,
        }),
      },
    };
    const program = {
      updateProgramAudioBus: jest.fn(),
      takeCatalogSongOnAir: jest.fn(),
      takeProgramSongOffAir: jest.fn().mockResolvedValue(undefined),
      stopProgramSongForTimedBlock: jest.fn().mockResolvedValue(undefined),
      prepareContinuousRotationResume: jest.fn().mockResolvedValue(undefined),
      resumeContinuousRotation: jest.fn(),
      broadcastUpdate: jest.fn(),
    };
    const service = new FlightService(prisma as any, program as any, metrics);
    const internals = service as any;
    jest.spyOn(internals, 'broadcastFlightUpdate').mockResolvedValue(undefined);
    const runtime: FlightRuntimeState = {
      sequenceId: 7,
      programId: 'radio-1',
      items: [
        { id: 'content', kind: 'playSong', songId: 101, clockOffsetSeconds: 0 },
      ],
      loop: false,
      activeIndex: 0,
      isRunning: true,
      generation: 1,
      timer: null,
      waitingForSongEnd: true,
      startedAt: Date.now(),
      scheduledAtMs: Date.now(),
    };
    internals.runtimes.set('radio-1', runtime);
    return { service, internals, program, metrics, runtime };
  }
  it('keeps the saved filler pool when a timed content song is taken', async () => {
    const { internals, program } = setup();
    await internals.executePlaySongCue('radio-1', {
      id: 'content',
      kind: 'playSong',
      songId: 101,
    });
    expect(program.updateProgramAudioBus).not.toHaveBeenCalled();
    expect(program.takeCatalogSongOnAir).toHaveBeenCalled();
  });
  it('returns to continuous fillers after the final authoritative song end, once', async () => {
    const { service, program, metrics } = setup();
    await service.handleSongEnded('radio-1');
    await service.handleSongEnded('radio-1');
    expect(program.prepareContinuousRotationResume).toHaveBeenCalledTimes(1);
    expect(program.resumeContinuousRotation).toHaveBeenCalledTimes(1);
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="completed"} 1',
    );
    expect(service.isClockedLogRunning('radio-1')).toBe(false);
  });
  it('retains timed ownership until the physical stop resolves', async () => {
    const { service, program } = setup();
    let release!: () => void;
    program.stopProgramSongForTimedBlock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const completing = service.handleSongEnded('radio-1');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(service.isClockedLogRunning('radio-1')).toBe(true);
    expect(program.resumeContinuousRotation).not.toHaveBeenCalled();
    expect((await service.handleSongEnded('radio-1')).ok).toBe(false);
    release();
    await completing;
    expect(service.isClockedLogRunning('radio-1')).toBe(false);
    expect(program.resumeContinuousRotation).toHaveBeenCalledTimes(1);
  });
  it('reports resume persistence failure and sends no resume command', async () => {
    const { service, program, metrics } = setup();
    program.prepareContinuousRotationResume.mockRejectedValue(
      new Error('Database unavailable'),
    );
    await service.handleSongEnded('radio-1');
    expect(program.resumeContinuousRotation).not.toHaveBeenCalled();
    expect(program.broadcastUpdate).toHaveBeenCalledWith(
      'radio-1',
      expect.objectContaining({ type: 'radio_rotation_resume_failed' }),
    );
    expect(metrics.render()).toContain(
      'alcantara_radio_log_transitions_total{result="resume-failed"} 1',
    );
    expect(metrics.render()).not.toContain('result="Database unavailable"');
  });
  it('accepts content beyond one hour and rejects malformed offsets', () => {
    const { internals } = setup();
    expect(() =>
      internals.validateClockItems([
        { id: 'first', kind: 'playSong', songId: 101, clockOffsetSeconds: 0 },
        {
          id: 'later',
          kind: 'playSong',
          songId: 101,
          clockOffsetSeconds: 90000,
        },
      ]),
    ).not.toThrow();
    expect(() =>
      internals.validateClockItems([
        { id: 'first', kind: 'playSong', songId: 101, clockOffsetSeconds: 0 },
        { id: 'later', kind: 'playSong', songId: 101, clockOffsetSeconds: -1 },
      ]),
    ).toThrow();
  });
});

it('marks scheduled runtimes interrupted on startup without replaying them or changing the continuous rotation', async () => {
  const prisma = {
    flightSequence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const program = {
    updateProgramAudioBus: jest.fn(),
    takeCatalogSongOnAir: jest.fn(),
  };
  const metrics = new RadioMetricsService();
  const service = new FlightService(prisma as any, program as any, metrics);
  await service.onModuleInit();
  service.onModuleDestroy();
  expect(prisma.flightSequence.updateMany).toHaveBeenCalledWith({
    where: { isRunning: true, scheduledAt: { not: null } },
    data: { isRunning: false },
  });
  expect(program.updateProgramAudioBus).not.toHaveBeenCalled();
  expect(program.takeCatalogSongOnAir).not.toHaveBeenCalled();
  expect(metrics.render()).toContain(
    'alcantara_radio_log_transitions_total{result="interrupted"} 1',
  );
});
