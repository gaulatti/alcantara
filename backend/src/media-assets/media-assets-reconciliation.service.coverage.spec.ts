import { MediaAssetsReconciliationService } from './media-assets-reconciliation.service';

function buildService(scenes: Array<{ metadata: string | null }>) {
  const tx = {
    media: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    instant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 2,
          name: 'Bed',
          audioUrl: 'a',
          volume: 0.5,
          enabled: true,
          assetId: 'audio-clip:2',
        },
        {
          id: 3,
          name: 'Bed 3',
          audioUrl: 'b',
          volume: 0.9,
          enabled: true,
          assetId: 'audio-clip:3',
        },
      ]),
      update: jest.fn(),
    },
    song: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    stinger: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    scene: { findMany: jest.fn().mockResolvedValue(scenes) },
    backgroundAudioCapability: { upsert: jest.fn() },
    mediaGroup: { findMany: jest.fn().mockResolvedValue([]) },
    mediaLabel: {
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    mediaAssetLabel: { deleteMany: jest.fn(), createMany: jest.fn() },
    mediaAsset: {
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
  const prisma = {
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  const metrics = { recordJob: jest.fn() };
  const service = new MediaAssetsReconciliationService(
    prisma as never,
    metrics as never,
  );
  return { service, tx };
}

const scene = (instantId: unknown) => ({
  metadata: JSON.stringify({ sceneInstant: { instantId } }),
});

describe('MediaAssetsReconciliationService scene metadata (coverage)', () => {
  it('only registers background audio for valid, known, de-duplicated instant ids', async () => {
    const { service, tx } = buildService([
      { metadata: null },
      { metadata: '   ' },
      { metadata: 'not json' },
      { metadata: '{}' },
      { metadata: JSON.stringify({ sceneInstant: {} }) },
      scene(0),
      scene(-4),
      scene(1.5),
      scene('abc'),
      scene(99),
      scene('3'),
      scene(3),
    ]);

    await expect(service.reconcile()).resolves.toEqual({
      images: 0,
      audioClips: 2,
      songs: 0,
      transitions: 0,
      backgroundAudio: 1,
      labels: 0,
      // five asset deleteMany calls returning 3 each plus one label call returning 2
      removedOrphans: 17,
    });

    expect(tx.backgroundAudioCapability.upsert).toHaveBeenCalledTimes(1);
    expect(tx.backgroundAudioCapability.upsert).toHaveBeenCalledWith({
      where: { assetId: 'audio-clip:3' },
      create: { assetId: 'audio-clip:3', defaultVolume: 0.9 },
      update: { defaultVolume: 0.9 },
    });
  });

  it('reports zero background audio when no scene references an instant', async () => {
    const { service, tx } = buildService([]);
    const result = await service.reconcile();
    expect(result.backgroundAudio).toBe(0);
    expect(tx.backgroundAudioCapability.upsert).not.toHaveBeenCalled();
  });
});

describe('MediaAssetsReconciliationService metadata (coverage)', () => {
  it('records Object paramtypes when dependency imports are unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./media-assets-reconciliation.service');
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          mod.MediaAssetsReconciliationService,
        ),
      ).toEqual([Object, Object]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('../observability/managed-metrics.service');
  });
});
