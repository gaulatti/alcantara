import { Logger } from '@nestjs/common';
import { MediaAssetKind } from '@prisma/client';
import { MediaAssetsReconciliationService } from './media-assets-reconciliation.service';

function buildService(stationTeam?: number) {
  const tx = {
    media: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 1, name: 'Still', imageUrl: 'https://media.test/still.jpg' },
        ]),
      update: jest.fn(),
    },
    instant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 2,
          name: 'Bumper',
          audioUrl: 'https://media.test/bumper.mp3',
          volume: 0.7,
          enabled: true,
        },
      ]),
      update: jest.fn(),
    },
    song: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 3,
          artist: 'Artist',
          title: 'Song',
          audioUrl: 'https://media.test/song.mp3',
          enabled: true,
        },
      ]),
      update: jest.fn(),
    },
    stinger: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 4,
          name: 'Wipe',
          videoUrl: 'https://media.test/wipe.webm',
          enabled: false,
        },
      ]),
      update: jest.fn(),
    },
    scene: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { metadata: JSON.stringify({ sceneInstant: { instantId: 2 } }) },
          { metadata: '{malformed' },
        ]),
    },
    backgroundAudioCapability: { upsert: jest.fn() },
    mediaGroup: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 9,
            name: 'Morning slideshow',
            description: null,
            mediaItems: [
              {
                position: 0,
                media: { assetId: 'image:1' },
              },
            ],
          },
        ])
        .mockResolvedValueOnce([{ id: 9 }]),
    },
    mediaLabel: {
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    mediaAssetLabel: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    mediaAsset: {
      upsert: jest.fn(),
      deleteMany: jest
        .fn()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  const metrics = { recordJob: jest.fn() };
  return {
    service: new MediaAssetsReconciliationService(
      prisma as never,
      metrics as never,
      undefined,
      stationTeam === undefined
        ? undefined
        : ({ teamId: stationTeam } as never),
    ),
    tx,
    prisma,
    metrics,
  };
}

describe('MediaAssetsReconciliationService', () => {
  it.each([
    [7, { teamId: 7 }],
    [0, {}],
    [undefined, {}],
  ])(
    "creates a missing group label with the station's team (team %s)",
    async (stationTeam, owned) => {
      const { service, tx } = buildService(stationTeam);

      await service.reconcile();

      const [{ create, update }] = tx.mediaLabel.upsert.mock.calls[0];
      expect(create).toEqual({
        id: 'legacy-media-group:9',
        name: 'Morning slideshow',
        description: null,
        ...owned,
      });
      // An existing label keeps the team it has.
      expect(update).not.toHaveProperty('teamId');
    },
  );

  it('repairs every kind and removes only kind-matched orphan rows', async () => {
    const { service, tx, prisma } = buildService();

    await expect(service.reconcile()).resolves.toEqual({
      images: 1,
      audioClips: 1,
      songs: 1,
      transitions: 1,
      backgroundAudio: 1,
      labels: 1,
      removedOrphans: 1,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 60_000,
      isolationLevel: 'RepeatableRead',
    });

    expect(tx.mediaAsset.upsert).toHaveBeenCalledTimes(4);
    expect(tx.mediaAsset.deleteMany.mock.calls).toEqual([
      [
        {
          where: { kind: MediaAssetKind.IMAGE, image: { is: null } },
        },
      ],
      [
        {
          where: {
            kind: MediaAssetKind.AUDIO_CLIP,
            audioClip: { is: null },
          },
        },
      ],
      [
        {
          where: { kind: MediaAssetKind.SONG, song: { is: null } },
        },
      ],
      [
        {
          where: {
            kind: MediaAssetKind.TRANSITION,
            transition: { is: null },
          },
        },
      ],
      [
        {
          where: {
            id: { startsWith: 'song-cover:' },
            songCovers: { none: {} },
          },
        },
      ],
    ]);
    expect(tx.backgroundAudioCapability.upsert).toHaveBeenCalledWith({
      where: { assetId: 'audio-clip:2' },
      create: { assetId: 'audio-clip:2', defaultVolume: 0.7 },
      update: { defaultVolume: 0.7 },
    });
    expect(tx.mediaLabel.upsert).toHaveBeenCalledWith({
      where: { id: 'legacy-media-group:9' },
      create: {
        id: 'legacy-media-group:9',
        name: 'Morning slideshow',
        description: null,
      },
      update: {
        name: 'Morning slideshow',
        description: null,
      },
    });
    expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
      data: [
        {
          labelId: 'legacy-media-group:9',
          assetId: 'image:1',
          position: 0,
        },
      ],
    });
    expect(tx.mediaLabel.deleteMany).toHaveBeenLastCalledWith({
      where: {
        id: {
          startsWith: 'legacy-media-group:',
          notIn: ['legacy-media-group:9'],
        },
      },
    });
  });

  // The port opens only once every start-up hook has returned (alcantara#873).
  it('returns from start-up before the pass finishes, and counts its success', async () => {
    const { service, prisma, metrics } = buildService();
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    let release = () => {};
    const transaction = prisma.$transaction.getMockImplementation()!;
    prisma.$transaction.mockImplementationOnce(async (operation) => {
      await new Promise<void>((resolve) => (release = resolve));
      return transaction(operation);
    });

    expect(service.onApplicationBootstrap()).toBeUndefined();
    expect(metrics.recordJob).not.toHaveBeenCalled();
    release();
    await service.onModuleDestroy();

    expect(logged).toHaveBeenCalledWith('Media asset teams filled: 0');
    expect(metrics.recordJob).toHaveBeenCalledWith(
      'media-asset-reconciliation',
      'success',
    );
    logged.mockRestore();
  });

  it('logs and counts a failed pass without failing start-up', async () => {
    const { service, prisma, metrics } = buildService();
    const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    prisma.$transaction.mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    service.onApplicationBootstrap();
    await service.onModuleDestroy();

    expect(failed).toHaveBeenCalledWith(
      'Media asset reconciliation failed',
      expect.stringContaining('database unavailable'),
    );
    expect(metrics.recordJob).toHaveBeenCalledWith(
      'media-asset-reconciliation',
      'failure',
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    failed.mockRestore();
  });

  it('logs a failure that is not an Error as text', async () => {
    const { service, prisma } = buildService();
    const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    prisma.$transaction.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'connection reset';
    });

    service.onApplicationBootstrap();
    await service.onModuleDestroy();

    expect(failed).toHaveBeenCalledWith(
      'Media asset reconciliation failed',
      'connection reset',
    );
    failed.mockRestore();
  });

  it('runs the pass again after a concurrent write, at most three times', async () => {
    const conflict = Object.assign(new Error('write conflict'), {
      code: 'P2034',
    });
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const once = buildService();
    once.prisma.$transaction.mockImplementationOnce(() => {
      throw conflict;
    });
    once.service.onApplicationBootstrap();
    await once.service.onModuleDestroy();
    expect(once.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(once.metrics.recordJob).toHaveBeenCalledWith(
      'media-asset-reconciliation',
      'success',
    );

    const always = buildService();
    always.prisma.$transaction.mockImplementation(() => {
      throw conflict;
    });
    always.service.onApplicationBootstrap();
    await always.service.onModuleDestroy();
    expect(always.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(always.metrics.recordJob).toHaveBeenCalledWith(
      'media-asset-reconciliation',
      'failure',
    );
    warned.mockRestore();
    failed.mockRestore();
  });

  it('grants no background audio capability for blank, invalid or unresolvable scene references', async () => {
    const { service, tx } = buildService();
    tx.scene.findMany.mockResolvedValue([
      { metadata: null },
      { metadata: '   ' },
      { metadata: JSON.stringify({ sceneInstant: { instantId: 0 } }) },
      { metadata: JSON.stringify({ sceneInstant: { instantId: 2.5 } }) },
      { metadata: JSON.stringify({ sceneInstant: { instantId: 999 } }) },
    ]);

    const result = await service.reconcile();

    expect(result.backgroundAudio).toBe(0);
    expect(tx.backgroundAudioCapability.upsert).not.toHaveBeenCalled();
  });
});
