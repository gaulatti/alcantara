import { Test } from '@nestjs/testing';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { PrismaService } from '../prisma.service';
import { MediaController } from './media.controller';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';

function build() {
  const media = {
    findAll: jest.fn().mockResolvedValue('all'),
    findOne: jest.fn().mockResolvedValue('one'),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue('removed'),
  };
  return { controller: new MediaController(media as never), media };
}

describe('MediaController (coverage)', () => {
  it('uses default pagination when page and limit are absent', async () => {
    const { controller, media } = build();
    await expect(controller.findAll()).resolves.toBe('all');
    expect(media.findAll).toHaveBeenCalledWith({
      search: undefined,
      sortBy: undefined,
      sortOrder: undefined,
      page: 1,
      limit: 50,
    });
  });

  it('passes filters through and clamps page and limit', async () => {
    const { controller, media } = build();
    await controller.findAll('q', 'name', 'asc', '0', '999');
    await controller.findAll('q', 'name', 'asc', '4', '0');
    await controller.findAll(undefined, undefined, undefined, '2', '25');
    expect(media.findAll.mock.calls.map((c) => c[0])).toEqual([
      { search: 'q', sortBy: 'name', sortOrder: 'asc', page: 1, limit: 200 },
      { search: 'q', sortBy: 'name', sortOrder: 'asc', page: 4, limit: 1 },
      {
        search: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 2,
        limit: 25,
      },
    ]);
  });

  it('delegates single-record operations with numeric ids', async () => {
    const { controller, media } = build();
    await expect(controller.findOne('4')).resolves.toBe('one');
    await expect(controller.create({ name: 'n', imageUrl: 'u' })).resolves.toBe(
      'created',
    );
    await expect(controller.update('4', { name: 'm' })).resolves.toBe(
      'updated',
    );
    await expect(controller.remove('4')).resolves.toBe('removed');
    expect(media.findOne).toHaveBeenCalledWith(4);
    expect(media.create).toHaveBeenCalledWith({ name: 'n', imageUrl: 'u' });
    expect(media.update).toHaveBeenCalledWith(4, { name: 'm' });
    expect(media.remove).toHaveBeenCalledWith(4);
  });

  it('requires read on the controller and manage on mutations', () => {
    const perm = (target: object) =>
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, target);
    expect(perm(MediaController)).toBe(ALCANTARA_PERMISSIONS.media.read);
    for (const name of ['create', 'update', 'remove'] as const) {
      expect(perm(MediaController.prototype[name])).toBe(
        ALCANTARA_PERMISSIONS.media.manage,
      );
    }
  });

  it('records Object as the paramtype when MediaService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./media.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./media.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.MediaController),
      ).toEqual([Object]);
    });
    jest.dontMock('./media.service');
  });
});

describe('MediaService metadata (coverage)', () => {
  it('records Object as the paramtype when PrismaService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./media.service');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.MediaService),
      ).toEqual([Object]);
    });
    jest.dontMock('../prisma.service');
  });
});

describe('MediaModule (coverage)', () => {
  it('provides and exports a MediaService backed by PrismaService', async () => {
    const prisma = {
      media: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [MediaModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    const service = moduleRef.get(MediaService);
    expect(moduleRef.get(MediaController)).toBeInstanceOf(MediaController);
    await expect(service.findOne(1)).resolves.toEqual({ id: 1 });
    expect(prisma.media.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    await moduleRef.close();
  });
});
