import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalSourceSecurity } from './external-source.security';
import { ExternalSourcesService } from './external-sources.service';

const authorization = { teamId: 7, permissions: ['alcantara:webrtc:operate'] };
function fixture(transport = 'hls', quota: unknown = 16) {
  const config = new ConfigService({
    EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
    EXTERNAL_SOURCE_CONFIG_KEYS: JSON.stringify({
      1: Buffer.alloc(32, 7).toString('base64'),
    }),
    EXTERNAL_SOURCE_TEAM_QUOTA: quota,
  });
  const security = new ExternalSourceSecurity(config);
  jest
    .spyOn(security, 'validatePullUrl')
    .mockImplementation(async (url: unknown) => {
      if (url === 'blocked') throw new BadRequestException('unsafe pull URL');
      return String(url);
    });
  const initial = security.encrypt(
    7,
    'source-a',
    transport === 'hls' || transport === 'srt'
      ? { url: 'https://media.example/audio' }
      : {},
  );
  let source: any = {
    id: 'source-a',
    teamId: 7,
    name: 'Camera',
    transport,
    lifecycle: 'waiting',
    health: 'unknown',
    normalizationProfile: '720p30',
    transportConfigCiphertext: initial.ciphertext,
    transportConfigNonce: initial.nonce,
    configKeyVersion: initial.keyVersion,
    credentialVersion: 1,
    revokedAt: null,
    programs: [{ programId: 'news' }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    externalSource: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn(async () => [source]),
      findFirst: jest.fn(async () => source),
      create: jest.fn(async ({ data }: any) => {
        source = { ...source, ...data, programs: data.programs.create };
        return source;
      }),
      update: jest.fn(async ({ data }: any) => {
        source = {
          ...source,
          ...data,
          programs: data.programs ? data.programs.create : source.programs,
        };
        return source;
      }),
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { transport: 'hls', lifecycle: 'connected', _count: { _all: 2 } },
        ]),
    },
    externalSourceCredential: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    programState: { count: jest.fn().mockResolvedValue(1) },
    $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };
  const metrics = {
    recordExternalSource: jest.fn(),
    setExternalSourceInventory: jest.fn(),
  };
  return {
    service: new ExternalSourcesService(
      prisma as any,
      config,
      security,
      metrics as any,
    ),
    security,
    prisma,
    metrics,
    source: () => source,
  };
}
const input = (overrides: Record<string, unknown> = {}) => ({
  name: 'Remote studio',
  transport: 'hls',
  transportConfig: { url: 'https://media.example/audio' },
  programIds: ['news'],
  ...overrides,
});

