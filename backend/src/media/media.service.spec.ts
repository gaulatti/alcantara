import { MediaAssetKind } from '@prisma/client';
import { MediaService } from './media.service';

function buildService() {
  const media = {
    id: 8,
    assetId: 'image:8',
    name: 'Weather still',
    imageUrl: 'https://media.test/weather.jpg',
  };
  const tx = {
    media: {
      create: jest.fn().mockResolvedValue({ ...media, assetId: null }),
      update: jest.fn().mockResolvedValue(media),
      findUniqueOrThrow: jest.fn().mockResolvedValue(media),
      delete: jest.fn(),
    },
    mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaGroupItem: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    media: { findUnique: jest.fn().mockResolvedValue(media) },
    mediaGroupItem: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  return { service: new MediaService(prisma as never), prisma, tx, media };
}

describe('MediaService canonical asset writes', () => {
  it('creates an image and its common asset identity atomically', async () => {
    const { service, prisma, tx, media } = buildService();

    await expect(
      service.create({
        name: ' Weather still ',
        imageUrl: ' https://media.test/weather.jpg ',
      }),
    ).resolves.toEqual(media);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.mediaAsset.upsert).toHaveBeenCalledWith({
      where: { id: 'image:8' },
      create: {
        id: 'image:8',
        kind: MediaAssetKind.IMAGE,
        name: 'Weather still',
        sourceUrl: 'https://media.test/weather.jpg',
        enabled: true,
      },
      update: {
        kind: MediaAssetKind.IMAGE,
        name: 'Weather still',
        sourceUrl: 'https://media.test/weather.jpg',
        enabled: true,
      },
    });
  });

  it('deletes the image and only its matching registry row atomically', async () => {
    const { service, tx } = buildService();

    await expect(service.remove(8)).resolves.toEqual({ deletedMediaId: 8 });

    expect(tx.media.delete).toHaveBeenCalledWith({ where: { id: 8 } });
    expect(tx.mediaAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: 'image:8' },
    });
  });
});
