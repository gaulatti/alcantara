import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ALCANTARA_PERMISSIONS as permissions } from '../auth/permissions';
import { OperatorPreferencesService } from './operator-preferences.service';
import { defaultProfile } from './operator-preferences.types';

const caller = { subject: 'pool-subject', principalId: 'principal-a' };
const authorization = {
  teamId: 7,
  permissions: [
    permissions.access,
    permissions.program.read,
    permissions.layout.manage,
  ],
};
function fixture() {
  let preference: any = null;
  let layout: any = {
    id: 'layout-1',
    scope: 'program',
    scopeId: 'news',
    sourceDeviceClass: 'desktop',
    profile: defaultProfile('desktop'),
    retiredAt: null,
    version: 1,
  };
  const privateRows = {
    create: jest.fn(async ({ data }: any) => {
      preference = { ...data, version: 1 };
      return preference;
    }),
    updateMany: jest.fn(async ({ data }: any) => {
      preference = {
        ...preference,
        ...data,
        version: (preference?.version ?? 0) + 1,
      };
      return { count: 1 };
    }),
    findUniqueOrThrow: jest.fn(async () => preference),
  };
  const prisma = {
    operatorPreference: {
      findMany: jest.fn(async () => (preference ? [preference] : [])),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    sharedConsoleLayout: {
      findMany: jest.fn(async () => [layout]),
      findUnique: jest.fn(async () => layout),
      upsert: jest.fn(async ({ create }: any) => {
        layout = { id: 'layout-1', version: 1, retiredAt: null, ...create };
        return layout;
      }),
      update: jest.fn(async ({ data }: any) => {
        layout = { ...layout, ...data, version: layout.version + 1 };
        return layout;
      }),
    },
    programState: { findUnique: jest.fn().mockResolvedValue({ id: 8 }) },
    $transaction: jest.fn(async (operation: (tx: any) => unknown) =>
      operation({ operatorPreference: privateRows }),
    ),
  };
  const metrics = { recordPreference: jest.fn() };
  const service = new OperatorPreferencesService(prisma as any, metrics as any);
  return {
    service,
    prisma,
    privateRows,
    metrics,
    layout: () => layout,
    preference: () => preference,
    seedPreference: (value: any) => {
      preference = value;
    },
  };
}
const sharedInput = (override: Record<string, unknown> = {}) => ({
  scope: 'program',
  scopeId: 'news',
  sourceDeviceClass: 'desktop',
  name: 'Desk layout',
  description: 'Shared desk',
  profile: defaultProfile('desktop'),
  ...override,
});

describe('OperatorPreferencesService shared layouts and optimistic persistence', () => {
  it('persists a first canonical profile and reads the stored version instead of inventing one', async () => {
    const f = fixture();
    const profile = { ...defaultProfile('desktop'), dockWidth: 444 };
    const saved = await f.service.save(
      { ...caller, principalId: ' principal-a ' },
      'desktop',
      { version: 0, profile },
    );
    expect(saved).toMatchObject({
      subject: caller.subject,
      principalId: 'principal-a',
      profile,
      version: 1,
    });
    expect(await f.service.get(caller, 'desktop')).toBe(saved);
    expect(f.metrics.recordPreference.mock.calls).toEqual([
      ['write', 'success'],
      ['read', 'success'],
    ]);
  });

  it('backfills an owned legacy row through an optimistic version-bound update', async () => {
    const f = fixture();
    f.seedPreference({
      subject: caller.subject,
      principalId: null,
      deviceClass: 'desktop',
      version: 2,
      profile: defaultProfile('desktop'),
    });
    const saved = await f.service.save(caller, 'desktop', {
      version: 2,
      profile: { ...defaultProfile('desktop'), workspace: 'audio' },
    });
    expect(f.privateRows.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          subject: caller.subject,
          principalId: null,
          deviceClass: 'desktop',
          version: 2,
        },
        data: {
          profile: expect.objectContaining({ workspace: 'audio' }),
          version: { increment: 1 },
          principalId: 'principal-a',
        },
      }),
    );
    expect(saved.version).toBe(3);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])(
    'rejects an invalid optimistic version before a write: %p',
    async (version) => {
      const f = fixture();
      await expect(
        f.service.save(caller, 'desktop', {
          version,
          profile: defaultProfile('desktop'),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('returns the authoritative saved profile on a duplicate first-write race and keeps unrelated failures visible', async () => {
    const f = fixture();
    const winner = {
      subject: caller.subject,
      principalId: caller.principalId,
      deviceClass: 'desktop',
      version: 1,
      profile: defaultProfile('desktop'),
    };
    f.prisma.$transaction.mockImplementationOnce(async () => {
      f.seedPreference(winner);
      throw new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });
    try {
      await f.service.save(caller, 'desktop', {
        version: 0,
        profile: defaultProfile('desktop'),
      });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        error: 'PROFILE_VERSION_CONFLICT',
        authoritative: winner,
      });
    }
    const outage = new Error('write unavailable');
    f.prisma.$transaction.mockRejectedValueOnce(outage);
    await expect(
      f.service.save(caller, 'desktop', {
        version: 1,
        profile: defaultProfile('desktop'),
      }),
    ).rejects.toBe(outage);
    expect(f.metrics.recordPreference).toHaveBeenLastCalledWith(
      'write',
      'failure',
    );
  });

  it('resets all owned device classes and preserves explicit class defaults for an unlinked subject', async () => {
    const f = fixture();
    expect(await f.service.reset(caller)).toEqual({ ok: true });
    expect(f.prisma.operatorPreference.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { principalId: 'principal-a' },
          { principalId: null, subject: caller.subject },
        ],
      },
    });
    expect(
      await f.service.reset({ subject: 'legacy', principalId: '   ' }, 'phone'),
    ).toEqual({
      deviceClass: 'phone',
      version: 0,
      profile: defaultProfile('phone'),
    });
    expect(f.prisma.operatorPreference.deleteMany).toHaveBeenLastCalledWith({
      where: {
        OR: [{ principalId: null, subject: 'legacy' }],
        deviceClass: 'phone',
      },
    });
  });

  it.each(['program', 'team'])(
    'discovers only active layouts in an authorized %s scope',
    async (scope) => {
      const f = fixture();
      const scopeId = scope === 'program' ? 'news' : '7';
      expect(await f.service.discover(scope, scopeId, authorization)).toEqual([
        f.layout(),
      ]);
      expect(f.prisma.sharedConsoleLayout.findMany).toHaveBeenCalledWith({
        where: { scope, scopeId, retiredAt: null },
        orderBy: [{ name: 'asc' }],
      });
    },
  );

  it('requires a real program for program discovery and permission for team discovery', async () => {
    const f = fixture();
    f.prisma.programState.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.discover('program', 'missing', authorization),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.discover('team', '7', { ...authorization, permissions: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.sharedConsoleLayout.findMany).not.toHaveBeenCalled();
  });

  it.each(['program', 'team'])(
    'publishes a coherent %s layout with canonical ownership and normalized metadata',
    async (scope) => {
      const f = fixture();
      const input = sharedInput({
        scope,
        scopeId: scope === 'program' ? ' news ' : ' 7 ',
        name: ' Desk layout ',
        description: ' Shared desk ',
      });
      const result = await f.service.publish(caller, input, authorization);
      expect(result).toMatchObject({
        ownerSubject: caller.subject,
        ownerPrincipalId: caller.principalId,
        name: 'Desk layout',
        description: 'Shared desk',
        sourceDeviceClass: 'desktop',
        profile: defaultProfile('desktop'),
      });
      expect(f.prisma.sharedConsoleLayout.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            scope_scopeId_name: {
              scope,
              scopeId: scope === 'program' ? 'news' : '7',
              name: 'Desk layout',
            },
          },
          update: expect.objectContaining({
            retiredAt: null,
            version: { increment: 1 },
          }),
        }),
      );
      expect(f.metrics.recordPreference).toHaveBeenLastCalledWith(
        'publish',
        'success',
      );
    },
  );

  it.each([undefined, null, ''])(
    'stores an absent optional shared description as null: %p',
    async (description) => {
      const f = fixture();
      expect(
        (
          await f.service.publish(
            caller,
            sharedInput({ description }),
            authorization,
          )
        ).description,
      ).toBeNull();
    },
  );

  it.each([
    { scope: 'organization' },
    { scopeId: '' },
    { scopeId: 'x'.repeat(129) },
    { name: 7 },
    { name: '' },
    { name: 'x'.repeat(121) },
    { description: 'x'.repeat(501) },
  ])(
    'rejects invalid shared metadata without creating or replacing a layout: %p',
    async (override) => {
      const f = fixture();
      await expect(
        f.service.publish(caller, sharedInput(override), authorization),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.prisma.sharedConsoleLayout.upsert).not.toHaveBeenCalled();
    },
  );

  it('validates shared source device/profile and team scope before publication', async () => {
    const f = fixture();
    await expect(
      f.service.publish(
        caller,
        sharedInput({ sourceDeviceClass: 7 }),
        authorization,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.publish(caller, sharedInput({ profile: null }), authorization),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.publish(
        caller,
        sharedInput({ scope: 'team', scopeId: '8' }),
        authorization,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.sharedConsoleLayout.upsert).not.toHaveBeenCalled();
  });

  it('retires an authorized current layout atomically and rejects a missing layout', async () => {
    const f = fixture();
    expect(await f.service.retire('layout-1', authorization)).toMatchObject({
      retiredAt: expect.any(Date),
      version: 2,
    });
    expect(f.prisma.sharedConsoleLayout.update).toHaveBeenCalledWith({
      where: { id: 'layout-1' },
      data: { retiredAt: expect.any(Date), version: { increment: 1 } },
    });
    expect(f.metrics.recordPreference).toHaveBeenLastCalledWith(
      'retire',
      'success',
    );
    f.prisma.sharedConsoleLayout.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.retire('missing', authorization),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires management authority to retire a shared layout', async () => {
    const f = fixture();
    await expect(
      f.service.retire('layout-1', {
        ...authorization,
        permissions: [permissions.access],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.sharedConsoleLayout.update).not.toHaveBeenCalled();
  });

  it('loads a permitted shared profile through the same canonical optimistic save boundary', async () => {
    const f = fixture();
    const result = await f.service.load(
      caller,
      'layout-1',
      { deviceClass: 'desktop', version: 0 },
      authorization,
    );
    expect(result.layout).toBe(f.layout());
    expect(result.preference).toMatchObject({
      principalId: caller.principalId,
      subject: caller.subject,
      version: 1,
      profile: defaultProfile('desktop'),
    });
    expect(f.metrics.recordPreference.mock.calls).toEqual([
      ['write', 'success'],
      ['load-shared', 'success'],
    ]);
  });

  it('rejects missing/retired shared layouts and cross-device loads before changing private preferences', async () => {
    const f = fixture();
    f.prisma.sharedConsoleLayout.findUnique.mockResolvedValueOnce(null);
    await expect(
      f.service.load(
        caller,
        'missing',
        { deviceClass: 'desktop', version: 0 },
        authorization,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.layout().retiredAt = new Date();
    await expect(
      f.service.load(
        caller,
        'layout-1',
        { deviceClass: 'desktop', version: 0 },
        authorization,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.layout().retiredAt = null;
    await expect(
      f.service.load(
        caller,
        'layout-1',
        { deviceClass: 'phone', version: 0 },
        authorization,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
