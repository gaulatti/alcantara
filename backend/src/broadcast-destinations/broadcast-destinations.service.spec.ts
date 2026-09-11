/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AlanaClient } from './alana.client';
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
          selection,
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
    broadcastDestinationRuntime: { upsert: jest.fn() },
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
