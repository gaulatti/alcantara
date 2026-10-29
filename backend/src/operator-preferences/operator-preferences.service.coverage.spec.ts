import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { OperatorPreferencesService } from './operator-preferences.service';

const ACCESS = ALCANTARA_PERMISSIONS.access;
const PROGRAM_READ = ALCANTARA_PERMISSIONS.program.read;
const LAYOUT_MANAGE = ALCANTARA_PERMISSIONS.layout.manage;

function setup() {
  const transaction = {
    operatorPreference: {
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'reloaded' }),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      async (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
    operatorPreference: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    sharedConsoleLayout: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    programState: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  const metrics = { recordPreference: jest.fn() };
  const service = new OperatorPreferencesService(
    prisma as never,
    metrics as never,
  );
  return { service, prisma, transaction, metrics };
}

const profile = { selectedProgramId: 'main', workspace: 'audio' };
const subjectOnly = { subject: 'sub-a', principalId: null };

describe('OperatorPreferencesService coverage', () => {
  describe('identity normalization', () => {
    it('trims a principal and treats blank or null as unresolved', async () => {
      const { service, prisma } = setup();
      await service.get({ subject: 's', principalId: '  p-1  ' }, 'desktop');
      expect(
        prisma.operatorPreference.findMany.mock.calls[0][0].where.OR,
      ).toEqual([{ principalId: 'p-1' }, { principalId: null, subject: 's' }]);
      for (const principalId of ['   ', '', null]) {
        prisma.operatorPreference.findMany.mockClear();
        await service.get({ subject: 's', principalId }, 'desktop');
        expect(
          prisma.operatorPreference.findMany.mock.calls[0][0].where.OR,
        ).toEqual([{ principalId: null, subject: 's' }]);
      }
    });
  });

  describe('get', () => {
    it('returns the stored preference and records success', async () => {
      const { service, prisma, metrics } = setup();
      const stored = { subject: 'sub-a', deviceClass: 'tablet', version: 3 };
      prisma.operatorPreference.findMany.mockResolvedValue([stored]);
      await expect(service.get(subjectOnly, 'tablet')).resolves.toBe(stored);
      expect(metrics.recordPreference).toHaveBeenCalledWith('read', 'success');
    });

    it('returns a versionless default for a missing row', async () => {
      const { service, metrics } = setup();
      await expect(service.get(subjectOnly, 'phone')).resolves.toEqual({
        subject: 'sub-a',
        deviceClass: 'phone',
        version: 0,
        profile: {
          workspace: 'compact',
          touchMode: true,
          shortcutsEnabled: false,
          selectedProgramId: 'main',
          transitions: { main: 'crescendo-prism' },
        },
        createdAt: null,
        updatedAt: null,
      });
      expect(metrics.recordPreference).toHaveBeenCalledWith('read', 'default');
    });

    it('rejects an unknown device class', async () => {
      const { service, prisma } = setup();
      await expect(service.get(subjectOnly, 'watch')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.operatorPreference.findMany).not.toHaveBeenCalled();
    });

    it('records a conflict and fails on ambiguous ownership', async () => {
      const { service, prisma, metrics } = setup();
      prisma.operatorPreference.findMany.mockResolvedValue([{}, {}]);
      await expect(service.get(subjectOnly, 'desktop')).rejects.toThrow(
        'CANONICAL_IDENTITY_COLLISION',
      );
      expect(metrics.recordPreference).toHaveBeenCalledWith('read', 'conflict');
    });
  });

  describe('save', () => {
    it('creates version 0 with the caller subject and resolved principal', async () => {
      const { service, prisma, transaction, metrics } = setup();
      const created = { id: 'new' };
      transaction.operatorPreference.create.mockResolvedValue(created);

      await expect(
        service.save({ subject: 'sub-a', principalId: 'p-1' }, 'desktop', {
          version: 0,
          profile,
        }),
      ).resolves.toBe(created);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const data = transaction.operatorPreference.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        subject: 'sub-a',
        principalId: 'p-1',
        deviceClass: 'desktop',
      });
      expect(data.profile).toMatchObject({
        workspace: 'audio',
        selectedProgramId: 'main',
      });
      expect(transaction.operatorPreference.updateMany).not.toHaveBeenCalled();
      expect(metrics.recordPreference).toHaveBeenCalledWith('write', 'success');
    });

    it('creates under the existing row subject when the principal already owns one', async () => {
      const { service, prisma, transaction } = setup();
      prisma.operatorPreference.findMany.mockResolvedValue([
        { subject: 'old-pool-subject', principalId: 'p-1' },
      ]);
      transaction.operatorPreference.create.mockResolvedValue({});
      await service.save(
        { subject: 'new-pool-subject', principalId: 'p-1' },
        'desktop',
        {
          version: '0',
          profile,
        },
      );
      expect(
        transaction.operatorPreference.create.mock.calls[0][0].data.subject,
      ).toBe('old-pool-subject');
    });

    it('updates a legacy row under optimistic locking, restricted to the caller subject', async () => {
      const { service, prisma, transaction } = setup();
      prisma.operatorPreference.findMany.mockResolvedValue([
        { subject: 'sub-a', principalId: null },
      ]);
      await expect(
        service.save({ subject: 'sub-a', principalId: 'p-1' }, 'desktop', {
          version: 4,
          profile,
        }),
      ).resolves.toEqual({ id: 'reloaded' });

      const call = transaction.operatorPreference.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        subject: 'sub-a',
        deviceClass: 'desktop',
        version: 4,
        principalId: null,
      });
      expect(call.data.version).toEqual({ increment: 1 });
      expect(call.data.principalId).toBe('p-1');
      expect(
        transaction.operatorPreference.findUniqueOrThrow,
      ).toHaveBeenCalledWith({
        where: {
          subject_deviceClass: { subject: 'sub-a', deviceClass: 'desktop' },
        },
      });
    });

    it('does not backfill when the row has a principal or the caller has none', async () => {
      const { service, prisma, transaction } = setup();
      prisma.operatorPreference.findMany.mockResolvedValue([
        { subject: 'sub-a', principalId: 'p-1' },
      ]);
      await service.save({ subject: 'sub-b', principalId: 'p-1' }, 'desktop', {
        version: 1,
        profile,
      });
      let call = transaction.operatorPreference.updateMany.mock.calls[0][0];
      expect(call.where).toMatchObject({
        subject: 'sub-a',
        principalId: 'p-1',
      });
      expect(call.where).not.toHaveProperty('subjectSecond');
      expect(call.data).not.toHaveProperty('principalId');

      prisma.operatorPreference.findMany.mockResolvedValue([
        { subject: 'sub-a', principalId: null },
      ]);
      await service.save(subjectOnly, 'desktop', { version: 1, profile });
      call = transaction.operatorPreference.updateMany.mock.calls[1][0];
      expect(call.data).not.toHaveProperty('principalId');
    });

    it('updates against the caller subject when no row exists yet', async () => {
      const { service, transaction } = setup();
      await service.save(subjectOnly, 'desktop', { version: 2, profile });
      expect(
        transaction.operatorPreference.updateMany.mock.calls[0][0].where,
      ).toEqual({
        subject: 'sub-a',
        deviceClass: 'desktop',
        version: 2,
        principalId: null,
      });
    });

    it.each([undefined, 'abc', -1, 1.5, Infinity, '1e400'])(
      'requires a safe non-negative integer version (%p)',
      async (version) => {
        const { service, prisma } = setup();
        await expect(
          service.save(subjectOnly, 'desktop', { version, profile }),
        ).rejects.toThrow('PROFILE_VERSION_REQUIRED');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('rejects malformed profiles before writing', async () => {
      const { service, prisma } = setup();
      await expect(
        service.save(subjectOnly, 'desktop', { version: 0, profile: 'bad' }),
      ).rejects.toThrow('profile must be an object');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers a version mismatch with the authoritative row and records a conflict', async () => {
      const { service, prisma, transaction, metrics } = setup();
      transaction.operatorPreference.updateMany.mockResolvedValue({ count: 0 });
      const current = { subject: 'sub-a', version: 9 };
      prisma.operatorPreference.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([current]);

      const failure = await service
        .save(subjectOnly, 'desktop', { version: 1, profile })
        .catch((e: ConflictException) => e);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toEqual({
        error: 'PROFILE_VERSION_CONFLICT',
        authoritative: current,
      });
      expect(metrics.recordPreference).toHaveBeenCalledWith(
        'write',
        'conflict',
      );
    });

    it('treats a unique-constraint race as a conflict', async () => {
      const { service, prisma, transaction, metrics } = setup();
      transaction.operatorPreference.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.save(subjectOnly, 'desktop', { version: 0, profile }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(metrics.recordPreference).toHaveBeenCalledWith(
        'write',
        'conflict',
      );
      expect(prisma.operatorPreference.findMany).toHaveBeenCalledTimes(2);
    });

    it('records failure and rethrows other Prisma errors and unknown errors', async () => {
      const { service, transaction, metrics } = setup();
      const other = new Prisma.PrismaClientKnownRequestError('other', {
        code: 'P2025',
        clientVersion: 'test',
      });
      transaction.operatorPreference.create.mockRejectedValueOnce(other);
      await expect(
        service.save(subjectOnly, 'desktop', { version: 0, profile }),
      ).rejects.toBe(other);

      const boom = new Error('connection lost');
      transaction.operatorPreference.create.mockRejectedValueOnce(boom);
      await expect(
        service.save(subjectOnly, 'desktop', { version: 0, profile }),
      ).rejects.toBe(boom);
      expect(metrics.recordPreference).toHaveBeenCalledTimes(2);
      expect(metrics.recordPreference).toHaveBeenNthCalledWith(
        1,
        'write',
        'failure',
      );
      expect(metrics.recordPreference).toHaveBeenNthCalledWith(
        2,
        'write',
        'failure',
      );
    });
  });

  describe('reset', () => {
    it('resets one class for the owned rows', async () => {
      const { service, prisma, metrics } = setup();
      await expect(
        service.reset({ subject: 'sub-a', principalId: 'p-1' }, 'tablet'),
      ).resolves.toEqual({
        deviceClass: 'tablet',
        version: 0,
        profile: expect.objectContaining({
          workspace: 'compact',
          dockWidth: 300,
        }),
      });
      expect(prisma.operatorPreference.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [{ principalId: 'p-1' }, { principalId: null, subject: 'sub-a' }],
          deviceClass: 'tablet',
        },
      });
      expect(metrics.recordPreference).toHaveBeenCalledWith(
        'reset-class',
        'success',
      );
    });

    it('rejects an invalid class without deleting', async () => {
      const { service, prisma } = setup();
      await expect(service.reset(subjectOnly, 'watch')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.operatorPreference.deleteMany).not.toHaveBeenCalled();
    });

    it('resets every class when none is given', async () => {
      const { service, prisma, metrics } = setup();
      await expect(service.reset(subjectOnly)).resolves.toEqual({ ok: true });
      expect(prisma.operatorPreference.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ principalId: null, subject: 'sub-a' }] },
      });
      expect(metrics.recordPreference).toHaveBeenCalledWith(
        'reset-all',
        'success',
      );
    });

    it('treats an empty class string as reset-all', async () => {
      const { service, metrics } = setup();
      await service.reset(subjectOnly, '');
      expect(metrics.recordPreference).toHaveBeenCalledWith(
        'reset-all',
        'success',
      );
    });
  });

  describe('discover and scope access', () => {
    it('lists active team layouts for the caller team', async () => {
      const { service, prisma } = setup();
      const layouts = [{ id: 'l1' }];
      prisma.sharedConsoleLayout.findMany.mockResolvedValue(layouts);
      await expect(
        service.discover('team', '7', { permissions: [ACCESS], teamId: 7 }),
      ).resolves.toBe(layouts);
      expect(prisma.sharedConsoleLayout.findMany).toHaveBeenCalledWith({
        where: { scope: 'team', scopeId: '7', retiredAt: null },
        orderBy: [{ name: 'asc' }],
      });
      expect(prisma.programState.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a team scope id that is not the caller team', async () => {
      const { service, prisma } = setup();
      await expect(
        service.discover('team', '8', { permissions: [ACCESS], teamId: 7 }),
      ).rejects.toThrow('TEAM_SCOPE_MISMATCH');
      expect(prisma.sharedConsoleLayout.findMany).not.toHaveBeenCalled();
    });

    it('requires program read for program scope and resolves the program', async () => {
      const { service, prisma } = setup();
      await service.discover('program', 'main', {
        permissions: [PROGRAM_READ],
        teamId: 1,
      });
      expect(prisma.programState.findUnique).toHaveBeenCalledWith({
        where: { programId: 'main' },
        select: { id: true },
      });
      expect(prisma.sharedConsoleLayout.findMany).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown program', async () => {
      const { service, prisma } = setup();
      prisma.programState.findUnique.mockResolvedValue(null);
      await expect(
        service.discover('program', 'gone', {
          permissions: [PROGRAM_READ],
          teamId: 1,
        }),
      ).rejects.toThrow(new NotFoundException('Program not found'));
    });

    it('names the missing permission in the 403 body', async () => {
      const { service } = setup();
      const failure = await service
        .discover('team', '1', { permissions: [], teamId: 1 })
        .catch((e: ForbiddenException) => e);
      expect((failure as ForbiddenException).getResponse()).toEqual({
        error: 'FORBIDDEN',
        permission: ACCESS,
      });
      const program = await service
        .discover('program', 'main', { permissions: [ACCESS], teamId: 1 })
        .catch((e: ForbiddenException) => e);
      expect((program as ForbiddenException).getResponse()).toEqual({
        error: 'FORBIDDEN',
        permission: PROGRAM_READ,
      });
    });

    it('treats an unrecognized scope as a program lookup requiring only access', async () => {
      const { service, prisma } = setup();
      await service.discover('other', 'x', {
        permissions: [ACCESS],
        teamId: 1,
      });
      expect(prisma.programState.findUnique).toHaveBeenCalledWith({
        where: { programId: 'x' },
        select: { id: true },
      });
    });
  });

  describe('publish', () => {
    const authorization = { permissions: [LAYOUT_MANAGE], teamId: 3 };
    const body = {
      scope: 'team',
      scopeId: '3',
      sourceDeviceClass: 'desktop',
      name: '  Layout A  ',
      description: '  notes ',
      profile,
    };

    it('upserts a trimmed layout owned by the caller', async () => {
      const { service, prisma, metrics } = setup();
      const saved = { id: 'l1' };
      prisma.sharedConsoleLayout.upsert.mockResolvedValue(saved);

      await expect(
        service.publish(
          { subject: 's', principalId: 'p-1' },
          body,
          authorization,
        ),
      ).resolves.toBe(saved);

      const arg = prisma.sharedConsoleLayout.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        scope_scopeId_name: { scope: 'team', scopeId: '3', name: 'Layout A' },
      });
      expect(arg.create).toMatchObject({
        ownerSubject: 's',
        ownerPrincipalId: 'p-1',
        name: 'Layout A',
        description: 'notes',
        scope: 'team',
        scopeId: '3',
        sourceDeviceClass: 'desktop',
      });
      expect(arg.update).toMatchObject({
        ownerSubject: 's',
        ownerPrincipalId: 'p-1',
        description: 'notes',
        version: { increment: 1 },
        retiredAt: null,
      });
      expect(metrics.recordPreference).toHaveBeenCalledWith(
        'publish',
        'success',
      );
    });

    it.each([undefined, null, ''])(
      'stores a null description for %p',
      async (description) => {
        const { service, prisma } = setup();
        await service.publish(
          subjectOnly,
          { ...body, description },
          authorization,
        );
        expect(
          prisma.sharedConsoleLayout.upsert.mock.calls[0][0].create.description,
        ).toBeNull();
      },
    );

    it('requires layout management before any lookup', async () => {
      const { service, prisma } = setup();
      await expect(
        service.publish(subjectOnly, body, {
          permissions: [ACCESS],
          teamId: 3,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sharedConsoleLayout.upsert).not.toHaveBeenCalled();
    });

    it.each([
      ['scope', { scope: 'global' }, 'scope must be program or team'],
      ['scopeId type', { scopeId: 5 }, 'scopeId is invalid'],
      ['blank scopeId', { scopeId: '  ' }, 'scopeId is invalid'],
      ['long scopeId', { scopeId: 'x'.repeat(129) }, 'scopeId is invalid'],
      ['name type', { name: 5 }, 'name is invalid'],
      ['blank name', { name: ' ' }, 'name is invalid'],
      ['long name', { name: 'n'.repeat(121) }, 'name is invalid'],
      [
        'description',
        { description: 'd'.repeat(501) },
        'description is invalid',
      ],
      ['description type', { description: 5 }, 'description is invalid'],
    ])('rejects an invalid %s', async (_label, override, message) => {
      const { service, prisma } = setup();
      await expect(
        service.publish(subjectOnly, { ...body, ...override }, authorization),
      ).rejects.toThrow(message);
      expect(prisma.sharedConsoleLayout.upsert).not.toHaveBeenCalled();
    });

    it('rejects a missing or invalid source device class', async () => {
      const { service } = setup();
      await expect(
        service.publish(
          subjectOnly,
          { ...body, sourceDeviceClass: 5 },
          authorization,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.publish(subjectOnly, { ...body, profile: null }, authorization),
      ).rejects.toThrow('profile must be an object');
    });

    it('accepts the maximum-length bounded values', async () => {
      const { service, prisma } = setup();
      await service.publish(
        subjectOnly,
        {
          ...body,
          scope: 'program',
          scopeId: 'x'.repeat(128),
          name: 'n'.repeat(120),
          description: 'd'.repeat(500),
        },
        authorization,
      );
      expect(prisma.sharedConsoleLayout.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('retire', () => {
    const layout = { id: 'l1', scope: 'team', scopeId: '3' };

    it('404s for an unknown layout', async () => {
      const { service, prisma } = setup();
      prisma.sharedConsoleLayout.findUnique.mockResolvedValue(null);
      await expect(
        service.retire('l1', { permissions: [LAYOUT_MANAGE], teamId: 3 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sharedConsoleLayout.update).not.toHaveBeenCalled();
    });

    it('checks management access in the layout scope before retiring', async () => {
      const { service, prisma } = setup();
      prisma.sharedConsoleLayout.findUnique.mockResolvedValue(layout);
      await expect(
        service.retire('l1', { permissions: [ACCESS], teamId: 3 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sharedConsoleLayout.update).not.toHaveBeenCalled();
    });

    it('stamps retiredAt, bumps the version, and records the retirement', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-05-06T07:08:09Z'));
      try {
        const { service, prisma, metrics } = setup();
        const retired = { id: 'l1', retiredAt: new Date() };
        prisma.sharedConsoleLayout.findUnique.mockResolvedValue(layout);
        prisma.sharedConsoleLayout.update.mockResolvedValue(retired);
        await expect(
          service.retire('l1', { permissions: [LAYOUT_MANAGE], teamId: 3 }),
        ).resolves.toBe(retired);
        expect(prisma.sharedConsoleLayout.update).toHaveBeenCalledWith({
          where: { id: 'l1' },
          data: {
            retiredAt: new Date('2026-05-06T07:08:09Z'),
            version: { increment: 1 },
          },
        });
        expect(metrics.recordPreference).toHaveBeenCalledWith(
          'retire',
          'success',
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('load', () => {
    const layout = {
      id: 'l1',
      scope: 'team',
      scopeId: '3',
      sourceDeviceClass: 'desktop',
      profile,
      retiredAt: null,
    };
    const authorization = { permissions: [ACCESS], teamId: 3 };

    it.each([
      ['missing', null],
      ['retired', { ...layout, retiredAt: new Date() }],
    ])('404s for a %s layout', async (_label, row) => {
      const { service, prisma } = setup();
      prisma.sharedConsoleLayout.findUnique.mockResolvedValue(row);
      await expect(
        service.load(
          subjectOnly,
          'l1',
          { deviceClass: 'desktop', version: 0 },
          authorization,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('requires scope access', async () => {
      const { service, prisma } = setup();
      prisma.sharedConsoleLayout.findUnique.mockResolvedValue(layout);
      await expect(
        service.load(
          subjectOnly,
          'l1',
          { deviceClass: 'desktop', version: 0 },
          { permissions: [], teamId: 3 },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([['tablet'], [5]])(
      'rejects a device class mismatch (%p) naming the source class',
      async (deviceClass) => {
        const { service, prisma } = setup();
        prisma.sharedConsoleLayout.findUnique.mockResolvedValue(layout);
        const failure = await service
          .load(subjectOnly, 'l1', { deviceClass, version: 0 }, authorization)
          .catch((e: unknown) => e);
        if (deviceClass === 5) {
          expect(failure).toBeInstanceOf(BadRequestException);
        } else {
          expect((failure as ConflictException).getResponse()).toEqual({
            error: 'DEVICE_CLASS_MISMATCH',
            sourceDeviceClass: 'desktop',
          });
        }
      },
    );

    it('saves the layout profile as the caller preference and records the load', async () => {
      const { service, prisma, transaction, metrics } = setup();
      prisma.sharedConsoleLayout.findUnique.mockResolvedValue(layout);
      const created = { id: 'pref' };
      transaction.operatorPreference.create.mockResolvedValue(created);

      await expect(
        service.load(
          subjectOnly,
          'l1',
          { deviceClass: 'desktop', version: 0 },
          authorization,
        ),
      ).resolves.toEqual({ layout, preference: created });

      expect(
        transaction.operatorPreference.create.mock.calls[0][0].data.profile,
      ).toMatchObject({
        workspace: 'audio',
      });
      expect(metrics.recordPreference).toHaveBeenCalledWith('write', 'success');
      expect(metrics.recordPreference).toHaveBeenCalledWith(
        'load-shared',
        'success',
      );
    });
  });

  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      const {
        OperatorPreferencesService: Isolated,
      } = require('./operator-preferences.service');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
      ]);
    });
  });
});
