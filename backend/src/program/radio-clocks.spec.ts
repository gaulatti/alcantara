import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { RadioClocksController } from './radio-clocks.controller';
import { RadioClocksService } from './radio-clocks.service';

// gaulatti/alcantara#124: clocks are stored radio log rules, re-checked by the generator's own parser.
const rules = {
  artistSeparation: 1,
  slots: [
    {
      labelId: ' fictional-tag ',
      count: 2,
      clockOffsetSeconds: 0,
      extra: 'dropped',
    },
  ],
};
const row = {
  id: 5,
  name: 'Fictional morning',
  rules: { artistSeparation: 0, slots: [] },
  revision: 2,
};

function setup(type = 'radio') {
  const prisma = {
    programState: { findUnique: jest.fn().mockResolvedValue({ id: 3, type }) },
    radioClock: {
      findMany: jest.fn().mockResolvedValue([row]),
      findFirst: jest.fn().mockResolvedValue(row),
      create: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ id: 6, revision: 1, ...data }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    radioDaypart: { count: jest.fn().mockResolvedValue(0) },
  };
  return { prisma, service: new RadioClocksService(prisma as never) };
}

describe('RadioClocksService', () => {
  it('lists the clocks of a radio program', async () => {
    const { service, prisma } = setup('both');
    await expect(service.list(' fictional ')).resolves.toEqual([row]);
    expect(prisma.programState.findUnique).toHaveBeenCalledWith({
      where: { programId: 'fictional' },
      select: { id: true, type: true },
    });
  });

  it('refuses a program that is missing or has no radio leg', async () => {
    await expect(setup('tv').service.list('p')).rejects.toThrow(
      BadRequestException,
    );
    const { service, prisma } = setup();
    prisma.programState.findUnique.mockResolvedValue(null);
    await expect(service.list('p')).rejects.toThrow(NotFoundException);
  });

  it('stores only the rules the generator reads', async () => {
    const { service, prisma } = setup();
    const made = await service.create('p', {
      name: ' Fictional evening ',
      rules,
    });
    expect(made).toEqual({
      id: 6,
      revision: 1,
      name: 'Fictional evening',
      rules: {
        artistSeparation: 1,
        slots: [{ labelId: 'fictional-tag', count: 2, clockOffsetSeconds: 0 }],
      },
    });
    await service.create('p', {
      name: 'No offset',
      rules: {
        artistSeparation: 0,
        slots: [
          { labelId: 't', count: 1, clockOffsetSeconds: 0 },
          { labelId: 'u', count: 1 },
        ],
      },
    });
    expect(prisma.radioClock.create.mock.calls[1][0].data).toMatchObject({
      rules: {
        slots: [
          { labelId: 't', count: 1, clockOffsetSeconds: 0 },
          { labelId: 'u', count: 1 },
        ],
      },
    });
  });

  it('refuses a missing name, a long name and rules the generator would refuse', async () => {
    const { service } = setup();
    await expect(service.create('p', { rules })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.create('p', { name: 'x'.repeat(101), rules }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create('p', { name: 'n', rules: { slots: [] } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('says a taken name is taken, and passes other failures through', async () => {
    const { service, prisma } = setup();
    prisma.radioClock.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.create('p', { name: 'n', rules })).rejects.toThrow(
      'already exists',
    );
    prisma.radioClock.create.mockRejectedValueOnce(new Error('down'));
    await expect(service.create('p', { name: 'n', rules })).rejects.toThrow(
      'down',
    );
  });

  it('changes a clock only at the revision it was read', async () => {
    const { service, prisma } = setup();
    await expect(
      service.update('p', 5, { revision: 1, name: 'n' }),
    ).rejects.toThrow(ConflictException);
    await service.update('p', 5, { revision: 2, name: 'Renamed' });
    expect(prisma.radioClock.updateMany).toHaveBeenLastCalledWith({
      where: { id: 5, programStateId: 3, revision: 2 },
      data: { name: 'Renamed', revision: { increment: 1 } },
    });
    await service.update('p', 5, { revision: 2, rules });
    expect(prisma.radioClock.updateMany.mock.calls[1][0]).toMatchObject({
      data: { rules: { artistSeparation: 1 } },
    });
    prisma.radioClock.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.update('p', 5, { revision: 2 })).rejects.toThrow(
      ConflictException,
    );
    prisma.radioClock.updateMany.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      service.update('p', 5, { revision: 2, rules }),
    ).rejects.toThrow('"Fictional morning" already exists');
    prisma.radioClock.findFirst.mockResolvedValue(null);
    await expect(service.update('p', 9, { revision: 2 })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deletes only an unused clock at its revision', async () => {
    const { service, prisma } = setup();
    await expect(service.delete('p', 5, 1)).rejects.toThrow(ConflictException);
    prisma.radioDaypart.count.mockResolvedValueOnce(1);
    await expect(service.delete('p', 5, 2)).rejects.toThrow('fills 1 daypart.');
    prisma.radioDaypart.count.mockResolvedValueOnce(3);
    await expect(service.delete('p', 5, 2)).rejects.toThrow(
      'fills 3 dayparts.',
    );
    await expect(service.delete('p', 5, 2)).resolves.toEqual({ deleted: true });
    prisma.radioClock.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.delete('p', 5, 2)).rejects.toThrow(ConflictException);
  });
});

describe('RadioClocksController', () => {
  it('passes each route to the service, an empty body as an empty change', async () => {
    const clocks = {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    const controller = new RadioClocksController(clocks as never);
    await controller.listRadioClocks('p');
    await controller.createRadioClock('p', undefined as never);
    await controller.createRadioClock('p', { name: 'n' });
    await controller.updateRadioClock('p', 5, undefined as never);
    await controller.updateRadioClock('p', 5, { revision: 1 });
    await controller.deleteRadioClock('p', 5, 2);
    expect(clocks.create.mock.calls).toEqual([
      ['p', {}],
      ['p', { name: 'n' }],
    ]);
    expect(clocks.update.mock.calls).toEqual([
      ['p', 5, {}],
      ['p', 5, { revision: 1 }],
    ]);
    expect(clocks.delete).toHaveBeenCalledWith('p', 5, 2);
    expect(clocks.list).toHaveBeenCalledWith('p');
  });

  it('asks the radio log permissions: read to list, manage to change', () => {
    const permission = (name: keyof RadioClocksController) =>
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        RadioClocksController.prototype[name],
      ) as string;
    expect(permission('listRadioClocks')).toBe(
      ALCANTARA_PERMISSIONS.flight.read,
    );
    for (const name of [
      'createRadioClock',
      'updateRadioClock',
      'deleteRadioClock',
    ] as const)
      expect(permission(name)).toBe(ALCANTARA_PERMISSIONS.flight.manage);
  });
});

describe('radio clocks decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules have not resolved yet', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      const {
        RadioClocksService: Isolated,
      } = require('./radio-clocks.service');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
    jest.isolateModules(() => {
      jest.doMock('./radio-clocks.service', () => ({}));
      const {
        RadioClocksController: Isolated,
      } = require('./radio-clocks.controller');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('./radio-clocks.service');
  });
});
