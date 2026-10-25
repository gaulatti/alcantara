/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AlanaClient, AlanaRequestError } from './alana.client';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { canonicalJson } from './broadcast-destinations.types';

const destination = {
  id: 'primary',
  displayName: 'Primary platform',
  secretId: 'broadcast/test/primary',
  secretVersionId: 'version-1',
  position: 0,
  retiredAt: null,
  createdAt: new Date('2026-08-28T00:00:00Z'),
  updatedAt: new Date('2026-08-28T00:00:00Z'),
};

function stoppedState() {
  return {
    requestedState: 'stopped',
    actualState: 'stopped',
    transition: null,
    readiness: false,
    lastSequence: 4,
    activeDestinations: null,
    pendingDestinations: null,
    destinations: [],
    commandResult: null,
  };
}

function makeHarness(programType = 'both') {
  const version = 'destinations-test-version';
  const payload = {
    version,
    destinations: [
      {
        id: destination.id,
        secretId: destination.secretId,
        versionId: destination.secretVersionId,
      },
    ],
  };
  const selectionHash = createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex');
  const selection = {
    id: 'selection-1',
    version,
    programId: 'main',
    selectionHash,
    createdBySubject: 'operator',
    createdAt: new Date(),
    destinations: [
      {
        id: 'item-1',
        selectionId: 'selection-1',
        destinationId: destination.id,
        displayName: destination.displayName,
        secretId: destination.secretId,
        secretVersionId: destination.secretVersionId,
        position: 0,
      },
    ],
  };
  let storedCommand: any;
  const transaction = {
    broadcastDestinationRuntime: {
      upsert: jest
        .fn()
        .mockResolvedValue({ programId: 'main', nextSequence: 5 }),
      update: jest.fn().mockResolvedValue({}),
    },
    broadcastDestinationCommand: {
      create: jest.fn(async ({ data }: any) => {
        storedCommand = {
          ...data,
          selection: data.selectionId ? selection : null,
          downstreamStatus: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return storedCommand;
      }),
      update: jest.fn(async ({ data }: any) => {
        storedCommand = { ...storedCommand, ...data };
        return storedCommand;
      }),
    },
  };
  const prisma = {
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ programId: 'main', type: programType }),
    },
    broadcastDestination: {
      findMany: jest.fn().mockResolvedValue([destination]),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    broadcastDestinationSelection: {
      create: jest.fn().mockResolvedValue(selection),
      findUnique: jest.fn(),
    },
    broadcastDestinationCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(async ({ data }: any) => {
        storedCommand = { ...storedCommand, ...data };
        return storedCommand;
      }),
    },
    broadcastDestinationRuntime: {
      upsert: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(async (value: any) =>
      typeof value === 'function' ? value(transaction) : Promise.all(value),
    ),
  };
  const acknowledged = {
    version,
    selectionHash,
    count: 1,
    destinationIds: ['primary'],
  };
  const alana = {
    status: jest.fn().mockResolvedValue(stoppedState()),
    reload: jest.fn().mockResolvedValue({
      ...stoppedState(),
      pendingDestinations: acknowledged,
    }),
    start: jest.fn().mockResolvedValue({
      ...stoppedState(),
      requestedState: 'running',
      actualState: 'running',
      readiness: true,
      activeDestinations: acknowledged,
    }),
    stop: jest.fn(),
  };
  const metrics = { recordBroadcastDestination: jest.fn() };
  return {
    service: new BroadcastDestinationsService(
      prisma as unknown as PrismaService,
      alana as unknown as AlanaClient,
      metrics as unknown as ManagedMetricsService,
    ),
    prisma,
    alana,
    payload,
    selection,
    transaction,
    metrics,
    command: () => storedCommand,
  };
}

