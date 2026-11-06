import { Test } from '@nestjs/testing';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { PrismaService } from '../prisma.service';
import { MediaGroupsController } from './media-groups.controller';
import { MediaGroupsModule } from './media-groups.module';
import { MediaGroupsService } from './media-groups.service';

function build() {
  const groups = {
    findAll: jest.fn().mockResolvedValue('all'),
    findOne: jest.fn().mockResolvedValue('one'),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue('removed'),
  };
  return { controller: new MediaGroupsController(groups as never), groups };
}

describe('MediaGroupsController (coverage)', () => {
  it('uses default pagination when page and limit are absent', async () => {
    const { controller, groups } = build();
    await expect(controller.findAll()).resolves.toBe('all');
    expect(groups.findAll).toHaveBeenCalledWith({
      search: undefined,
      sortBy: undefined,
      sortOrder: undefined,
      page: 1,
      limit: 20,
    });
  });

  it('passes filters through and clamps page and (non-negative) limit', async () => {
    const { controller, groups } = build();
    await controller.findAll('q', 'name', 'asc', '0', '-5');
    await controller.findAll(undefined, undefined, undefined, '3', '500');
    expect(groups.findAll.mock.calls.map((c) => c[0])).toEqual([
      { search: 'q', sortBy: 'name', sortOrder: 'asc', page: 1, limit: 0 },
      {
        search: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 3,
        limit: 500,
      },
    ]);
  });

  it('delegates single-record operations with numeric ids', async () => {
    const { controller, groups } = build();
    await expect(controller.findOne('4')).resolves.toBe('one');
    await expect(
      controller.create({ name: 'n', description: null, mediaIds: [1] }),
    ).resolves.toBe('created');
    await expect(controller.update('4', { name: 'm' })).resolves.toBe(
      'updated',
    );
    await expect(controller.remove('4')).resolves.toBe('removed');
    expect(groups.findOne).toHaveBeenCalledWith(4);
    expect(groups.create).toHaveBeenCalledWith({
      name: 'n',
      description: null,
      mediaIds: [1],
    });
    expect(groups.update).toHaveBeenCalledWith(4, { name: 'm' });
    expect(groups.remove).toHaveBeenCalledWith(4);
  });

  it('keeps findOne public and mutations behind manage', () => {
    const perm = (target: object) =>
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, target);
    expect(perm(MediaGroupsController)).toBe(ALCANTARA_PERMISSIONS.media.read);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        MediaGroupsController.prototype.findOne,
      ),
    ).toBe(true);
    for (const name of ['create', 'update', 'remove'] as const) {
      expect(perm(MediaGroupsController.prototype[name])).toBe(
        ALCANTARA_PERMISSIONS.media.manage,
      );
    }
  });

  it('records Object as the paramtype when MediaGroupsService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('./media-groups.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./media-groups.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.MediaGroupsController),
      ).toEqual([Object]);
    });
    jest.dontMock('./media-groups.service');
  });
});

describe('MediaGroupsModule (coverage)', () => {
  it('provides a MediaGroupsService backed by PrismaService', async () => {
    const prisma = {
      mediaGroup: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [MediaGroupsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    expect(moduleRef.get(MediaGroupsController)).toBeInstanceOf(
      MediaGroupsController,
    );
    await expect(moduleRef.get(MediaGroupsService).findOne(2)).rejects.toThrow(
      'Media group not found',
    );
    expect(prisma.mediaGroup.findUnique).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });
});
