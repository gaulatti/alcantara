import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';

function fixture() {
  const state: any = {
    id: 1,
    programId: 'news',
    type: 'radio',
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
      findMany: jest
        .fn()
        .mockResolvedValue([
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
  const service = new FlightService(prisma, programs, metrics);
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

describe('FlightService public lifecycle and clock boundary', () => {
  const active: FlightService[] = [];
  const setup = () => {
    const f = fixture();
    active.push(f.service);
    return f;
  };
  const flush = () => jest.advanceTimersByTimeAsync(0);
  const clockItems = () => [
    { id: 'song', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 },
  ];
  const clocked = (
    f: ReturnType<typeof fixture>,
    items: any[] = clockItems(),
  ) =>
    Object.assign(f.sequence(), {
      scheduledAt: new Date(),
      publishedAt: new Date(),
      items,
    });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00Z'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const service of active.splice(0)) service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('lists normalized stored sequences and resolves only an existing active sequence', async () => {
    const f = setup();
    expect(await f.service.listFlightSequences(' news ')).toEqual([
      expect.objectContaining({ id: 7, revision: 1, scheduledAt: null }),
    ]);
    expect(await f.service.getActiveFlightSequence('news')).toEqual({
      activeSequenceId: 7,
      sequence: expect.objectContaining({ id: 7 }),
    });
    f.state.activeFlightSequenceId = null;
    expect(await f.service.getActiveFlightSequence('news')).toBeNull();
    f.state.activeFlightSequenceId = 99;
    expect(await f.service.getActiveFlightSequence('news')).toBeNull();
    await expect(
      f.service.listFlightSequences('missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalizes legacy cues without inventing unsupported cue kinds or optional fields', async () => {
    const f = setup();
    const result = await f.service.createFlightSequence('news', {
      name: ' Legacy rundown ',
      loop: true,
      items: [
        null,
        [],
        { kind: 'unsupported' },
        { kind: 1 },
        {
          id: ' ',
          kind: 'scene',
          label: ' Camera ',
          sceneId: 3.2,
          transitionId: ' dissolve ',
          isFiller: false,
        },
        { id: 'clip', kind: 'instant', instantId: 12, durationMs: -1 },
        {
          id: 'mix',
          kind: 'mixer',
          mixerChange: {
            channelId: 'song',
            volume: 1,
            muted: true,
            solo: false,
          },
          metadataPatch: [],
        },
        {
          id: 'bad-mix',
          kind: 'mixer',
          mixerChange: { channelId: 'unknown', volume: NaN, muted: 'yes' },
        },
      ],
    });
    expect(result.name).toBe('Legacy rundown');
    expect(result.loop).toBe(true);
    expect(result.items).toHaveLength(4);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^cue_/),
        kind: 'scene',
        label: 'Camera',
        sceneId: 3,
        transitionId: 'dissolve',
        isFiller: false,
      }),
    );
    expect(result.items[1]).not.toHaveProperty('durationMs');
    expect(result.items[2].mixerChange).toEqual({
      channelId: 'song',
      volume: 1,
      muted: true,
      solo: false,
    });
    expect(result.items[3].mixerChange).toEqual({});
  });

  it('requires a bounded program identity and nonempty sequence name', async () => {
    const f = setup();
    await expect(
      f.service.createFlightSequence('', { name: 'Rundown' }),
    ).rejects.toThrow('programId is required');
    await expect(
      f.service.createFlightSequence('news', { name: ' ' }),
    ).rejects.toThrow('name is required');
    expect(f.prisma.flightSequence.create).not.toHaveBeenCalled();
  });

  it.each([
    'not a date',
    '2026-01-01T12:00:01Z',
    '2026-02-30T12:00:00Z',
    '2026-99-01T12:00:00Z',
  ])(
    'rejects an invalid scheduled start before writing: %p',
    async (scheduledAt) => {
      const f = setup();
      await expect(
        f.service.createFlightSequence('news', {
          name: 'Clocked',
          scheduledAt,
          items: clockItems(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.flightSequence.create).not.toHaveBeenCalled();
    },
  );

  it('permits an empty draft but requires a radio leg and a nonlooping clocked block', async () => {
    const f = setup();
    expect(
      (
        await f.service.createFlightSequence('news', {
          name: 'Draft',
          scheduledAt: '2026-01-01T13:00:00Z',
          items: [],
        })
      ).items,
    ).toEqual([]);
    await expect(f.service.preflightFlightSequence('news', 7)).rejects.toThrow(
      'needs 1-120',
    );
    await expect(
      f.service.createFlightSequence('news', {
        name: 'Loop',
        scheduledAt: '2026-01-01T13:00:00Z',
        loop: true,
      }),
    ).rejects.toThrow('cannot loop');
    f.state.type = 'tv';
    await expect(
      f.service.createFlightSequence('news', {
        name: 'No radio',
        scheduledAt: '2026-01-01T13:00:00Z',
      }),
    ).rejects.toThrow('no radio leg');
  });

  it.each([
    [{ kind: 'playSong', songId: 5, clockOffsetSeconds: 0 }],
    [{ id: 'one', kind: 'scene', sceneId: 3, clockOffsetSeconds: 0 }],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        isFiller: 'yes',
      },
    ],
    [
      {
        id: 'one',
        kind: 'instant',
        instantId: 12,
        clockOffsetSeconds: 0,
        durationMs: 0,
      },
    ],
    [{ id: 'one', kind: 'playSong', songId: '5', clockOffsetSeconds: 0 }],
    [{ id: 'one', kind: 'playSong', songId: 0, clockOffsetSeconds: 0 }],
    [{ id: 'one', kind: 'instant', instantId: 0, clockOffsetSeconds: 0 }],
    [{ id: 'one', kind: 'playSong', songId: 5 }],
    [{ id: 'one', kind: 'playSong', songId: 5, clockOffsetSeconds: -1 }],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 0,
      },
    ],
    [
      {
        id: 'one',
        kind: 'instant',
        instantId: 12,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
      },
    ],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceDuckGain: 0.5,
      },
    ],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
        voiceDuckGain: -1,
      },
    ],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
        voiceDuckGain: 2,
      },
    ],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
        voiceFadeInSeconds: 6,
      },
    ],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
        voiceFadeOutSeconds: -1,
      },
    ],
    [
      {
        id: 'one',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
        voiceFadeInSeconds: NaN,
      },
    ],
    [
      { id: 'one', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 },
      { id: 'one', kind: 'stopSong', clockOffsetSeconds: 2 },
    ],
    [
      { id: 'one', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 },
      { id: 'two', kind: 'stopSong', clockOffsetSeconds: 10 },
      { id: 'three', kind: 'stopSong', clockOffsetSeconds: 5 },
    ],
  ])(
    'rejects malformed clock cues before persistence: %p',
    async (...items) => {
      const f = setup();
      await expect(
        f.service.createFlightSequence('news', {
          name: 'Invalid clock',
          scheduledAt: '2026-01-01T13:00:00Z',
          items,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.flightSequence.create).not.toHaveBeenCalled();
    },
  );

  it('maps database sequence uniqueness conflicts and propagates unrelated create failures', async () => {
    const f = setup();
    f.prisma.flightSequence.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      f.service.createFlightSequence('news', { name: 'Duplicate' }),
    ).rejects.toThrow('already exists');
    f.prisma.flightSequence.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      f.service.createFlightSequence('news', {
        name: 'Clock',
        scheduledAt: '2026-01-01T13:00:00Z',
      }),
    ).rejects.toThrow('scheduled start or name');
    const failure = new Error('database unavailable');
    f.prisma.flightSequence.create.mockRejectedValueOnce(failure);
    await expect(
      f.service.createFlightSequence('news', { name: 'Failure' }),
    ).rejects.toBe(failure);
  });

  it('edits an unpublished sequence through its compare-and-swap revision and retains source ownership', async () => {
    const f = setup();
    const result = await f.service.updateFlightSequence(' news ', 7, {
      name: ' Revised ',
      items: [{ id: 'wait', kind: 'wait', durationMs: 500 }],
      loop: true,
    });
    expect(result).toEqual(
      expect.objectContaining({ name: 'Revised', loop: true, revision: 2 }),
    );
    expect(f.prisma.flightSequence.updateMany).toHaveBeenCalledWith({
      where: { id: 7, revision: 1 },
      data: {
        name: 'Revised',
        items: [{ id: 'wait', kind: 'wait', durationMs: 500 }],
        loop: true,
        revision: { increment: 1 },
      },
    });
    f.prisma.flightSequence.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      f.service.updateFlightSequence('news', 7, {}),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      f.service.updateFlightSequence('news', 99, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.updateFlightSequence('news', 7, { items: {} }),
    ).rejects.toThrow('must be an array');
  });

  it('activates, deactivates and deletes sequences while clearing the persisted active pointer', async () => {
    const f = setup();
    expect(await f.service.activateFlightSequence('news', 7)).toEqual({
      activeSequenceId: 7,
    });
    expect(await f.service.deactivateFlightSequence('news')).toEqual({
      activeSequenceId: null,
    });
    expect(f.state.activeFlightSequenceId).toBeNull();
    f.state.activeFlightSequenceId = 7;
    expect(await f.service.deleteFlightSequence('news', 7)).toEqual({
      deletedId: 7,
    });
    expect(f.prisma.flightSequence.delete).toHaveBeenCalledWith({
      where: { id: 7 },
    });
    expect(f.state.activeFlightSequenceId).toBeNull();
    await expect(
      f.service.deleteFlightSequence('news', 99),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.activateFlightSequence('news', 99),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires an active nonempty published sequence before starting', async () => {
    const f = setup();
    f.state.activeFlightSequenceId = null;
    await expect(f.service.start('news')).rejects.toThrow('no active');
    f.state.activeFlightSequenceId = 99;
    await expect(f.service.start('news')).rejects.toThrow('not found');
    f.state.activeFlightSequenceId = 7;
    f.sequence().items = [];
    await expect(f.service.start('news')).rejects.toThrow('no cues');
    clocked(f);
    f.sequence().publishedAt = null;
    await expect(f.service.start('news')).rejects.toThrow('publish');
    await expect(f.service.activateFlightSequence('news', 7)).rejects.toThrow(
      'publish',
    );
    f.sequence().publishedAt = new Date();
    f.prisma.song.findMany.mockResolvedValue([]);
    await expect(f.service.start('news')).rejects.toThrow('song unavailable');
    await expect(f.service.activateFlightSequence('news', 7)).rejects.toThrow(
      'song unavailable',
    );
  });

  it('runs wait cues in order and stops after completion without advancing again on stale song feedback', async () => {
    const f = setup();
    f.sequence().items.push({ id: 'last', kind: 'wait', durationMs: 500 });
    await f.service.start('news');
    await flush();
    expect(f.sequence()).toEqual(
      expect.objectContaining({ isRunning: true, activeItemId: 'wait' }),
    );
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.sequence().activeItemId).toBe('last');
    await jest.advanceTimersByTimeAsync(500);
    expect(f.sequence().isRunning).toBe(false);
    expect(await f.service.handleSongEnded('news')).toEqual({ ok: false });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('lets GO start an idle log, loop an active sequence, and reset its cursor without leaking timers', async () => {
    const f = setup();
    f.sequence().loop = true;
    await f.service.go('news');
    await flush();
    const firstWrites = f.prisma.flightSequence.update.mock.calls.length;
    await f.service.go('news');
    await flush();
    expect(f.prisma.flightSequence.update.mock.calls.length).toBeGreaterThan(
      firstWrites,
    );
    expect(f.sequence().isRunning).toBe(true);
    await f.service.reset('news');
    await flush();
    expect(f.sequence().activeItemId).toBe('wait');
    await f.service.stop('news');
    expect(jest.getTimerCount()).toBe(0);
    await f.service.reset('news');
    expect(f.sequence().isRunning).toBe(false);
  });

  it('advances authoritative song-end waits and uses the declared timeout when no completion arrives', async () => {
    const f = setup();
    f.sequence().items = [
      { id: 'song-end', kind: 'waitForSongEnd' },
      { id: 'after', kind: 'wait', durationMs: 1000 },
    ];
    await f.service.start('news');
    await flush();
    expect(await f.service.handleSongEnded('news')).toEqual({ ok: true });
    expect(f.sequence().activeItemId).toBe('after');
    await f.service.stop('news');
    await f.service.start('news');
    await flush();
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(f.sequence().activeItemId).toBe('after');
  });

  it('runs scene, metadata patch, instant and mixer cues through their normal program boundaries', async () => {
    const f = setup();
    f.sequence().items = [
      { id: 'scene', kind: 'scene', sceneId: 3, transitionId: 'cut' },
      {
        id: 'patch',
        kind: 'sceneUpdate',
        sceneId: 3,
        metadataPatch: {
          title: { text: 'New' },
          remove: undefined,
          extra: ['item'],
        },
      },
      { id: 'clip', kind: 'instant', instantId: 12 },
      {
        id: 'mix',
        kind: 'mixer',
        mixerChange: { channelId: 'song', volume: 0, muted: true, solo: true },
      },
      {
        id: 'main',
        kind: 'mixer',
        mixerChange: { channelId: 'main', volume: 1 },
      },
      { id: 'wait', kind: 'wait', durationMs: 1000 },
    ];
    await f.service.start('news');
    await flush();
    expect(f.programs.activateScene).toHaveBeenCalledWith(3, 'news', 'cut');
    expect(JSON.parse(f.scene().metadata)).toEqual({
      title: { text: 'New', color: 'red' },
      extra: ['item'],
    });
    expect(f.programs.playInstant).toHaveBeenCalledWith(12, 'news');
    expect(f.programs.updateProgramAudioBus).toHaveBeenCalledWith(
      {
        mixerSettings: {
          mixerChannels: [
            { id: 'song', volume: 0, muted: true, solo: true },
            { id: 'instants', volume: 1, muted: false, solo: false },
          ],
        },
      },
      'news',
    );
    expect(f.programs.updateProgramAudioBus).toHaveBeenCalledWith(
      { mixerSettings: { mainMasterVolume: 1 } },
      'news',
    );
    expect(f.sequence().activeItemId).toBe('wait');
  });

  it('continues an unclocked rundown after a failed cue and handles malformed metadata without losing the patch', async () => {
    const f = setup();
    f.programs.activateScene.mockRejectedValueOnce(
      new Error('scene unavailable'),
    );
    f.scene().metadata = 'invalid JSON';
    f.sequence().items = [
      { id: 'scene', kind: 'scene', sceneId: 3 },
      {
        id: 'patch',
        kind: 'sceneUpdate',
        sceneId: 3,
        metadataPatch: { text: 'New' },
      },
      { id: 'wait', kind: 'wait' },
    ];
    await f.service.start('news');
    await flush();
    expect(console.error).toHaveBeenCalledWith(
      'Flight cue execution failed (scene)',
      expect.any(Error),
    );
    expect(JSON.parse(f.scene().metadata)).toEqual({ text: 'New' });
  });

  it('does not play clocked content before the scheduled start or allow GO to skip the clock', async () => {
    const f = setup();
    clocked(f);
    f.sequence().scheduledAt = new Date(Date.now() + 60000);
    await f.service.start('news');
    await flush();
    expect(f.programs.takeCatalogSongOnAir).not.toHaveBeenCalled();
    await expect(f.service.go('news')).rejects.toThrow('cannot advance before');
    await jest.advanceTimersByTimeAsync(60000);
    expect(f.programs.takeCatalogSongOnAir).toHaveBeenCalledWith(
      'news',
      expect.objectContaining({ id: 5 }),
      undefined,
    );
    expect(f.service.isClockedLogRunning('news')).toBe(true);
    expect(f.programs.updateProgramAudioBus).not.toHaveBeenCalled();
  });

  it('stops a failed clocked cue visibly and never pretends the failed block completed', async () => {
    const f = setup();
    clocked(f);
    f.programs.takeCatalogSongOnAir.mockImplementationOnce(() => {
      throw new Error('playout unavailable');
    });
    await f.service.start('news');
    await flush();
    expect(f.sequence().isRunning).toBe(false);
    expect(f.programs.broadcastUpdate).toHaveBeenCalledWith('news', {
      type: 'radio_log_cue_failed',
      sequenceId: 7,
      cueId: 'song',
    });
    expect(f.metrics.render()).toContain('result="cue-failed"');
    expect(f.programs.resumeContinuousRotation).not.toHaveBeenCalled();
  });

  it('cuts at the next hard clock cue even if a preceding song never ends, then respects clip duration', async () => {
    const f = setup();
    clocked(f, [
      { id: 'song', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 },
      {
        id: 'clip',
        kind: 'instant',
        instantId: 12,
        durationMs: 2000,
        clockOffsetSeconds: 10,
      },
      { id: 'end', kind: 'stopSong', clockOffsetSeconds: 20 },
    ]);
    await f.service.start('news');
    await flush();
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.programs.playInstant).toHaveBeenCalledWith(12, 'news');
    expect(f.sequence().activeItemId).toBe('clip');
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.sequence().activeItemId).toBe('clip');
    await jest.advanceTimersByTimeAsync(8000);
    expect(f.programs.prepareContinuousRotationResume).toHaveBeenCalledWith(
      'news',
    );
    expect(f.programs.resumeContinuousRotation).toHaveBeenCalledWith('news');
    expect(f.sequence().isRunning).toBe(false);
  });

  it('preserves diagnostic failure when physical timed-block stop cannot complete and releases the runtime', async () => {
    const f = setup();
    clocked(f);
    f.programs.stopProgramSongForTimedBlock.mockRejectedValue(
      new Error('physical stop failed'),
    );
    await expect(f.service.activateFlightSequence('news', 7)).resolves.toEqual({
      activeSequenceId: 7,
    });
    await f.service.start('news');
    await flush();
    expect(f.metrics.render()).toContain('result="cue-failed"');
    expect(f.service.isClockedLogRunning('news')).toBe(false);
  });

  it('marks interrupted scheduled runtime state on startup and clears only its own polling timer on shutdown', async () => {
    const f = setup();
    clocked(f);
    f.sequence().isRunning = true;
    await f.service.onModuleInit();
    expect(f.prisma.flightSequence.updateMany).toHaveBeenCalledWith({
      where: { isRunning: true, scheduledAt: { not: null } },
      data: { isRunning: false },
    });
    expect(f.metrics.render()).toContain('result="interrupted"');
    expect(jest.getTimerCount()).toBe(1);
    f.service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('coalesces slow schedule polls instead of concurrently claiming the same block', async () => {
    const f = setup();
    let release!: (rows: unknown[]) => void;
    f.prisma.flightSequence.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.service.onModuleInit();
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.prisma.flightSequence.findMany).toHaveBeenCalledTimes(1);
    release([]);
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.prisma.flightSequence.findMany).toHaveBeenCalledTimes(2);
  });

  it('claims a due published block once and starts its actual catalog cue', async () => {
    const f = setup();
    clocked(f);
    f.prisma.flightSequence.findMany.mockResolvedValueOnce([
      { ...f.sequence(), programState: { programId: 'news' } },
    ]);
    await f.service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.prisma.flightSequence.updateMany).toHaveBeenCalledWith({
      where: { id: 7, lastStartedAt: null, publishedAt: { not: null } },
      data: { lastStartedAt: new Date() },
    });
    expect(f.programs.takeCatalogSongOnAir).toHaveBeenCalledTimes(1);
    expect(f.sequence().lastStartedAt).toEqual(new Date());
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.programs.takeCatalogSongOnAir).toHaveBeenCalledTimes(1);
  });

  it('skips a due block whose one-time claim was already taken by another worker', async () => {
    const f = setup();
    clocked(f);
    f.prisma.flightSequence.findMany.mockResolvedValueOnce([
      { ...f.sequence(), programState: { programId: 'news' } },
    ]);
    await f.service.onModuleInit();
    f.prisma.flightSequence.updateMany.mockResolvedValueOnce({ count: 0 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.programs.takeCatalogSongOnAir).not.toHaveBeenCalled();
  });

  it('preserves a failed one-time scheduled claim and reports the failed start without playing unavailable media', async () => {
    const f = setup();
    clocked(f);
    f.prisma.flightSequence.findMany.mockResolvedValueOnce([
      { ...f.sequence(), programState: { programId: 'news' } },
    ]);
    f.prisma.song.findMany.mockResolvedValue([]);
    await f.service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.sequence().lastStartedAt).toEqual(new Date());
    expect(f.metrics.render()).toContain('result="start-failed"');
    expect(f.programs.broadcastUpdate).toHaveBeenCalledWith('news', {
      type: 'radio_log_start_failed',
      sequenceId: 7,
    });
    expect(f.programs.takeCatalogSongOnAir).not.toHaveBeenCalled();
  });

  it('records a polling failure without turning an unavailable database into a successful schedule check', async () => {
    const f = setup();
    f.prisma.flightSequence.findMany.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await f.service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.metrics.render()).toContain('result="poll-failed"');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Scheduled radio log poll failed',
    );
    expect(f.programs.takeCatalogSongOnAir).not.toHaveBeenCalled();
  });

  it('preflights songs and recorded voice clips, then publishes only the exact still-current future revision', async () => {
    const f = setup();
    clocked(f, [
      {
        id: 'song',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
        voiceDuckGain: 0.5,
        voiceFadeInSeconds: 1,
        voiceFadeOutSeconds: 2,
      },
      {
        id: 'clip',
        kind: 'instant',
        instantId: 12,
        clockOffsetSeconds: 10,
        durationMs: 1000,
      },
    ]);
    f.sequence().publishedAt = null;
    f.sequence().scheduledAt = new Date('2026-01-01T13:00:00Z');
    expect(await f.service.preflightFlightSequence('news', 7)).toEqual({
      programId: 'news',
      ready: true,
      issues: [],
    });
    const published = await f.service.publishFlightSequence('news', 7, 1);
    expect(published).toEqual(
      expect.objectContaining({ revision: 2, publishedAt: new Date() }),
    );
    expect(f.prisma.flightSequence.updateMany).toHaveBeenCalledWith({
      where: { id: 7, revision: 1 },
      data: { publishedAt: new Date(), revision: { increment: 1 } },
    });
    expect(f.metrics.render()).toContain('result="published"');
  });

  it('reports every unavailable song/clip and refuses publication without changing its revision', async () => {
    const f = setup();
    clocked(f, [
      {
        id: 'song',
        kind: 'playSong',
        songId: 5,
        clockOffsetSeconds: 0,
        voiceTrackInstantId: 12,
      },
      { id: 'clip', kind: 'instant', instantId: 13, durationMs: 1000 },
    ]);
    f.sequence().scheduledAt = new Date('2026-01-01T13:00:00Z');
    f.prisma.song.findMany.mockResolvedValue([
      { id: 5, enabled: true, audioUrl: ' ' },
    ]);
    f.prisma.instant.findMany.mockResolvedValue([
      { id: 12, enabled: false, audioUrl: 'https://media.example/voice.mp3' },
    ]);
    const preflight = await f.service.preflightFlightSequence('news', 7);
    expect(preflight).toEqual({
      programId: 'news',
      ready: false,
      issues: [
        'Item 1: song unavailable',
        'Item 1: audio clip unavailable',
        'Item 2: audio clip unavailable',
      ],
    });
    await expect(f.service.publishFlightSequence('news', 7, 1)).rejects.toThrow(
      'audio clip unavailable',
    );
    expect(f.prisma.flightSequence.updateMany).not.toHaveBeenCalled();
    expect(f.metrics.render()).toContain('result="preflight-failed"');
  });

  it('rejects publication authority, schedule, loop, missing sequence and stale revision before any write', async () => {
    const f = setup();
    await expect(f.service.preflightFlightSequence('news', 7)).rejects.toThrow(
      'not a clocked log',
    );
    await expect(
      f.service.preflightFlightSequence('news', 99),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.publishFlightSequence('news', 7, 1)).rejects.toThrow(
      'future',
    );
    clocked(f);
    await expect(f.service.publishFlightSequence('news', 7, 1)).rejects.toThrow(
      'future',
    );
    f.sequence().scheduledAt = new Date('2026-01-01T13:00:00Z');
    await expect(
      f.service.publishFlightSequence('news', 99, 1),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.state.type = 'tv';
    await expect(f.service.publishFlightSequence('news', 7, 1)).rejects.toThrow(
      'no radio leg',
    );
    f.state.type = 'both';
    f.sequence().loop = true;
    await expect(f.service.publishFlightSequence('news', 7, 1)).rejects.toThrow(
      'cannot loop',
    );
    f.sequence().loop = false;
    await expect(
      f.service.publishFlightSequence('news', 7, 99),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.prisma.flightSequence.updateMany).not.toHaveBeenCalled();
    f.prisma.flightSequence.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      f.service.publishFlightSequence('news', 7, 1),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects oversized, unsupported and unsafe persisted clock layouts during preflight', async () => {
    const f = setup();
    clocked(f);
    f.sequence().items = Array.from({ length: 121 }, (_, index) => ({
      id: `cue-${index}`,
      kind: 'playSong',
      songId: 5,
      ...(index === 0 ? { clockOffsetSeconds: 0 } : {}),
    }));
    await expect(f.service.preflightFlightSequence('news', 7)).rejects.toThrow(
      '1-120',
    );
    f.sequence().items = [
      { id: 'scene', kind: 'scene', sceneId: 3, clockOffsetSeconds: 0 },
    ];
    await expect(f.service.preflightFlightSequence('news', 7)).rejects.toThrow(
      'support songs, clips, and stop cues',
    );
    f.sequence().items = [
      { id: 'song', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 },
      {
        id: 'end',
        kind: 'stopSong',
        clockOffsetSeconds: Number.MAX_SAFE_INTEGER + 1,
      },
    ];
    await expect(f.service.preflightFlightSequence('news', 7)).rejects.toThrow(
      'fixed starts must be ordered',
    );
  });

  it('does not poison later serialized edits after a failed update and maps uniqueness errors', async () => {
    const f = setup();
    const failed = f.service.updateFlightSequence('news', 7, { items: {} });
    const next = f.service.updateFlightSequence('news', 7, {
      name: 'After failure',
    });
    await expect(failed).rejects.toThrow('must be an array');
    expect((await next).name).toBe('After failure');
    f.prisma.flightSequence.updateMany.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      f.service.updateFlightSequence('news', 7, { name: 'Duplicate' }),
    ).rejects.toThrow('already exists');
  });

  it('stops a running sequence before deletion and clears its active program pointer', async () => {
    const f = setup();
    await f.service.start('news');
    await flush();
    await f.service.deleteFlightSequence('news', 7);
    expect(f.sequence().isRunning).toBe(false);
    expect(f.state.activeFlightSequenceId).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    expect(f.programs.takeProgramSongOffAir).toHaveBeenCalled();
  });

  it('rejects generation/filler previews for missing drafts or programs without a radio leg', async () => {
    const f = setup();
    const rules = { slots: [{ labelId: 'music', count: 1, clockOffsetSeconds: 0 }], artistSeparation: 0 };
    await expect(f.service.generateTaggedLog('news', 99, { revision: 1, rules })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.fillRundown('news', 99, { revision: 1, rules: { labelId: 'music', artistSeparation: 0 } })).rejects.toBeInstanceOf(NotFoundException);
    f.state.type = 'tv';
    await expect(f.service.fillRundown('news', 7, {})).rejects.toThrow('require a radio leg');
  });

  it('uses prior concrete song history for tag previews and refuses an unavailable generated result before saving', async () => {
    const f = setup(); clocked(f); f.sequence().publishedAt = null;
    const rules = { slots: [{ labelId: 'music', count: 1, clockOffsetSeconds: 0 }], artistSeparation: 0 };
    f.prisma.flightSequence.findMany.mockResolvedValueOnce([{ items: [{ id: 'old', kind: 'playSong', songId: 5 }, { id: 'pause', kind: 'wait' }] }]);
    expect((await f.service.generateTaggedLog('news', 7, { revision: 1, rules })).items[0].songId).toBe(5);
    f.prisma.song.findMany.mockResolvedValueOnce([{ id: 5, artist: 'Artist', durationMs: 1000, asset: { labels: [{ labelId: 'music', position: 0 }] } }]).mockResolvedValueOnce([]);
    await expect(f.service.generateTaggedLog('news', 7, { revision: 1, rules })).rejects.toThrow('song unavailable');
    expect(f.prisma.flightSequence.updateMany).not.toHaveBeenCalled();
  });

  it('preflights filler previews against current audio and rejects missing item arrays', async () => {
    const f = setup(); clocked(f); f.sequence().publishedAt = null;
    const rules = { labelId: 'music', artistSeparation: 0 };
    await expect(f.service.fillRundown('news', 7, { revision: 1, rules })).rejects.toThrow('items must be an array');
    const items = [{ id: 'content', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 }, { id: 'end', kind: 'stopSong', clockOffsetSeconds: 1 }];
    f.prisma.flightSequence.findMany.mockResolvedValueOnce([{ items: [{ id: 'old', kind: 'playSong', songId: 5 }, { id: 'pause', kind: 'wait' }] }]);
    f.prisma.song.findMany.mockResolvedValueOnce([{ id: 5, artist: 'Artist', durationMs: 1000, asset: { labels: [{ labelId: 'music', position: 0 }] } }]).mockResolvedValueOnce([]);
    await expect(f.service.fillRundown('news', 7, { revision: 1, rules, items })).rejects.toThrow('song unavailable');
    expect(f.prisma.flightSequence.updateMany).not.toHaveBeenCalled();
  });

  it('validates schedule/type/loop changes and revision freshness before editing clocked drafts', async () => {
    const f = setup(); clocked(f); f.sequence().publishedAt = null;
    await expect(f.service.updateFlightSequence('news', 7, { revision: 99, name: 'Stale' })).rejects.toBeInstanceOf(ConflictException);
    const changed = await f.service.updateFlightSequence('news', 7, { revision: 1, scheduledAt: '2026-01-01T13:00:00Z' });
    expect(changed.scheduledAt).toEqual(new Date('2026-01-01T13:00:00Z'));
    f.state.type = 'tv';
    await expect(f.service.updateFlightSequence('news', 7, { revision: 2, name: 'No radio' })).rejects.toThrow('no radio leg');
    f.state.type = 'radio';
    await expect(f.service.updateFlightSequence('news', 7, { revision: 2, loop: true })).rejects.toThrow('cannot loop');
    f.sequence().publishedAt = new Date(); f.prisma.song.findMany.mockResolvedValue([]);
    await expect(f.service.updateFlightSequence('news', 7, { revision: 2, name: 'Missing media' })).rejects.toThrow('song unavailable');
  });

  it('keeps an on-air clock schedule immutable and rearms a clip after an accepted future-only edit', async () => {
    const f = setup(); clocked(f, [{ id: 'clip', kind: 'instant', instantId: 12, clockOffsetSeconds: 0, durationMs: 2000 }, { id: 'end', kind: 'stopSong', clockOffsetSeconds: 10 }]);
    await f.service.start('news'); await flush();
    await expect(f.service.updateFlightSequence('news', 7, { revision: 1, loop: false })).rejects.toThrow('on-air log cannot change');
    const updated = await f.service.updateFlightSequence('news', 7, { revision: 1, items: [{ id: 'clip', kind: 'instant', instantId: 12, clockOffsetSeconds: 0, durationMs: 2000 }, { id: 'end', kind: 'stopSong', clockOffsetSeconds: 5 }] });
    expect(updated.revision).toBe(2);
    await jest.advanceTimersByTimeAsync(5000);
    expect(f.programs.resumeContinuousRotation).toHaveBeenCalledWith('news');
  });

  it('propagates failure to physically cut an already running clocked block before reactivation', async () => {
    const f = setup(); clocked(f);
    await f.service.start('news'); await flush();
    f.programs.stopProgramSongForTimedBlock.mockRejectedValueOnce(new Error('physical stop unavailable'));
    await expect(f.service.activateFlightSequence('news', 7)).rejects.toThrow('physical stop unavailable');
    expect(f.service.isClockedLogRunning('news')).toBe(false);
  });

  it('uses GO to advance and finish nonlooping waits, while authoritative song-end feedback can loop a waiting sequence', async () => {
    const f = setup(); f.sequence().items.push({ id: 'second', kind: 'wait', durationMs: 1000 });
    await f.service.start('news'); await flush();
    await f.service.go('news');
    expect(f.sequence().activeItemId).toBe('second');
    await f.service.go('news');
    expect(f.sequence().isRunning).toBe(false);
    f.sequence().items = [{ id: 'end-wait', kind: 'waitForSongEnd' }]; f.sequence().loop = true;
    await f.service.start('news'); await flush();
    expect(await f.service.handleSongEnded('news')).toEqual({ ok: true });
    expect(f.sequence().isRunning).toBe(true);
  });

  it('loops a timed wait and ignores an in-flight completion after the operator has stopped the runtime', async () => {
    const f = setup(); f.sequence().loop = true;
    await f.service.start('news'); await flush();
    const writes = f.prisma.flightSequence.update.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.prisma.flightSequence.update.mock.calls.length).toBeGreaterThan(writes);
    await f.service.stop('news');
    let release!: () => void;
    f.programs.activateScene.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    f.sequence().items = [{ id: 'slow', kind: 'scene', sceneId: 3 }, { id: 'clip', kind: 'instant', instantId: 12 }]; f.sequence().loop = false;
    await f.service.start('news'); await flush();
    await f.service.stop('news'); release(); await flush();
    expect(f.programs.playInstant).not.toHaveBeenCalled();
    expect(f.sequence().isRunning).toBe(false);
  });

  it('rechecks hard-cue wall time after a backward clock adjustment instead of cutting early', async () => {
    const f = setup(); clocked(f, [{ id: 'song', kind: 'playSong', songId: 5, clockOffsetSeconds: 0 }, { id: 'end', kind: 'stopSong', clockOffsetSeconds: 10 }]);
    await f.service.start('news'); await flush();
    jest.setSystemTime(new Date('2026-01-01T11:59:55Z'));
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.programs.resumeContinuousRotation).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    expect(f.programs.resumeContinuousRotation).toHaveBeenCalledWith('news');
  });

  it('rechecks clip wall time after a backward clock adjustment rather than ending the clip early', async () => {
    const f = setup(); clocked(f, [{ id: 'clip', kind: 'instant', instantId: 12, clockOffsetSeconds: 0, durationMs: 2000 }]);
    await f.service.start('news'); await flush();
    jest.setSystemTime(new Date('2026-01-01T11:59:59Z'));
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.programs.resumeContinuousRotation).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.programs.resumeContinuousRotation).toHaveBeenCalledWith('news');
  });

  it('continues past an unavailable unclocked catalog song, absent scene and empty mixer patch without making up side effects', async () => {
    const f = setup(); f.prisma.song.findUnique.mockResolvedValue(null); f.prisma.scene.findUnique.mockResolvedValue(null);
    f.sequence().items = [{ id: 'song', kind: 'playSong', songId: 5 }, { id: 'patch', kind: 'sceneUpdate', sceneId: 3, metadataPatch: { title: 'New' } }, { id: 'mix', kind: 'mixer', mixerChange: { channelId: 'main' } }, { id: 'stop', kind: 'stopSong' }, { id: 'wait', kind: 'wait', durationMs: 1000 }];
    await f.service.start('news'); await flush();
    expect(f.programs.takeCatalogSongOnAir).not.toHaveBeenCalled();
    expect(f.prisma.scene.update).not.toHaveBeenCalled();
    expect(f.programs.updateProgramAudioBus).not.toHaveBeenCalled();
    expect(f.programs.takeProgramSongOffAir).toHaveBeenCalledTimes(2);
    expect(f.sequence().activeItemId).toBe('wait');
  });
});
