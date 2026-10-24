import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaGroupsService } from './media-groups.service';

function fixture() {
  const group = {
    id: 7,
    name: 'Opening',
    description: 'Station idents',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    mediaItems: [
      {
        id: 11,
        mediaGroupId: 7,
        mediaId: 3,
        position: 0,
        media: { id: 3, assetId: 'asset-3' },
      },
      {
        id: 12,
        mediaGroupId: 7,
        mediaId: 4,
        position: 1,
        media: { id: 4, assetId: null },
      },
    ],
  };
  const tx = {
    mediaGroup: {
      create: jest.fn().mockResolvedValue({ id: 7 }),
      update: jest.fn(),
      delete: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(group),
    },
    mediaGroupItem: { createMany: jest.fn(), deleteMany: jest.fn() },
    mediaLabel: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaAssetLabel: { createMany: jest.fn(), deleteMany: jest.fn() },
  };
  const prisma = {
    mediaGroup: {
      findMany: jest.fn().mockResolvedValue([group]),
      count: jest.fn().mockResolvedValue(3),
      findUnique: jest.fn().mockResolvedValue(group),
    },
    media: { findMany: jest.fn().mockResolvedValue([{ id: 3 }, { id: 4 }]) },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return { service: new MediaGroupsService(prisma as any), prisma, tx, group };
}

describe('MediaGroupsService application boundary', () => {
  it('searches case-insensitively, paginates, preserves stable ordering and returns hydrated ordered items', async () => {
    const f = fixture();
    const result = await f.service.findAll({
      search: '  station ',
      sortBy: 'name',
      sortOrder: 'asc',
      page: 2,
      limit: 2,
    });
    expect(f.prisma.mediaGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: { contains: 'station', mode: 'insensitive' } },
        orderBy: [{ name: 'asc' }, { id: 'desc' }],
        skip: 2,
        take: 2,
      }),
    );
    expect(result).toEqual({
      data: [{ ...f.group, mediaItems: undefined, items: f.group.mediaItems }],
      meta: { total: 3, page: 2, limit: 2, totalPages: 2 },
    });
  });

  it.each([undefined, '', '   '])(
    'omits an empty search and refuses arbitrary sorting: %p',
    async (search) => {
      const f = fixture();
      await f.service.findAll({
        search,
        sortBy: 'not-a-column',
        sortOrder: 'unsafe',
        page: 1,
        limit: 0,
      });
      expect(f.prisma.mediaGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(f.prisma.mediaGroup.findMany.mock.calls[0][0]).not.toHaveProperty(
        'take',
      );
    },
  );

  it('reads one group and reports missing groups', async () => {
    const f = fixture();
    expect((await f.service.findOne(7)).items).toEqual(f.group.mediaItems);
    f.prisma.mediaGroup.findUnique.mockResolvedValue(null);
    await expect(f.service.findOne(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('normalizes and deduplicates selected media while mirroring ordered canonical labels in the same transaction', async () => {
    const f = fixture();
    const created = await f.service.create({
      name: ' Opening ',
      description: '  Station idents ',
      mediaIds: [3, 4, 3],
    });
    expect(created.id).toBe(7);
    expect(f.tx.mediaGroup.create).toHaveBeenCalledWith({
      data: { name: 'Opening', description: 'Station idents' },
    });
    expect(f.tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
      data: [
        { mediaGroupId: 7, mediaId: 3, position: 0 },
        { mediaGroupId: 7, mediaId: 4, position: 1 },
      ],
    });
    expect(f.tx.mediaLabel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'legacy-media-group:7' } }),
    );
    expect(f.tx.mediaAssetLabel.deleteMany).toHaveBeenCalledWith({
      where: { labelId: 'legacy-media-group:7' },
    });
    expect(f.tx.mediaAssetLabel.createMany).toHaveBeenCalledWith({
      data: [
        { labelId: 'legacy-media-group:7', assetId: 'asset-3', position: 0 },
      ],
    });
  });

  it.each([undefined, null, []])(
    'creates an empty group without querying or inserting media: %p',
    async (mediaIds) => {
      const f = fixture();
      f.tx.mediaGroup.findUnique.mockResolvedValue({
        ...f.group,
        mediaItems: [],
      });
      await f.service.create({
        name: 'Empty',
        description: null,
        mediaIds: mediaIds as any,
      });
      expect(f.prisma.media.findMany).not.toHaveBeenCalled();
      expect(f.tx.mediaGroupItem.createMany).not.toHaveBeenCalled();
      expect(f.tx.mediaAssetLabel.createMany).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', undefined, 1])(
    'rejects a missing/nontext name without opening a transaction: %p',
    async (name) => {
      const f = fixture();
      await expect(
        f.service.create({ name: name as any }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['3', {}, [0], [-1], [1.1], [NaN], [Infinity], ['not-an-id']])(
    'rejects invalid media input: %p',
    async (mediaIds) => {
      const f = fixture();
      await expect(
        f.service.create({ name: 'Invalid', mediaIds: mediaIds as any }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown media before writing a group', async () => {
    const f = fixture();
    await expect(
      f.service.create({ name: 'Missing', mediaIds: [3, 99] }),
    ).rejects.toThrow('Unknown media ids: 99');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('updates textual fields without clearing the existing media selection', async () => {
    const f = fixture();
    await f.service.update(7, { name: ' Rename ', description: '   ' });
    expect(f.tx.mediaGroup.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { name: 'Rename', description: null },
    });
    expect(f.tx.mediaGroupItem.deleteMany).not.toHaveBeenCalled();
    expect(f.prisma.media.findMany).not.toHaveBeenCalled();
  });

  it('replaces ordered media and accepts numeric ids from an API payload', async () => {
    const f = fixture();
    await f.service.update(7, { mediaIds: ['4', 3, 4] as any });
    expect(f.tx.mediaGroup.update).not.toHaveBeenCalled();
    expect(f.tx.mediaGroupItem.deleteMany).toHaveBeenCalledWith({
      where: { mediaGroupId: 7 },
    });
    expect(f.tx.mediaGroupItem.createMany).toHaveBeenCalledWith({
      data: [
        { mediaGroupId: 7, mediaId: 4, position: 0 },
        { mediaGroupId: 7, mediaId: 3, position: 1 },
      ],
    });
  });

  it('clears media only when an explicit empty selection is supplied', async () => {
    const f = fixture();
    await f.service.update(7, { mediaIds: [], description: null });
    expect(f.tx.mediaGroupItem.deleteMany).toHaveBeenCalled();
    expect(f.tx.mediaGroupItem.createMany).not.toHaveBeenCalled();
    await expect(f.service.update(7, { mediaIds: undefined })).rejects.toThrow(
      'mediaIds must be an array',
    );
  });

  it.each(['create', 'update'] as const)(
    'maps database uniqueness errors and preserves other %s failures',
    async (method) => {
      const f = fixture();
      const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      });
      f.prisma.$transaction.mockRejectedValueOnce(duplicate as never);
      const call = () =>
        method === 'create'
          ? f.service.create({ name: 'Opening' })
          : f.service.update(7, { name: 'Opening' });
      await expect(call()).rejects.toThrow('Media group name already exists');
      const outage = new Error('transaction unavailable');
      f.prisma.$transaction.mockRejectedValueOnce(outage as never);
      await expect(call()).rejects.toBe(outage);
    },
  );

  it.each(['create', 'update'] as const)(
    'does not return an unhydrated result after %s',
    async (method) => {
      const f = fixture();
      f.tx.mediaGroup.findUnique.mockResolvedValue(null);
      const call =
        method === 'create'
          ? f.service.create({ name: 'Opening' })
          : f.service.update(7, {});
      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      expect(f.tx.mediaLabel.upsert).not.toHaveBeenCalled();
    },
  );

  it('deletes the legacy mirror with its group and rejects a missing group before mutation', async () => {
    const f = fixture();
    expect(await f.service.remove(7)).toEqual({ deletedMediaGroupId: 7 });
    expect(f.tx.mediaGroup.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(f.tx.mediaLabel.deleteMany).toHaveBeenCalledWith({
      where: { id: 'legacy-media-group:7' },
    });
    f.prisma.mediaGroup.findUnique.mockResolvedValue(null);
    await expect(f.service.update(7, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(f.service.remove(7)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.mediaGroup.delete).toHaveBeenCalledTimes(1);
  });
});
