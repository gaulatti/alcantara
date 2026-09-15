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
    const { service, tx } = buildService();

    await expect(service.reconcile()).resolves.toEqual({
      images: 1,
      audioClips: 1,
      songs: 1,
      transitions: 1,
      removedOrphans: 1,
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
    ]);
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
