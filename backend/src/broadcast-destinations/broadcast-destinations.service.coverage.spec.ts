/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, @typescript-eslint/require-await */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import type { PrismaService } from '../prisma.service';
import { AlanaClient, AlanaRequestError } from './alana.client';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import { canonicalJson } from './broadcast-destinations.types';

const destination = {
  id: 'primary',
  displayName: 'Primary platform',
  secretId: 'broadcast/test/primary',
  secretVersionId: 'version-1',
  position: 0,
  retiredAt: null as Date | null,
  createdAt: new Date('2026-08-28T00:00:00Z'),
  updatedAt: new Date('2026-08-28T00:00:00Z'),
};

const VERSION = 'destinations-test-version';
const PAYLOAD = {
  version: VERSION,
  destinations: [
    {
      id: destination.id,
      secretId: destination.secretId,
      versionId: destination.secretVersionId,
    },
  ],
};
const HASH = createHash('sha256').update(canonicalJson(PAYLOAD)).digest('hex');
const ACK = {
  version: VERSION,
  selectionHash: HASH,
  count: 1,
  destinationIds: ['primary'],
};

function state(overrides: Record<string, unknown> = {}): any {
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
    ...overrides,
  };
}

const running = (overrides: Record<string, unknown> = {}) =>
  state({
    requestedState: 'running',
    actualState: 'running',
    activeDestinations: ACK,
    ...overrides,
  });

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('failure', {
    code,
    clientVersion: 'test',
  });
}

function harness(programType = 'both') {
  const selection: any = {
    id: 'selection-1',
    version: VERSION,
    programId: 'main',
    selectionHash: HASH,
    createdBySubject: 'operator',
    createdAt: new Date(),
    destinations: [
      {
        id: 'item-1',
        selectionId: 'selection-1',
        destinationId: 'primary',
        displayName: destination.displayName,
        secretId: destination.secretId,
        secretVersionId: destination.secretVersionId,
        position: 0,
      },
    ],
  };
  let stored: any;
  const transaction = {
    broadcastDestinationRuntime: {
      upsert: jest.fn().mockResolvedValue({ nextSequence: 5 }),
      update: jest.fn().mockResolvedValue({}),
    },
    broadcastDestinationCommand: {
      create: jest.fn(async ({ data }: any) => {
        stored = { ...data, selection, downstreamStatus: null };
        return stored;
      }),
      update: jest.fn(async ({ data }: any) => {
        stored = { ...stored, ...data };
        return stored;
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
      count: jest.fn().mockResolvedValue(3),
      create: jest.fn(async ({ data }: any) => ({ ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...data })),
    },
    broadcastDestinationSelection: {
      create: jest.fn().mockResolvedValue(selection),
      findUnique: jest.fn(),
    },
    broadcastDestinationCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    broadcastDestinationRuntime: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (value: any, options?: any) =>
      typeof value === 'function' ? value(transaction) : Promise.all(value),
    ),
  };
  const alana = {
    status: jest.fn().mockResolvedValue(state()),
    reload: jest.fn().mockResolvedValue(state({ pendingDestinations: ACK })),
    start: jest.fn().mockResolvedValue(running()),
    stop: jest.fn().mockResolvedValue(state()),
  };
  const metrics = { recordBroadcastDestination: jest.fn() };
  const service = new BroadcastDestinationsService(
    prisma as unknown as PrismaService,
    alana as unknown as AlanaClient,
    metrics as unknown as ManagedMetricsService,
  );
  return {
    service,
    prisma,
    alana,
    metrics,
    transaction,
    selection,
    stored: () => stored,
  };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  commandId: 'command-1',
  destinationIds: ['primary'],
  confirmed: true,
  ...overrides,
});

