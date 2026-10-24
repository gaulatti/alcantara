import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ProgramService } from './program.service';
import { validateProgramTemplateManifest } from './program-template.service';

function fixture() {
  const scene = {
    id: 7,
    name: 'Opening',
    metadata: JSON.stringify({ sceneInstant: { instantId: 12 } }),
    layout: { componentType: 'lower-third' },
  };
  const group = {
    id: 3,
    name: 'Idents',
    description: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    mediaItems: [
      {
        id: 11,
        mediaGroupId: 3,
        mediaId: 5,
        position: 0,
        media: {
          id: 5,
          name: 'Ident',
          imageUrl: 'https://media.example/ident.png',
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      },
    ],
  };
  const transition = {
    id: 4,
    name: 'Wipe',
    videoUrl: 'https://media.example/wipe.webm',
    cutPointMs: 400,
    enabled: true,
  };
  const states = new Map<string, any>();
  let broadcast: any = null;
  const newState = (programId: string, data: Record<string, unknown> = {}) => ({
    id: states.size + 1,
    programId,
    type: 'tv',
    activeSceneId: 7,
    stagedSceneId: null,
    scenes: [{ sceneId: 7, position: 0, scene }],
    activeScene: scene,
    mediaGroups: [{ mediaGroupId: 3, position: 0, mediaGroup: group }],
    stingers: [{ stingerId: 4, position: 0, stinger: transition }],
    flightSequences: [],
    ...data,
  });
  states.set('main', newState('main'));
  states.set('news', newState('news'));
  let instant: any = {
    id: 12,
    name: 'Opening ident',
    audioUrl: 'https://media.example/ident.mp3',
    enabled: true,
    volume: 0.5,
    position: 2,
    assetId: 'audio-clip:12',
    songIntro: null,
  };
  const relation = () => ({
    findUnique: jest.fn().mockResolvedValue(null),
    aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
    create: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  });
  const prisma: any = {
    programState: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.programId
          ? (states.get(where.programId) ?? null)
          : ([...states.values()].find((state) => state.id === where.id) ??
            null),
      ),
      findMany: jest.fn(async ({ where }: any = {}) =>
        [...states.values()].filter(
          (state) => !where || state.activeSceneId === where.activeSceneId,
        ),
      ),
      create: jest.fn(async ({ data }: any) => {
        const state = newState(data.programId, data);
        states.set(state.programId, state);
        return state;
      }),
      upsert: jest.fn(async ({ where, create }: any) => {
        if (!states.has(where.programId))
          states.set(where.programId, newState(where.programId, create));
        return states.get(where.programId);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const current = [...states.values()].find((state) =>
          where.programId
            ? state.programId === where.programId
            : state.id === where.id,
        );
        if (!current) throw new Error('Missing fixture row');
        states.delete(current.programId);
        Object.assign(current, data);
        for (const key of ['scenes', 'mediaGroups', 'stingers'])
          if (data[key]?.deleteMany) current[key] = [];
        states.set(current.programId, current);
        return current;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const current = [...states.values()].find(
          (state) => state.id === where.id,
        );
        states.delete(current.programId);
        return current;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const state of states.values())
          if (state.activeSceneId === where.activeSceneId)
            Object.assign(state, data);
      }),
    },
    scene: { findUnique: jest.fn().mockResolvedValue(scene) },
    mediaGroup: { findUnique: jest.fn().mockResolvedValue(group) },
    stinger: { findUnique: jest.fn().mockResolvedValue(transition) },
    programScene: relation(),
    programMediaGroup: relation(),
    programStinger: relation(),
    instant: {
      findUnique: jest.fn(async () => instant),
      findUniqueOrThrow: jest.fn(async () => instant),
      findMany: jest.fn(async () => [instant]),
      aggregate: jest.fn().mockResolvedValue({ _max: { position: 2 } }),
      create: jest.fn(async ({ data }: any) => {
        instant = { id: 13, ...data };
        return instant;
      }),
      update: jest.fn(async ({ data }: any) => {
        instant = { ...instant, ...data };
        return instant;
      }),
      delete: jest.fn(),
      updateMany: jest.fn(),
    },
    mediaAsset: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    broadcastSettings: {
      upsert: jest.fn(async ({ create, update }: any) => {
        broadcast = broadcast ? { ...broadcast, ...update } : { ...create };
        return broadcast;
      }),
    },
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) =>
    callback(prisma),
  );
  const radio = {
    getRadioSettings: jest.fn().mockResolvedValue({ enabled: false }),
    playInstant: jest.fn(),
    stopAllInstants: jest.fn(),
    playSong: jest.fn().mockResolvedValue({ ok: true }),
    updateMixer: jest.fn(),
    stopSong: jest.fn(),
  };
  const engine = {
    setBroadcastHandler: jest.fn(),
    handleSequenceUpdated: jest.fn(),
    handleQueueUpdated: jest.fn(),
    enqueueSong: jest.fn().mockResolvedValue([{ id: 'queue-1' }]),
    removeQueuedSong: jest.fn().mockResolvedValue([]),
    reorderSongQueue: jest.fn().mockResolvedValue([{ id: 'queue-2' }]),
    prepareContinuousRotationResume: jest.fn().mockResolvedValue(undefined),
    resumeContinuousRotation: jest.fn(),
    handleManualSong: jest.fn(),
    handleStopSong: jest.fn(),
  };
  const confidence = { observe: jest.fn() };
  const service = new ProgramService(
    prisma,
    radio as any,
    engine as any,
    undefined,
    confidence as any,
  );
  const events: any[] = [];
  service.addEventListener((event) => events.push(event));
  return {
    service,
    prisma,
    radio,
    engine,
    confidence,
    events,
    states,
    scene,
    group,
    transition,
    instant: () => instant,
  };
}

const template = {
  templateUrl: 'https://renderer.example/template.json',
  templateManifest: { schemaVersion: 1 },
  templateVerifiedAt: new Date(0),
} as any;