describe('ExternalSourcesService lifecycle and safe presentation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists and reads only the requesting team and never publishes encrypted configuration or reusable secrets', async () => {
    const f = fixture();
    const rows = await f.service.list(authorization);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'source-a',
      teamId: 7,
      programIds: ['news'],
    });
    for (const field of [
      'transportConfigCiphertext',
      'transportConfigNonce',
      'configKeyVersion',
      'credential',
    ])
      expect(rows[0]).not.toHaveProperty(field);
    expect(f.prisma.externalSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 7 } }),
    );
    expect(await f.service.get('source-a', authorization)).toEqual(rows[0]);
  });

  it.each(['hls', 'srt'])(
    'creates an encrypted pull %s source without fabricating a push credential',
    async (transport) => {
      const f = fixture(transport);
      const url =
        transport === 'hls'
          ? 'https://media.example/audio'
          : 'srt://media.example:9000';
      const created = await f.service.create(
        'operator',
        input({
          transport,
          transportConfig: { url },
          normalizationProfile: 'passthrough',
        }),
        authorization,
      );
      expect(created).toMatchObject({
        lifecycle: 'unconfigured',
        credentialVersion: 0,
        normalizationProfile: 'passthrough',
        programIds: ['news'],
      });
      expect(created).not.toHaveProperty('credential');
      expect(
        f.security.decrypt(
          7,
          created.id,
          f.source().transportConfigCiphertext,
          f.source().transportConfigNonce,
          f.source().configKeyVersion,
        ),
      ).toEqual({ url });
      expect(f.metrics.setExternalSourceInventory).toHaveBeenCalledWith([
        { transport: 'hls', lifecycle: 'connected', count: 2 },
      ]);
    },
  );

  it.each([undefined, 0, 2.5, 101, 'invalid'])(
    'applies the documented sixteen-source quota when configuration is invalid: %p',
    async (quota) => {
      const f = fixture('hls', quota);
      f.prisma.externalSource.count.mockResolvedValue(16);
      await expect(
        f.service.create('operator', input(), authorization),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(f.prisma.externalSource.create).not.toHaveBeenCalled();
      expect(f.metrics.recordExternalSource).toHaveBeenLastCalledWith(
        'create',
        'rejected',
      );
    },
  );

  it.each([
    { transport: undefined },
    { transport: 'ftp' },
    { name: null },
    { name: ' ' },
    { name: 'x'.repeat(121) },
    { normalizationProfile: '2160p60' },
    { programIds: undefined },
    { programIds: [] },
    { programIds: new Array(17).fill('news') },
    { programIds: [7] },
  ])(
    'rejects invalid source creation before persistence: %p',
    async (override) => {
      const f = fixture();
      await expect(
        f.service.create('operator', input(override), authorization),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.externalSource.create).not.toHaveBeenCalled();
    },
  );

  it('requires all assigned programs to exist and deduplicates repeated valid assignments', async () => {
    const f = fixture();
    f.prisma.programState.count.mockResolvedValueOnce(0);
    await expect(
      f.service.create('operator', input(), authorization),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      (
        await f.service.create(
          'operator',
          input({ programIds: [' news ', 'news'] }),
          authorization,
        )
      ).programIds,
    ).toEqual(['news']);
    expect(f.prisma.programState.count).toHaveBeenLastCalledWith({
      where: { programId: { in: ['news'] } },
    });
  });

  it('updates textual metadata while re-encrypting the same transport configuration without clearing assignments', async () => {
    const f = fixture();
    const originalCipher = f.source().transportConfigCiphertext;
    const updated = await f.service.update(
      'source-a',
      { name: ' Renamed ' },
      authorization,
    );
    expect(updated).toMatchObject({
      name: 'Renamed',
      transport: 'hls',
      programIds: ['news'],
    });
    expect(f.source().transportConfigCiphertext).not.toBe(originalCipher);
    expect(
      f.security.decrypt(
        7,
        'source-a',
        f.source().transportConfigCiphertext,
        f.source().transportConfigNonce,
        1,
      ),
    ).toEqual({ url: 'https://media.example/audio' });
    expect(f.prisma.programState.count).not.toHaveBeenCalled();
  });

  it('validates replacement configuration and updates explicit normalization and program assignments together', async () => {
    const f = fixture();
    expect(
      await f.service.update(
        'source-a',
        {
          transport: 'hls',
          transportConfig: { url: 'https://media.example/new' },
          normalizationProfile: '1080p30',
          programIds: ['news'],
          name: 'Studio',
        },
        authorization,
      ),
    ).toMatchObject({ normalizationProfile: '1080p30', name: 'Studio' });
    expect(f.security.validatePullUrl).toHaveBeenCalledWith(
      'https://media.example/new',
      'hls',
    );
    expect(f.prisma.externalSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          programs: { deleteMany: {}, create: [{ programId: 'news' }] },
        }),
      }),
    );
  });

  it('refuses revoked, transport-changing and unreadable stored source edits', async () => {
    const f = fixture();
    f.source().revokedAt = new Date();
    await expect(
      f.service.update('source-a', {}, authorization),
    ).rejects.toThrow('SOURCE_REVOKED');
    f.source().revokedAt = null;
    await expect(
      f.service.update('source-a', { transport: 'whip' }, authorization),
    ).rejects.toThrow('SOURCE_TRANSPORT_IMMUTABLE');
    f.source().transportConfigCiphertext = 'corrupted';
    await expect(
      f.service.update('source-a', {}, authorization),
    ).rejects.toThrow('unreadable');
    expect(f.prisma.externalSource.update).not.toHaveBeenCalled();
  });

  it('only rotates active push credentials and returns opaque not-found errors across team boundaries', async () => {
    const f = fixture();
    await expect(
      f.service.rotateCredential('source-a', authorization),
    ).rejects.toThrow('SOURCE_CREDENTIAL_NOT_AVAILABLE');
    f.source().transport = 'whip';
    f.source().revokedAt = new Date();
    await expect(
      f.service.rotateCredential('source-a', authorization),
    ).rejects.toThrow('SOURCE_CREDENTIAL_NOT_AVAILABLE');
    f.prisma.externalSource.findFirst.mockResolvedValueOnce(null);
    await expect(
      f.service.get('other-team', authorization),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.metrics.recordExternalSource).toHaveBeenLastCalledWith(
      'read',
      'not-found',
    );
  });

  it('validates pull redirects without publishing the URL and rejects redirects for push sources', async () => {
    const f = fixture();
    const result = await f.service.validateRedirect(
      'source-a',
      'https://media.example/new',
      authorization,
    );
    expect(result).toEqual({
      allowed: true,
      urlFingerprint: f.security.fingerprint('https://media.example/new'),
    });
    expect(JSON.stringify(result)).not.toContain('https://');
    await expect(
      f.service.validateRedirect('source-a', 'blocked', authorization),
    ).rejects.toBeInstanceOf(BadRequestException);
    f.source().transport = 'whip';
    await expect(
      f.service.validateRedirect(
        'source-a',
        'https://media.example/new',
        authorization,
      ),
    ).rejects.toThrow('Push source has no redirects');
  });

  it('revalidates encrypted pull URLs while recording connected runtime identity and inventory', async () => {
    const f = fixture();
    expect(
      await f.service.reconcile(
        'source-a',
        {
          lifecycle: 'connected',
          health: 'healthy',
          ingressId: ' ingress-1 ',
          participantIdentity: ' camera-1 ',
        },
        authorization,
      ),
    ).toMatchObject({
      lifecycle: 'connected',
      health: 'healthy',
      ingressId: 'ingress-1',
      participantIdentity: 'camera-1',
      lastConnectedAt: expect.any(Date),
    });
    expect(f.security.validatePullUrl).toHaveBeenCalledWith(
      'https://media.example/audio',
      'hls',
    );
    expect(f.metrics.recordExternalSource).toHaveBeenLastCalledWith(
      'reconcile',
      'success',
    );
  });

  it.each([undefined, null, ''])(
    'clears absent push runtime identities without fabricating a connected timestamp: %p',
    async (identity) => {
      const f = fixture('whip');
      expect(
        await f.service.reconcile(
          'source-a',
          {
            lifecycle: 'waiting',
            health: 'unknown',
            ingressId: identity,
            participantIdentity: identity,
          },
          authorization,
        ),
      ).toMatchObject({
        lifecycle: 'waiting',
        ingressId: null,
        participantIdentity: null,
      });
      expect(
        f.prisma.externalSource.update.mock.calls[0][0].data,
      ).not.toHaveProperty('lastConnectedAt');
      expect(f.security.validatePullUrl).not.toHaveBeenCalled();
    },
  );

  it.each([
    { lifecycle: undefined },
    { lifecycle: 'nonsense' },
    { health: undefined },
    { health: 'nonsense' },
    { ingressId: 7 },
    { participantIdentity: 'x'.repeat(256) },
  ])(
    'rejects invalid runtime reconciliation before changing source state: %p',
    async (override) => {
      const f = fixture();
      await expect(
        f.service.reconcile(
          'source-a',
          { lifecycle: 'connected', health: 'healthy', ...override },
          authorization,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.externalSource.update).not.toHaveBeenCalled();
    },
  );

  it('requires the explicit revoke operation and never reconciles revoked or newly unsafe pull sources', async () => {
    const f = fixture();
    await expect(
      f.service.reconcile(
        'source-a',
        { lifecycle: 'revoked', health: 'unavailable' },
        authorization,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    f.source().revokedAt = new Date();
    await expect(
      f.service.reconcile(
        'source-a',
        { lifecycle: 'connected', health: 'healthy' },
        authorization,
      ),
    ).rejects.toThrow('SOURCE_REVOKED');
    f.source().revokedAt = null;
    const changed = f.security.encrypt(7, 'source-a', { url: 'blocked' });
    f.source().transportConfigCiphertext = changed.ciphertext;
    f.source().transportConfigNonce = changed.nonce;
    await expect(
      f.service.reconcile(
        'source-a',
        { lifecycle: 'connected', health: 'healthy' },
        authorization,
      ),
    ).rejects.toThrow('unsafe pull URL');
    expect(f.prisma.externalSource.update).not.toHaveBeenCalled();
  });

  it('keeps the stored name when an update omits it', async () => {
    const f = fixture();
    const updated = await f.service.update('source-a', {}, authorization);
    expect(updated.name).toBe('Camera');
    const data = f.prisma.externalSource.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('name');
  });

  it('presents a stored source without program assignments as an empty program list', async () => {
    const f = fixture();
    delete f.source().programs;
    await expect(f.service.get('source-a', authorization)).resolves.toEqual(
      expect.objectContaining({ id: 'source-a', programIds: [] }),
    );
  });
});
