import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ExternalSourceSecurity } from './external-source.security';
import { ExternalSourcesService } from './external-sources.service';

const keyring = '{"1":"YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA="}';

function harness() {
  const created: any[] = [];
  const prisma: any = {
    externalSource: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return {
          ...data,
          programs: data.programs.create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
      findFirst: jest.fn(),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({
        ...data,
        id: 'source-a',
        teamId: 1,
        name: 'Camera',
        transport: 'whip',
        programs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    externalSourceCredential: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({ id: 'credential' }),
    },
    programState: { count: jest.fn().mockResolvedValue(1) },
    $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };
  const config = new ConfigService({
    EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
    EXTERNAL_SOURCE_CONFIG_KEYS: keyring,
    EXTERNAL_SOURCE_TEAM_QUOTA: '2',
  });
  const metrics = new ManagedMetricsService();
  return {
    prisma,
    created,
    service: new ExternalSourcesService(
      prisma,
      config,
      new ExternalSourceSecurity(config),
      metrics,
    ),
  };
}

describe('ExternalSourcesService', () => {
  const auth = { teamId: 1, permissions: ['alcantara:webrtc:operate'] };

  it('creates a team/program-scoped source and returns its push secret once', async () => {
    const { service, created } = harness();
    const result = await service.create(
      'operator-a',
      {
        name: 'Studio WHIP',
        transport: 'whip',
        programIds: ['main'],
        transportConfig: {},
      },
      auth,
    );
    expect(result.credential.secret).toHaveLength(43);
    expect(result.lifecycle).toBe('waiting');
    expect(created[0].teamId).toBe(1);
    expect(created[0].programs.create).toEqual([{ programId: 'main' }]);
    expect(created[0].credentials.create.secretHash).not.toContain(
      result.credential.secret,
    );
    expect(JSON.stringify(created[0])).not.toContain(result.credential.secret);
    expect(created[0].transportConfigCiphertext).not.toBe('{}');
  });

  it('enforces quotas and opaque team ownership', async () => {
    const quota = harness();
    quota.prisma.externalSource.count.mockResolvedValue(2);
    await expect(
      quota.service.create(
        'operator',
        {
          name: 'Extra',
          transport: 'rtmp',
          programIds: ['main'],
          transportConfig: {},
        },
        auth,
      ),
    ).rejects.toThrow('EXTERNAL_SOURCE_QUOTA_EXCEEDED');

    const ownership = harness();
    ownership.prisma.externalSource.findFirst.mockResolvedValue(null);
    await expect(
      ownership.service.get('other-team-source', auth),
    ).rejects.toThrow('External source not found');
    expect(ownership.prisma.externalSource.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'other-team-source', teamId: 1 },
      }),
    );
  });

  it('revokes prior credentials during rotation and clears runtime identity on revocation', async () => {
    const { service, prisma } = harness();
    prisma.externalSource.findFirst.mockResolvedValue({
      id: 'source-a',
      teamId: 1,
      name: 'Camera',
      transport: 'whip',
      lifecycle: 'connected',
      health: 'healthy',
      credentialVersion: 1,
      programs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null,
    });
    const rotated = await service.rotateCredential('source-a', auth);
    expect(rotated.credential.version).toBe(2);
    expect(prisma.externalSourceCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceId: 'source-a', revokedAt: null },
      }),
    );
    expect(prisma.externalSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycle: 'waiting',
          ingressId: null,
          participantIdentity: null,
        }),
      }),
    );

    await service.revoke('source-a', auth);
    expect(prisma.externalSource.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycle: 'revoked',
          health: 'unavailable',
          ingressId: null,
          participantIdentity: null,
        }),
      }),
    );
  });
});
