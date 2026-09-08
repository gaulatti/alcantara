import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../src/observability/managed-metrics.service';
import { PrismaService } from '../src/prisma.service';
import { ExternalSourceSecurity } from '../src/external-sources/external-source.security';
import { ExternalSourcesService } from '../src/external-sources/external-sources.service';
import { ScenesService } from '../src/scenes/scenes.service';

describe('external source registry with PostgreSQL (e2e)', () => {
  const auth = { teamId: 43, permissions: ['alcantara:webrtc:operate'] };
  let prisma: PrismaService;
  let service: ExternalSourcesService;

  beforeAll(async () => {
    process.env.EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION = '1';
    process.env.EXTERNAL_SOURCE_CONFIG_KEYS =
      '{"1":"YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA="}';
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.externalSource.deleteMany({ where: { teamId: auth.teamId } });
    await prisma.programState.upsert({
      where: { programId: 'source-e2e' },
      update: {},
      create: { programId: 'source-e2e' },
    });
    const config = new ConfigService(process.env);
    service = new ExternalSourcesService(
      prisma,
      config,
      new ExternalSourceSecurity(config),
      new ManagedMetricsService(),
    );
  });

  afterAll(async () => {
    await prisma.externalSource.deleteMany({ where: { teamId: auth.teamId } });
    await prisma.programState.deleteMany({
      where: { programId: 'source-e2e' },
    });
    await prisma.$disconnect();
    delete process.env.EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION;
    delete process.env.EXTERNAL_SOURCE_CONFIG_KEYS;
  });

  it('persists encrypted config, one-time credentials, lifecycle, rotation, and cleanup', async () => {
    const created: any = await service.create(
      'e2e-operator',
      {
        name: 'E2E WHIP',
        transport: 'whip',
        programIds: ['source-e2e'],
        transportConfig: {},
      },
      auth,
    );
    expect(created.credential.secret).toHaveLength(43);
    const raw = await prisma.externalSource.findUniqueOrThrow({
      where: { id: created.id },
      include: { credentials: true, programs: true },
    });
    expect(raw.programs.map((item) => item.programId)).toEqual(['source-e2e']);
    expect(raw.transportConfigCiphertext).not.toContain('{}');
    expect(raw.credentials[0].secretHash).not.toContain(
      created.credential.secret,
    );

    const rotated: any = await service.rotateCredential(created.id, auth);
    expect(rotated.credential.version).toBe(2);
    const credentials = await prisma.externalSourceCredential.findMany({
      where: { sourceId: created.id },
      orderBy: { version: 'asc' },
    });
    expect(credentials).toHaveLength(2);
    expect(credentials[0].revokedAt).not.toBeNull();
    expect(credentials[1].secretHash).not.toContain(rotated.credential.secret);

    const connected: any = await service.reconcile(
      created.id,
      {
        lifecycle: 'connected',
        health: 'healthy',
        ingressId: 'ingress-e2e',
        participantIdentity: 'source-e2e',
      },
      auth,
    );
    expect(connected.lifecycle).toBe('connected');
    expect(connected.lastConnectedAt).not.toBeNull();
    await service.revoke(created.id, auth);
    const revoked = await prisma.externalSource.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(revoked).toMatchObject({
      lifecycle: 'revoked',
      health: 'unavailable',
      ingressId: null,
      participantIdentity: null,
    });
    expect(
      await prisma.externalSourceCredential.count({
        where: { sourceId: created.id, revokedAt: null },
      }),
    ).toBe(0);
  });

  it('revalidates pull URLs and denies unsafe redirects', async () => {
    const created: any = await service.create(
      'e2e-operator',
      {
        name: 'E2E HLS',
        transport: 'hls',
        programIds: ['source-e2e'],
        transportConfig: { url: 'https://93.184.216.34/feed.m3u8' },
      },
      auth,
    );
    expect(created).not.toHaveProperty('transportConfig');
    await expect(
      service.validateRedirect(
        created.id,
        'https://127.0.0.1/private.m3u8',
        auth,
      ),
    ).rejects.toThrow('not permitted');
    await expect(
      service.reconcile(
        created.id,
        { lifecycle: 'waiting', health: 'healthy' },
        auth,
      ),
    ).resolves.toMatchObject({ lifecycle: 'waiting' });

    const layout = await prisma.layout.create({
      data: {
        name: `E2E source layout ${created.id}`,
        componentType: 'video-stream',
        settings: '{}',
      },
    });
    const scenes = new ScenesService(prisma, {
      getProgramIdsByAssignedScene: jest.fn().mockResolvedValue([]),
      broadcastUpdate: jest.fn(),
    } as any);
    await expect(
      scenes.create({
        name: 'Unsafe URL scene',
        layoutId: layout.id,
        externalSourceId: created.id,
        metadata: {
          'video-stream': { sourceUrl: 'https://example.invalid/live' },
        },
      }),
    ).rejects.toThrow('reference externalSourceId');
    const scene = await scenes.create({
      name: 'Stable source scene',
      layoutId: layout.id,
      externalSourceId: created.id,
      metadata: { 'video-stream': {} },
    });
    expect(scene.externalSourceId).toBe(created.id);
    await prisma.scene.delete({ where: { id: scene.id } });
    await prisma.layout.delete({ where: { id: layout.id } });
  });
});
