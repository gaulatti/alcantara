/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-argument */
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import type { BroadcastDestinationsService } from './broadcast-destinations.service';

describe('BroadcastDestinationsController coverage', () => {
  const service = {
    listDestinations: jest.fn(),
    listCatalog: jest.fn(),
    reorderDestinations: jest.fn(),
    renameDestination: jest.fn(),
    setRetired: jest.fn(),
    getProgramState: jest.fn(),
    reload: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  };
  const keys = { add: jest.fn(), replaceKey: jest.fn() };
  const controller = new BroadcastDestinationsController(
    service as unknown as BroadcastDestinationsService,
    {} as never,
    keys as never,
    {} as never,
  );
  const teamRequest = {
    user: { sub: 'operator-1', authorization: { teamId: 7 } },
  };
  const request = { user: { sub: 'operator-1' } };

  beforeEach(() => jest.resetAllMocks());

  it('delegates catalog reads and writes to the services, with the caller team', async () => {
    service.listDestinations.mockResolvedValue(['list']);
    service.listCatalog.mockResolvedValue(['catalog']);
    keys.add.mockResolvedValue({ id: 'created' });
    keys.replaceKey.mockResolvedValue({ id: 'keyed' });
    service.reorderDestinations.mockResolvedValue(['ordered']);
    service.renameDestination.mockResolvedValue({ id: 'renamed' });

    await expect(controller.listDestinations(teamRequest)).resolves.toEqual([
      'list',
    ]);
    expect(service.listDestinations).toHaveBeenCalledWith(7);
    await expect(controller.listCatalog(teamRequest)).resolves.toEqual([
      'catalog',
    ]);
    expect(service.listCatalog).toHaveBeenCalledWith(7);
    await expect(
      controller.addDestination({ name: 'x' }, teamRequest),
    ).resolves.toEqual({ id: 'created' });
    expect(keys.add).toHaveBeenCalledWith({ name: 'x' }, 7, 'operator-1');
    await expect(
      controller.replaceKey('x', { streamKey: 'k' }, teamRequest),
    ).resolves.toEqual({ id: 'keyed' });
    expect(keys.replaceKey).toHaveBeenCalledWith(
      'x',
      { streamKey: 'k' },
      7,
      'operator-1',
    );
    await expect(
      controller.reorderDestinations({ destinationIds: ['b', 'a'] }),
    ).resolves.toEqual(['ordered']);
    expect(service.reorderDestinations).toHaveBeenCalledWith(['b', 'a']);
    await expect(
      controller.renameDestination('x', { displayName: 'Y' }, teamRequest),
    ).resolves.toEqual({ id: 'renamed' });
    expect(service.renameDestination).toHaveBeenCalledWith(
      'x',
      { displayName: 'Y' },
      7,
    );
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
      jest.doMock('./broadcast-ingest.service', () => ({
        BroadcastIngestService: undefined,
      }));
      jest.doMock('./destination-test.service', () => ({
        DestinationTestService: undefined,
      }));
      jest.doMock('./broadcast-destination-keys.service', () => ({
        BroadcastDestinationKeysService: undefined,
      }));
      const { BroadcastDestinationsController: Isolated } =
        require('./broadcast-destinations.controller') as {
          BroadcastDestinationsController: new (...args: never[]) => unknown;
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
        Object,
        Object,
      ]);
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          Isolated.prototype,
          'addDestination',
        ),
      ).toEqual([Object, Object]);
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
          'addDestination',
          'replaceKey',
          'renameDestination',
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
