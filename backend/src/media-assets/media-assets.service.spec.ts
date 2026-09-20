import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MediaAssetType } from '@prisma/client';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { MediaAssetsService } from './media-assets.service';

const timestamp = new Date('2026-09-14T12:00:00.000Z');

function imageAsset(id = 'image:1') {
  return {
    id,
    kind: 'IMAGE',
    mediaType: MediaAssetType.IMAGE,
    name: 'Studio wide',
    sourceUrl: 'https://media.test/studio.jpg',
    enabled: true,
    image: {
      id: 1,
      name: 'Studio wide',
      imageUrl: 'https://media.test/studio.jpg',
    },
    audioClip: null,
    backgroundAudio: null,
    song: null,
    songCovers: [],
    transition: null,
    labels: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function songAsset() {
  return {
    ...imageAsset('song:9'),
    kind: 'SONG',
    mediaType: MediaAssetType.AUDIO,
    name: 'Song title',
    sourceUrl: 'https://media.test/song.mp3',
    image: null,
    song: {
      id: 9,
      artist: 'Artist',
      title: 'Song title',
      coverUrl: null,
      durationMs: 180000,
    },
  };
}

function songCoverAsset() {
  return {
    ...imageAsset('song-cover:9'),
    kind: null,
    image: null,
    songCovers: [{ id: 9 }],
  };
}

function buildService() {
  const tx = {
    $queryRaw: jest.fn(),
    mediaAssetLabel: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
    mediaGroupItem: { deleteMany: jest.fn(), createMany: jest.fn() },
    mediaLabel: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    mediaGroup: { update: jest.fn(), delete: jest.fn() },
  };
  const prisma = {
    mediaAsset: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    mediaAssetLabel: { findMany: jest.fn() },
    mediaLabel: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const metrics = { recordMediaLabelAssignment: jest.fn() };
  return {
    service: new MediaAssetsService(prisma as never, metrics as never),
    prisma,
    tx,
    metrics,
  };
}

describe('MediaAssetsService', () => {
  it('queries physical type and capability through the permission-scoped catalog', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.findMany.mockResolvedValue([songAsset()]);
    prisma.mediaAsset.count.mockResolvedValue(1);

    const result = await service.findAll(
      {
        mediaType: 'AUDIO',
        capability: 'SONG',
        page: 1,
        limit: 50,
      },
      { permissions: [ALCANTARA_PERMISSIONS.song.read] },
    );

    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { OR: [{ song: { isNot: null } }] },
            { mediaType: MediaAssetType.AUDIO },
            { song: { isNot: null } },
          ],
        },
      }),
    );
    expect(result.data[0]).toMatchObject({
      id: 'song:9',
      mediaType: 'AUDIO',
      capabilities: ['SONG'],
      song: { id: 9, artist: 'Artist' },
    });
  });

  it('rejects label changes when the operator cannot manage the asset capability', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.findUnique.mockResolvedValue(songAsset());

    await expect(
      service.replaceAssetLabels('song:9', [], {
        permissions: [ALCANTARA_PERMISSIONS.media.manage],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('locks a label before allocating its next position and records the committed assignment', async () => {
    const { service, prisma, tx, metrics } = buildService();
    prisma.mediaAsset.findUnique.mockResolvedValue(imageAsset());
    prisma.mediaAsset.findFirst.mockResolvedValue(imageAsset());
    prisma.mediaLabel.findMany.mockResolvedValue([{ id: 'label:1' }]);
    tx.mediaAssetLabel.findMany.mockResolvedValue([]);
    tx.mediaAssetLabel.aggregate.mockResolvedValue({ _max: { position: 7 } });

    await service.replaceAssetLabels('image:1', ['label:1'], {
      permissions: [ALCANTARA_PERMISSIONS.media.manage],
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe('label:1');
    expect(String(tx.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mediaAssetLabel.aggregate.mock.invocationCallOrder[0],
    );
    expect(tx.mediaAssetLabel.create).toHaveBeenCalledWith({
      data: { assetId: 'image:1', labelId: 'label:1', position: 8 },
    });
    expect(metrics.recordMediaLabelAssignment).toHaveBeenCalledWith('success');
  });

  it('rolls back a failed label assignment and records its failure', async () => {
    const { service, prisma, tx, metrics } = buildService();
    prisma.mediaAsset.findUnique.mockResolvedValue(imageAsset());
    prisma.mediaLabel.findMany.mockResolvedValue([{ id: 'label:1' }]);
    tx.mediaAssetLabel.findMany.mockResolvedValue([]);
    tx.mediaAssetLabel.aggregate.mockResolvedValue({ _max: { position: 7 } });
    tx.mediaAssetLabel.create.mockRejectedValue(new Error('write failed'));

    await expect(
      service.replaceAssetLabels('image:1', ['label:1'], {
        permissions: [ALCANTARA_PERMISSIONS.media.manage],
      }),
    ).rejects.toThrow('write failed');
    expect(metrics.recordMediaLabelAssignment).toHaveBeenCalledWith('failure');
  });

  it('creates standalone background audio without creating an Instant or Song', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.create.mockImplementation(
      ({ data }: { data: { id: string; name: string; sourceUrl: string } }) =>
        Promise.resolve({
          ...imageAsset(data.id),
          kind: null,
          mediaType: MediaAssetType.AUDIO,
          name: data.name,
          sourceUrl: data.sourceUrl,
          image: null,
          backgroundAudio: { assetId: data.id, defaultVolume: 0.6 },
        }),
    );

    const result = await service.createBackgroundAudio(
      {
        name: 'Night bed',
        sourceUrl: 'https://media.test/night.mp3',
        defaultVolume: 0.6,
      },
      { permissions: [ALCANTARA_PERMISSIONS.scene.manage] },
    );

    expect(prisma.mediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.stringMatching(/^media:/),
          mediaType: MediaAssetType.AUDIO,
          name: 'Night bed',
          sourceUrl: 'https://media.test/night.mp3',
          backgroundAudio: { create: { defaultVolume: 0.6 } },
        }),
      }),
    );
    expect(result).toMatchObject({
      mediaType: 'AUDIO',
      capabilities: ['BACKGROUND'],
      instant: null,
      song: null,
    });
  });

  it('exposes a song cover as an image asset with a derived cover capability', async () => {
    const { service, prisma } = buildService();
    prisma.mediaAsset.findMany.mockResolvedValue([songCoverAsset()]);
    prisma.mediaAsset.count.mockResolvedValue(1);

    const result = await service.findAll(
      { mediaType: 'IMAGE', capability: 'COVER', page: 1, limit: 50 },
      { permissions: [ALCANTARA_PERMISSIONS.media.read] },
    );

    expect(result.data[0]).toMatchObject({
      id: 'song-cover:9',
      mediaType: 'IMAGE',
      capabilities: ['COVER'],
      coverForSongIds: [9],
    });
  });

  it('preserves label order when mirroring an imported slideshow label', async () => {
    const { service, prisma, tx } = buildService();
    const first = imageAsset('image:1');
    const second = {
      ...imageAsset('image:2'),
      image: {
        id: 2,
        name: 'Second',
        imageUrl: 'https://media.test/second.jpg',
      },
    };
    prisma.mediaLabel.findUnique.mockResolvedValue({
      id: 'legacy-media-group:4',
    });
    prisma.mediaAssetLabel.findMany.mockResolvedValue([]);
    prisma.mediaAsset.findMany.mockResolvedValue([first, second]);
    tx.mediaAssetLabel.findMany.mockResolvedValue([
      { asset: { image: { id: 2 } } },
      { asset: { image: { id: 1 } } },
    ]);
    jest
      .spyOn(service, 'findLabel')
      .mockResolvedValue({ id: 'legacy-media-group:4' } as never);

    await service.replaceLabelAssets(
      'legacy-media-group:4',
      ['image:2', 'image:1'],
      { permissions: [ALCANTARA_PERMISSIONS.media.manage] },
    );

    expect(tx.$queryRaw.mock.calls[0][1]).toBe('legacy-media-group:4');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mediaAssetLabel.deleteMany.mock.invocationCallOrder[0],
    );

    expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
      data: [
        { labelId: 'legacy-media-group:4', assetId: 'image:2', position: 0 },
        { labelId: 'legacy-media-group:4', assetId: 'image:1', position: 1 },
      ],
    });
    expect(tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
      data: [
        { mediaGroupId: 4, mediaId: 2, position: 0 },
        { mediaGroupId: 4, mediaId: 1, position: 1 },
      ],
    });
  });

  it('resolves only ordered enabled image URLs for public slideshow playback', async () => {
    const { service, prisma } = buildService();
    prisma.mediaLabel.findUnique.mockResolvedValue({
      id: 'label-1',
      name: 'Headlines',
      assets: [
        {
          position: 0,
          asset: { id: 'image:2', name: 'Two', sourceUrl: 'two.jpg' },
        },
        {
          position: 1,
          asset: { id: 'image:1', name: 'One', sourceUrl: 'one.jpg' },
        },
      ],
    });

    await expect(service.resolveLabelImages('label-1')).resolves.toEqual({
      id: 'label-1',
      name: 'Headlines',
      images: [
        { assetId: 'image:2', name: 'Two', imageUrl: 'two.jpg', position: 0 },
        { assetId: 'image:1', name: 'One', imageUrl: 'one.jpg', position: 1 },
      ],
    });
  });

  it('fails closed when a requested label does not exist', async () => {
    const { service, prisma } = buildService();
    prisma.mediaLabel.findUnique.mockResolvedValue(null);
    await expect(service.resolveLabelImages('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
