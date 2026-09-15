import { MediaAssetKind } from '@prisma/client';
import { MediaAssetsReconciliationService } from './media-assets-reconciliation.service';

function buildService() {
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
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  const metrics = { recordJob: jest.fn() };
  return {
    service: new MediaAssetsReconciliationService(
      prisma as never,
      metrics as never,
    ),
    tx,
    prisma,
    metrics,
  };
}

describe('MediaAssetsReconciliationService', () => {
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

  it('records bounded startup success and failure without serving stale data', async () => {
    const success = buildService();
    await success.service.onApplicationBootstrap();
    expect(success.metrics.recordJob).toHaveBeenCalledWith(
      'media-asset-reconciliation',
      'success',
    );

    const failure = buildService();
    failure.prisma.$transaction.mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    await expect(failure.service.onApplicationBootstrap()).rejects.toThrow(
      'database unavailable',
    );
    expect(failure.metrics.recordJob).toHaveBeenCalledWith(
      'media-asset-reconciliation',
      'failure',
    );
  });
});
