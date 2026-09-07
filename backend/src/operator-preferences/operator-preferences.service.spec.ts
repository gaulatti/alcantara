import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { OperatorPreferencesService } from './operator-preferences.service';

describe('OperatorPreferencesService authorization boundaries', () => {
  const transaction = {
    operatorPreference: {
      create: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
    operatorPreference: {
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    sharedConsoleLayout: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    programState: {
      findUnique: jest.fn(),
    },
  };
  const metrics = { recordPreference: jest.fn() };
  const service = new OperatorPreferencesService(
    prisma as never,
    metrics as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.operatorPreference.findMany.mockResolvedValue([]);
    prisma.operatorPreference.findUnique.mockResolvedValue(null);
    prisma.operatorPreference.deleteMany.mockResolvedValue({ count: 0 });
    transaction.operatorPreference.updateMany.mockResolvedValue({ count: 1 });
    transaction.operatorPreference.findUniqueOrThrow.mockResolvedValue({});
  });

  it('always scopes private profile reads to the authenticated subject and class', async () => {
    prisma.operatorPreference.findUnique.mockResolvedValue(null);

    await service.get({ principalId: null, subject: 'subject-a' }, 'desktop');

    expect(prisma.operatorPreference.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      take: 2,
      where: {
        deviceClass: 'desktop',
        OR: [{ principalId: null, subject: 'subject-a' }],
      },
    });
  });

  it('finds one canonical match while also checking the current subject', async () => {
    const migrated = {
      deviceClass: 'desktop',
      principalId: 'principal-a',
      subject: 'subject-from-first-pool',
    };
    prisma.operatorPreference.findMany.mockResolvedValue([migrated]);

    await expect(
      service.get(
        { principalId: 'principal-a', subject: 'subject-from-second-pool' },
        'desktop',
      ),
    ).resolves.toBe(migrated);

    expect(prisma.operatorPreference.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      take: 2,
      where: {
        deviceClass: 'desktop',
        OR: [
          { principalId: 'principal-a' },
          { principalId: null, subject: 'subject-from-second-pool' },
        ],
      },
    });
    expect(prisma.operatorPreference.findUnique).not.toHaveBeenCalled();
  });

  it('falls back only to the current subject while a row is unmigrated', async () => {
    await service.get(
      { principalId: 'principal-a', subject: 'subject-a' },
      'desktop',
    );

    expect(prisma.operatorPreference.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      take: 2,
      where: {
        deviceClass: 'desktop',
        OR: [
          { principalId: 'principal-a' },
          { principalId: null, subject: 'subject-a' },
        ],
      },
    });
  });

  it('fails visibly when multiple rows claim one canonical device profile', async () => {
    prisma.operatorPreference.findMany.mockResolvedValue([
      { principalId: 'principal-a', subject: 'subject-a' },
      { principalId: 'principal-a', subject: 'subject-b' },
    ]);

    await expect(
      service.get(
        { principalId: 'principal-a', subject: 'subject-a' },
        'desktop',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(metrics.recordPreference).toHaveBeenCalledWith('read', 'conflict');
  });

  it('fails when a canonical row and the current subjects legacy row converge', async () => {
    prisma.operatorPreference.findMany.mockResolvedValue([
      {
        deviceClass: 'desktop',
        principalId: 'principal-a',
        subject: 'subject-from-first-pool',
      },
      {
        deviceClass: 'desktop',
        principalId: null,
        subject: 'subject-from-second-pool',
      },
    ]);

    await expect(
      service.get(
        { principalId: 'principal-a', subject: 'subject-from-second-pool' },
        'desktop',
      ),
    ).rejects.toThrow('CANONICAL_IDENTITY_COLLISION');

    expect(prisma.operatorPreference.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      take: 2,
      where: {
        deviceClass: 'desktop',
        OR: [
          { principalId: 'principal-a' },
          { principalId: null, subject: 'subject-from-second-pool' },
        ],
      },
    });
    expect(metrics.recordPreference).toHaveBeenCalledWith('read', 'conflict');
  });

  it('does not read a current-subject row owned by another principal', async () => {
    await expect(
      service.get(
        { principalId: 'principal-a', subject: 'shared-pool-subject' },
        'desktop',
      ),
    ).resolves.toMatchObject({
      subject: 'shared-pool-subject',
      version: 0,
    });

    expect(prisma.operatorPreference.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'desc' },
      take: 2,
      where: {
        deviceClass: 'desktop',
        OR: [
          { principalId: 'principal-a' },
          { principalId: null, subject: 'shared-pool-subject' },
        ],
      },
    });
  });

  it('does not update a current-subject row owned by another principal', async () => {
    transaction.operatorPreference.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.save(
        { principalId: 'principal-a', subject: 'shared-pool-subject' },
        'desktop',
        {
          version: 3,
          profile: {
            workspace: 'director',
            dockWidth: 320,
            touchMode: false,
            shortcutsEnabled: true,
            selectedProgramId: 'main',
            transitions: { main: 'crescendo-prism' },
          },
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transaction.operatorPreference.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          subject: 'shared-pool-subject',
          deviceClass: 'desktop',
          version: 3,
          OR: [{ principalId: 'principal-a' }, { principalId: null }],
        },
      }),
    );
  });

  it('does not reset a current-subject row owned by another principal', async () => {
    await service.reset(
      { principalId: 'principal-a', subject: 'shared-pool-subject' },
      'desktop',
    );

    expect(prisma.operatorPreference.deleteMany).toHaveBeenCalledWith({
      where: {
        deviceClass: 'desktop',
        OR: [
          { principalId: 'principal-a' },
          { principalId: null, subject: 'shared-pool-subject' },
        ],
      },
    });
  });

  it('rejects discovery for another team before querying layouts', async () => {
    await expect(
      service.discover('team', '2', {
        teamId: 1,
        permissions: [ALCANTARA_PERMISSIONS.access],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.sharedConsoleLayout.findMany).not.toHaveBeenCalled();
  });

  it('rejects program discovery without program read access', async () => {
    await expect(
      service.discover('program', 'main', {
        teamId: 1,
        permissions: [ALCANTARA_PERMISSIONS.access],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.programState.findUnique).not.toHaveBeenCalled();
  });

  it('rejects direct publication without layout management permission', async () => {
    await expect(
      service.publish(
        { principalId: null, subject: 'subject-a' },
        {
          name: 'Forbidden layout',
          scope: 'team',
          scopeId: '1',
          sourceDeviceClass: 'desktop',
          profile: {
            workspace: 'director',
            dockWidth: 320,
            touchMode: false,
            shortcutsEnabled: true,
            selectedProgramId: 'main',
            transitions: { main: 'crescendo-prism' },
          },
        },
        {
          teamId: 1,
          permissions: [ALCANTARA_PERMISSIONS.access],
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.sharedConsoleLayout.upsert).not.toHaveBeenCalled();
  });
});
