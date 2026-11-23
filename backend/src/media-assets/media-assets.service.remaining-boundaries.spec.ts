import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaAssetType } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { MediaAssetsService } from './media-assets.service';

describe('media label missing-record and legacy image boundaries', () => {
  const authority = { permissions: ['*'] };
  function fixture() {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      mediaAssetLabel: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      mediaGroupItem: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn(),
      },
    };
    const prisma = {
      mediaAsset: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      mediaLabel: { findUnique: jest.fn(), findMany: jest.fn() },
      mediaAssetLabel: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    return {
      service: new MediaAssetsService(
        prisma as unknown as PrismaService,
        new ManagedMetricsService(),
      ),
      prisma,
      tx,
    };
  }

  it('returns a missing-label error instead of mapping a nonexistent label', async () => {
    const { service, prisma } = fixture();
    prisma.mediaLabel.findUnique.mockResolvedValue(null);
    await expect(
      service.findLabel('missing', authority),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.replaceLabelAssets('missing', [], authority),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a cover-only image without a legacy image row in an imported slideshow label', async () => {
    const { service, prisma } = fixture();
    prisma.mediaAsset.findUnique.mockResolvedValue({
      id: 'song-cover:7',
      mediaType: MediaAssetType.IMAGE,
      kind: null,
      image: null,
    });
    prisma.mediaLabel.findMany.mockResolvedValue([
      { id: 'legacy-media-group:1' },
    ]);
    await expect(
      service.replaceAssetLabels(
        'song-cover:7',
        ['legacy-media-group:1'],
        authority,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('clears an imported slideshow atomically without issuing an empty createMany', async () => {
    const { service, prisma, tx } = fixture();
    const label = {
      id: 'legacy-media-group:1',
      name: 'Slideshow',
      description: null,
      assets: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.mediaLabel.findUnique.mockResolvedValue(label);
    await expect(
      service.replaceLabelAssets(label.id, [], authority),
    ).resolves.toMatchObject({ id: label.id, assetCount: 0, assets: [] });
    expect(tx.mediaAssetLabel.deleteMany).toHaveBeenCalledWith({
      where: { labelId: label.id },
    });
    expect(tx.mediaGroupItem.deleteMany).toHaveBeenCalledWith({
      where: { mediaGroupId: 1 },
    });
    expect(tx.mediaGroupItem.createMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
