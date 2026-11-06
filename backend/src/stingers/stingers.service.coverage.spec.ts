import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StingersService } from './stingers.service';

function build() {
  const tx = {
    stinger: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    mediaAsset: { upsert: jest.fn(), deleteMany: jest.fn() },
  };
  const prisma = {
    stinger: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((op: (client: typeof tx) => unknown) => op(tx)),
  };
  return { service: new StingersService(prisma as never), prisma, tx };
}

const row = {
  id: 4,
  assetId: 'transition:4',
  name: 'Wipe',
  videoUrl: 'https://media.test/wipe.webm',
  cutPointMs: 1000,
  enabled: true,
};

describe('StingersService', () => {
  it('lists stingers newest first', async () => {
    const { service, prisma } = build();
    prisma.stinger.findMany.mockResolvedValue([row]);
    await expect(service.findAll()).resolves.toEqual([row]);
    expect(prisma.stinger.findMany).toHaveBeenCalledWith({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('finds one stinger or throws NotFoundException', async () => {
    const { service, prisma } = build();
    prisma.stinger.findUnique.mockResolvedValueOnce(row);
    await expect(service.findOne(4)).resolves.toBe(row);
    prisma.stinger.findUnique.mockResolvedValueOnce(null);
    await expect(service.findOne(5)).rejects.toThrow(
      new NotFoundException('Stinger not found'),
    );
  });

  it('creates with defaults for cutPointMs and enabled', async () => {
    const { service, tx } = build();
    tx.stinger.create.mockResolvedValue({ ...row, assetId: null });
    tx.stinger.findUniqueOrThrow.mockResolvedValue(row);
    await expect(
      service.create({ name: ' Wipe ', videoUrl: ' https://x/y.webm ' }),
    ).resolves.toBe(row);
    expect(tx.stinger.create).toHaveBeenCalledWith({
      data: {
        name: 'Wipe',
        videoUrl: 'https://x/y.webm',
        cutPointMs: 1000,
        enabled: true,
      },
    });
  });

  it('creates honoring explicit cutPointMs and enabled=false', async () => {
    const { service, tx } = build();
    tx.stinger.create.mockResolvedValue({ ...row, assetId: null });
    tx.stinger.findUniqueOrThrow.mockResolvedValue(row);
    await service.create({
      name: 'a',
      videoUrl: 'b',
      cutPointMs: 0,
      enabled: false,
    });
    expect(tx.stinger.create).toHaveBeenCalledWith({
      data: { name: 'a', videoUrl: 'b', cutPointMs: 0, enabled: false },
    });
  });

  it('rejects a missing, non-string or blank name or videoUrl', async () => {
    const { service, prisma } = build();
    await expect(service.create({ videoUrl: 'u' })).rejects.toThrow(
      new BadRequestException('name is required'),
    );
    await expect(
      service.create({ name: '   ', videoUrl: 'u' }),
    ).rejects.toThrow('name is required');
    await expect(service.create({ name: 'n' })).rejects.toThrow(
      new BadRequestException('videoUrl is required'),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('updates all provided fields and syncs the asset', async () => {
    const { service, prisma, tx } = build();
    prisma.stinger.findUnique.mockResolvedValue(row);
    tx.stinger.update.mockResolvedValue(row);
    tx.stinger.findUniqueOrThrow.mockResolvedValue({ ...row, name: 'New' });
    await expect(
      service.update(4, {
        name: ' New ',
        videoUrl: ' v ',
        cutPointMs: 5,
        enabled: false,
      }),
    ).resolves.toEqual({ ...row, name: 'New' });
    expect(tx.stinger.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { name: 'New', videoUrl: 'v', cutPointMs: 5, enabled: false },
    });
    expect(tx.mediaAsset.upsert).toHaveBeenCalledTimes(1);
  });

  it('updates a single field only', async () => {
    const { service, prisma, tx } = build();
    prisma.stinger.findUnique.mockResolvedValue(row);
    tx.stinger.update.mockResolvedValue(row);
    tx.stinger.findUniqueOrThrow.mockResolvedValue(row);
    await service.update(4, { cutPointMs: 9 });
    expect(tx.stinger.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { cutPointMs: 9 },
    });
  });

  it('returns the existing stinger without a transaction when nothing changes', async () => {
    const { service, prisma } = build();
    prisma.stinger.findUnique.mockResolvedValue(row);
    await expect(service.update(4, {})).resolves.toBe(row);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects blank names and videoUrls on update and unknown ids', async () => {
    const { service, prisma } = build();
    prisma.stinger.findUnique.mockResolvedValue(row);
    await expect(service.update(4, { name: ' ' })).rejects.toThrow(
      'name is required',
    );
    await expect(service.update(4, { videoUrl: '' })).rejects.toThrow(
      'videoUrl is required',
    );
    prisma.stinger.findUnique.mockResolvedValue(null);
    await expect(service.update(9, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('removes a stinger and its media asset', async () => {
    const { service, prisma, tx } = build();
    prisma.stinger.findUnique.mockResolvedValue(row);
    await expect(service.remove(4)).resolves.toEqual({ deletedStingerId: 4 });
    expect(tx.stinger.delete).toHaveBeenCalledWith({ where: { id: 4 } });
    expect(tx.mediaAsset.deleteMany).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tx.mediaAsset.deleteMany.mock.calls[0])).toContain(
      'transition:4',
    );
  });

  it('refuses to remove an unknown stinger', async () => {
    const { service, prisma } = build();
    prisma.stinger.findUnique.mockResolvedValue(null);
    await expect(service.remove(4)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
