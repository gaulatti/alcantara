import { LayoutsService } from './layouts.service';

function build() {
  const prisma = {
    layout: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  return { service: new LayoutsService(prisma as never), prisma };
}

describe('LayoutsService', () => {
  it('lists layouts ordered by name', async () => {
    const { service, prisma } = build();
    prisma.layout.findMany.mockResolvedValue([{ id: 1 }]);
    await expect(service.findAll()).resolves.toEqual([{ id: 1 }]);
    expect(prisma.layout.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
    });
  });

  it('finds one layout including its scenes', async () => {
    const { service, prisma } = build();
    prisma.layout.findUnique.mockResolvedValue({ id: 3, scenes: [] });
    await expect(service.findOne(3)).resolves.toEqual({ id: 3, scenes: [] });
    expect(prisma.layout.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      include: { scenes: true },
    });
  });

  it('creates a layout serializing settings to JSON', async () => {
    const { service, prisma } = build();
    prisma.layout.create.mockResolvedValue({ id: 1 });
    await service.create({
      name: 'L',
      componentType: 'c',
      settings: { a: 1 },
    });
    expect(prisma.layout.create).toHaveBeenCalledWith({
      data: { name: 'L', componentType: 'c', settings: '{"a":1}' },
    });
  });

  it('creates a layout with empty-object settings when none are given', async () => {
    const { service, prisma } = build();
    prisma.layout.create.mockResolvedValue({ id: 1 });
    await service.create({ name: 'L', componentType: 'c' });
    expect(prisma.layout.create).toHaveBeenCalledWith({
      data: { name: 'L', componentType: 'c', settings: '{}' },
    });
  });

  it('updates every provided field', async () => {
    const { service, prisma } = build();
    prisma.layout.update.mockResolvedValue({ id: 2 });
    await expect(
      service.update(2, { name: 'N', componentType: 'T', settings: { b: 2 } }),
    ).resolves.toEqual({ id: 2 });
    expect(prisma.layout.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { name: 'N', componentType: 'T', settings: '{"b":2}' },
    });
  });

  it('updates nothing but the id when no field is provided', async () => {
    const { service, prisma } = build();
    prisma.layout.update.mockResolvedValue({ id: 2 });
    await service.update(2, {});
    expect(prisma.layout.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: {},
    });
  });

  it('removes a layout by id', async () => {
    const { service, prisma } = build();
    prisma.layout.delete.mockResolvedValue({ id: 5 });
    await expect(service.remove(5)).resolves.toEqual({ id: 5 });
    expect(prisma.layout.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});
