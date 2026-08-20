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
});