describe('BroadcastDestinationsService', () => {
  it('requires a deliberate confirmation and at least one destination', async () => {
    const { service } = makeHarness();
    await expect(
      service.start(
        'main',
        { commandId: 'command-1', destinationIds: [], confirmed: true },
        'operator',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.start(
        'main',
        {
          commandId: 'command-2',
          destinationIds: ['primary'],
          confirmed: false,
        },
        'operator',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reloads then starts the exact television selection for a simulcast program', async () => {
    const { service, alana, payload } = makeHarness('both');

    const result = await service.start(
      'main',
      {
        commandId: 'command-1',
        destinationIds: ['primary'],
        confirmed: true,
      },
      'operator',
    );

    expect(alana.reload).toHaveBeenCalledWith(
      'main',
      'command-1:reload',
      payload,
    );
    expect(alana.start).toHaveBeenCalledWith('main', 'command-1', 5, payload);
    expect(result).toMatchObject({
      action: 'start',
      status: 'succeeded',
      destinationIds: ['primary'],
      duplicate: false,
    });
  });

  it('rejects retired or missing destinations before sending a command', async () => {
    const { service, prisma, alana } = makeHarness();
    prisma.broadcastDestination.findMany.mockResolvedValueOnce([]);

    await expect(
      service.start(
        'main',
        {
          commandId: 'command-1',
          destinationIds: ['primary'],
          confirmed: true,
        },
        'operator',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(alana.reload).not.toHaveBeenCalled();
    expect(alana.start).not.toHaveBeenCalled();
  });

  it('blocks destination reload while the downstream session is active', async () => {
    const { service, alana } = makeHarness();
    alana.status.mockResolvedValueOnce({
      ...stoppedState(),
      requestedState: 'running',
      actualState: 'running',
    });

    await expect(
      service.reload(
        'main',
        {
          commandId: 'command-1',
          destinationIds: ['primary'],
          confirmed: true,
        },
        'operator',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never reports Running when Alana acknowledges a different selection', async () => {
    const { service, alana } = makeHarness();
    alana.start.mockResolvedValueOnce({
      ...stoppedState(),
      requestedState: 'running',
      actualState: 'running',
      activeDestinations: {
        version: 'other-version',
        selectionHash: 'b'.repeat(64),
        count: 1,
        destinationIds: ['primary'],
      },
    });

    await expect(
      service.start(
        'main',
        {
          commandId: 'command-1',
          destinationIds: ['primary'],
          confirmed: true,
        },
        'operator',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

const confirmed = (overrides: Record<string, unknown> = {}) => ({
  commandId: 'workflow-command',
  destinationIds: ['primary'],
  confirmed: true,
  ...overrides,
});
function databaseError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(
    'fictional database failure',
    { code, clientVersion: 'test' },
  );
}

describe('BroadcastDestinationsService catalog and immutable command lifecycle', () => {
  it('separates public destination labels from administrator-only immutable secret references', async () => {
    const f = makeHarness();
    f.prisma.broadcastDestination.findMany.mockResolvedValueOnce([
      { ...destination, retiredAt: new Date() },
    ]);
    expect(await f.service.listDestinations()).toEqual([
      {
        id: 'primary',
        displayName: 'Primary platform',
        position: 0,
        retired: true,
      },
    ]);
    expect(await f.service.listCatalog()).toEqual([destination]);
  });

  it('normalizes catalog metadata and places a new destination after the existing catalog', async () => {
    const f = makeHarness();
    f.prisma.broadcastDestination.count.mockResolvedValue(3);
    f.prisma.broadcastDestination.create.mockResolvedValue(destination);
    expect(
      await f.service.createDestination({
        id: ' primary ',
        displayName: ' Primary platform ',
        secretId: ' broadcast/test/primary ',
        secretVersionId: ' version-1 ',
      }),
    ).toBe(destination);
    expect(f.prisma.broadcastDestination.create).toHaveBeenCalledWith({
      data: {
        id: 'primary',
        displayName: 'Primary platform',
        secretId: 'broadcast/test/primary',
        secretVersionId: 'version-1',
        position: 3,
      },
    });
    await f.service.updateDestination('primary', {
      id: 'untrusted-body-id',
      displayName: 'New label',
      secretId: 'broadcast/test/new',
      secretVersionId: 'version-2',
    });
    expect(f.prisma.broadcastDestination.update).toHaveBeenCalledWith({
      where: { id: 'primary' },
      data: {
        displayName: 'New label',
        secretId: 'broadcast/test/new',
        secretVersionId: 'version-2',
      },
    });
  });

  it.each([
    { id: undefined },
    { id: 'bad id' },
    { displayName: undefined },
    { displayName: '' },
    { displayName: 'x'.repeat(101) },
    { secretId: undefined },
    { secretId: 'invalid secret reference' },
    { secretVersionId: undefined },
    { secretVersionId: 'bad version' },
  ])(
    'rejects invalid administrator catalog input before mutation: %p',
    async (override) => {
      const f = makeHarness();
      await expect(
        f.service.createDestination({ ...destination, ...override }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.broadcastDestination.create).not.toHaveBeenCalled();
    },
  );

  it('maps only supported catalog uniqueness and missing-row errors, preserving other database failures', async () => {
    const f = makeHarness();
    f.prisma.broadcastDestination.create.mockRejectedValueOnce(
      databaseError('P2002'),
    );
    await expect(
      f.service.createDestination(destination),
    ).rejects.toBeInstanceOf(ConflictException);
    const outage = new Error('catalog unavailable');
    f.prisma.broadcastDestination.create.mockRejectedValueOnce(outage);
    await expect(f.service.createDestination(destination)).rejects.toBe(outage);
    for (const operation of [
      () => f.service.updateDestination('primary', destination),
      () => f.service.setRetired('primary', true),
    ]) {
      f.prisma.broadcastDestination.update.mockRejectedValueOnce(
        databaseError('P2025'),
      );
      await expect(operation()).rejects.toBeInstanceOf(NotFoundException);
      f.prisma.broadcastDestination.update.mockRejectedValueOnce(outage);
      await expect(operation()).rejects.toBe(outage);
    }
  });

  it('retires and restores the same catalog identity without deleting its immutable history', async () => {
    const f = makeHarness();
    await f.service.setRetired('primary', true);
    await f.service.setRetired('primary', false);
    expect(f.prisma.broadcastDestination.update.mock.calls).toEqual([
      [{ where: { id: 'primary' }, data: { retiredAt: expect.any(Date) } }],
      [{ where: { id: 'primary' }, data: { retiredAt: null } }],
    ]);
  });

  it.each(
    [
      undefined,
      'primary',
      new Array(101).fill('primary'),
      [7],
      ['bad id'],
      ['primary', 'primary'],
      [],
      ['other'],
    ].map((value) => [value] as const),
  )(
    'rejects a malformed or incomplete catalog order atomically: %p',
    async (ids) => {
      const f = makeHarness();
      await expect(f.service.reorderDestinations(ids)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('reorders the complete catalog and returns its refreshed administrator view', async () => {
    const f = makeHarness();
    f.prisma.broadcastDestination.findMany.mockResolvedValueOnce([
      destination,
      { ...destination, id: 'secondary', position: 1 },
    ]);
    expect(
      await f.service.reorderDestinations(['secondary', 'primary']),
    ).toEqual([destination]);
    expect(f.prisma.broadcastDestination.update.mock.calls).toEqual([
      [{ where: { id: 'secondary' }, data: { position: 0 } }],
      [{ where: { id: 'primary' }, data: { position: 1 } }],
    ]);
  });

  it('reconciles observable downstream state and decorates only known destination labels', async () => {
    const f = makeHarness();
    f.prisma.broadcastDestinationRuntime.findUnique.mockResolvedValue({
      nextSequence: 12,
    } as never);
    const state = {
      ...stoppedState(),
      destinations: [{ id: 'primary' }, { id: 'removed' }],
    };
    f.alana.status.mockResolvedValue(state as never);
    const result = await f.service.getProgramState('main');
    expect(result.available).toBe(true);
    expect(result.downstream.destinations).toEqual([
      { id: 'primary', displayName: 'Primary platform' },
      { id: 'removed', displayName: 'removed' },
    ]);
    expect(f.prisma.broadcastDestinationRuntime.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          nextSequence: 12,
          requestedState: 'stopped',
          actualState: 'stopped',
        },
      }),
    );
  });

  it('reports a safe unavailable downstream state but does not hide unrelated persistence failures', async () => {
    const f = makeHarness();
    const state = { ...stoppedState(), error: 'Executor unavailable' };
    f.alana.status.mockRejectedValueOnce(new AlanaRequestError(503, state));
    expect(await f.service.getProgramState('main')).toMatchObject({
      available: false,
      downstream: state,
    });
    const outage = new Error('database unavailable');
    f.alana.status.mockRejectedValueOnce(outage);
    await expect(f.service.getProgramState('main')).rejects.toBe(outage);
    expect(f.prisma.broadcastDestinationRuntime.upsert).not.toHaveBeenCalled();
  });

  it.each([undefined, 1, '', 'bad id', 'x'.repeat(201)])(
    'requires a stable bounded command id: %p',
    async (commandId) => {
      const f = makeHarness();
      await expect(
        f.service.start('main', confirmed({ commandId }), 'operator'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.alana.status).not.toHaveBeenCalled();
    },
  );

  it.each([
    { confirmed: undefined },
    { destinationIds: [3] },
    { destinationIds: 'primary' },
    { selectionVersion: 'bad version' },
    { destinationIds: ['primary', 'primary'] },
    { destinationIds: ['bad id'] },
    { destinationIds: new Array(21).fill('primary') },
  ])(
    'rejects invalid confirmation/selection before sending an executor command: %p',
    async (override) => {
      const f = makeHarness();
      await expect(
        f.service.start('main', confirmed(override), 'operator'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.alana.start).not.toHaveBeenCalled();
      expect(f.alana.reload).not.toHaveBeenCalled();
    },
  );

  it('keeps stop independent of selection and rejects an attached destination selection', async () => {
    const f = makeHarness();
    await expect(
      f.service.stop('main', confirmed(), 'operator'),
    ).rejects.toThrow('Stop does not accept destinations');
    f.alana.stop.mockResolvedValue(stoppedState());
    const stopped = await f.service.stop(
      'main',
      confirmed({ destinationIds: undefined }),
      'operator',
    );
    expect(stopped).toMatchObject({
      action: 'stop',
      status: 'succeeded',
      selectionVersion: null,
      selectionHash: null,
      destinationIds: [],
    });
    expect(f.alana.stop).toHaveBeenCalledWith('main', 'workflow-command', 5);
  });

  it('rejects missing and radio-only programs before consulting the downstream executor', async () => {
    const f = makeHarness('radio');
    await expect(
      f.service.start('main', confirmed(), 'operator'),
    ).rejects.toBeInstanceOf(BadRequestException);
    f.prisma.programState.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.stop('missing', confirmed({ destinationIds: [] }), 'operator'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.alana.status).not.toHaveBeenCalled();
  });

  it('reloads a stopped television leg without starting it and preserves the pending selection', async () => {
    const f = makeHarness('tv');
    expect(
      await f.service.reload('main', confirmed(), 'operator'),
    ).toMatchObject({
      action: 'reload',
      status: 'succeeded',
      destinationIds: ['primary'],
    });
    expect(f.alana.start).not.toHaveBeenCalled();
    expect(
      f.transaction.broadcastDestinationRuntime.upsert,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: {
          requestedState: 'stopped',
          actualState: 'stopped',
          pendingSelectionId: 'selection-1',
        },
      }),
    );
  });

  it.each(['start', 'reload', 'stop'] as const)(
    'returns an exact successful %s retry as a duplicate without repeating its executor operation',
    async (action) => {
      const f = makeHarness();
      f.alana.stop.mockResolvedValue(stoppedState());
      const input = confirmed({
        destinationIds: action === 'stop' ? [] : ['primary'],
      });
      await f.service[action]('main', input, 'operator');
      f.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue(
        f.command(),
      );
      const repeated = await f.service[action]('main', input, 'operator');
      expect(repeated.duplicate).toBe(true);
      expect(f.alana[action]).toHaveBeenCalledTimes(1);
      expect(
        f.transaction.broadcastDestinationCommand.create,
      ).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let an existing command id authorize another action, program or selection', async () => {
    const f = makeHarness();
    await f.service.start('main', confirmed(), 'operator');
    f.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue(
      f.command(),
    );
    await expect(
      f.service.reload('main', confirmed(), 'operator'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      f.service.start('other', confirmed(), 'operator'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      f.service.start(
        'main',
        confirmed({ destinationIds: ['secondary'] }),
        'operator',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.alana.start).toHaveBeenCalledTimes(1);
  });

  it('starts an already running television leg without a stopped-state reload', async () => {
    const f = makeHarness();
    f.alana.status.mockResolvedValue({
      ...stoppedState(),
      requestedState: 'running',
      actualState: 'running',
    });
    expect(
      await f.service.start('main', confirmed(), 'operator'),
    ).toMatchObject({ status: 'succeeded' });
    expect(f.alana.reload).not.toHaveBeenCalled();
  });

  it.each([
    { requestedState: 'stopped', actualState: 'running' },
    { requestedState: 'running', actualState: 'stopped' },
  ])(
    'never reports successful start unless both requested and actual states are running: %p',
    async (states) => {
      const f = makeHarness();
      f.alana.start.mockResolvedValue({ ...stoppedState(), ...states });
      await expect(
        f.service.start('main', confirmed(), 'operator'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(f.command().status).toBe('failed');
      expect(f.metrics.recordBroadcastDestination).toHaveBeenLastCalledWith(
        'command',
        'failed',
      );
    },
  );

  it.each([
    { requestedState: 'running', actualState: 'stopped' },
    { requestedState: 'stopped', actualState: 'running' },
  ])(
    'never reports successful stop unless both requested and actual states are stopped: %p',
    async (states) => {
      const f = makeHarness();
      f.alana.stop.mockResolvedValue({ ...stoppedState(), ...states });
      await expect(
        f.service.stop('main', confirmed({ destinationIds: [] }), 'operator'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(f.command().status).toBe('failed');
    },
  );

  it.each([409, 503, 502])(
    'maps safe executor HTTP status%d before preparing any command',
    async (status) => {
      const f = makeHarness();
      for (const action of ['start', 'reload', 'stop'] as const) {
        f.alana.status.mockRejectedValueOnce(
          new AlanaRequestError(status, {
            ...stoppedState(),
            error: 'Safe executor diagnostic',
          }),
        );
        await expect(
          f.service[action](
            'main',
            confirmed({ destinationIds: action === 'stop' ? [] : ['primary'] }),
            'operator',
          ),
        ).rejects.toBeInstanceOf(
          status === 409
            ? ConflictException
            : status === 503
              ? ServiceUnavailableException
              : BadGatewayException,
        );
      }
      expect(
        f.transaction.broadcastDestinationCommand.create,
      ).not.toHaveBeenCalled();
    },
  );

  it('sanitizes an unexpected executor error while preserving a failed command diagnostic', async () => {
    const f = makeHarness();
    f.alana.reload.mockRejectedValueOnce(
      new Error('private executor transport details'),
    );
    await expect(
      f.service.reload('main', confirmed(), 'operator'),
    ).rejects.toThrow('Broadcast executor request failed');
    expect(f.command()).toMatchObject({
      status: 'failed',
      downstreamStatus: {
        requestedState: 'unknown',
        actualState: 'unknown',
        error: 'downstream request failed',
      },
    });
  });

  it('resolves only an existing same-program immutable selection with the exact confirmed destination set', async () => {
    const f = makeHarness();
    const input = confirmed({ selectionVersion: f.selection.version });
    f.prisma.broadcastDestinationSelection.findUnique.mockResolvedValueOnce(
      null,
    );
    await expect(
      f.service.start('main', input, 'operator'),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.prisma.broadcastDestinationSelection.findUnique.mockResolvedValueOnce({
      ...f.selection,
      programId: 'other',
    });
    await expect(
      f.service.start('main', input, 'operator'),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.prisma.broadcastDestinationSelection.findUnique.mockResolvedValueOnce(
      f.selection,
    );
    await expect(
      f.service.start(
        'main',
        { ...input, destinationIds: ['secondary'] },
        'operator',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    f.prisma.broadcastDestinationSelection.findUnique.mockResolvedValueOnce(
      f.selection,
    );
    expect(await f.service.start('main', input, 'operator')).toMatchObject({
      status: 'succeeded',
      selectionVersion: f.selection.version,
    });
    expect(
      f.prisma.broadcastDestinationSelection.create,
    ).not.toHaveBeenCalled();
  });

  it.each(['missing', 'version', 'hash', 'count', 'ids'] as const)(
    'fails a reload whose %s acknowledgement is not the exact immutable selection',
    async (mismatch) => {
      const f = makeHarness();
      const acknowledgement: any = {
        version: f.selection.version,
        selectionHash: f.selection.selectionHash,
        count: 1,
        destinationIds: ['primary'],
      };
      if (mismatch === 'version') acknowledgement.version = 'other-version';
      if (mismatch === 'hash') acknowledgement.selectionHash = 'a'.repeat(64);
      if (mismatch === 'count') acknowledgement.count = 2;
      if (mismatch === 'ids') acknowledgement.destinationIds = ['other'];
      f.alana.reload.mockResolvedValue({
        ...stoppedState(),
        pendingDestinations: mismatch === 'missing' ? null : acknowledgement,
      });
      await expect(
        f.service.reload('main', confirmed(), 'operator'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(f.command().status).toBe('failed');
      expect(f.alana.start).not.toHaveBeenCalled();
    },
  );
});

describe('BroadcastDestinationsService multi-destination and recovery boundaries', () => {
  it('preserves catalog ordering in an exact immutable multi-destination retry regardless of caller selection order', async () => {
    const f = makeHarness();
    const secondary = {
      ...destination,
      id: 'secondary',
      position: 1,
      secretId: 'broadcast/test/secondary',
    };
    f.selection.destinations.unshift({
      ...f.selection.destinations[0],
      id: 'item-2',
      destinationId: 'secondary',
      secretId: secondary.secretId,
      position: 1,
    });
    f.payload.destinations.push({
      id: 'secondary',
      secretId: secondary.secretId,
      versionId: secondary.secretVersionId,
    });
    f.selection.selectionHash = createHash('sha256')
      .update(canonicalJson(f.payload))
      .digest('hex');
    f.prisma.broadcastDestinationSelection.findUnique.mockResolvedValue(
      f.selection,
    );
    f.prisma.broadcastDestination.findMany.mockResolvedValue([
      destination,
      secondary,
    ]);
    f.alana.reload.mockResolvedValue({
      ...stoppedState(),
      pendingDestinations: {
        version: f.selection.version,
        selectionHash: f.selection.selectionHash,
        count: 2,
        destinationIds: ['primary', 'secondary'],
      },
    });
    const result = await f.service.reload(
      'main',
      confirmed({
        destinationIds: ['secondary', 'primary'],
        selectionVersion: f.selection.version,
      }),
      'operator',
    );
    expect(result.destinationIds).toEqual(['primary', 'secondary']);
    expect(f.alana.reload).toHaveBeenCalledWith(
      'main',
      'workflow-command:reload',
      f.payload,
    );
    expect(
      f.prisma.broadcastDestinationSelection.create,
    ).not.toHaveBeenCalled();
  });

  it('refuses a corrupted pending start without an immutable selection before sending another executor command', async () => {
    const f = makeHarness();
    await f.service.start('main', confirmed(), 'operator');
    f.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue({
      ...f.command(),
      status: 'pending',
      selection: null,
    });
    await expect(
      f.service.start('main', confirmed(), 'operator'),
    ).rejects.toThrow('Destination command has no immutable selection');
    expect(f.alana.start).toHaveBeenCalledTimes(1);
  });

  it('initializes runtime reconciliation at the downstream sequence when no local runtime exists', async () => {
    const f = makeHarness();
    expect((await f.service.getProgramState('main')).available).toBe(true);
    expect(f.prisma.broadcastDestinationRuntime.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          programId: 'main',
          nextSequence: 5,
          requestedState: 'stopped',
          actualState: 'stopped',
        },
      }),
    );
  });
});
