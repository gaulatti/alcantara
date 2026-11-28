/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/prefer-promise-reject-errors */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BroadcastDestinationKeysService } from './broadcast-destination-keys.service';

const KEY = 'live_SecretKey-9f8e7d6c';
const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', {
    code,
    clientVersion: 'test',
  });

function harness(
  options: {
    taken?: string[];
    clash?: boolean;
    existing?: object | null;
    txError?: unknown;
    createSecretError?: boolean;
    putError?: boolean;
    discardError?: boolean;
  } = {},
) {
  const rows = (options.taken ?? []).map((id) => ({ id }));
  const prisma: any = {
    // The team-scoped client (gaulatti/alcantara#122) as a pass-through: its scoping is proven in scoped-prisma.spec,
    // and the service still applies its explicit team checks.
    $extends: jest.fn(function (this: unknown) {
      return this;
    }),
    broadcastDestination: {
      findFirst: jest
        .fn()
        .mockResolvedValue(options.clash ? { id: 'x' } : null),
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(2),
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.existing === undefined ? null : options.existing,
        ),
      create: jest.fn((args: any) => ({
        ...args.data,
        createdAt: 1,
        updatedAt: 2,
      })),
      update: jest.fn((args: any) => ({
        id: args.where.id,
        ...args.data,
        createdAt: 1,
        updatedAt: 3,
      })),
    },
    broadcastDestinationKeyChange: {
      create: jest.fn((args: any) => args.data),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) =>
      options.txError ? Promise.reject(options.txError) : Promise.all(ops),
    ),
  };
  const secrets = {
    create: options.createSecretError
      ? jest.fn().mockRejectedValue(new Error(`provider echoed ${KEY}`))
      : jest.fn().mockResolvedValue({ secretId: 'arn:new', versionId: 'v1' }),
    put: options.putError
      ? jest.fn().mockRejectedValue(new Error(`provider echoed ${KEY}`))
      : jest.fn().mockResolvedValue('v2'),
    discard: options.discardError
      ? jest.fn().mockRejectedValue(new Error('no'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const metrics = { recordBroadcastDestination: jest.fn() };
  const service = new BroadcastDestinationKeysService(
    prisma,
    secrets as never,
    metrics as never,
  );
  return { service, prisma, secrets, metrics };
}

const youtube = { service: 'youtube', name: 'YouTube Main', streamKey: KEY };

describe('BroadcastDestinationKeysService.add', () => {
  it('writes the secret itself, pins its version and audits who did it', async () => {
    const { service, prisma, secrets, metrics } = harness();
    const row = await service.add(youtube, 7, 'user-1');
    expect(secrets.create).toHaveBeenCalledWith(
      'alcantara/destinations/7/youtube-main',
      {
        scheme: 'rtmps',
        host: 'a.rtmps.youtube.com',
        port: 443,
        application: 'live2',
        streamKey: KEY,
      },
    );
    expect(prisma.broadcastDestination.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'youtube-main',
        displayName: 'YouTube Main',
        secretId: 'arn:new',
        secretVersionId: 'v1',
        service: 'youtube',
        ingestUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
        keyLast4: '7d6c',
        position: 2,
        teamId: 7,
      }),
    });
    expect(prisma.broadcastDestinationKeyChange.create).toHaveBeenCalledWith({
      data: {
        teamId: 7,
        destinationId: 'youtube-main',
        subject: 'user-1',
        action: 'created',
      },
    });
    expect(row).toMatchObject({ id: 'youtube-main', keyLast4: '7d6c' });
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(
      JSON.stringify(prisma.broadcastDestinationKeyChange.create.mock.calls),
    ).not.toContain(KEY);
    expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'create',
      'succeeded',
    );
  });

  it('stamps no team where none is configured and shows no ending for a short key', async () => {
    const { service, prisma, secrets } = harness();
    await service.add({ ...youtube, streamKey: 'short' }, 0, 'u');
    expect(secrets.create.mock.calls[0][0]).toBe(
      'alcantara/destinations/0/youtube-main',
    );
    const data = prisma.broadcastDestination.create.mock.calls[0][0].data;
    expect(data.teamId).toBeNull();
    expect(data.keyLast4).toBeNull();
  });

  it('accepts a custom RTMP(S) address', async () => {
    const { service, secrets } = harness();
    await service.add(
      {
        service: 'custom',
        name: 'Backup',
        ingestUrl: 'rtmp://example.test:1936/live',
        streamKey: KEY,
      },
      7,
      'u',
    );
    expect(secrets.create.mock.calls[0][1]).toEqual({
      scheme: 'rtmp',
      host: 'example.test',
      port: 1936,
      application: 'live',
      streamKey: KEY,
    });
  });

  it.each([
    ['no service', { ...youtube, service: undefined }],
    ['an unknown service', { ...youtube, service: 'twitch' }],
    ['an ingest URL for YouTube', { ...youtube, ingestUrl: 'rtmp://x.test/a' }],
    ['a custom service without a URL', { ...youtube, service: 'custom' }],
    ['a blank custom URL', { ...youtube, service: 'custom', ingestUrl: '  ' }],
    [
      'a bad custom URL',
      { ...youtube, service: 'custom', ingestUrl: 'http://x.test/a' },
    ],
    ['no name', { ...youtube, name: undefined }],
    ['a blank name', { ...youtube, name: '   ' }],
    ['a long name', { ...youtube, name: 'n'.repeat(101) }],
    ['no key', { ...youtube, streamKey: undefined }],
    ['an empty key', { ...youtube, streamKey: '' }],
    ['a key with a space', { ...youtube, streamKey: 'a b' }],
  ])('refuses %s before touching Secrets Manager', async (_name, body) => {
    const { service, secrets, prisma } = harness();
    const error = await service
      .add(body as never, 7, 'u')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(secrets.create).not.toHaveBeenCalled();
    expect(prisma.broadcastDestination.create).not.toHaveBeenCalled();
  });

  it('refuses a name another destination of the team already has', async () => {
    const { service, secrets } = harness({ clash: true });
    await expect(service.add(youtube, 7, 'u')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(secrets.create).not.toHaveBeenCalled();
  });

  it("checks the name through the caller's team-scoped client, and team 0's unscoped", async () => {
    const team = harness();
    await team.service.add(youtube, 7, 'u');
    expect(team.prisma.$extends).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'team-7' }),
    );
    const local = harness();
    await local.service.add(youtube, 0, 'u');
    expect(local.prisma.$extends).not.toHaveBeenCalled();
  });

  it('checks the name across every team where none is configured', async () => {
    const { service, prisma } = harness();
    await service.add(youtube, 0, 'u');
    expect(
      prisma.broadcastDestination.findFirst.mock.calls[0][0].where,
    ).not.toHaveProperty('teamId');
  });

  it.each([
    ['a taken slug', 'YouTube Main', ['youtube-main'], 'youtube-main-2'],
    [
      'two taken slugs',
      'YouTube Main',
      ['youtube-main', 'youtube-main-2'],
      'youtube-main-3',
    ],
    ['a name with no letters or digits', '!!!', [], 'destination'],
    ['a very long name', 'x'.repeat(100), [], 'x'.repeat(48)],
  ])('makes the id from the name: %s', async (_name, name, taken, expected) => {
    const { service, prisma } = harness({ taken });
    await service.add({ ...youtube, name }, 7, 'u');
    expect(prisma.broadcastDestination.create.mock.calls[0][0].data.id).toBe(
      expected,
    );
  });

  it('answers 503 and writes no row when the secret cannot be created, without the key', async () => {
    const { service, prisma, metrics } = harness({ createSecretError: true });
    const error = await service.add(youtube, 7, 'u').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(prisma.broadcastDestination.create).not.toHaveBeenCalled();
    expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'create',
      'failed',
    );
  });

  it('discards the secret it just created when the row cannot be saved', async () => {
    const { service, secrets } = harness({ txError: prismaError('P2003') });
    await expect(service.add(youtube, 7, 'u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(secrets.discard).toHaveBeenCalledWith('arn:new');
  });

  it('maps a duplicate id race to a conflict and still discards, even when the discard fails', async () => {
    const { service, secrets } = harness({
      txError: prismaError('P2002'),
      discardError: true,
    });
    await expect(service.add(youtube, 7, 'u')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(secrets.discard).toHaveBeenCalled();
  });
});

describe('BroadcastDestinationKeysService.replaceKey', () => {
  const row = {
    id: 'youtube-main',
    displayName: 'YouTube Main',
    secretId: 'arn:old',
    secretVersionId: 'v1',
    service: 'youtube',
    ingestUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
    teamId: 7,
    retiredAt: null,
  };

  it('writes a new version of the same secret, re-pins it and audits', async () => {
    const { service, prisma, secrets, metrics } = harness({ existing: row });
    const out = await service.replaceKey(
      'youtube-main',
      { streamKey: KEY },
      7,
      'user-1',
    );
    expect(secrets.put).toHaveBeenCalledWith('arn:old', {
      scheme: 'rtmps',
      host: 'a.rtmps.youtube.com',
      port: 443,
      application: 'live2',
      streamKey: KEY,
    });
    expect(secrets.create).not.toHaveBeenCalled();
    expect(
      prisma.broadcastDestination.update.mock.calls[0][0].data,
    ).toMatchObject({
      secretId: 'arn:old',
      secretVersionId: 'v2',
      keyLast4: '7d6c',
    });
    expect(prisma.broadcastDestinationKeyChange.create).toHaveBeenCalledWith({
      data: {
        teamId: 7,
        destinationId: 'youtube-main',
        subject: 'user-1',
        action: 'replaced',
      },
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'replace_key',
      'succeeded',
    );
  });

  it('leaves the pinned version alone when saving fails, and does not discard the shared secret', async () => {
    const { service, secrets } = harness({
      existing: row,
      txError: new Error('db'),
    });
    await expect(
      service.replaceKey('youtube-main', { streamKey: KEY }, 7, 'u'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(secrets.discard).not.toHaveBeenCalled();
  });

  it('answers 503, without the key, when the new version cannot be written', async () => {
    const { service, metrics } = harness({ existing: row, putError: true });
    const error = await service
      .replaceKey('youtube-main', { streamKey: KEY }, 7, 'u')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'replace_key',
      'failed',
    );
  });

  it('refuses to change the service of a destination that has one', async () => {
    const { service, secrets } = harness({ existing: row });
    await expect(
      service.replaceKey(
        'youtube-main',
        { streamKey: KEY, service: 'custom' },
        7,
        'u',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.replaceKey(
        'youtube-main',
        { streamKey: KEY, ingestUrl: 'rtmp://x.test/a' },
        7,
        'u',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it('refuses a missing or invalid key', async () => {
    const { service } = harness({ existing: row });
    await expect(
      service.replaceKey('youtube-main', {}, 7, 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.replaceKey('youtube-main', { streamKey: 'a b' }, 7, 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['a malformed id', '-bad', row, BadRequestException],
    ['an unknown destination', 'x', null, NotFoundException],
    [
      "another team's destination",
      'x',
      { ...row, teamId: 9 },
      NotFoundException,
    ],
    [
      'a destination with no team',
      'x',
      { ...row, teamId: null },
      NotFoundException,
    ],
    [
      'a retired destination',
      'x',
      { ...row, retiredAt: new Date() },
      ConflictException,
    ],
  ])('refuses %s', async (_name, id, existing, errorClass) => {
    const { service, secrets } = harness({ existing });
    await expect(
      service.replaceKey(id, { streamKey: KEY }, 7, 'u'),
    ).rejects.toBeInstanceOf(errorClass);
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it('applies no team check where no team is configured', async () => {
    const { service } = harness({ existing: { ...row, teamId: 9 } });
    await expect(
      service.replaceKey('youtube-main', { streamKey: KEY }, 0, 'u'),
    ).resolves.toMatchObject({ id: 'youtube-main' });
  });

  describe('a destination added by hand (no service yet)', () => {
    const legacy = {
      ...row,
      service: null,
      ingestUrl: null,
      secretId: 'broadcast/hand/made',
    };

    it('moves it under a secret this backend owns and records the service', async () => {
      const { service, prisma, secrets } = harness({ existing: legacy });
      await service.replaceKey(
        'youtube-main',
        { ...youtube, name: undefined },
        7,
        'u',
      );
      expect(secrets.create).toHaveBeenCalledWith(
        'alcantara/destinations/7/youtube-main',
        expect.objectContaining({
          host: 'a.rtmps.youtube.com',
          streamKey: KEY,
        }),
      );
      expect(secrets.put).not.toHaveBeenCalled();
      expect(
        prisma.broadcastDestination.update.mock.calls[0][0].data,
      ).toMatchObject({
        secretId: 'arn:new',
        secretVersionId: 'v1',
        service: 'youtube',
        ingestUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
      });
    });

    it('needs the service to be named', async () => {
      const { service } = harness({ existing: legacy });
      await expect(
        service.replaceKey('youtube-main', { streamKey: KEY }, 7, 'u'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('discards the new secret when the row cannot be saved, and answers 503 when it cannot be created', async () => {
      const failing = harness({ existing: legacy, txError: new Error('db') });
      await expect(
        failing.service.replaceKey('youtube-main', youtube, 7, 'u'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(failing.secrets.discard).toHaveBeenCalledWith('arn:new');
      const unable = harness({ existing: legacy, createSecretError: true });
      await expect(
        unable.service.replaceKey('youtube-main', youtube, 7, 'u'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('swallows a failed discard', async () => {
      const { service } = harness({
        existing: legacy,
        txError: new Error('db'),
        discardError: true,
      });
      await expect(
        service.replaceKey('youtube-main', youtube, 7, 'u'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
