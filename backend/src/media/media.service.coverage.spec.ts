import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaService } from './media.service';

function buildService() {
  const media = { id: 8, assetId: 'image:8', name: 'Still', imageUrl: 'u' };
  const group = { id: 1, name: 'G', description: null, mediaItems: [] };
  const tx = {
    media: {
      create: jest.fn().mockResolvedValue({ ...media, assetId: null }),
      update: jest.fn().mockResolvedValue(media),
      findUniqueOrThrow: jest.fn().mockResolvedValue(media),
      delete: jest.fn(),
    },
    mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaGroup: { findUniqueOrThrow: jest.fn().mockResolvedValue(group) },
    mediaGroupItem: {
      findMany: jest.fn().mockResolvedValue([{ id: 11 }, { id: 12 }]),
      update: jest.fn(),
    },
    mediaLabel: { upsert: jest.fn() },
    mediaAssetLabel: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = {
    media: {
      findUnique: jest.fn().mockResolvedValue(media),
      findMany: jest.fn().mockResolvedValue([media]),
      count: jest.fn().mockResolvedValue(101),
    },
    mediaGroupItem: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  return { service: new MediaService(prisma as never), prisma, tx, media };
}

describe('MediaService (coverage)', () => {
  describe('findAll', () => {
    it('applies a trimmed case-insensitive search, valid sort and pagination', async () => {
      const { service, prisma, media } = buildService();
      await expect(
        service.findAll({
          search: '  still ',
          sortBy: 'name',
          sortOrder: 'asc',
          page: 3,
          limit: 20,
        }),
      ).resolves.toEqual({
        data: [media],
        meta: { total: 101, page: 3, limit: 20, totalPages: 6 },
      });
      const where = { name: { contains: 'still', mode: 'insensitive' } };
      expect(prisma.media.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ name: 'asc' }, { id: 'desc' }],
        skip: 40,
        take: 20,
      });
      expect(prisma.media.count).toHaveBeenCalledWith({ where });
    });

    it('ignores blank searches and falls back to updatedAt desc for unknown sort', async () => {
      const { service, prisma } = buildService();
      await service.findAll({
        search: '   ',
        sortBy: 'bogus',
        sortOrder: 'sideways',
        page: 1,
        limit: 50,
      });
      expect(prisma.media.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 50,
      });
    });

    it('works with no search, sort or order supplied', async () => {
      const { service, prisma } = buildService();
      await service.findAll({ page: 1, limit: 10 });
      expect(prisma.media.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 10,
      });
    });
  });

  describe('findOne', () => {
    it('returns the media or throws NotFound', async () => {
      const { service, prisma, media } = buildService();
      await expect(service.findOne(8)).resolves.toBe(media);
      prisma.media.findUnique.mockResolvedValueOnce(null);
      await expect(service.findOne(9)).rejects.toThrow(
        new NotFoundException('Media not found'),
      );
    });
  });

  describe('create', () => {
    it.each([
      [{ imageUrl: 'u' }, 'name is required'],
      [{ name: '   ', imageUrl: 'u' }, 'name is required'],
      [{ name: 5 as unknown as string, imageUrl: 'u' }, 'name is required'],
      [{ name: 'n' }, 'imageUrl is required'],
    ])('rejects %j', async (input, message) => {
      const { service, prisma } = buildService();
      await expect(service.create(input)).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws NotFound for unknown media', async () => {
      const { service, prisma } = buildService();
      prisma.media.findUnique.mockResolvedValueOnce(null);
      await expect(service.update(1, { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the current media when nothing changes', async () => {
      const { service, prisma, media } = buildService();
      await expect(service.update(8, {})).resolves.toBe(media);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('updates name only and imageUrl only inside a transaction', async () => {
      const { service, tx, media } = buildService();
      await expect(service.update(8, { name: ' New ' })).resolves.toBe(media);
      expect(tx.media.update).toHaveBeenLastCalledWith({
        where: { id: 8 },
        data: { name: 'New' },
      });
      await service.update(8, { imageUrl: ' http://x ' });
      expect(tx.media.update).toHaveBeenLastCalledWith({
        where: { id: 8 },
        data: { imageUrl: 'http://x' },
      });
      await service.update(8, { name: 'A', imageUrl: 'B' });
      expect(tx.media.update).toHaveBeenLastCalledWith({
        where: { id: 8 },
        data: { name: 'A', imageUrl: 'B' },
      });
      expect(tx.mediaAsset.upsert).toHaveBeenCalledTimes(3);
    });

    it('rejects blank fields', async () => {
      const { service } = buildService();
      await expect(service.update(8, { name: ' ' })).rejects.toThrow(
        new BadRequestException('name is required'),
      );
      await expect(service.update(8, { imageUrl: '' })).rejects.toThrow(
        new BadRequestException('imageUrl is required'),
      );
    });
  });

  describe('remove', () => {
    it('throws NotFound for unknown media', async () => {
      const { service, prisma } = buildService();
      prisma.media.findUnique.mockResolvedValueOnce(null);
      await expect(service.remove(1)).rejects.toThrow(NotFoundException);
    });

    it('rebalances and relabels every impacted group once', async () => {
      const { service, prisma, tx } = buildService();
      prisma.mediaGroupItem.findMany.mockResolvedValueOnce([
        { mediaGroupId: 1 },
        { mediaGroupId: 1 },
        { mediaGroupId: 2 },
      ]);

      await expect(service.remove(8)).resolves.toEqual({ deletedMediaId: 8 });

      expect(tx.mediaAsset.deleteMany).toHaveBeenCalledWith({
        where: { id: 'image:8' },
      });
      expect(tx.mediaGroup.findUniqueOrThrow).toHaveBeenCalledTimes(2);
      // each group: two items, two passes (offset then final positions)
      const updates = tx.mediaGroupItem.update.mock.calls.map((c) => c[0]);
      expect(updates.slice(0, 4)).toEqual([
        { where: { id: 11 }, data: { position: 100000 } },
        { where: { id: 12 }, data: { position: 100001 } },
        { where: { id: 11 }, data: { position: 0 } },
        { where: { id: 12 }, data: { position: 1 } },
      ]);
      expect(updates).toHaveLength(8);
      expect(tx.mediaLabel.upsert).toHaveBeenCalledTimes(2);
    });
  });
});
