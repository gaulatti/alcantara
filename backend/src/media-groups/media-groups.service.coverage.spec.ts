import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaGroupsService } from './media-groups.service';

const now = new Date('2026-01-01T00:00:00Z');

function hydrated(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Group',
    description: null,
    createdAt: now,
    updatedAt: now,
    mediaItems: [
      {
        id: 10,
        mediaGroupId: 1,
        mediaId: 5,
        position: 0,
        media: { id: 5, assetId: 'image:5', name: 'm', imageUrl: 'u' },
      },
    ],
    ...overrides,
  };
}

function buildService() {
  const tx = {
    mediaGroup: {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(hydrated()),
    },
    mediaGroupItem: { createMany: jest.fn(), deleteMany: jest.fn() },
    mediaLabel: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaAssetLabel: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = {
    mediaGroup: {
      findMany: jest.fn().mockResolvedValue([hydrated()]),
      count: jest.fn().mockResolvedValue(41),
      findUnique: jest.fn().mockResolvedValue(hydrated()),
    },
    media: {
      findMany: jest.fn().mockResolvedValue([{ id: 5 }, { id: 6 }]),
    },
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ) as jest.Mock,
  };
  return { service: new MediaGroupsService(prisma as never), prisma, tx };
}

const mapped = {
  id: 1,
  name: 'Group',
  description: null,
  createdAt: now,
  updatedAt: now,
  items: [
    {
      id: 10,
      mediaGroupId: 1,
      mediaId: 5,
      position: 0,
      media: { id: 5, assetId: 'image:5', name: 'm', imageUrl: 'u' },
    },
  ],
};

