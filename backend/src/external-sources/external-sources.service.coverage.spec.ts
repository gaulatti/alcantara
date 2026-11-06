/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ExternalSourceSecurity } from './external-source.security';
import { ExternalSourcesService } from './external-sources.service';

const KEYRING = '{"1":"YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA="}';
const auth = { teamId: 1, permissions: [] };
const FEED = 'https://93.184.216.34/feed.m3u8';

function harness(extraConfig: Record<string, unknown> = {}) {
  const prisma: any = {
    externalSource: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async ({ data }: any) => ({
        ...data,
        programs: data.programs.create,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(async ({ data }: any) => ({
        id: 'source-a',
        teamId: 1,
        name: 'Camera',
        transport: 'whip',
        programs: [],
        ...data,
      })),
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { transport: 'whip', lifecycle: 'waiting', _count: { _all: 2 } },
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
  const config = new ConfigService({
    EXTERNAL_SOURCE_CONFIG_CURRENT_VERSION: '1',
    EXTERNAL_SOURCE_CONFIG_KEYS: KEYRING,
    ...extraConfig,
  });
  const security = new ExternalSourceSecurity(config);
  const metrics = new ManagedMetricsService();
  const record = jest.spyOn(metrics, 'recordExternalSource');
  const inventory = jest.spyOn(metrics, 'setExternalSourceInventory');
  return {
    prisma,
    security,
    record,
    inventory,
    service: new ExternalSourcesService(prisma, config, security, metrics),
  };
}

function row(
  security: ExternalSourceSecurity,
  overrides: Record<string, unknown> = {},
) {
  const transport = (overrides.transport as string) ?? 'hls';
  const encrypted = security.encrypt(
    1,
    'source-a',
    transport === 'hls' || transport === 'srt' ? { url: FEED } : {},
  );
  return {
    id: 'source-a',
    teamId: 1,
    name: 'Camera',
    transport,
    lifecycle: 'waiting',
    health: 'unknown',
    normalizationProfile: '720p30',
    credentialVersion: 1,
    ingressId: null,
    participantIdentity: null,
    lastConnectedAt: null,
    revokedAt: null,
    transportConfigCiphertext: encrypted.ciphertext,
    transportConfigNonce: encrypted.nonce,
    configKeyVersion: encrypted.keyVersion,
    programs: [{ programId: 'main' }],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

const createBody = (overrides: Record<string, unknown> = {}) => ({
  name: '  Studio  ',
  transport: 'whip',
  programIds: ['main'],
  transportConfig: {},
  ...overrides,
});

describe('ExternalSourcesService coverage', () => {
  describe('reads', () => {
    it('lists team sources with presented fields and records success', async () => {
      const h = harness();
      h.prisma.externalSource.findMany.mockResolvedValue([
        row(h.security),
        row(h.security, { id: 'no-programs', programs: undefined }),
      ]);

      const result = await h.service.list(auth);

      expect(h.prisma.externalSource.findMany).toHaveBeenCalledWith({
        where: { teamId: 1 },
        include: { programs: true },
        orderBy: [{ revokedAt: 'asc' }, { name: 'asc' }],
      });
      expect(result[0]).toEqual({
        id: 'source-a',
        teamId: 1,
        name: 'Camera',
        transport: 'hls',
        lifecycle: 'waiting',
        health: 'unknown',
        normalizationProfile: '720p30',
        credentialVersion: 1,
        ingressId: null,
        participantIdentity: null,
        lastConnectedAt: null,
        revokedAt: null,
        programIds: ['main'],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      });
      expect(result[0]).not.toHaveProperty('transportConfigCiphertext');
      expect(result[1].programIds).toEqual([]);
      expect(h.record).toHaveBeenCalledWith('read', 'success');
    });

    it('gets one source and records not-found for foreign ones', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValueOnce(row(h.security));
      await expect(h.service.get('source-a', auth)).resolves.toMatchObject({
        id: 'source-a',
      });
      expect(h.record).toHaveBeenCalledWith('read', 'success');

      h.prisma.externalSource.findFirst.mockResolvedValueOnce(null);
      await expect(h.service.get('nope', auth)).rejects.toThrow(
        new NotFoundException('External source not found'),
      );
      expect(h.record).toHaveBeenCalledWith('read', 'not-found');
    });
  });

  describe('create', () => {
    it('creates a pull source without a credential', async () => {
      const h = harness();
      const result = await h.service.create(
        'operator',
        createBody({
          transport: 'hls',
          transportConfig: { url: FEED },
          normalizationProfile: '1080p30',
        }),
        auth,
      );

      const data = h.prisma.externalSource.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        teamId: 1,
        name: 'Studio',
        transport: 'hls',
        lifecycle: 'unconfigured',
        health: 'unknown',
        normalizationProfile: '1080p30',
        credentialVersion: 0,
        createdBySubject: 'operator',
        programs: { create: [{ programId: 'main' }] },
      });
      expect(data).not.toHaveProperty('credentials');
      expect(result).not.toHaveProperty('credential');
      expect(h.record).toHaveBeenCalledWith('create', 'success');
      expect(h.inventory).toHaveBeenCalledWith([
        { transport: 'whip', lifecycle: 'waiting', count: 2 },
      ]);
    });

    it('creates a push source with a hashed credential and default normalization', async () => {
      const h = harness();
      const result = await h.service.create(
        'operator',
        createBody({ transport: 'rtmp', programIds: ['main', 'main'] }),
        auth,
      );
      const data = h.prisma.externalSource.create.mock.calls[0][0].data;
      expect(data.normalizationProfile).toBe('720p30');
      expect(data.lifecycle).toBe('waiting');
      expect(data.credentialVersion).toBe(1);
      expect(data.programs.create).toEqual([{ programId: 'main' }]);
      expect(data.credentials.create.version).toBe(1);
      expect(data.credentials.create.secretHash).toMatch(/^scrypt\$/);
      expect(result.credential).toMatchObject({ version: 1 });
      expect(h.prisma.programState.count).toHaveBeenCalledWith({
        where: { programId: { in: ['main'] } },
      });
    });

    it.each([
      ['unset', {}, 16, 15],
      ['non numeric', { EXTERNAL_SOURCE_TEAM_QUOTA: 'abc' }, 16, 15],
      ['below 1', { EXTERNAL_SOURCE_TEAM_QUOTA: '0' }, 16, 15],
      ['above 100', { EXTERNAL_SOURCE_TEAM_QUOTA: '101' }, 16, 15],
      ['fractional', { EXTERNAL_SOURCE_TEAM_QUOTA: '2.5' }, 16, 15],
      ['custom', { EXTERNAL_SOURCE_TEAM_QUOTA: '3' }, 3, 2],
      ['maximum', { EXTERNAL_SOURCE_TEAM_QUOTA: '100' }, 100, 99],
    ])('applies the %s team quota', async (_name, cfg, limit, below) => {
      const h = harness(cfg);
      h.prisma.externalSource.count.mockResolvedValue(limit);
      await expect(
        h.service.create('operator', createBody(), auth),
      ).rejects.toThrow(
        new ConflictException('EXTERNAL_SOURCE_QUOTA_EXCEEDED'),
      );
      expect(h.record).toHaveBeenCalledWith('create', 'rejected');
      expect(h.prisma.externalSource.count).toHaveBeenCalledWith({
        where: { teamId: 1, revokedAt: null },
      });

      h.prisma.externalSource.count.mockResolvedValue(below);
      await expect(
        h.service.create('operator', createBody(), auth),
      ).resolves.toHaveProperty('credential');
    });

    it.each([
      [
        'an invalid transport',
        createBody({ transport: 'ftp' }),
        'transport is invalid',
      ],
      [
        'a non string transport',
        createBody({ transport: 5 }),
        'transport is invalid',
      ],
      [
        'no program ids',
        createBody({ programIds: [] }),
        'programIds is invalid',
      ],
      [
        'non array program ids',
        createBody({ programIds: 'main' }),
        'programIds is invalid',
      ],
      [
        'too many program ids',
        createBody({
          programIds: Array.from({ length: 17 }, (_, i) => `p${i}`),
        }),
        'programIds is invalid',
      ],
      [
        'a blank program id',
        createBody({ programIds: [' '] }),
        'programId is invalid',
      ],
      ['a blank name', createBody({ name: '   ' }), 'name is invalid'],
      ['a non string name', createBody({ name: 5 }), 'name is invalid'],
      ['a long name', createBody({ name: 'n'.repeat(121) }), 'name is invalid'],
      [
        'an unknown profile',
        createBody({ normalizationProfile: '4k' }),
        'normalizationProfile is invalid',
      ],
    ])('rejects %s', async (_name, body, message) => {
      const h = harness();
      await expect(h.service.create('operator', body, auth)).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(h.prisma.externalSource.create).not.toHaveBeenCalled();
    });

    it('rejects push sources carrying transport config', async () => {
      const h = harness();
      await expect(
        h.service.create(
          'operator',
          createBody({ transportConfig: { url: FEED } }),
          auth,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown programs', async () => {
      const h = harness();
      h.prisma.programState.count.mockResolvedValue(0);
      await expect(
        h.service.create('operator', createBody(), auth),
      ).rejects.toThrow(new NotFoundException('Program not found'));
    });
  });

  describe('update', () => {
    it('rejects revoked sources', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, { revokedAt: new Date() }),
      );
      await expect(h.service.update('source-a', {}, auth)).rejects.toThrow(
        new ConflictException('SOURCE_REVOKED'),
      );
    });

    it('keeps the stored transport, config and programs when nothing is supplied', async () => {
      const h = harness();
      const existing = row(h.security);
      h.prisma.externalSource.findFirst.mockResolvedValue(existing);

      await h.service.update('source-a', {}, auth);

      const args = h.prisma.externalSource.update.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'source-a' });
      expect(args.data.transport).toBe('hls');
      expect(args.data).not.toHaveProperty('name');
      expect(args.data).not.toHaveProperty('normalizationProfile');
      expect(args.data).not.toHaveProperty('programs');
      expect(
        h.security.decrypt(
          1,
          'source-a',
          args.data.transportConfigCiphertext,
          args.data.transportConfigNonce,
          args.data.configKeyVersion,
        ),
      ).toEqual({ url: FEED });
      expect(h.record).toHaveBeenCalledWith('update', 'success');
    });

    it('applies supplied name, profile, config and programs', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(row(h.security));
      const otherFeed = 'https://93.184.216.35/other.m3u8';
      h.prisma.programState.count.mockResolvedValue(2);
      h.prisma.externalSource.update.mockImplementation(
        async ({ data }: any) => ({
          ...row(h.security),
          ...data,
          programs: [],
        }),
      );

      await h.service.update(
        'source-a',
        {
          transport: 'hls',
          name: ' Renamed ',
          normalizationProfile: 'passthrough',
          transportConfig: { url: otherFeed },
          programIds: ['a', 'b'],
        },
        auth,
      );

      const data = h.prisma.externalSource.update.mock.calls[0][0].data;
      expect(data.name).toBe('Renamed');
      expect(data.normalizationProfile).toBe('passthrough');
      expect(data.programs).toEqual({
        deleteMany: {},
        create: [{ programId: 'a' }, { programId: 'b' }],
      });
      expect(
        h.security.decrypt(
          1,
          'source-a',
          data.transportConfigCiphertext,
          data.transportConfigNonce,
          data.configKeyVersion,
        ),
      ).toEqual({ url: otherFeed });
    });

    it('refuses to change the transport', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(row(h.security));
      await expect(
        h.service.update('source-a', { transport: 'srt' }, auth),
      ).rejects.toThrow(new ConflictException('SOURCE_TRANSPORT_IMMUTABLE'));
      await expect(
        h.service.update('source-a', { transport: 'bogus' }, auth),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('rotateCredential', () => {
    it.each([
      ['revoked push source', { transport: 'whip', revokedAt: new Date() }],
      ['pull source', { transport: 'hls' }],
    ])('rejects a %s', async (_name, overrides) => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, overrides),
      );
      await expect(
        h.service.rotateCredential('source-a', auth),
      ).rejects.toThrow(
        new ConflictException('SOURCE_CREDENTIAL_NOT_AVAILABLE'),
      );
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rotates an rtmp credential to the next version', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, { transport: 'rtmp', credentialVersion: 4 }),
      );
      const result = await h.service.rotateCredential('source-a', auth);
      expect(result).toMatchObject({
        id: 'source-a',
        credential: { version: 5 },
      });
      expect(result.credential.secret).toHaveLength(43);
      expect(h.prisma.externalSourceCredential.create).toHaveBeenCalledWith({
        data: {
          sourceId: 'source-a',
          version: 5,
          secretHash: expect.stringMatching(/^scrypt\$/),
        },
      });
      expect(h.record).toHaveBeenCalledWith('rotate', 'success');
    });
  });

  describe('revoke', () => {
    it('revokes credentials and refreshes the inventory', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(row(h.security));
      await expect(h.service.revoke('source-a', auth)).resolves.toEqual({
        id: 'source-a',
        lifecycle: 'revoked',
      });
      expect(h.record).toHaveBeenCalledWith('revoke', 'success');
      expect(h.inventory).toHaveBeenCalled();
    });
  });

  describe('validateRedirect', () => {
    it('rejects push sources', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, { transport: 'whip' }),
      );
      await expect(
        h.service.validateRedirect('source-a', FEED, auth),
      ).rejects.toThrow(
        new BadRequestException('Push source has no redirects'),
      );
    });

    it.each(['hls', 'srt'])(
      'allows a %s redirect and returns only a fingerprint',
      async (transport) => {
        const h = harness();
        h.prisma.externalSource.findFirst.mockResolvedValue(
          row(h.security, { transport }),
        );
        const url =
          transport === 'hls'
            ? 'https://93.184.216.34/next.m3u8'
            : 'srt://93.184.216.34:9000';
        const result = await h.service.validateRedirect('source-a', url, auth);
        expect(result).toEqual({
          allowed: true,
          urlFingerprint: h.security.fingerprint(url),
        });
        expect(h.record).toHaveBeenCalledWith('redirect', 'success');
      },
    );

    it('rejects a redirect to a private address', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(row(h.security));
      await expect(
        h.service.validateRedirect('source-a', 'https://10.0.0.1/x', auth),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reconcile', () => {
    const body = (overrides: Record<string, unknown> = {}) => ({
      lifecycle: 'waiting',
      health: 'healthy',
      ...overrides,
    });

    it('rejects revoked sources', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, { revokedAt: new Date() }),
      );
      await expect(
        h.service.reconcile('source-a', body(), auth),
      ).rejects.toThrow(new ConflictException('SOURCE_REVOKED'));
    });

    it('revalidates the stored pull url and stamps connections', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(row(h.security));
      const validate = jest.spyOn(h.security, 'validatePullUrl');

      await h.service.reconcile(
        'source-a',
        body({
          lifecycle: 'connected',
          ingressId: ' ingress-1 ',
          participantIdentity: 'participant-1',
        }),
        auth,
      );

      expect(validate).toHaveBeenCalledWith(FEED, 'hls');
      const data = h.prisma.externalSource.update.mock.calls[0][0].data;
      expect(data).toMatchObject({
        lifecycle: 'connected',
        health: 'healthy',
        ingressId: 'ingress-1',
        participantIdentity: 'participant-1',
      });
      expect(data.lastConnectedAt).toBeInstanceOf(Date);
      expect(h.record).toHaveBeenCalledWith('reconcile', 'success');
      expect(h.inventory).toHaveBeenCalled();
    });

    it('does not stamp non connected states and skips url checks for push sources', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, { transport: 'rtmp' }),
      );
      const validate = jest.spyOn(h.security, 'validatePullUrl');

      for (const ingressId of [undefined, null, '']) {
        await h.service.reconcile('source-a', body({ ingressId }), auth);
      }

      expect(validate).not.toHaveBeenCalled();
      for (const [call] of h.prisma.externalSource.update.mock.calls) {
        expect(call.data).not.toHaveProperty('lastConnectedAt');
        expect(call.data.ingressId).toBeNull();
        expect(call.data.participantIdentity).toBeNull();
      }
    });

    it('fails when the stored pull url is no longer permitted', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(row(h.security));
      jest
        .spyOn(h.security, 'validatePullUrl')
        .mockRejectedValue(
          new BadRequestException('Source address is not permitted'),
        );
      await expect(
        h.service.reconcile('source-a', body(), auth),
      ).rejects.toThrow('Source address is not permitted');
      expect(h.prisma.externalSource.update).not.toHaveBeenCalled();
    });

    it('checks srt sources the same way', async () => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, { transport: 'srt' }),
      );
      const validate = jest
        .spyOn(h.security, 'validatePullUrl')
        .mockResolvedValue(FEED);
      await h.service.reconcile('source-a', body(), auth);
      expect(validate).toHaveBeenCalledWith(FEED, 'srt');
    });

    it.each([
      [
        'a missing lifecycle',
        body({ lifecycle: undefined }),
        BadRequestException,
      ],
      [
        'an unknown lifecycle',
        body({ lifecycle: 'weird' }),
        BadRequestException,
      ],
      [
        'the revoked lifecycle',
        body({ lifecycle: 'revoked' }),
        ForbiddenException,
      ],
      ['an unknown health', body({ health: 'meh' }), BadRequestException],
      ['a non string health', body({ health: 3 }), BadRequestException],
      [
        'an oversized ingress id',
        body({ ingressId: 'i'.repeat(256) }),
        BadRequestException,
      ],
      [
        'a non string participant',
        body({ participantIdentity: 5 }),
        BadRequestException,
      ],
    ])('rejects %s', async (_name, payload, errorType) => {
      const h = harness();
      h.prisma.externalSource.findFirst.mockResolvedValue(
        row(h.security, { transport: 'whip' }),
      );
      await expect(
        h.service.reconcile('source-a', payload, auth),
      ).rejects.toBeInstanceOf(errorType);
      expect(h.prisma.externalSource.update).not.toHaveBeenCalled();
    });
  });

  it('falls back to Object paramtypes when collaborators are undefined at decoration time', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({ PrismaService: undefined }));
      jest.doMock('@nestjs/config', () => ({ ConfigService: undefined }));
      jest.doMock('../observability/managed-metrics.service', () => ({
        ManagedMetricsService: undefined,
      }));
      jest.doMock('./external-source.security', () => ({
        ExternalSourceSecurity: undefined,
      }));
      const { ExternalSourcesService: Isolated } =
        require('./external-sources.service') as {
          ExternalSourcesService: new (...args: never[]) => unknown;
        };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
        Object,
        Object,
      ]);
    });
    jest.resetModules();
  });
});
