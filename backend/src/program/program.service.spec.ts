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

  it('stores and fans out authoritative Palazzo playback, stop, and meter feedback', async () => {
    const { service } = buildService({
      id: 1,
      programId: 'radio-1',
      type: 'radio',
      activeSceneId: null,
      stagedSceneId: null,
      fadeToBlack: false,
      scenes: [],
    });
    const events: Array<Record<string, unknown>> = [];
    service.addEventListener((event) => events.push(event.data));
    const internal = service as unknown as {
      handleEngineEvent: (event: Record<string, unknown>) => void;
    };

    internal.handleEngineEvent({
      type: 'playback_update',
      programId: 'radio-1',
      playback: {
        token: 'song-1:https://example.test/song.mp3',
        audioUrl: 'https://example.test/song.mp3',
        title: 'Song one',
        artist: 'Artist one',
        coverUrl: 'https://example.test/cover.jpg',
        durationMs: 60_000,
        isPlaying: true,
        positionMs: 12_000,
        progress: 0.2,
        startedAt: '2026-09-11T12:00:00.000Z',
        updatedAt: '2026-09-11T12:00:12.000Z',
        telemetryStale: true,
        introStatus: 'none',
        introFailureReason: null,
      },
    });
    internal.handleEngineEvent({
      type: 'audio_levels',
      programId: 'radio-1',
      levels: {
        song: { rms: 0.2, peak: 0.4 },
        intro: { rms: 0.3, peak: 0.5 },
        instant: { rms: 0.1, peak: 0.25 },
        output: { rms: 0.35, peak: 0.6 },
      },
      sampledAt: '2026-09-11T12:00:13.000Z',
    });

    expect(await service.getProgramSongPlayback('radio-1')).toMatchObject({
      title: 'Song one',
      currentTimeMs: 12_000,
      isPlaying: true,
      telemetryStale: true,
    });
    expect(await service.getProgramAudioMeter('radio-1')).toMatchObject({
      song: { vu: 0.3, peak: 0.5, peakHold: 0.5 },
      instants: { vu: 0.1, peak: 0.25, peakHold: 0.25 },
      main: { vu: 0.35, peak: 0.6, peakHold: 0.6 },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'song_playback_update' }),
        expect.objectContaining({ type: 'palazzo_audio_levels' }),
        expect.objectContaining({ type: 'audio_meter_update' }),
      ]),
    );

    internal.handleEngineEvent({
      type: 'song_off_air',
      programId: 'radio-1',
      triggeredAt: '2026-09-11T12:01:00.000Z',
    });

    expect(await service.getProgramSongPlayback('radio-1')).toMatchObject({
      isPlaying: false,
      updatedAt: '2026-09-11T12:01:00.000Z',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'song_off_air',
      playback: { isPlaying: false },
    });
  });

  it('removes visual configuration when a show becomes radio-only', async () => {
    const { service, prisma } = buildService({
      id: 1,
      programId: 'show-1',
      type: 'tv',
      templateUrl: 'https://example.test/template.json',
      activeSceneId: scene.id,
      stagedSceneId: scene.id,
      fadeToBlack: true,
      scenes: [{ sceneId: scene.id, scene }],
      mediaGroups: [{ mediaGroupId: 3 }],
      stingers: [{ stingerId: 4 }],
    });

    await service.renameProgram('show-1', 'show-1', 'radio', null);

    expect(prisma.programState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        type: 'radio',
        templateUrl: null,
        templateManifest: null,
        templateVerifiedAt: null,
        activeSceneId: null,
        stagedSceneId: null,
        fadeToBlack: false,
        scenes: { deleteMany: {} },
        mediaGroups: { deleteMany: {} },
        stingers: { deleteMany: {} },
      }),
    });
  });

  it('rejects visual assignments for radio-only shows', async () => {
    const { service } = buildService({
      id: 1,
      programId: 'radio-1',
      type: 'radio',
      scenes: [],
    });

    await expect(service.addSceneToProgram(scene.id, 'radio-1')).rejects.toThrow(
      'Radio programs do not support scenes',
    );
    await expect(
      service.addMediaGroupToProgram(3, 'radio-1'),
    ).rejects.toThrow('Radio programs do not support media groups');
    await expect(
      service.addStingerToProgram(4, 'radio-1'),
    ).rejects.toThrow('Radio programs do not support stingers');
    await expect(service.stageScene(null, 'radio-1')).rejects.toThrow(
      'Radio programs do not support scenes',
    );
    await expect(service.activateScene(scene.id, 'radio-1')).rejects.toThrow(
      'Radio programs do not support scenes',
    );
    await expect(service.setFadeToBlack(true, 'radio-1')).rejects.toThrow(
      'Radio programs do not support fade to black',
    );
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

  it('projects registered template snapshots and forwards only declared signals', async () => {
    const { service } = buildService({
      id: 1,
      programId: 'fifthbell',
      activeSceneId: scene.id,
      stagedSceneId: null,
      fadeToBlack: false,
    });
    const templateManifest = {
      kind: 'alcantara.program-template',
      contractVersion: 1,
      id: 'fifthbell.live-program',
      name: 'Fifthbell Live Program',
      package: '@fifthbell/brokaw',
      bundleVersion: '0.1.65',
      schemaVersion: 1,
      entrypoint: 'index.html',
      entrypointUrl:
        'https://cdn.fifthbell.com/html/program-releases/0.1.65/index.html',
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
        signals: ['program_state_snapshot', 'scene_change'],
      },
    };
    jest.spyOn(service, 'getState').mockResolvedValue({
      id: 1,
      programId: 'fifthbell',
      activeSceneId: scene.id,
      activeScene: scene,
      stagedSceneId: null,
      stagedScene: null,
      fadeToBlack: false,
      updatedAt: '2026-09-08T18:00:00.000Z',
      version: 0,
      templateManifest,
      operatorQueue: [{ secret: true }],
    } as never);

    const events: Array<Record<string, unknown>> = [];
    const subscription = service
      .getEventStream('fifthbell')
      .subscribe((event) => events.push(JSON.parse(event.data)));
    await new Promise((resolve) => setImmediate(resolve));

    service.broadcastUpdate('fifthbell', {
      type: 'operator_snapshot',
      secret: true,
    });
    service.broadcastUpdate('fifthbell', {
      type: 'scene_change',
      programId: 'fifthbell',
      state: {
        id: 1,
        programId: 'fifthbell',
        activeSceneId: scene.id,
        activeScene: scene,
        stagedSceneId: null,
        stagedScene: null,
        fadeToBlack: false,
        updatedAt: '2026-09-08T18:01:00.000Z',
        secret: true,
      },
      secret: true,
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'program_state_snapshot',
      schemaVersion: 1,
      state: { programId: 'fifthbell', activeSceneId: scene.id },
    });
    expect(events[0].state).not.toHaveProperty('operatorQueue');
    expect(events[1]).toMatchObject({
      type: 'scene_change',
      schemaVersion: 1,
      state: { programId: 'fifthbell', activeSceneId: scene.id },
    });
    expect(events[1]).not.toHaveProperty('secret');
    expect(events[1].state).not.toHaveProperty('secret');

    subscription.unsubscribe();
  });
});
