import { ProgramService } from './program.service';

describe('ProgramService switcher state', () => {
  const scene = {
    id: 7,
    name: 'Camera one',
    layoutId: 2,
    layout: {
      id: 2,
      name: 'Camera',
      componentType: 'video-stream',
      settings: '{}',
    },
    chyronText: null,
    metadata: null,
  };

  const buildService = (programState: Record<string, unknown>) => {
    let currentState = programState;
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(currentState)),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            currentState = { ...currentState, ...data };
            return Promise.resolve(currentState);
          }),
      },
    };
    const service = new ProgramService(
      prisma as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  it('persists the selected Preview scene before broadcasting it', async () => {
    const programState = {
      id: 1,
      programId: 'main',
      activeSceneId: null,
      stagedSceneId: null,
      fadeToBlack: false,
      scenes: [{ sceneId: scene.id, scene }],
    };
    const { service, prisma } = buildService(programState);

    const result = await service.stageScene(scene.id, 'main');

    expect(prisma.programState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { stagedSceneId: scene.id },
    });
    expect(result).toMatchObject({
      stagedSceneId: scene.id,
      stagedScene: scene,
    });
  });

  it('persists fade-to-black without clearing Program or Preview', async () => {
    const programState = {
      id: 1,
      programId: 'main',
      activeSceneId: scene.id,
      stagedSceneId: scene.id,
      fadeToBlack: false,
      activeScene: scene,
      scenes: [{ sceneId: scene.id, scene }],
    };
    const { service, prisma } = buildService(programState);

    const result = await service.setFadeToBlack(true, 'main');

    expect(prisma.programState.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: { fadeToBlack: true },
      }),
    );
    expect(result).toMatchObject({
      activeSceneId: scene.id,
      stagedSceneId: scene.id,
      fadeToBlack: true,
    });
  });

  it('treats off-air as an explicit Program and FTB clear while preserving Preview', async () => {
    const programState = {
      id: 1,
      programId: 'main',
      activeSceneId: scene.id,
      stagedSceneId: scene.id,
      fadeToBlack: true,
      activeScene: scene,
      scenes: [{ sceneId: scene.id, scene }],
    };
    const { service, prisma } = buildService(programState);

    const result = await service.takeProgramOffAir('main');

    expect(prisma.programState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { activeSceneId: null, fadeToBlack: false },
    });
    expect(result).toMatchObject({
      activeSceneId: null,
      stagedSceneId: scene.id,
      fadeToBlack: false,
    });
  });

  it('applies persisted radio mixer changes to Palazzo', async () => {
    let currentState = {
      programId: 'palazzo',
      type: 'radio',
      songSequence: null,
      audioMixer: null,
    };
    const prisma = {
      programState: {
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(currentState)),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            currentState = { ...currentState, ...data } as typeof currentState;
            return Promise.resolve(currentState);
          }),
      },
    };
    const radioService = {
      updateMixer: jest.fn().mockResolvedValue(undefined),
    };
    const songExecutionEngine = { handleSequenceUpdated: jest.fn() };
    const service = new ProgramService(
      prisma as never,
      radioService as never,
      songExecutionEngine as never,
    );

    await service.updateProgramAudioBus(
      {
        mixerSettings: {
          mainMasterVolume: 1,
          mixerChannels: [
            {
              id: 'song',
              name: 'Song',
              volume: 0.5,
              muted: false,
              solo: false,
            },
            {
              id: 'instants',
              name: 'Instants',
              volume: 0.72,
              muted: true,
              solo: false,
            },
          ],
        },
      },
      'palazzo',
    );

    expect(radioService.updateMixer).toHaveBeenCalledWith(
      'palazzo',
      expect.objectContaining({
        mainVolume: 1,
        songVolume: expect.closeTo(0.177828, 6),
        instantMuted: true,
      }),
    );
  });

  it('prevents deletion of an Instant assigned as a song intro', async () => {
    const prisma = {
      instant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          position: 1,
          songIntro: { songId: 42 },
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new ProgramService(
      prisma as never,
      {} as never,
      {} as never,
    );

    await expect(service.deleteInstant(12)).rejects.toThrow(
      'remove the assignment before deleting it',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('hydrates every SSE subscriber before delivering queued live updates', async () => {
    const { service } = buildService({
      id: 1,
      programId: 'modoitaliano',
      activeSceneId: scene.id,
      stagedSceneId: null,
      fadeToBlack: false,
    });
    let resolveState: ((state: Record<string, unknown>) => void) | undefined;
    const statePromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveState = resolve;
    });
    jest
      .spyOn(service, 'getState')
      .mockImplementation(() => statePromise as never);

    const first: Array<Record<string, unknown>> = [];
    const second: Array<Record<string, unknown>> = [];
    const firstSubscription = service
      .getEventStream('modoitaliano')
      .subscribe((event) => first.push(JSON.parse(event.data)));
    const secondSubscription = service
      .getEventStream('modoitaliano')
      .subscribe((event) => second.push(JSON.parse(event.data)));

    service.broadcastUpdate('modoitaliano', {
      type: 'scene_change',
      programId: 'modoitaliano',
      state: { activeSceneId: 8 },
    });
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    resolveState?.({
      programId: 'modoitaliano',
      activeSceneId: scene.id,
      version: 0,
    });
    await new Promise((resolve) => setImmediate(resolve));

    for (const events of [first, second]) {
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'program_state_snapshot',
        programId: 'modoitaliano',
        state: { activeSceneId: scene.id },
        version: 0,
      });
      expect(events[1]).toMatchObject({
        type: 'scene_change',
        programId: 'modoitaliano',
        version: 1,
      });
    }

    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
  });
});
