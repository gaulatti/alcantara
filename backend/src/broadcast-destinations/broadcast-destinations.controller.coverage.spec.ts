/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-argument */
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import type { BroadcastDestinationsService } from './broadcast-destinations.service';

describe('BroadcastDestinationsController coverage', () => {
  const service = {
    listDestinations: jest.fn(),
    listCatalog: jest.fn(),
    createDestination: jest.fn(),
    reorderDestinations: jest.fn(),
    updateDestination: jest.fn(),
    setRetired: jest.fn(),
    getProgramState: jest.fn(),
    reload: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  };
  const controller = new BroadcastDestinationsController(
    service as unknown as BroadcastDestinationsService,
  );
  const request = { user: { sub: 'operator-1' } };

  beforeEach(() => jest.resetAllMocks());

  it('delegates catalog reads and writes to the service', async () => {
    service.listDestinations.mockResolvedValue(['list']);
    service.listCatalog.mockResolvedValue(['catalog']);
    service.createDestination.mockResolvedValue({ id: 'created' });
    service.reorderDestinations.mockResolvedValue(['ordered']);
    service.updateDestination.mockResolvedValue({ id: 'updated' });

    await expect(controller.listDestinations()).resolves.toEqual(['list']);
    await expect(controller.listCatalog()).resolves.toEqual(['catalog']);
    await expect(controller.createDestination({ id: 'x' })).resolves.toEqual({
      id: 'created',
    });
    expect(service.createDestination).toHaveBeenCalledWith({ id: 'x' });
    await expect(
      controller.reorderDestinations({ destinationIds: ['b', 'a'] }),
    ).resolves.toEqual(['ordered']);
    expect(service.reorderDestinations).toHaveBeenCalledWith(['b', 'a']);
    await expect(
      controller.updateDestination('x', { displayName: 'Y' }),
    ).resolves.toEqual({ id: 'updated' });
    expect(service.updateDestination).toHaveBeenCalledWith('x', {
      displayName: 'Y',
    });
  });

  it('retires and restores through setRetired', async () => {
    service.setRetired.mockResolvedValue({ ok: true });
    await controller.retireDestination('x');
    await controller.restoreDestination('x');
    expect(service.setRetired).toHaveBeenNthCalledWith(1, 'x', true);
    expect(service.setRetired).toHaveBeenNthCalledWith(2, 'x', false);
  });

  it('reads program state and runs commands as the authenticated subject', async () => {
    service.getProgramState.mockResolvedValue({ available: true });
    service.reload.mockResolvedValue('reloaded');
    service.start.mockResolvedValue('started');
    service.stop.mockResolvedValue('stopped');
    const body = { commandId: 'c1' };

    await expect(controller.getProgramState('main')).resolves.toEqual({
      available: true,
    });
    expect(service.getProgramState).toHaveBeenCalledWith('main');
    await expect(controller.reload('main', body, request)).resolves.toBe(
      'reloaded',
    );
    await expect(controller.start('main', body, request)).resolves.toBe(
      'started',
    );
    await expect(controller.stop('main', body, request)).resolves.toBe(
      'stopped',
    );
    expect(service.reload).toHaveBeenCalledWith('main', body, 'operator-1');
    expect(service.start).toHaveBeenCalledWith('main', body, 'operator-1');
    expect(service.stop).toHaveBeenCalledWith('main', body, 'operator-1');
  });

  it('falls back to Object paramtypes when the service class is undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('./broadcast-destinations.service', () => ({
        BroadcastDestinationsService: undefined,
      }));
      const { BroadcastDestinationsController: Isolated } =
        require('./broadcast-destinations.controller') as {
          BroadcastDestinationsController: new (...args: never[]) => unknown;
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
      ]);
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          Isolated.prototype,
          'createDestination',
        ),
      ).toEqual([Object]);
    });
    jest.resetModules();
  });

  it('records the body type when a global Record constructor exists at decoration time', () => {
    class FakeRecord {}
    const holder = globalThis as unknown as { Record?: unknown };
    holder.Record = FakeRecord;
    try {
      jest.isolateModules(() => {
        const { BroadcastDestinationsController: Isolated } =
          require('./broadcast-destinations.controller') as {
            BroadcastDestinationsController: { prototype: object };
          };
        for (const method of [
          'createDestination',
          'updateDestination',
          'reload',
          'start',
          'stop',
        ]) {
          const types = Reflect.getMetadata(
            'design:paramtypes',
            Isolated.prototype,
            method,
          ) as unknown[];
          expect(types).toContain(FakeRecord);
        }
      });
    } finally {
      delete holder.Record;
      jest.resetModules();
    }
  });
});
