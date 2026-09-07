import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { OperatorPreferencesService } from './operator-preferences.service';

describe('OperatorPreferencesService authorization boundaries', () => {
  const prisma = {
    operatorPreference: {
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
  });

  it('always scopes private profile reads to the authenticated subject and class', async () => {
    prisma.operatorPreference.findUnique.mockResolvedValue(null);

    await service.get({ principalId: null, subject: 'subject-a' }, 'desktop');

    expect(prisma.operatorPreference.findUnique).toHaveBeenCalledWith({
      where: {
        subject_deviceClass: {
          subject: 'subject-a',
          deviceClass: 'desktop',
        },
      },
    });
  });

  it('prefers one canonical match across pools', async () => {
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
      where: { deviceClass: 'desktop', principalId: 'principal-a' },
    });
    expect(prisma.operatorPreference.findUnique).not.toHaveBeenCalled();
  });

  it('falls back only to the current subject while a row is unmigrated', async () => {
    await service.get(
      { principalId: 'principal-a', subject: 'subject-a' },
      'desktop',
    );

    expect(prisma.operatorPreference.findUnique).toHaveBeenCalledWith({
      where: {
        subject_deviceClass: {
          subject: 'subject-a',
          deviceClass: 'desktop',
        },
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