describe('ProgramService persisted program workflows', () => {
  beforeEach(() =>
    jest.spyOn(console, 'log').mockImplementation(() => undefined),
  );
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('initializes the required confidence-aware engine handler and default program', async () => {
    const f = fixture();
    f.states.delete('main');
    await f.service.onModuleInit();
    expect(f.engine.setBroadcastHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(f.prisma.programState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { programId: 'main' } }),
    );
    expect((await f.service.getState()).programId).toBe('main');
    await expect(
      new ProgramService(
        f.prisma,
        f.radio as any,
        f.engine as any,
      ).onModuleInit(),
    ).rejects.toThrow('confidence service is required');
  });

  it.each([undefined, 'tv', 'both', 'radio', 'unsupported'])(
    'creates a new %p program with explicit safe defaults and no implicit visual template',
    async (type) => {
      const f = fixture();
      const result = await f.service.createProgram('  new-show ', type);
      expect(result.programId).toBe('new-show');
      expect(result.type).toBe(
        type === 'radio' || type === 'both' ? type : 'tv',
      );
      expect(f.prisma.programState.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          programId: 'new-show',
          activeSceneId: null,
          templateUrl: null,
          templateManifest: null,
          templateVerifiedAt: null,
          audioMixer: expect.objectContaining({
            mainMasterVolume: 1,
            songMuted: false,
            mixerChannels: expect.arrayContaining([
              expect.objectContaining({ id: 'song', volume: 1 }),
            ]),
          }),
        }),
      });
    },
  );

  it('registers an explicit television renderer and rejects duplicate, blank, and radio-template creation', async () => {
    const f = fixture();
    await f.service.createProgram('renderer', 'tv', template);
    expect(f.states.get('renderer')).toEqual(expect.objectContaining(template));
    await expect(f.service.createProgram('news')).rejects.toThrow(
      'already exists',
    );
    await expect(f.service.createProgram('  ')).rejects.toThrow(
      'programId is required',
    );
    await expect(
      f.service.createProgram('radio', 'radio', template),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renames a program while retaining its meters, playback and event stream', async () => {
    const f = fixture();
    await f.service.updateProgramAudioMeter(
      { song: 0.1, instants: 0.2, main: 0.3 },
      'news',
    );
    await f.service.updateProgramSongPlayback(
      {
        token: 'song-1',
        audioUrl: 'https://media.example/song.mp3',
        progress: 0.2,
        currentTimeMs: 200,
        durationMs: 1000,
        isPlaying: false,
      },
      'news',
    );
    await f.service.takeProgramSceneInstant(7, 'news');
    const received: any[] = [];
    const subscription = f.service
      .getEventStream('news')
      .subscribe((event) => received.push(JSON.parse(event.data)));
    await Promise.resolve();
    await Promise.resolve();
    const renamed = await f.service.renameProgram(
      'news',
      'bulletin',
      'both',
      template,
    );
    expect(renamed).toEqual(
      expect.objectContaining({
        programId: 'bulletin',
        type: 'both',
        ...template,
      }),
    );
    expect((await f.service.getProgramAudioMeter('bulletin')).song.vu).toBe(
      0.1,
    );
    expect((await f.service.getProgramSongPlayback('bulletin')).token).toBe(
      'song-1',
    );
    expect(await f.service.getProgramSceneInstantPlayback('bulletin')).toEqual(
      expect.objectContaining({
        programId: 'bulletin',
        isPlaying: true,
        sceneId: 7,
      }),
    );
    f.service.broadcastUpdate('bulletin', { type: 'scene_change', sceneId: 7 });
    expect(received.at(-1)).toEqual(
      expect.objectContaining({ type: 'scene_change', sceneId: 7 }),
    );
    await expect(f.service.getState('news')).rejects.toThrow(
      'Program not found',
    );
    subscription.unsubscribe();
  });

  it('handles same-id edits, explicit template removal and radio conversion without retaining visual configuration', async () => {
    const f = fixture();
    await f.service.renameProgram('news', 'news');
    expect(f.prisma.programState.update).not.toHaveBeenCalled();
    await f.service.renameProgram('news', 'news', 'unsupported');
    expect(f.prisma.programState.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: {} }),
    );
    await f.service.renameProgram('news', 'news', 'tv', null);
    expect(f.states.get('news').templateUrl).toBeNull();
    const radio = await f.service.renameProgram('news', 'news', 'radio');
    expect(radio).toEqual(
      expect.objectContaining({
        type: 'radio',
        activeSceneId: null,
        stagedSceneId: null,
        fadeToBlack: false,
        scenes: [],
        mediaGroups: [],
        stingers: [],
      }),
    );
    await expect(
      f.service.renameProgram('news', 'news', undefined, template),
    ).rejects.toThrow('do not support visual templates');
  });

  it('rejects missing sources and occupied target identities before a rename write', async () => {
    const f = fixture();
    await expect(f.service.renameProgram('missing', 'new')).rejects.toThrow(
      'Program not found',
    );
    await expect(f.service.renameProgram('news', 'main')).rejects.toThrow(
      'Target program id already exists',
    );
    expect(f.prisma.programState.update).not.toHaveBeenCalled();
  });

  it('deletes only an existing program and clears its cached feedback', async () => {
    const f = fixture();
    await f.service.getEventStream('news').subscribe().unsubscribe();
    expect(await f.service.deleteProgram(' news ')).toEqual({
      deletedProgramId: 'news',
    });
    expect(f.states.has('news')).toBe(false);
    await expect(f.service.deleteProgram('news')).rejects.toThrow(
      'Program not found',
    );
    await f.service.createProgram('news');
    expect((await f.service.getProgramSongPlayback('news')).token).toBe('');
    expect((await f.service.getProgramAudioMeter('news')).main.vu).toBe(0);
    expect(
      (await f.service.getProgramSceneInstantPlayback('news')).isPlaying,
    ).toBe(false);
  });

  it('lists persisted programs with only resolvable staged scenes and returns public/staged state', async () => {
    const f = fixture();
    f.states.get('news').stagedSceneId = 7;
    expect(
      (await f.service.listPrograms()).find(
        (state) => state.programId === 'news',
      )?.stagedScene,
    ).toBe(f.scene);
    expect(await f.service.getStagedScene('news')).toEqual({
      programId: 'news',
      stagedSceneId: 7,
      stagedScene: f.scene,
      version: 0,
    });
    expect(await f.service.getPublicState('news')).toEqual(
      await f.service.getState('news'),
    );
    f.states.get('news').stagedSceneId = 99;
    expect((await f.service.getState('news')).stagedSceneId).toBeNull();
    f.states.get('news').stagedSceneId = '7';
    expect((await f.service.getState('news')).stagedScene).toBeNull();
  });

  it.each([
    ['addSceneToProgram', 'scene', 'programScene', 'sceneId', 7],
    [
      'addMediaGroupToProgram',
      'mediaGroup',
      'programMediaGroup',
      'mediaGroupId',
      3,
    ],
    ['addStingerToProgram', 'stinger', 'programStinger', 'stingerId', 4],
  ] as const)(
    'assigns %s at a stable append position and makes repeated assignments idempotent',
    async (method, resource, relation, key, id) => {
      const f = fixture();
      await f.service[method](id, 'news');
      expect(f.prisma[relation].create).toHaveBeenCalledWith({
        data: {
          programStateId: f.states.get('news').id,
          [key]: id,
          position: 0,
        },
      });
      f.prisma[relation].findUnique.mockResolvedValue({ id: 1 });
      await f.service[method](id, 'news');
      expect(f.prisma[relation].create).toHaveBeenCalledTimes(1);
      f.prisma[relation].findUnique.mockResolvedValue(null);
      f.prisma[relation].aggregate.mockResolvedValue({ _max: { position: 5 } });
      await f.service[method](id, 'news');
      expect(f.prisma[relation].create).toHaveBeenLastCalledWith({
        data: {
          programStateId: f.states.get('news').id,
          [key]: id,
          position: 6,
        },
      });
      f.prisma[resource].findUnique.mockResolvedValue(null);
      await expect(f.service[method](id, 'news')).rejects.toThrow('not found');
      await expect(f.service[method](id, 'missing')).rejects.toThrow(
        'Program not found',
      );
    },
  );

  it.each([
    [7, 7, { activeSceneId: null, stagedSceneId: null }],
    [7, null, { activeSceneId: null }],
    [null, 7, { stagedSceneId: null }],
    [null, null, null],
  ])(
    'removes an assigned scene and clears only its currently occupied buses',
    async (activeSceneId, stagedSceneId, expectedData) => {
      const f = fixture();
      Object.assign(f.states.get('news'), { activeSceneId, stagedSceneId });
      await f.service.removeSceneFromProgram(7, 'news');
      expect(f.prisma.programScene.deleteMany).toHaveBeenCalledWith({
        where: { programStateId: f.states.get('news').id, sceneId: 7 },
      });
      if (expectedData)
        expect(f.prisma.programState.update).toHaveBeenCalledWith({
          where: { id: f.states.get('news').id },
          data: expectedData,
        });
      else expect(f.prisma.programState.update).not.toHaveBeenCalled();
      await expect(
        f.service.removeSceneFromProgram(7, 'missing'),
      ).rejects.toThrow('Program not found');
    },
  );

  it('stops a removed scene background and clears active-scene references across affected programs', async () => {
    const f = fixture();
    await f.service.takeProgramSceneInstant(7, 'news');
    await f.service.removeSceneFromProgram(7, 'news');
    expect(
      (await f.service.getProgramSceneInstantPlayback('news')).isPlaying,
    ).toBe(false);
    f.prisma.programScene.findMany.mockResolvedValue([
      { programState: { programId: 'main' } },
      { programState: { programId: 'main' } },
      { programState: { programId: 'news' } },
    ]);
    expect(await f.service.getProgramIdsByAssignedScene(7)).toEqual([
      'main',
      'news',
    ]);
    expect(await f.service.clearActiveScene(7)).toEqual(['main']);
    expect(f.prisma.programState.updateMany).toHaveBeenCalledWith({
      where: { activeSceneId: 7 },
      data: { activeSceneId: null },
    });
    expect(await f.service.clearActiveScene(7)).toEqual([]);
  });

  it('returns ordered media/stinger projections and removes associations without deleting reusable assets', async () => {
    const f = fixture();
    expect(await f.service.listProgramMediaGroups('news')).toEqual([
      { ...f.group, mediaItems: undefined, items: f.group.mediaItems },
    ]);
    expect(await f.service.listProgramStingers('news')).toEqual([
      { ...f.transition, position: 0 },
    ]);
    await f.service.removeMediaGroupFromProgram(3, 'news');
    await f.service.removeStingerFromProgram(4, 'news');
    expect(f.prisma.programMediaGroup.deleteMany).toHaveBeenCalledWith({
      where: { programStateId: f.states.get('news').id, mediaGroupId: 3 },
    });
    expect(f.prisma.programStinger.deleteMany).toHaveBeenCalledWith({
      where: { programStateId: f.states.get('news').id, stingerId: 4 },
    });
    expect(f.prisma.mediaAsset.deleteMany).not.toHaveBeenCalled();
    for (const method of [
      'listProgramMediaGroups',
      'listProgramStingers',
    ] as const)
      await expect(f.service[method]('missing')).rejects.toThrow(
        'Program not found',
      );
    await expect(
      f.service.removeMediaGroupFromProgram(3, 'missing'),
    ).rejects.toThrow('Program not found');
    await expect(
      f.service.removeStingerFromProgram(4, 'missing'),
    ).rejects.toThrow('Program not found');
  });

  it('lists intro availability without leaking a different program song assignment', async () => {
    const f = fixture();
    f.prisma.instant.findMany.mockResolvedValue([
      { id: 1, songIntro: null },
      { id: 2, songIntro: { programId: 'news', songId: 10 } },
      { id: 3, songIntro: { programId: 'other', songId: 11 } },
    ]);
    expect(await f.service.listInstants('news')).toEqual([
      { id: 1, availableForSongIntro: true, assignedSongId: null },
      { id: 2, availableForSongIntro: false, assignedSongId: 10 },
      { id: 3, availableForSongIntro: false, assignedSongId: null },
    ]);
  });

  it('creates and synchronizes an instant asset using normalized values and stable append ordering', async () => {
    const f = fixture();
    const created = await f.service.createInstant({
      name: ' Ident ',
      audioUrl: ' https://media.example/new.mp3 ',
      volume: 2,
      enabled: false,
    });
    expect(f.prisma.instant.create).toHaveBeenCalledWith({
      data: {
        name: 'Ident',
        audioUrl: 'https://media.example/new.mp3',
        volume: 1,
        enabled: false,
        position: 3,
      },
    });
    expect(created.assetId).toBe('audio-clip:13');
    expect(f.prisma.mediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'audio-clip:13' } }),
    );
    f.prisma.instant.aggregate.mockResolvedValue({ _max: { position: null } });
    await f.service.createInstant({
      name: 'Default',
      audioUrl: 'https://media.example/default.mp3',
      volume: NaN,
    });
    expect(f.prisma.instant.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ volume: 1, enabled: true, position: 0 }),
    });
  });

  it.each([
    { name: '', audioUrl: 'url' },
    { name: 'Name', audioUrl: '' },
  ])(
    'rejects incomplete instant creation before a transaction',
    async (data) => {
      const f = fixture();
      await expect(f.service.createInstant(data)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('updates only supplied instant fields and synchronizes the canonical asset', async () => {
    const f = fixture();
    await f.service.updateInstant(12, {
      name: ' Renamed ',
      audioUrl: ' https://media.example/changed.mp3 ',
      volume: -1,
      enabled: false,
    });
    expect(f.prisma.instant.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: {
        name: 'Renamed',
        audioUrl: 'https://media.example/changed.mp3',
        volume: 0,
        enabled: false,
      },
    });
    expect(f.prisma.mediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ name: 'Renamed', enabled: false }),
      }),
    );
    await f.service.updateInstant(12, {});
    expect(f.prisma.instant.update).toHaveBeenLastCalledWith({
      where: { id: 12 },
      data: {},
    });
  });

  it.each([{ name: '  ' }, { audioUrl: '  ' }, { volume: NaN }])(
    'rejects invalid instant edits before a transaction',
    async (data) => {
      const f = fixture();
      await expect(f.service.updateInstant(12, data)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('deletes an unassigned instant with its canonical asset and uses a collision-safe two-stage position shift', async () => {
    const f = fixture();
    expect(await f.service.deleteInstant(12)).toEqual({ deletedInstantId: 12 });
    expect(f.prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: 'audio-clip:12' },
    });
    expect(f.prisma.instant.updateMany.mock.calls).toEqual([
      [
        {
          where: { position: { gt: 2 } },
          data: { position: { increment: 1000000 } },
        },
      ],
      [
        {
          where: { position: { gt: 1000002 } },
          data: { position: { decrement: 1000001 } },
        },
      ],
    ]);
    f.prisma.instant.findUnique.mockResolvedValue(null);
    await expect(f.service.updateInstant(12, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.service.deleteInstant(12)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.service.playInstant(12, 'news')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('plays enabled instants through the program stream and radio leg only when radio settings allow it', async () => {
    const f = fixture();
    await f.service.playInstant(12, 'news');
    expect(f.events.at(-1).data).toEqual(
      expect.objectContaining({
        type: 'instant_play',
        instant: expect.objectContaining({ id: 12 }),
      }),
    );
    expect(f.radio.playInstant).not.toHaveBeenCalled();
    f.radio.getRadioSettings.mockResolvedValue({ enabled: true });
    await f.service.playInstant(12, 'news');
    expect(f.radio.playInstant).toHaveBeenCalledWith(
      'news',
      f.instant().audioUrl,
      0.5,
    );
    await f.service.stopAllInstants('news');
    expect(f.radio.stopAllInstants).toHaveBeenCalledWith('news');
    f.radio.getRadioSettings.mockRejectedValue(new Error('radio unavailable'));
    await f.service.stopAllInstants('news');
    expect(f.radio.stopAllInstants).toHaveBeenCalledTimes(1);
    f.instant().enabled = false;
    await expect(f.service.playInstant(12, 'news')).rejects.toThrow(
      'Instant is disabled',
    );
  });

  it('requests renderer reload only for a known program and isolates a faulty event listener', async () => {
    const f = fixture();
    f.service.addEventListener(() => {
      throw new Error('listener failed');
    });
    const received = jest.fn();
    const unsubscribe = f.service.addEventListener(received);
    expect(await f.service.requestProgramReload('news')).toEqual(
      expect.objectContaining({ ok: true, programId: 'news' }),
    );
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'program_reload' }),
      }),
    );
    unsubscribe();
    f.service.broadcastUpdate('news', { type: 'program_reload' });
    expect(received).toHaveBeenCalledTimes(1);
    await expect(f.service.requestProgramReload('missing')).rejects.toThrow(
      'Program not found',
    );
  });

  it('proxies actual upstream bytes and rejects URL, transport, status and size failures', async () => {
    const f = fixture();
    const fetcher = jest.spyOn(global, 'fetch');
    for (const invalid of [
      undefined,
      '',
      'not an absolute URL',
      'file:///tmp/audio',
    ])
      await expect(f.service.proxyAudio(invalid)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    fetcher.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(
      f.service.proxyAudio('https://media.example/audio'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      f.service.proxyAudio('https://media.example/audio'),
    ).rejects.toThrow('HTTP 503');
    fetcher.mockResolvedValueOnce(
      new Response(Buffer.from('audio bytes'), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    expect(await f.service.proxyAudio(' https://media.example/audio ')).toEqual(
      { buffer: Buffer.from('audio bytes'), contentType: 'audio/mpeg' },
    );
    fetcher.mockResolvedValueOnce(new Response(Buffer.from('unknown bytes')));
    expect(
      (await f.service.proxyAudio('http://media.example/audio')).contentType,
    ).toBe('application/octet-stream');
    fetcher.mockResolvedValueOnce(
      new Response(new Uint8Array(100 * 1024 * 1024 + 1)),
    );
    await expect(
      f.service.proxyAudio('https://media.example/too-large'),
    ).rejects.toThrow('too large to proxy');
  });

  it('initializes global mixer settings once and leaves untouched configuration unchanged', async () => {
    const f = fixture();
    const settings = await f.service.getBroadcastSettings();
    expect(settings).toEqual(
      expect.objectContaining({
        version: 0,
        timeOverrideEnabled: false,
        mainMasterVolume: 1,
      }),
    );
    expect(settings.mixerChannels.map((channel) => channel.id)).toEqual([
      'song',
      'stream',
      'instants',
      'sceneInstant',
    ]);
    await f.service.getBroadcastSettings();
    expect(f.prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(f.prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('ADD COLUMN IF NOT EXISTS "mixerChannels"'),
    );
    expect((await f.service.updateBroadcastSettings({})).mainMasterVolume).toBe(
      1,
    );
    expect(f.events).toEqual([]);
  });

  it('normalizes every global mixer channel patch and publishes one versioned global update', async () => {
    const f = fixture();
    const settings = await f.service.updateBroadcastSettings({
      mainMasterVolume: 0.4,
      songMasterVolume: 2,
      instantMasterVolume: -1,
      streamMasterVolume: 0.5,
      sceneInstantMasterVolume: 0.3,
      songMuted: true,
      instantMuted: true,
      streamMuted: true,
      sceneInstantMuted: true,
      songSolo: true,
      instantSolo: true,
      streamSolo: true,
      sceneInstantSolo: true,
      mixerChannels: [
        null,
        1,
        [],
        {},
        { id: 2 },
        { id: ' ' },
        { id: ' custom ', volume: 0.6 },
        { id: 'custom', name: ' Custom ', volume: NaN },
        { id: 'song', name: ' Lead ', muted: false },
      ],
    });
    expect(settings.mainMasterVolume).toBe(0.4);
    expect(settings.mixerChannels).toEqual(
      expect.arrayContaining([
        { id: 'song', name: 'Lead', volume: 1, muted: true, solo: true },
        { id: 'stream', name: 'Stream', volume: 0.5, muted: true, solo: true },
        {
          id: 'instants',
          name: 'Instants',
          volume: 0,
          muted: true,
          solo: true,
        },
        {
          id: 'sceneInstant',
          name: 'Scene Instant',
          volume: 0.3,
          muted: true,
          solo: true,
        },
        {
          id: 'custom',
          name: 'Custom',
          volume: 0.6,
          muted: false,
          solo: false,
        },
      ]),
    );
    expect(settings.version).toBe(1);
    expect(f.service.getGlobalBroadcastVersion()).toBe(1);
    expect(f.events.at(-1)).toEqual(
      expect.objectContaining({
        scope: 'global',
        programId: null,
        data: expect.objectContaining({
          type: 'broadcast_settings_update',
          version: 1,
        }),
      }),
    );
  });

  it.each([
    'mainMasterVolume',
    'songMasterVolume',
    'instantMasterVolume',
    'streamMasterVolume',
    'sceneInstantMasterVolume',
  ])(
    'rejects nonfinite global %s input without publishing a change',
    async (field) => {
      const f = fixture();
      await expect(
        f.service.updateBroadcastSettings({ [field]: NaN }),
      ).rejects.toThrow(`${field} must be a finite number`);
      expect(f.events).toEqual([]);
    },
  );

  it.each([
    'songMuted',
    'instantMuted',
    'streamMuted',
    'sceneInstantMuted',
    'songSolo',
    'instantSolo',
    'streamSolo',
    'sceneInstantSolo',
  ])('rejects nonboolean global %s input', async (field) => {
    const f = fixture();
    await expect(
      f.service.updateBroadcastSettings({ [field]: 'yes' } as any),
    ).rejects.toThrow(`${field} must be a boolean`);
    expect(f.events).toEqual([]);
  });

  it('validates explicit time overrides, preserves their start during mixer edits, and clears them when disabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const f = fixture();
    await expect(
      f.service.updateBroadcastSettings({ enabled: true }),
    ).rejects.toThrow('startTime is required');
    await expect(
      f.service.updateBroadcastSettings({ enabled: true, startTime: '24:00' }),
    ).rejects.toThrow('HH:mm');
    const first = await f.service.updateBroadcastSettings({
      enabled: true,
      startTime: ' 09:30 ',
    });
    expect(first.timeOverrideStartTime).toBe('09:30');
    expect(first.timeOverrideStartedAt).toEqual(
      new Date('2026-01-01T12:00:00Z'),
    );
    jest.setSystemTime(new Date('2026-01-01T12:01:00Z'));
    expect(
      (await f.service.updateBroadcastSettings({ songMasterVolume: 0.5 }))
        .timeOverrideStartedAt,
    ).toEqual(first.timeOverrideStartedAt);
    const changed = await f.service.updateBroadcastSettings({
      startTime: '10:00',
    });
    expect(changed.timeOverrideStartedAt).toEqual(
      new Date('2026-01-01T12:01:00Z'),
    );
    const cleared = await f.service.updateBroadcastSettings({
      enabled: false,
      startTime: null,
    });
    expect(cleared).toEqual(
      expect.objectContaining({
        timeOverrideEnabled: false,
        timeOverrideStartTime: null,
        timeOverrideStartedAt: null,
      }),
    );
  });

  it('reads program mixer defaults and normalizes channel/legacy fields into the same audible settings', async () => {
    const f = fixture();
    const initial = await f.service.getProgramAudioBus('news');
    expect(initial.mixerSettings.mainMasterVolume).toBe(1);
    expect(initial.songSequence).toBeNull();
    expect(initial.songQueue).toEqual([]);
    await expect(f.service.getProgramAudioBus('missing')).rejects.toThrow(
      'Program not found',
    );
    const input = {
      mainMasterVolume: 0.4,
      songMasterVolume: 2,
      instantMasterVolume: -1,
      streamMasterVolume: 0.5,
      sceneInstantMasterVolume: 0.3,
      songMuted: true,
      instantMuted: true,
      streamMuted: true,
      sceneInstantMuted: true,
      songSolo: true,
      instantSolo: true,
      streamSolo: true,
      sceneInstantSolo: true,
      mixerChannels: [null, {}, { id: 'extra', name: '', volume: 0.2 }],
    };
    f.states.get('news').type = 'both';
    const updated = await f.service.updateProgramAudioBus(
      { mixerSettings: input },
      'news',
    );
    expect(updated.mixerSettings).toEqual(
      expect.objectContaining({
        mainMasterVolume: 0.4,
        songMasterVolume: 1,
        instantMasterVolume: 0,
        streamMasterVolume: 0.5,
        sceneInstantMasterVolume: 0.3,
        songMuted: true,
        instantMuted: true,
        streamMuted: true,
        sceneInstantMuted: true,
        songSolo: true,
        instantSolo: true,
        streamSolo: true,
        sceneInstantSolo: true,
      }),
    );
    expect(f.radio.updateMixer).toHaveBeenCalledWith(
      'news',
      expect.objectContaining({ mainVolume: expect.closeTo(0.090063, 6) }),
    );
    const preserved = await f.service.updateProgramAudioBus(
      { mixerSettings: { mainMasterVolume: NaN, songMuted: 'invalid' } },
      'news',
    );
    expect(preserved.mixerSettings.mainMasterVolume).toBe(0.4);
    expect(preserved.mixerSettings.songMuted).toBe(true);
    expect(
      (await f.service.updateProgramAudioBus(null, 'news')).mixerSettings,
    ).toEqual(preserved.mixerSettings);
  });

  it.each([[], 'not an object', 1])(
    'rejects malformed audio-bus input: %p',
    async (input) => {
      const f = fixture();
      await expect(
        f.service.updateProgramAudioBus(input as any, 'news'),
      ).rejects.toThrow('must be an object');
      expect(f.prisma.programState.update).not.toHaveBeenCalled();
    },
  );

  it('persists a playlist update, removes obsolete Play Next references and informs the execution engine', async () => {
    const f = fixture();
    f.states.get('news').songQueue = [
      { id: 'keep', itemId: 'song-1', enqueuedAt: 1 },
      { id: 'remove', itemId: 'song-2', enqueuedAt: 2 },
    ];
    const songSequence = {
      items: [
        {
          id: 'song-1',
          kind: 'preset',
          artist: 'Artist',
          title: 'Title',
          coverUrl: '',
          audioUrl: 'https://media.example/song.mp3',
        },
      ],
    };
    const result = await f.service.updateProgramAudioBus(
      { songSequence },
      'news',
    );
    expect(result.songQueue).toEqual([
      { id: 'keep', itemId: 'song-1', enqueuedAt: 1 },
    ]);
    expect(f.engine.handleSequenceUpdated).toHaveBeenCalledWith(
      'news',
      songSequence,
    );
    expect(f.engine.handleQueueUpdated).toHaveBeenCalledWith(
      'news',
      result.songQueue,
    );
    expect(f.radio.updateMixer).not.toHaveBeenCalled();
    await expect(
      f.service.updateProgramAudioBus({}, 'missing'),
    ).rejects.toThrow('Program not found');
    await f.service.updateProgramAudioBus({ songSequence: null }, 'news');
    expect((await f.service.getProgramAudioBus('news')).songQueue).toEqual([]);
  });

  it('forwards explicit queue, rotation and catalog-song actions with the normalized program identity', async () => {
    const f = fixture();
    expect(await f.service.enqueueProgramSong(' news ', 'song-1')).toEqual({
      songQueue: [{ id: 'queue-1' }],
      version: 0,
    });
    expect(
      await f.service.removeQueuedProgramSong(' news ', 'queue-1'),
    ).toEqual({ songQueue: [], version: 0 });
    expect(
      await f.service.reorderProgramSongQueue(' news ', ['queue-2']),
    ).toEqual({ songQueue: [{ id: 'queue-2' }], version: 0 });
    await f.service.prepareContinuousRotationResume(' news ');
    f.service.resumeContinuousRotation(' news ');
    const song = {
      id: 9,
      audioUrl: 'https://media.example/song.mp3',
      title: 'Title',
      artist: 'Artist',
      durationMs: null,
      coverUrl: null,
    };
    f.service.takeCatalogSongOnAir(' news ', song);
    expect(f.engine.handleManualSong).toHaveBeenCalledWith(
      'news',
      song.audioUrl,
      'Title',
      'Artist',
      undefined,
      undefined,
      9,
      undefined,
    );
    f.service.takeCatalogSongOnAir(
      'news',
      {
        ...song,
        durationMs: 1000,
        coverUrl: 'https://media.example/cover.png',
      },
      { instantId: 12 },
    );
    expect(f.engine.handleManualSong).toHaveBeenLastCalledWith(
      'news',
      song.audioUrl,
      'Title',
      'Artist',
      1000,
      'https://media.example/cover.png',
      9,
      { instantId: 12 },
    );
    expect(f.engine.enqueueSong).toHaveBeenCalledWith('news', 'song-1');
    expect(f.engine.removeQueuedSong).toHaveBeenCalledWith('news', 'queue-1');
    expect(f.engine.reorderSongQueue).toHaveBeenCalledWith('news', ['queue-2']);
    expect(f.engine.prepareContinuousRotationResume).toHaveBeenCalledWith(
      'news',
    );
    expect(f.engine.resumeContinuousRotation).toHaveBeenCalledWith('news');
  });

  it('clamps finite meter channels and preserves peak/hold ordering before broadcasting', async () => {
    const f = fixture();
    const result = await f.service.updateProgramAudioMeter(
      {
        song: -0.2,
        instants: { level: 0.5, peak: 0.2, peakHold: 0.1 },
        sceneInstant: { vu: 0.3 },
        main: 2,
      },
      'news',
    );
    expect(result).toEqual(
      expect.objectContaining({
        song: { vu: 0, peak: 0, peakHold: 0 },
        instants: { vu: 0.5, peak: 0.5, peakHold: 0.5 },
        sceneInstant: { vu: 0.3, peak: 0.3, peakHold: 0.3 },
        main: { vu: 1, peak: 1, peakHold: 1 },
      }),
    );
    expect(await f.service.getProgramAudioMeter('news')).toEqual(result);
  });

  it.each([
    null,
    undefined,
    'bad',
    { song: null, instants: 0, main: 0 },
    { song: [], instants: 0, main: 0 },
    { song: NaN, instants: 0, main: 0 },
    { song: { vu: Infinity }, instants: 0, main: 0 },
    { song: { vu: 0.1, peak: 'bad' }, instants: 0, main: 0 },
    { song: { vu: 0.1, peakHold: NaN }, instants: 0, main: 0 },
  ])(
    'rejects malformed meter data without publishing feedback: %p',
    async (input) => {
      const f = fixture();
      await expect(
        f.service.updateProgramAudioMeter(input as any, 'news'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.events).toEqual([]);
    },
  );

  it('validates playback telemetry, ignores excessive backward drift, and forwards only genuinely new songs', async () => {
    const f = fixture();
    f.radio.getRadioSettings.mockResolvedValue({ enabled: true });
    const payload = {
      token: ' one ',
      audioUrl: ' https://media.example/one.mp3 ',
      progress: 2,
      currentTimeMs: 1500,
      durationMs: 1000,
      isPlaying: true,
    };
    const first = await f.service.updateProgramSongPlayback(payload, 'news');
    expect(first).toEqual(
      expect.objectContaining({
        token: 'one',
        audioUrl: 'https://media.example/one.mp3',
        progress: 1,
        currentTimeMs: 1000,
      }),
    );
    expect(f.radio.playSong).toHaveBeenCalledTimes(1);
    const stale = await f.service.updateProgramSongPlayback(
      { ...payload, currentTimeMs: 100 },
      'news',
    );
    expect(stale).toEqual(first);
    expect(f.events).toHaveLength(1);
    await f.service.updateProgramSongPlayback(
      { ...payload, currentTimeMs: 800, isPlaying: false },
      'news',
    );
    expect(f.radio.playSong).toHaveBeenCalledTimes(1);
    f.radio.playSong.mockResolvedValue({ ok: false });
    await expect(
      f.service.updateProgramSongPlayback(
        { ...payload, token: 'two', audioUrl: 'https://media.example/two.mp3' },
        'news',
      ),
    ).rejects.toThrow('Palazzo rejected');
    const stopped = await f.service.updateProgramSongPlayback(
      {
        token: undefined,
        audioUrl: undefined,
        progress: 0,
        currentTimeMs: -1,
        isPlaying: false,
      },
      'news',
    );
    expect(stopped).toEqual(
      expect.objectContaining({
        token: '',
        audioUrl: '',
        currentTimeMs: 0,
        durationMs: null,
        isPlaying: false,
      }),
    );
  });

  it.each([
    null,
    undefined,
    'bad',
    { progress: NaN },
    { progress: 0, currentTimeMs: NaN },
    { progress: 0, currentTimeMs: 0, durationMs: 0 },
    { progress: 0, currentTimeMs: 0, durationMs: Infinity },
    { progress: 0, currentTimeMs: 0, durationMs: null, isPlaying: 'yes' },
  ])('rejects malformed playback data: %p', async (input) => {
    const f = fixture();
    await expect(
      f.service.updateProgramSongPlayback(input as any, 'news'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.events).toEqual([]);
  });

  it.each([
    null,
    undefined,
    '',
    'bad JSON',
    '[]',
    '{}',
    JSON.stringify({ sceneInstant: [] }),
    JSON.stringify({ sceneInstant: { instantId: -1 } }),
    JSON.stringify({ sceneInstant: { instantId: 1.5 } }),
    JSON.stringify({ sceneInstant: { assetId: ' ' } }),
  ])(
    'rejects scene backgrounds without a valid explicit asset or instant identity: %p',
    async (metadata) => {
      const f = fixture();
      f.scene.metadata = metadata as any;
      await expect(
        f.service.takeProgramSceneInstant(7, 'news'),
      ).rejects.toThrow('no configured background');
      expect(f.events).toEqual([]);
    },
  );

  it('resolves scene background assets and explicit overrides without changing the Program scene', async () => {
    const f = fixture();
    f.prisma.mediaAsset.findFirst.mockResolvedValue({
      id: 'background-1',
      name: 'Bed',
      sourceUrl: 'https://media.example/bed.mp3',
      backgroundAudio: { defaultVolume: 0.2 },
      audioClip: null,
    });
    f.scene.metadata = {
      sceneInstant: { assetId: ' background-1 ', instantId: '12' },
    } as any;
    const background = await f.service.takeProgramSceneInstant(
      undefined,
      'news',
    );
    expect(background).toEqual(
      expect.objectContaining({
        sceneId: 7,
        mediaAssetId: 'background-1',
        instantId: null,
        isPlaying: true,
        instant: expect.objectContaining({ volume: 0.2 }),
      }),
    );
    expect(f.states.get('news').activeSceneId).toBe(7);
    const explicit = await f.service.takeProgramSceneInstant(7, 'news', 12);
    expect(explicit.instantId).toBe(12);
    expect(explicit.mediaAssetId).toBe('audio-clip:12');
    const stopped = await f.service.stopProgramSceneInstant('news', 1500);
    expect(stopped).toEqual(
      expect.objectContaining({ isPlaying: false, startedAt: null }),
    );
    expect(f.events.at(-1).data).toEqual(
      expect.objectContaining({ type: 'scene_instant_stop', fadeMs: 1500 }),
    );
  });

  it('rejects missing, unassigned, disabled or unresolvable background targets before broadcasting', async () => {
    const f = fixture();
    await expect(
      f.service.takeProgramSceneInstant(7, 'missing'),
    ).rejects.toThrow('Program not found');
    await expect(f.service.takeProgramSceneInstant(99, 'news')).rejects.toThrow(
      'not assigned',
    );
    f.states.get('news').activeSceneId = null;
    await expect(
      f.service.takeProgramSceneInstant(null, 'news'),
    ).rejects.toThrow('No target scene');
    f.prisma.instant.findUnique.mockResolvedValueOnce(null);
    await expect(f.service.takeProgramSceneInstant(7, 'news')).rejects.toThrow(
      'instant not found',
    );
    f.instant().enabled = false;
    await expect(f.service.takeProgramSceneInstant(7, 'news')).rejects.toThrow(
      'instant is disabled',
    );
    f.prisma.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(
      f.service.takeProgramSceneInstant(7, 'news', null, 'missing'),
    ).rejects.toThrow('asset not found');
    f.prisma.mediaAsset.findFirst.mockResolvedValue({ id: 'missing-relation' });
    await expect(
      f.service.takeProgramSceneInstant(7, 'news', null, 'missing-relation'),
    ).rejects.toThrow('asset not found');
    expect(f.events).toEqual([]);
  });

  it('fails switcher mutations on missing/unassigned programs without altering persisted state', async () => {
    const f = fixture();
    await expect(f.service.stageScene(7, 'missing')).rejects.toThrow(
      'Program not found',
    );
    await expect(f.service.stageScene(99, 'news')).rejects.toThrow(
      'not assigned',
    );
    await expect(f.service.activateScene(7, 'missing')).rejects.toThrow(
      'Program not found',
    );
    await expect(f.service.activateScene(99, 'news')).rejects.toThrow(
      'not assigned',
    );
    await expect(f.service.setFadeToBlack(true, 'missing')).rejects.toThrow(
      'Program not found',
    );
    await expect(f.service.takeProgramOffAir('missing')).rejects.toThrow(
      'Program not found',
    );
    await expect(f.service.takeProgramSongOffAir('missing')).rejects.toThrow(
      'Program not found',
    );
    expect(f.prisma.programState.update).not.toHaveBeenCalled();
  });

  it('clears Preview explicitly, avoids redundant FTB writes and makes repeated off-air requests idempotent', async () => {
    const f = fixture();
    f.states.get('news').fadeToBlack = false;
    await f.service.stageScene(null, 'news');
    expect(f.states.get('news').stagedSceneId).toBeNull();
    const count = f.prisma.programState.update.mock.calls.length;
    await f.service.setFadeToBlack(false, 'news');
    expect(f.prisma.programState.update).toHaveBeenCalledTimes(count);
    await f.service.takeProgramSceneInstant(7, 'news');
    await f.service.takeProgramOffAir('news');
    expect(
      (await f.service.getProgramSceneInstantPlayback('news')).isPlaying,
    ).toBe(false);
    const offAirCount = f.prisma.programState.update.mock.calls.length;
    await f.service.takeProgramOffAir('news');
    expect(f.prisma.programState.update).toHaveBeenCalledTimes(offAirCount);
  });

  it('fades a previous scene background before starting the next persisted scene background', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const nextScene = { ...f.scene, id: 8, name: 'Next' };
    f.states.get('news').scenes.push({ sceneId: 8, scene: nextScene });
    await f.service.takeProgramSceneInstant(7, 'news');
    const transition = f.service.activateScene(8, 'news', ' dissolve ');
    await jest.advanceTimersByTimeAsync(0);
    expect(
      (await f.service.getProgramSceneInstantPlayback('news')).isPlaying,
    ).toBe(false);
    await jest.advanceTimersByTimeAsync(1500);
    await transition;
    expect(
      (await f.service.getProgramSceneInstantPlayback('news')).sceneId,
    ).toBe(8);
    expect(f.events.at(-1).data).toEqual(
      expect.objectContaining({
        type: 'scene_change',
        transitionId: 'dissolve',
      }),
    );
  });

  it('keeps a persisted scene switch when its configured background is unavailable', async () => {
    const f = fixture();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    f.prisma.instant.findUnique.mockResolvedValue(null);
    const result = await f.service.activateScene(7, 'news');
    expect(result.activeSceneId).toBe(7);
    expect(console.warn).toHaveBeenCalledWith(
      'Could not play background instant for scene 7:',
      expect.stringContaining('not found'),
    );
    expect(f.events.at(-1).data.type).toBe('scene_change');
  });

  it('stops a removed active scene background while clearing all matching persisted references', async () => {
    const f = fixture();
    await f.service.takeProgramSceneInstant(7, 'main');
    expect(await f.service.clearActiveScene(7)).toEqual(['main', 'news']);
    expect(
      (await f.service.getProgramSceneInstantPlayback('main')).isPlaying,
    ).toBe(false);
    expect(
      f.events.find((event) => event.data.type === 'scene_instant_stop')?.data
        .fadeMs,
    ).toBe(1500);
  });

  it('resets rotation on an explicit song stop while preserving it during a timed block', async () => {
    const f = fixture();
    f.radio.getRadioSettings.mockResolvedValue({ enabled: true });
    const songSequence = {
      mode: 'autoplay',
      items: [
        {
          id: 'song-1',
          kind: 'preset',
          artist: 'Artist',
          title: 'Title',
          coverUrl: '',
        },
      ],
    };
    f.states.get('news').songSequence = songSequence;
    expect(await f.service.stopProgramSongForTimedBlock('news')).toEqual({
      ok: true,
      programId: 'news',
    });
    expect(f.states.get('news').songSequence.mode).toBe('autoplay');
    expect(f.engine.handleSequenceUpdated).not.toHaveBeenCalled();
    await f.service.takeProgramSongOffAir('news');
    expect(f.states.get('news').songSequence).toEqual({
      ...songSequence,
      mode: 'manual',
      activeItemId: null,
    });
    expect(f.radio.stopSong).toHaveBeenCalledTimes(2);
    expect(f.engine.handleStopSong).toHaveBeenCalledWith('news');
    expect((await f.service.getProgramSongPlayback('news')).isPlaying).toBe(
      false,
    );
    f.radio.getRadioSettings.mockResolvedValue({ enabled: false });
    await f.service.takeProgramSongOffAir('news');
    expect(f.radio.stopSong).toHaveBeenCalledTimes(2);
  });

  it('restores a missing default state on both lightweight and full reads without creating arbitrary programs', async () => {
    const f = fixture();
    f.states.delete('main');
    expect((await f.service.getState()).programId).toBe('main');
    f.states.delete('main');
    expect((await f.service.getProgramAudioMeter()).main.vu).toBe(0);
    expect(f.prisma.programState.upsert).toHaveBeenCalledTimes(2);
    await expect(f.service.getProgramAudioMeter('missing')).rejects.toThrow(
      'Program not found',
    );
    await expect(f.service.getState('missing')).rejects.toThrow(
      'Program not found',
    );
  });

  it('translates engine playback, queue and radio-leg events without losing program identity or output-confidence observations', async () => {
    const f = fixture();
    await f.service.onModuleInit();
    const dispatch = f.engine.setBroadcastHandler.mock.calls[0][0];
    const playback = {
      token: 'song-1',
      audioUrl: 'https://media.example/song.mp3',
      title: 'Title',
      artist: 'Artist',
      coverUrl: '',
      progress: 0.3,
      positionMs: 300,
      durationMs: 1000,
      isPlaying: true,
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      introStatus: 'playing',
      queueEntryId: 'queue-1',
    };
    dispatch({ type: 'song_playback_active', programId: 'news', playback });
    expect(await f.service.getProgramSongPlayback('news')).toEqual(
      expect.objectContaining({
        token: 'song-1',
        currentTimeMs: 300,
        introStatus: 'playing',
        queueEntryId: 'queue-1',
      }),
    );
    dispatch({
      type: 'song_queue_update',
      programId: 'news',
      songQueue: [{ id: 'queue-1' }],
    });
    expect(f.events.at(-1).data).not.toHaveProperty('songSequence');
    dispatch({
      type: 'song_queue_update',
      programId: 'news',
      songQueue: [],
      songSequence: null,
    });
    expect(f.events.at(-1).data).toHaveProperty('songSequence', null);
    dispatch({
      type: 'radio_leg_status',
      programId: 'news',
      status: { state: 'degraded' },
    });
    expect(f.events.at(-1).data).toEqual(
      expect.objectContaining({
        type: 'radio_leg_status',
        programId: 'news',
        status: { state: 'degraded' },
      }),
    );
    dispatch({
      type: 'song_off_air',
      programId: 'news',
      triggeredAt: '2026-01-01T00:00:01Z',
    });
    expect(await f.service.getProgramSongPlayback('news')).toEqual(
      expect.objectContaining({
        token: 'song-1',
        isPlaying: false,
        introStatus: 'playing',
        queueEntryId: 'queue-1',
      }),
    );
    dispatch({
      type: 'song_off_air',
      programId: 'main',
      triggeredAt: '2026-01-01T00:00:01Z',
    });
    expect(await f.service.getProgramSongPlayback()).toEqual(
      expect.objectContaining({
        token: '',
        audioUrl: '',
        isPlaying: false,
        durationMs: null,
        introStatus: 'none',
        queueEntryId: null,
      }),
    );
    expect(f.confidence.observe).toHaveBeenCalledTimes(6);
  });

  it('versions each program topic independently and leaves unknown or primitive events untouched', () => {
    const f = fixture();
    expect(
      f.service.broadcastUpdate('news', { type: 'flight_update' }),
    ).toEqual({ type: 'flight_update', version: 1 });
    expect(f.service.getProgramUpdateVersion(' news ', 'flight')).toBe(1);
    expect(f.service.getProgramUpdateVersion('main', 'flight')).toBe(0);
    for (const payload of [
      null,
      'legacy',
      [],
      { type: '' },
      {},
      { type: 'unknown' },
    ])
      expect(f.service.broadcastUpdate('news', payload)).toBe(payload);
    expect(f.service.getProgramUpdateVersion('news', 'flight')).toBe(1);
    expect(
      new ProgramService(
        f.prisma,
        f.radio as any,
        f.engine as any,
      ).broadcastUpdate('main', { type: 'unknown' }),
    ).toEqual({ type: 'unknown' });
  });

  it('delivers a renderer snapshot before queued live events and cancels its declared heartbeat on unsubscribe', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const manifest = validateProgramTemplateManifest(
      {
        kind: 'alcantara.program-template',
        contractVersion: 1,
        id: 'test.renderer',
        name: 'Test renderer',
        package: '@test/renderer',
        bundleVersion: '1.0.0',
        schemaVersion: 1,
        entrypoint: 'index.html',
        capabilities: ['scene.configuration'],
        control: {
          protocol: 'alcantara.program.v1',
          transport: 'server-sent-events',
          snapshotPath: 'state',
          eventsPath: 'events',
          runtimeParameters: {
            programId: 'programId',
            apiBaseUrl: 'apiBaseUrl',
          },
          signals: ['program_state_snapshot', 'scene_change', 'heartbeat'],
        },
      },
      new URL('https://cdn.example/manifest.json'),
    );
    f.states.get('news').templateManifest = manifest;
    let release!: (state: any) => void;
    f.prisma.programState.findUnique.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const events: any[] = [];
    const subscription = f.service
      .getEventStream('news')
      .subscribe((event) => events.push(JSON.parse(event.data)));
    f.service.broadcastUpdate('news', {
      type: 'scene_change',
      state: f.states.get('news'),
    });
    f.service.broadcastUpdate('news', { type: 'operator_private' });
    release(f.states.get('news'));
    await jest.advanceTimersByTimeAsync(0);
    expect(events.map((event) => event.type)).toEqual([
      'program_state_snapshot',
      'scene_change',
    ]);
    expect(events[0].schemaVersion).toBe(1);
    await jest.advanceTimersByTimeAsync(15000);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: 'heartbeat', programId: 'news' }),
    );
    subscription.unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports a failed SSE snapshot and stops tracking a disconnected request before its state read settles', async () => {
    const f = fixture();
    const metrics = {
      recordProgramSseConnection: jest.fn(),
      recordProgramSseSnapshot: jest.fn(),
    };
    const service = new ProgramService(
      f.prisma,
      f.radio as any,
      f.engine as any,
      metrics as any,
      f.confidence as any,
    );
    f.prisma.programState.findUnique.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const errors: unknown[] = [];
    service
      .getEventStream('news')
      .subscribe({ error: (error) => errors.push(error) });
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(errors).toEqual([
      expect.objectContaining({ message: 'database unavailable' }),
    ]);
    expect(metrics.recordProgramSseSnapshot).toHaveBeenCalledWith('failure');
    expect(metrics.recordProgramSseConnection.mock.calls).toEqual([[1], [-1]]);
    let reject!: (error: Error) => void;
    f.prisma.programState.findUnique.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const disconnected = service.getEventStream('news').subscribe({
      error: () => {
        throw new Error('disconnected client received an error');
      },
    });
    disconnected.unsubscribe();
    reject(new Error('late failure'));
    for (let step = 0; step < 8; step++) await Promise.resolve();
    expect(metrics.recordProgramSseSnapshot).toHaveBeenCalledTimes(1);
  });
});