async function caught(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('BroadcastDestinationsService coverage', () => {
  describe('catalog', () => {
    it('lists destinations flagging retired entries', async () => {
      const h = harness();
      h.prisma.broadcastDestination.findMany.mockResolvedValue([
        destination,
        { ...destination, id: 'old', position: 1, retiredAt: new Date() },
      ]);
      await expect(h.service.listDestinations()).resolves.toEqual([
        {
          id: 'primary',
          displayName: 'Primary platform',
          position: 0,
          retired: false,
        },
        {
          id: 'old',
          displayName: 'Primary platform',
          position: 1,
          retired: true,
        },
      ]);
      expect(h.prisma.broadcastDestination.findMany).toHaveBeenCalledWith({
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
    });

    it('lists the catalog including secret references', async () => {
      const h = harness();
      await expect(h.service.listCatalog()).resolves.toEqual([
        {
          id: 'primary',
          displayName: 'Primary platform',
          secretId: 'broadcast/test/primary',
          secretVersionId: 'version-1',
          position: 0,
          retiredAt: null,
          createdAt: destination.createdAt,
          updatedAt: destination.updatedAt,
        },
      ]);
    });

    it('creates a destination at the end of the catalog with trimmed input', async () => {
      const h = harness();
      const created = await h.service.createDestination({
        id: ' new-one ',
        displayName: ' New ',
        secretId: ' broadcast/test/new ',
        secretVersionId: ' v2 ',
      });
      expect(h.prisma.broadcastDestination.create).toHaveBeenCalledWith({
        data: {
          id: 'new-one',
          displayName: 'New',
          secretId: 'broadcast/test/new',
          secretVersionId: 'v2',
          position: 3,
        },
      });
      expect(created).toMatchObject({ id: 'new-one', position: 3 });
    });

    const valid = {
      id: 'x',
      displayName: 'X',
      secretId: 'a/b',
      secretVersionId: 'v1',
    };

    it('maps duplicate ids to a conflict and rethrows other failures', async () => {
      const h = harness();
      h.prisma.broadcastDestination.create.mockRejectedValueOnce(
        prismaError('P2002'),
      );
      await expect(h.service.createDestination(valid)).rejects.toThrow(
        new ConflictException('Destination ID already exists'),
      );
      h.prisma.broadcastDestination.create.mockRejectedValueOnce(
        prismaError('P2003'),
      );
      await expect(h.service.createDestination(valid)).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      const boom = new Error('boom');
      h.prisma.broadcastDestination.create.mockRejectedValueOnce(boom);
      await expect(h.service.createDestination(valid)).rejects.toBe(boom);
    });

    it.each([
      [
        'a missing id',
        { ...valid, id: undefined },
        'Destination ID is invalid',
      ],
      ['an invalid id', { ...valid, id: '-bad' }, 'Destination ID is invalid'],
      [
        'a non string display name',
        { ...valid, displayName: 3 },
        'Display name must contain 1-100 characters',
      ],
      [
        'a blank display name',
        { ...valid, displayName: '   ' },
        'Display name must contain 1-100 characters',
      ],
      [
        'a long display name',
        { ...valid, displayName: 'n'.repeat(101) },
        'Display name must contain 1-100 characters',
      ],
      [
        'a non string secret id',
        { ...valid, secretId: 5 },
        'Secrets Manager reference is invalid',
      ],
      [
        'a secret id with spaces',
        { ...valid, secretId: 'a b' },
        'Secrets Manager reference is invalid',
      ],
      [
        'a non string secret version',
        { ...valid, secretVersionId: 5 },
        'Secret version ID is invalid',
      ],
      [
        'a bad secret version',
        { ...valid, secretVersionId: '!' },
        'Secret version ID is invalid',
      ],
    ])('rejects creation with %s', async (_name, body, message) => {
      const h = harness();
      await expect(h.service.createDestination(body)).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(h.prisma.broadcastDestination.create).not.toHaveBeenCalled();
    });

    it('updates only the mutable fields of a destination', async () => {
      const h = harness();
      await h.service.updateDestination('primary', {
        id: 'ignored',
        displayName: 'Renamed',
        secretId: 'a/b',
        secretVersionId: 'v9',
      });
      expect(h.prisma.broadcastDestination.update).toHaveBeenCalledWith({
        where: { id: 'primary' },
        data: {
          displayName: 'Renamed',
          secretId: 'a/b',
          secretVersionId: 'v9',
        },
      });
    });

    it('validates the id before updating and maps P2025 to not found', async () => {
      const h = harness();
      await expect(
        h.service.updateDestination('-bad', valid),
      ).rejects.toBeInstanceOf(BadRequestException);
      h.prisma.broadcastDestination.update.mockRejectedValueOnce(
        prismaError('P2025'),
      );
      await expect(h.service.updateDestination('x', valid)).rejects.toThrow(
        new NotFoundException('Destination not found'),
      );
      h.prisma.broadcastDestination.update.mockRejectedValueOnce(
        prismaError('P2002'),
      );
      await expect(
        h.service.updateDestination('x', valid),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const boom = new Error('boom');
      h.prisma.broadcastDestination.update.mockRejectedValueOnce(boom);
      await expect(h.service.updateDestination('x', valid)).rejects.toBe(boom);
    });

    it('retires with a timestamp and restores with null', async () => {
      const h = harness();
      await h.service.setRetired('x', true);
      await h.service.setRetired('x', false);
      const [retire, restore] = h.prisma.broadcastDestination.update.mock
        .calls as any[];
      expect(retire[0].where).toEqual({ id: 'x' });
      expect(retire[0].data.retiredAt).toBeInstanceOf(Date);
      expect(restore[0].data).toEqual({ retiredAt: null });
    });

    it('validates ids and maps errors when retiring', async () => {
      const h = harness();
      await expect(h.service.setRetired('/', true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      h.prisma.broadcastDestination.update.mockRejectedValueOnce(
        prismaError('P2025'),
      );
      await expect(h.service.setRetired('x', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      h.prisma.broadcastDestination.update.mockRejectedValueOnce(
        prismaError('P2002'),
      );
      await expect(h.service.setRetired('x', true)).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      const boom = new Error('boom');
      h.prisma.broadcastDestination.update.mockRejectedValueOnce(boom);
      await expect(h.service.setRetired('x', true)).rejects.toBe(boom);
    });
  });

  describe('reorderDestinations', () => {
    it.each([
      ['a non array', 'abc', 'A bounded destination order is required'],
      [
        'too many ids',
        Array.from({ length: 101 }, (_, i) => `d${i}`),
        'A bounded destination order is required',
      ],
      ['a non string id', [1], 'Destination order is invalid'],
      ['a duplicate id', ['a', 'a'], 'Destination order contains duplicates'],
    ])('rejects %s', async (_name, ids, message) => {
      const h = harness();
      await expect(h.service.reorderDestinations(ids)).rejects.toThrow(
        new BadRequestException(message),
      );
    });

    it('rejects an invalid id value', async () => {
      const h = harness();
      await expect(
        h.service.reorderDestinations(['-bad']),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires the complete catalog', async () => {
      const h = harness();
      h.prisma.broadcastDestination.findMany.mockResolvedValue([
        { id: 'a' },
        { id: 'b' },
      ]);
      const message = 'Destination order must include the complete catalog';
      await expect(h.service.reorderDestinations(['a'])).rejects.toThrow(
        new BadRequestException(message),
      );
      await expect(h.service.reorderDestinations(['a', 'c'])).rejects.toThrow(
        new BadRequestException(message),
      );
    });

    it('persists positions in one transaction and returns the catalog', async () => {
      const h = harness();
      h.prisma.broadcastDestination.findMany
        .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
        .mockResolvedValueOnce([destination]);

      const result = await h.service.reorderDestinations(['b', 'a']);

      expect(h.prisma.broadcastDestination.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'b' },
        data: { position: 0 },
      });
      expect(h.prisma.broadcastDestination.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'a' },
        data: { position: 1 },
      });
      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('secretId');
    });
  });

  describe('getProgramState', () => {
    it('rejects unknown and radio programs', async () => {
      const h = harness();
      h.prisma.programState.findUnique.mockResolvedValueOnce(null);
      await expect(h.service.getProgramState('main')).rejects.toThrow(
        new NotFoundException('Program not found'),
      );
      h.prisma.programState.findUnique.mockResolvedValueOnce({
        programId: 'main',
        type: 'radio',
      });
      await expect(h.service.getProgramState('main')).rejects.toThrow(
        new BadRequestException(
          'Destination selection applies only to a television program leg',
        ),
      );
    });

    it('reconciles runtime from Alana and decorates destination names', async () => {
      const h = harness('tv');
      h.alana.status.mockResolvedValue(
        state({
          lastSequence: 12,
          destinations: [
            { id: 'primary', mode: 'relaying' },
            { id: 'unlisted', mode: 'idle' },
          ],
        }),
      );
      h.prisma.broadcastDestinationRuntime.findUnique.mockResolvedValue({
        nextSequence: 3,
      });

      const result = await h.service.getProgramState('main');

      expect(result).toMatchObject({
        programId: 'main',
        available: true,
        destinations: [{ id: 'primary', displayName: 'Primary platform' }],
      });
      expect(result.downstream.destinations).toEqual([
        { id: 'primary', mode: 'relaying', displayName: 'Primary platform' },
        { id: 'unlisted', mode: 'idle', displayName: 'unlisted' },
      ]);
      expect(h.prisma.broadcastDestinationRuntime.upsert).toHaveBeenCalledWith({
        where: { programId: 'main' },
        create: {
          programId: 'main',
          nextSequence: 13,
          requestedState: 'stopped',
          actualState: 'stopped',
        },
        update: {
          nextSequence: 13,
          requestedState: 'stopped',
          actualState: 'stopped',
        },
      });
    });

    it('never lowers a persisted next sequence and defaults to 1', async () => {
      const h = harness();
      h.alana.status.mockResolvedValue(state({ lastSequence: 0 }));
      h.prisma.broadcastDestinationRuntime.findUnique.mockResolvedValue({
        nextSequence: 40,
      });
      await h.service.getProgramState('main');
      expect(
        h.prisma.broadcastDestinationRuntime.upsert.mock.calls[0][0].update
          .nextSequence,
      ).toBe(40);

      h.prisma.broadcastDestinationRuntime.upsert.mockClear();
      h.prisma.broadcastDestinationRuntime.findUnique.mockResolvedValue(null);
      h.alana.status.mockResolvedValue(state({ lastSequence: 0 }));
      await h.service.getProgramState('main');
      expect(
        h.prisma.broadcastDestinationRuntime.upsert.mock.calls[0][0].update
          .nextSequence,
      ).toBe(1);
    });

    it('reports Alana as unavailable using the error state', async () => {
      const h = harness();
      h.alana.status.mockRejectedValue(
        new AlanaRequestError(503, state({ error: 'Alana is unavailable' })),
      );
      const result = await h.service.getProgramState('main');
      expect(result.available).toBe(false);
      expect(result.downstream.error).toBe('Alana is unavailable');
      expect(
        h.prisma.broadcastDestinationRuntime.upsert,
      ).not.toHaveBeenCalled();
    });

    it('rethrows unexpected failures', async () => {
      const h = harness();
      const boom = new Error('boom');
      h.alana.status.mockRejectedValue(boom);
      await expect(h.service.getProgramState('main')).rejects.toBe(boom);
    });
  });

  describe('command input validation', () => {
    it.each([
      [
        'a non string command id',
        input({ commandId: 7 }),
        'A stable bounded command ID is required',
      ],
      [
        'a malformed command id',
        input({ commandId: '-x' }),
        'A stable bounded command ID is required',
      ],
      [
        'missing confirmation',
        input({ confirmed: 'yes' }),
        'The broadcast action must be confirmed',
      ],
      [
        'a non string destination',
        input({ destinationIds: [1] }),
        'Destination selection is invalid',
      ],
      [
        'an absent destination list',
        input({ destinationIds: 'primary' }),
        'Select at least one destination',
      ],
      [
        'a malformed selection version',
        input({ selectionVersion: '!!' }),
        'Selection version is invalid',
      ],
    ])('rejects start with %s', async (_name, body, message) => {
      const h = harness();
      await expect(h.service.start('main', body, 'operator')).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(h.alana.status).not.toHaveBeenCalled();
    });

    it('rejects stop requests carrying destinations', async () => {
      const h = harness();
      await expect(h.service.stop('main', input(), 'operator')).rejects.toThrow(
        new BadRequestException('Stop does not accept destinations'),
      );
    });

    it('treats an empty or non string selection version as absent', async () => {
      const h = harness();
      await h.service.start(
        'main',
        input({ selectionVersion: '' }),
        'operator',
      );
      expect(
        h.prisma.broadcastDestinationSelection.findUnique,
      ).not.toHaveBeenCalled();
      const second = harness();
      await second.service.start(
        'main',
        input({ selectionVersion: 12 }),
        'operator',
      );
      expect(
        second.prisma.broadcastDestinationSelection.findUnique,
      ).not.toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('creates an immutable selection, reloads then starts', async () => {
      const h = harness();

      const result = await h.service.start('main', input(), 'operator');

      const createArgs = h.prisma.broadcastDestinationSelection.create.mock
        .calls[0][0] as any;
      expect(createArgs.data.programId).toBe('main');
      expect(createArgs.data.createdBySubject).toBe('operator');
      expect(createArgs.data.version).toMatch(/^destinations-\d+-[0-9a-f-]+$/);
      expect(createArgs.data.destinations.create).toEqual([
        {
          destinationId: 'primary',
          displayName: 'Primary platform',
          secretId: 'broadcast/test/primary',
          secretVersionId: 'version-1',
          position: 0,
        },
      ]);
      expect(h.alana.reload).toHaveBeenCalledWith(
        'main',
        'command-1:reload',
        PAYLOAD,
      );
      expect(h.alana.start).toHaveBeenCalledWith(
        'main',
        'command-1',
        5,
        PAYLOAD,
      );
      expect(result).toMatchObject({
        commandId: 'command-1',
        action: 'start',
        sequence: 5,
        status: 'succeeded',
        selectionVersion: VERSION,
        selectionHash: HASH,
        destinationIds: ['primary'],
        duplicate: false,
      });
      expect(h.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
        'start',
        'succeeded',
      );
      expect(
        h.transaction.broadcastDestinationRuntime.upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            requestedState: 'running',
            actualState: 'running',
            activeSelectionId: 'selection-1',
            pendingSelectionId: null,
          },
        }),
      );
    });

    it('allocates the sequence from the larger of runtime and downstream', async () => {
      const h = harness();
      h.transaction.broadcastDestinationRuntime.upsert.mockResolvedValue({
        nextSequence: 50,
      });
      await h.service.start('main', input(), 'operator');
      expect(h.alana.start.mock.calls[0][2]).toBe(50);
      expect(
        h.transaction.broadcastDestinationRuntime.update,
      ).toHaveBeenCalledWith({
        where: { programId: 'main' },
        data: { nextSequence: 51 },
      });
    });

    it('skips the reload when Alana is not fully stopped', async () => {
      const h = harness();
      h.alana.status.mockResolvedValue(
        state({ requestedState: 'running', actualState: 'stopped' }),
      );
      await h.service.start('main', input(), 'operator');
      expect(h.alana.reload).not.toHaveBeenCalled();

      const other = harness();
      other.alana.status.mockResolvedValue(
        state({ requestedState: 'stopped', actualState: 'running' }),
      );
      await other.service.start('main', input(), 'operator');
      expect(other.alana.reload).not.toHaveBeenCalled();
    });

    it('returns a stored successful command as a duplicate without calling Alana', async () => {
      const h = harness();
      const prior = {
        id: 'command-1',
        programId: 'main',
        action: 'start',
        status: 'succeeded',
        sequence: 8,
        requestHash: createHash('sha256')
          .update(
            canonicalJson({
              action: 'start',
              destinationIds: ['primary'],
              selectionVersion: null,
            }),
          )
          .digest('hex'),
        selection: h.selection,
        downstreamStatus: { ok: true },
      };
      h.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue(prior);

      const result = await h.service.start('main', input(), 'operator');

      expect(result).toMatchObject({
        commandId: 'command-1',
        sequence: 8,
        downstream: { ok: true },
        duplicate: true,
      });
      expect(h.alana.reload).not.toHaveBeenCalled();
      expect(h.alana.start).not.toHaveBeenCalled();
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['program', { programId: 'other' }],
      ['action', { action: 'reload' }],
      ['request hash', { requestHash: 'different' }],
    ])(
      'rejects a reused command id with a different %s',
      async (_name, change) => {
        const h = harness();
        const hash = createHash('sha256')
          .update(
            canonicalJson({
              action: 'start',
              destinationIds: ['primary'],
              selectionVersion: null,
            }),
          )
          .digest('hex');
        h.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue({
          id: 'command-1',
          programId: 'main',
          action: 'start',
          requestHash: hash,
          status: 'pending',
          ...change,
        });
        await expect(
          h.service.start('main', input(), 'operator'),
        ).rejects.toThrow(
          new ConflictException(
            'Command ID was already used for a different request',
          ),
        );
      },
    );

    it('resumes a pending prior command with the same request', async () => {
      const h = harness();
      h.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue({
        id: 'command-1',
        programId: 'main',
        action: 'start',
        status: 'pending',
        sequence: 6,
        selectionId: 'selection-1',
        selection: h.selection,
        requestHash: createHash('sha256')
          .update(
            canonicalJson({
              action: 'start',
              destinationIds: ['primary'],
              selectionVersion: null,
            }),
          )
          .digest('hex'),
      });
      h.transaction.broadcastDestinationCommand.update.mockImplementation(
        async ({ data }: any) => ({
          id: 'command-1',
          action: 'start',
          sequence: 6,
          programId: 'main',
          selection: h.selection,
          ...data,
        }),
      );
      const result = await h.service.start('main', input(), 'operator');
      expect(result).toMatchObject({ sequence: 6, duplicate: false });
      expect(h.alana.start.mock.calls[0][2]).toBe(6);
      expect(
        h.transaction.broadcastDestinationCommand.create,
      ).not.toHaveBeenCalled();
    });

    it('fails when the prior command has no immutable selection', async () => {
      const h = harness();
      h.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue({
        id: 'command-1',
        programId: 'main',
        action: 'start',
        status: 'pending',
        selection: null,
        requestHash: createHash('sha256')
          .update(
            canonicalJson({
              action: 'start',
              destinationIds: ['primary'],
              selectionVersion: null,
            }),
          )
          .digest('hex'),
      });
      await expect(
        h.service.start('main', input(), 'operator'),
      ).rejects.toThrow('Destination command has no immutable selection');
    });

    it('maps an Alana status failure without creating a command', async () => {
      const h = harness();
      h.alana.status.mockRejectedValue(
        new AlanaRequestError(503, state({ error: 'Alana is unavailable' })),
      );
      const error = await caught(h.service.start('main', input(), 'operator'));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('records a failed command and maps a conflict from Alana', async () => {
      const h = harness();
      const downstream = state({ error: 'busy' });
      h.alana.start.mockRejectedValue(new AlanaRequestError(409, downstream));

      const error = await caught(h.service.start('main', input(), 'operator'));

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toEqual({
        error: 'busy',
        downstream,
      });
      expect(h.prisma.broadcastDestinationCommand.update).toHaveBeenCalledWith({
        where: { id: 'command-1' },
        data: { status: 'failed', downstreamStatus: downstream },
      });
      expect(h.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
        'command',
        'failed',
      );
    });

    it('wraps unexpected errors as a bad gateway with a generic downstream status', async () => {
      const h = harness();
      h.alana.reload.mockRejectedValue(new Error('private detail'));

      const error = await caught(h.service.start('main', input(), 'operator'));

      expect(error).toBeInstanceOf(BadGatewayException);
      expect(error.getResponse()).toMatchObject({
        message: 'Broadcast executor request failed',
      });
      expect(JSON.stringify(error.getResponse())).not.toContain('private');
      expect(h.prisma.broadcastDestinationCommand.update).toHaveBeenCalledWith({
        where: { id: 'command-1' },
        data: {
          status: 'failed',
          downstreamStatus: {
            requestedState: 'unknown',
            actualState: 'unknown',
            error: 'downstream request failed',
          },
        },
      });
    });

    it('maps other Alana statuses to a bad gateway carrying the state', async () => {
      const h = harness();
      h.alana.start.mockRejectedValue(
        new AlanaRequestError(500, state({ error: 'nope' })),
      );
      const error = await caught(h.service.start('main', input(), 'operator'));
      expect(error).toBeInstanceOf(BadGatewayException);
      expect(error.getResponse()).toMatchObject({ error: 'nope' });
    });

    it.each([
      ['requested', { requestedState: 'stopped', actualState: 'running' }],
      ['actual', { requestedState: 'running', actualState: 'stopped' }],
    ])(
      'rejects when Alana did not acknowledge Running (%s)',
      async (_name, change) => {
        const h = harness();
        h.alana.start.mockResolvedValue(running(change));
        const error = await caught(
          h.service.start('main', input(), 'operator'),
        );
        expect(error).toBeInstanceOf(BadGatewayException);
        expect(error.getResponse().error).toBe(
          'Alana did not acknowledge Running',
        );
      },
    );

    it('rejects when the reload acknowledgement does not match', async () => {
      const h = harness();
      h.alana.reload.mockResolvedValue(state({ pendingDestinations: null }));
      const error = await caught(h.service.start('main', input(), 'operator'));
      expect(error).toBeInstanceOf(BadGatewayException);
      expect(error.getResponse().error).toBe(
        'Alana did not acknowledge the exact destination selection',
      );
      expect(h.alana.start).not.toHaveBeenCalled();
    });

    describe('acknowledgement mismatches', () => {
      it.each([
        ['null acknowledgement', null],
        ['version', { ...ACK, version: 'other' }],
        ['hash', { ...ACK, selectionHash: 'f'.repeat(64) }],
        ['count', { ...ACK, count: 2 }],
        ['destination ids', { ...ACK, destinationIds: ['other'] }],
      ])('rejects a %s', async (_name, activeDestinations) => {
        const h = harness();
        h.alana.start.mockResolvedValue(running({ activeDestinations }));
        const error = await caught(
          h.service.start('main', input(), 'operator'),
        );
        expect(error).toBeInstanceOf(BadGatewayException);
        expect(error.getResponse().downstream).toMatchObject({
          requestedState: 'unknown',
          actualState: 'degraded',
          pendingDestinations: activeDestinations,
        });
      });
    });

    describe('with a selection version', () => {
      const withVersion = input({ selectionVersion: VERSION });

      it('reuses an existing matching selection', async () => {
        const h = harness();
        h.prisma.broadcastDestinationSelection.findUnique.mockResolvedValue(
          h.selection,
        );
        await h.service.start('main', withVersion, 'operator');
        expect(
          h.prisma.broadcastDestinationSelection.findUnique,
        ).toHaveBeenCalledWith({
          where: { version: VERSION },
          include: { destinations: true },
        });
        expect(
          h.prisma.broadcastDestinationSelection.create,
        ).not.toHaveBeenCalled();
      });

      it('reports unknown selections and selections of another program', async () => {
        const h = harness();
        h.prisma.broadcastDestinationSelection.findUnique.mockResolvedValue(
          null,
        );
        await expect(
          h.service.start('main', withVersion, 'operator'),
        ).rejects.toThrow(
          new NotFoundException('Destination selection not found'),
        );
        h.prisma.broadcastDestinationSelection.findUnique.mockResolvedValue({
          ...h.selection,
          programId: 'other',
        });
        await expect(
          h.service.start('main', withVersion, 'operator'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('rejects a version whose destinations differ from the confirmed ones', async () => {
        const h = harness();
        h.prisma.broadcastDestinationSelection.findUnique.mockResolvedValue(
          h.selection,
        );
        await expect(
          h.service.start(
            'main',
            input({
              selectionVersion: VERSION,
              destinationIds: ['primary', 'second'],
            }),
            'operator',
          ),
        ).rejects.toThrow(
          new ConflictException(
            'Selection version does not match the confirmed destinations',
          ),
        );
        await expect(
          h.service.start(
            'main',
            input({ selectionVersion: VERSION, destinationIds: ['second'] }),
            'operator',
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('orders stored destinations by position and rechecks selectability', async () => {
        const h = harness();
        const second = {
          ...h.selection.destinations[0],
          id: 'item-2',
          destinationId: 'second',
          position: 1,
        };
        h.prisma.broadcastDestinationSelection.findUnique.mockResolvedValue({
          ...h.selection,
          destinations: [second, h.selection.destinations[0]],
        });
        h.prisma.broadcastDestination.findMany.mockResolvedValue([]);
        await expect(
          h.service.start(
            'main',
            input({
              selectionVersion: VERSION,
              destinationIds: ['second', 'primary'],
            }),
            'operator',
          ),
        ).rejects.toThrow(
          new BadRequestException(
            'Every selected destination must exist and not be retired',
          ),
        );
        expect(h.prisma.broadcastDestination.findMany).toHaveBeenCalledWith({
          where: { id: { in: ['primary', 'second'] }, retiredAt: null },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        });
      });
    });

    describe('destination selectability', () => {
      it.each([
        [
          'more than 20 destinations',
          Array.from({ length: 21 }, (_, i) => `d${i}`),
        ],
        ['duplicate destinations', ['primary', 'primary']],
      ])('rejects %s', async (_name, destinationIds) => {
        const h = harness();
        await expect(
          h.service.start('main', input({ destinationIds }), 'operator'),
        ).rejects.toThrow(
          new BadRequestException(
            'Select between 1 and 20 unique destinations',
          ),
        );
      });

      it('rejects malformed destination ids and retired destinations', async () => {
        const h = harness();
        await expect(
          h.service.start(
            'main',
            input({ destinationIds: ['-x'] }),
            'operator',
          ),
        ).rejects.toThrow(new BadRequestException('Destination ID is invalid'));
        h.prisma.broadcastDestination.findMany.mockResolvedValue([]);
        await expect(
          h.service.start('main', input(), 'operator'),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });

  describe('reload', () => {
    it('stores the pending selection after an exact acknowledgement', async () => {
      const h = harness();
      const result = await h.service.reload('main', input(), 'operator');
      expect(h.alana.reload).toHaveBeenCalledWith(
        'main',
        'command-1:reload',
        PAYLOAD,
      );
      expect(result).toMatchObject({ action: 'reload', status: 'succeeded' });
      expect(
        h.transaction.broadcastDestinationRuntime.upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            requestedState: 'stopped',
            actualState: 'stopped',
            pendingSelectionId: 'selection-1',
          },
        }),
      );
    });

    it.each([
      ['requested state', { requestedState: 'running' }],
      ['actual state', { actualState: 'running' }],
      ['transition', { transition: 'starting' }],
    ])('requires a stopped broadcast (%s)', async (_name, change) => {
      const h = harness();
      h.alana.status.mockResolvedValue(state(change));
      await expect(
        h.service.reload('main', input(), 'operator'),
      ).rejects.toThrow(
        new ConflictException(
          'Destination reload requires the television broadcast to be stopped',
        ),
      );
    });

    it('maps an Alana status failure', async () => {
      const h = harness();
      h.alana.status.mockRejectedValue(new Error('x'));
      await expect(
        h.service.reload('main', input(), 'operator'),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('returns a stored success as a duplicate', async () => {
      const h = harness();
      h.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue({
        id: 'command-1',
        programId: 'main',
        action: 'reload',
        status: 'succeeded',
        sequence: 2,
        selection: h.selection,
        downstreamStatus: null,
        requestHash: createHash('sha256')
          .update(
            canonicalJson({
              action: 'reload',
              destinationIds: ['primary'],
              selectionVersion: null,
            }),
          )
          .digest('hex'),
      });
      const result = await h.service.reload('main', input(), 'operator');
      expect(result).toMatchObject({ duplicate: true, downstream: null });
      expect(h.alana.reload).not.toHaveBeenCalled();
    });

    it('records a failure when the selection is not acknowledged', async () => {
      const h = harness();
      h.alana.reload.mockResolvedValue(state({ pendingDestinations: null }));
      await expect(
        h.service.reload('main', input(), 'operator'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(h.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
        'command',
        'failed',
      );
    });
  });

  describe('stop', () => {
    const stopInput = { commandId: 'stop-1', confirmed: true };

    it('stops without a selection and clears the active selection', async () => {
      const h = harness();
      const result = await h.service.stop('main', stopInput, 'operator');
      expect(
        h.prisma.broadcastDestinationSelection.create,
      ).not.toHaveBeenCalled();
      expect(
        h.transaction.broadcastDestinationCommand.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'stop',
            selectionId: undefined,
          }),
        }),
      );
      expect(h.alana.stop).toHaveBeenCalledWith('main', 'stop-1', 5);
      expect(
        h.transaction.broadcastDestinationRuntime.upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            requestedState: 'stopped',
            actualState: 'stopped',
            activeSelectionId: null,
          },
        }),
      );
      expect(result).toMatchObject({ status: 'succeeded' });
    });

    it('reports empty selection data for a stop command whose selection is absent', async () => {
      const h = harness();
      h.transaction.broadcastDestinationCommand.create.mockImplementation(
        async ({ data }: any) => ({ ...data, selection: null }),
      );
      h.transaction.broadcastDestinationCommand.update.mockImplementation(
        async ({ data }: any) => ({
          id: 'stop-1',
          action: 'stop',
          sequence: 5,
          programId: 'main',
          selection: null,
          ...data,
        }),
      );
      const result = await h.service.stop('main', stopInput, 'operator');
      expect(result).toMatchObject({
        selectionVersion: null,
        selectionHash: null,
        destinationIds: [],
      });
    });

    it('returns a stored success as a duplicate', async () => {
      const h = harness();
      h.prisma.broadcastDestinationCommand.findUnique.mockResolvedValue({
        id: 'stop-1',
        programId: 'main',
        action: 'stop',
        status: 'succeeded',
        sequence: 2,
        selection: null,
        downstreamStatus: { done: true },
        requestHash: createHash('sha256')
          .update(
            canonicalJson({
              action: 'stop',
              destinationIds: [],
              selectionVersion: null,
            }),
          )
          .digest('hex'),
      });
      const result = await h.service.stop('main', stopInput, 'operator');
      expect(result).toMatchObject({ duplicate: true, destinationIds: [] });
      expect(h.alana.stop).not.toHaveBeenCalled();
    });

    it('maps an Alana status failure', async () => {
      const h = harness();
      h.alana.status.mockRejectedValue(
        new AlanaRequestError(503, state({ error: 'down' })),
      );
      await expect(
        h.service.stop('main', stopInput, 'operator'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it.each([
      ['requested', { requestedState: 'running' }],
      ['actual', { actualState: 'running' }],
    ])(
      'rejects when Alana did not acknowledge Stopped (%s)',
      async (_name, change) => {
        const h = harness();
        h.alana.stop.mockResolvedValue(state(change));
        const error = await caught(
          h.service.stop('main', stopInput, 'operator'),
        );
        expect(error).toBeInstanceOf(BadGatewayException);
        expect(error.getResponse().error).toBe(
          'Alana did not acknowledge Stopped',
        );
        expect(h.metrics.recordBroadcastDestination).toHaveBeenCalledWith(
          'command',
          'failed',
        );
      },
    );

    it('records failures from the executor', async () => {
      const h = harness();
      h.alana.stop.mockRejectedValue(
        new AlanaRequestError(409, state({ error: 'busy' })),
      );
      const error = await caught(h.service.stop('main', stopInput, 'operator'));
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(409);
    });
  });
});
