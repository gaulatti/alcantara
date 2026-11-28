import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { RadioDaypartsController } from './radio-dayparts.controller';
import {
  RadioDaypartsService,
  daypartsOf,
  timeZoneOf,
} from './radio-dayparts.service';

// gaulatti/alcantara#124: the weekly grid is saved whole; an empty one means nothing is generated.
const morning = { dayOfWeek: 1, startHour: 6, endHour: 10, clockId: 5 };

function setup(grid: unknown = null) {
  const tx = {
    radioDaypartGrid: {
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    radioDaypart: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = {
    programState: {
      findUnique: jest.fn().mockResolvedValue({ id: 3, type: 'radio' }),
    },
    radioDaypartGrid: { findUnique: jest.fn().mockResolvedValue(grid) },
    radioClock: { count: jest.fn().mockResolvedValue(1) },
    $transaction: jest.fn((work: (client: typeof tx) => Promise<void>) =>
      work(tx),
    ),
  };
  return { tx, prisma, service: new RadioDaypartsService(prisma as never) };
}

const stored = {
  timeZone: 'Europe/Rome',
  revision: 2,
  dayparts: [
    { ...morning, dayOfWeek: 2, start: 'hard' },
    { ...morning, startHour: 12, endHour: 13, start: 'soft' },
    { ...morning, start: 'other' },
  ],
};

describe('daypart checks', () => {
  it('takes IANA zones and nothing else', () => {
    expect(timeZoneOf(' Europe/Rome ')).toBe('Europe/Rome');
    for (const bad of ['Mars/Base', '', 5, undefined])
      expect(() => timeZoneOf(bad)).toThrow(BadRequestException);
  });

  it('defaults to a soft start and allows adjacent dayparts', () => {
    expect(
      daypartsOf([morning, { ...morning, startHour: 10, endHour: 24 }]),
    ).toEqual([
      { ...morning, start: 'soft' },
      { ...morning, startHour: 10, endHour: 24, start: 'soft' },
    ]);
  });

  it('refuses impossible rows and overlaps', () => {
    for (const bad of [
      null,
      { ...morning, dayOfWeek: 7 },
      { ...morning, startHour: 24 },
      { ...morning, endHour: 25 },
      { ...morning, endHour: 6 },
      { ...morning, clockId: 0 },
      { ...morning, start: 'later' },
    ])
      expect(() => daypartsOf([bad])).toThrow('Daypart 1');
    expect(() =>
      daypartsOf([morning, { ...morning, startHour: 9, endHour: 11 }]),
    ).toThrow('Daypart 2 overlaps');
    expect(() => daypartsOf('no')).toThrow(BadRequestException);
    expect(() => daypartsOf(new Array(169).fill(morning))).toThrow(
      'at most 168',
    );
  });
});

describe('RadioDaypartsService', () => {
  it('answers an empty grid before one is saved', async () => {
    await expect(setup().service.get('p')).resolves.toEqual({
      timeZone: null,
      revision: 0,
      dayparts: [],
    });
  });

  it('reads the saved grid in day and hour order', async () => {
    const grid = await setup(stored).service.get('p');
    expect(
      grid.dayparts.map((d) => [d.dayOfWeek, d.startHour, d.start]),
    ).toEqual([
      [1, 6, 'soft'],
      [1, 12, 'soft'],
      [2, 6, 'hard'],
    ]);
  });

  it('refuses a program that is missing or has no radio leg', async () => {
    const { service, prisma } = setup();
    prisma.programState.findUnique.mockResolvedValueOnce(null);
    await expect(service.get('p')).rejects.toThrow(NotFoundException);
    prisma.programState.findUnique.mockResolvedValueOnce({ id: 3, type: 'tv' });
    await expect(service.get('p')).rejects.toThrow(BadRequestException);
  });

  it('creates the first grid, then replaces its rows', async () => {
    const { service, tx } = setup();
    await service.save('p', {
      revision: 0,
      timeZone: 'UTC',
      dayparts: [morning],
    });
    expect(tx.radioDaypartGrid.create).toHaveBeenCalledWith({
      data: { programStateId: 3, timeZone: 'UTC' },
    });
    expect(tx.radioDaypart.deleteMany).toHaveBeenCalledWith({
      where: { programStateId: 3 },
    });
    expect(tx.radioDaypart.createMany).toHaveBeenCalledWith({
      data: [{ programStateId: 3, ...morning, start: 'soft' }],
    });
  });

  it('saves an emptied grid at its revision without creating rows', async () => {
    const { service, tx, prisma } = setup(stored);
    await service.save('p', { revision: 2, timeZone: 'UTC', dayparts: [] });
    expect(tx.radioDaypartGrid.updateMany).toHaveBeenCalledWith({
      where: { programStateId: 3, revision: 2 },
      data: { timeZone: 'UTC', revision: { increment: 1 } },
    });
    expect(tx.radioDaypart.createMany).not.toHaveBeenCalled();
    expect(prisma.radioClock.count).not.toHaveBeenCalled();
  });

  it('refuses a stale revision, a lost race and another program’s clock', async () => {
    const input = { revision: 2, timeZone: 'UTC', dayparts: [morning] };
    const { service, tx, prisma } = setup(stored);
    await expect(service.save('p', { ...input, revision: 1 })).rejects.toThrow(
      ConflictException,
    );
    tx.radioDaypartGrid.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.save('p', input)).rejects.toThrow(ConflictException);
    prisma.radioClock.count.mockResolvedValueOnce(0);
    await expect(service.save('p', input)).rejects.toThrow('does not have');
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.save('p', input)).rejects.toThrow(ConflictException);
    prisma.$transaction.mockRejectedValueOnce(new Error('down'));
    await expect(service.save('p', input)).rejects.toThrow('down');
  });
});

describe('RadioDaypartsController', () => {
  it('passes the routes through with the radio log permissions', async () => {
    const dayparts = { get: jest.fn(), save: jest.fn() };
    const controller = new RadioDaypartsController(dayparts as never);
    await controller.getRadioDayparts('p');
    await controller.saveRadioDayparts('p', undefined as never);
    await controller.saveRadioDayparts('p', { revision: 1 });
    expect(dayparts.get).toHaveBeenCalledWith('p');
    expect(dayparts.save.mock.calls).toEqual([
      ['p', {}],
      ['p', { revision: 1 }],
    ]);
    const permission = (name: keyof RadioDaypartsController) =>
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        RadioDaypartsController.prototype[name],
      ) as string;
    expect(permission('getRadioDayparts')).toBe(
      ALCANTARA_PERMISSIONS.flight.read,
    );
    expect(permission('saveRadioDayparts')).toBe(
      ALCANTARA_PERMISSIONS.flight.manage,
    );
  });
});

describe('daypart decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules have not resolved yet', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      const {
        RadioDaypartsService: Isolated,
      } = require('./radio-dayparts.service');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
    jest.isolateModules(() => {
      jest.doMock('./radio-dayparts.service', () => ({}));
      const {
        RadioDaypartsController: Isolated,
      } = require('./radio-dayparts.controller');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
    });
    jest.dontMock('../prisma.service');
    jest.dontMock('./radio-dayparts.service');
  });
});