const includeItems = {
  mediaItems: { include: { media: true }, orderBy: { position: 'asc' } },
};

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('MediaGroupsService (coverage)', () => {
  describe('findAll', () => {
    it('searches, sorts and paginates', async () => {
      const { service, prisma } = buildService();
      await expect(
        service.findAll({
          search: ' news ',
          sortBy: 'createdAt',
          sortOrder: 'asc',
          page: 3,
          limit: 20,
        }),
      ).resolves.toEqual({
        data: [mapped],
        meta: { total: 41, page: 3, limit: 20, totalPages: 3 },
      });
      const where = { name: { contains: 'news', mode: 'insensitive' } };
      expect(prisma.mediaGroup.findMany).toHaveBeenCalledWith({
        where,
        include: includeItems,
        orderBy: [{ createdAt: 'asc' }, { id: 'desc' }],
        skip: 40,
        take: 20,
      });
      expect(prisma.mediaGroup.count).toHaveBeenCalledWith({ where });
    });

    it('returns all rows without skip/take when limit is 0', async () => {
      const { service, prisma } = buildService();
      const result = await service.findAll({
        search: '   ',
        sortBy: 'nope',
        sortOrder: 'x',
        page: 5,
        limit: 0,
      });
      expect(prisma.mediaGroup.findMany).toHaveBeenCalledWith({
        where: {},
        include: includeItems,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      expect(result.meta).toEqual({
        total: 41,
        page: 5,
        limit: 0,
        totalPages: Infinity,
      });
    });

    it('works with only required params', async () => {
      const { service, prisma } = buildService();
      await service.findAll({ page: 1, limit: 10 });
      expect(prisma.mediaGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, skip: 0, take: 10 }),
      );
    });
  });

  describe('findOne', () => {
    it('maps a found group and throws NotFound otherwise', async () => {
      const { service, prisma } = buildService();
      await expect(service.findOne(1)).resolves.toEqual(mapped);
      expect(prisma.mediaGroup.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        include: includeItems,
      });
      prisma.mediaGroup.findUnique.mockResolvedValueOnce(null);
      await expect(service.findOne(2)).rejects.toThrow(
        new NotFoundException('Media group not found'),
      );
    });
  });

  describe('create', () => {
    it('creates a group with deduplicated, ordered media and syncs its label', async () => {
      const { service, prisma, tx } = buildService();
      await expect(
        service.create({
          name: ' Group ',
          description: ' d ',
          mediaIds: [5, '6' as unknown as number, 5],
        }),
      ).resolves.toEqual(mapped);

      expect(prisma.media.findMany).toHaveBeenCalledWith({
        where: { id: { in: [5, 6] } },
        select: { id: true },
      });
      expect(tx.mediaGroup.create).toHaveBeenCalledWith({
        data: { name: 'Group', description: 'd' },
      });
      expect(tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
        data: [
          { mediaGroupId: 1, mediaId: 5, position: 0 },
          { mediaGroupId: 1, mediaId: 6, position: 1 },
        ],
      });
      expect(tx.mediaLabel.upsert).toHaveBeenCalledTimes(1);
      expect(tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
        data: [
          { labelId: 'legacy-media-group:1', assetId: 'image:5', position: 0 },
        ],
      });
    });

    it('creates an empty group when mediaIds and description are omitted or null', async () => {
      const { service, prisma, tx } = buildService();
      await service.create({ name: 'g' });
      await service.create({ name: 'g', mediaIds: null as never });
      await service.create({ name: 'g', mediaIds: [], description: '  ' });
      await service.create({ name: 'g', description: null });
      expect(prisma.media.findMany).not.toHaveBeenCalled();
      expect(tx.mediaGroupItem.createMany).not.toHaveBeenCalled();
      for (const call of tx.mediaGroup.create.mock.calls) {
        expect(call[0]).toEqual({ data: { name: 'g', description: null } });
      }
    });

    it.each([
      [{}, 'name is required'],
      [{ name: '  ' }, 'name is required'],
      [{ name: 4 as never }, 'name is required'],
      [{ name: 'g', mediaIds: 'x' as never }, 'mediaIds must be an array'],
      [
        { name: 'g', mediaIds: [0] },
        'mediaIds must contain positive integer ids',
      ],
      [
        { name: 'g', mediaIds: [-1] },
        'mediaIds must contain positive integer ids',
      ],
      [
        { name: 'g', mediaIds: [1.5] },
        'mediaIds must contain positive integer ids',
      ],
      [
        { name: 'g', mediaIds: ['abc' as never] },
        'mediaIds must contain positive integer ids',
      ],
      [
        { name: 'g', mediaIds: [Infinity] },
        'mediaIds must contain positive integer ids',
      ],
      [{ name: 'g', mediaIds: [5, 9, 8] }, 'Unknown media ids: 9, 8'],
    ])('rejects %j', async (input, message) => {
      const { service, prisma } = buildService();
      await expect(service.create(input)).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps unique violations to BadRequest and rethrows other errors', async () => {
      const { service, prisma } = buildService();
      prisma.$transaction.mockRejectedValueOnce(p2002());
      await expect(service.create({ name: 'g' })).rejects.toThrow(
        new BadRequestException('Media group name already exists'),
      );

      const other = new Prisma.PrismaClientKnownRequestError('x', {
        code: 'P2003',
        clientVersion: 'test',
      });
      prisma.$transaction.mockRejectedValueOnce(other);
      await expect(service.create({ name: 'g' })).rejects.toBe(other);

      const plain = new Error('boom');
      prisma.$transaction.mockRejectedValueOnce(plain);
      await expect(service.create({ name: 'g' })).rejects.toBe(plain);
    });

    it('fails when the created group cannot be reloaded', async () => {
      const { service, tx } = buildService();
      tx.mediaGroup.findUnique.mockResolvedValueOnce(null);
      await expect(service.create({ name: 'g' })).rejects.toThrow(
        new NotFoundException('Media group not found after create'),
      );
    });

    it('fails when the transaction yields no group', async () => {
      const { service, prisma } = buildService();
      prisma.$transaction.mockResolvedValueOnce(null);
      await expect(service.create({ name: 'g' })).rejects.toThrow(
        new NotFoundException('Media group not found after create'),
      );
    });
  });

  describe('update', () => {
    it('throws NotFound for unknown groups', async () => {
      const { service, prisma } = buildService();
      prisma.mediaGroup.findUnique.mockResolvedValueOnce(null);
      await expect(service.update(9, { name: 'x' })).rejects.toThrow(
        new NotFoundException('Media group not found'),
      );
      expect(prisma.mediaGroup.findUnique).toHaveBeenCalledWith({
        where: { id: 9 },
        select: { id: true },
      });
    });

    it('updates scalar fields and replaces the media list', async () => {
      const { service, tx } = buildService();
      await expect(
        service.update(1, {
          name: ' New ',
          description: '  ',
          mediaIds: [6, 5],
        }),
      ).resolves.toEqual(mapped);
      expect(tx.mediaGroup.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { name: 'New', description: null },
      });
      expect(tx.mediaGroupItem.deleteMany).toHaveBeenCalledWith({
        where: { mediaGroupId: 1 },
      });
      expect(tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
        data: [
          { mediaGroupId: 1, mediaId: 6, position: 0 },
          { mediaGroupId: 1, mediaId: 5, position: 1 },
        ],
      });
    });

    it('clears the media list when mediaIds is an empty array', async () => {
      const { service, tx, prisma } = buildService();
      await service.update(1, { mediaIds: [] });
      expect(tx.mediaGroup.update).not.toHaveBeenCalled();
      expect(tx.mediaGroupItem.deleteMany).toHaveBeenCalled();
      expect(tx.mediaGroupItem.createMany).not.toHaveBeenCalled();
      expect(prisma.media.findMany).not.toHaveBeenCalled();
      expect(tx.mediaLabel.upsert).toHaveBeenCalled();
    });

    it('updates only the name or only the description', async () => {
      const { service, tx } = buildService();
      await service.update(1, { name: 'n' });
      await service.update(1, { description: 'd' });
      expect(tx.mediaGroup.update.mock.calls.map((c) => c[0].data)).toEqual([
        { name: 'n' },
        { description: 'd' },
      ]);
      expect(tx.mediaGroupItem.deleteMany).not.toHaveBeenCalled();
    });

    it('does not touch scalars or items for an empty patch', async () => {
      const { service, tx } = buildService();
      await expect(service.update(1, {})).resolves.toEqual(mapped);
      expect(tx.mediaGroup.update).not.toHaveBeenCalled();
      expect(tx.mediaGroupItem.deleteMany).not.toHaveBeenCalled();
    });

    it.each([
      [{ name: ' ' }, 'name is required'],
      [{ mediaIds: undefined }, 'mediaIds must be an array'],
      [{ mediaIds: null as never }, 'mediaIds must be an array'],
      [{ mediaIds: [3, 5] }, 'Unknown media ids: 3'],
    ])('rejects %j', async (input, message) => {
      const { service, prisma } = buildService();
      await expect(service.update(1, input)).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps unique violations to BadRequest and rethrows other errors', async () => {
      const { service, prisma } = buildService();
      prisma.$transaction.mockRejectedValueOnce(p2002());
      await expect(service.update(1, { name: 'g' })).rejects.toThrow(
        new BadRequestException('Media group name already exists'),
      );
      const plain = new Error('boom');
      prisma.$transaction.mockRejectedValueOnce(plain);
      await expect(service.update(1, { name: 'g' })).rejects.toBe(plain);
      const other = new Prisma.PrismaClientKnownRequestError('x', {
        code: 'P2025',
        clientVersion: 'test',
      });
      prisma.$transaction.mockRejectedValueOnce(other);
      await expect(service.update(1, { name: 'g' })).rejects.toBe(other);
    });

    it('fails when the updated group cannot be reloaded', async () => {
      const { service, tx } = buildService();
      tx.mediaGroup.findUnique.mockResolvedValueOnce(null);
      await expect(service.update(1, {})).rejects.toThrow(
        new NotFoundException('Media group not found after update'),
      );
    });

    it('fails when the transaction yields no group', async () => {
      const { service, prisma } = buildService();
      prisma.$transaction.mockResolvedValueOnce(null);
      await expect(service.update(1, {})).rejects.toThrow(
        new NotFoundException('Media group not found after update'),
      );
    });
  });

  describe('remove', () => {
    it('deletes the group and its legacy label', async () => {
      const { service, tx } = buildService();
      await expect(service.remove(1)).resolves.toEqual({
        deletedMediaGroupId: 1,
      });
      expect(tx.mediaGroup.delete).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(tx.mediaLabel.deleteMany).toHaveBeenCalledWith({
        where: { id: 'legacy-media-group:1' },
      });
    });

    it('throws NotFound for unknown groups', async () => {
      const { service, prisma } = buildService();
      prisma.mediaGroup.findUnique.mockResolvedValueOnce(null);
      await expect(service.remove(2)).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it('records Object as the paramtype when PrismaService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./media-groups.service');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.MediaGroupsService),
      ).toEqual([Object]);
    });
    jest.dontMock('../prisma.service');
  });
});
