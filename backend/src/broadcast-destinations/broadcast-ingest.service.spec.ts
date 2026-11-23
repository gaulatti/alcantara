/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PrismaService } from '../prisma.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  BroadcastIngestService,
  type IngestSecretClient,
} from './broadcast-ingest.service';

const mockClientSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  ...jest.requireActual('@aws-sdk/client-secrets-manager'),
  SecretsManagerClient: jest.fn(() => ({ send: mockClientSend })),
}));

const KEY = 'live_AbC123-secret-key-9f8e7d';
const VERSION = 'v-123';

function secret(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    scheme: 'rtmps',
    host: 'a.rtmps.youtube.com',
    port: 443,
    application: 'live2',
    streamKey: KEY,
    ...overrides,
  });
}

function harness(
  options: {
    destination?: object | null;
    secretString?: string;
    noSecretString?: boolean;
    versionId?: string;
    sendError?: Error;
    auditError?: Error;
  } = {},
) {
  const destination =
    options.destination === undefined
      ? {
          id: 'youtube',
          displayName: 'YouTube',
          secretId: 'prod/tv/youtube',
          secretVersionId: VERSION,
          retiredAt: null,
          teamId: 7,
        }
      : options.destination;
  const prisma = {
    broadcastDestination: {
      findUnique: jest.fn().mockResolvedValue(destination),
    },
    broadcastIngestAccess: {
      create: options.auditError
        ? jest.fn().mockRejectedValue(options.auditError)
        : jest.fn().mockResolvedValue({}),
    },
  };
  const send = options.sendError
    ? jest.fn().mockRejectedValue(options.sendError)
    : jest.fn().mockResolvedValue({
        SecretString: options.noSecretString
          ? undefined
          : (options.secretString ?? secret()),
        VersionId: options.versionId ?? VERSION,
      });
  const metrics = { recordBroadcastDestination: jest.fn() };
  const service = new BroadcastIngestService(
    prisma as unknown as PrismaService,
    metrics as unknown as ManagedMetricsService,
  );
  service.secretClient = { send } as unknown as IngestSecretClient;
  return { service, prisma, send, metrics };
}

describe('BroadcastIngestService', () => {
  const sinks: jest.SpyInstance[] = [];
  afterEach(() => {
    sinks.splice(0).forEach((spy) => spy.mockRestore());
  });

  /** Every place this process could write the key: Nest's logger and the console. */
  function captureLogs() {
    for (const method of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'])
      sinks.push(jest.spyOn(Logger.prototype, method as 'log'));
    for (const method of ['log', 'info', 'warn', 'error', 'debug'])
      sinks.push(jest.spyOn(console, method as 'log').mockImplementation());
    return () =>
      sinks
        .flatMap((spy) => spy.mock.calls)
        .map((call) => JSON.stringify(call));
  }

  it('returns the address and key apart, reads the pinned version, and audits who asked', async () => {
    const { service, prisma, send, metrics } = harness();
    await expect(service.issue('youtube', 'user-1', 7)).resolves.toEqual({
      destinationId: 'youtube',
      displayName: 'YouTube',
      ingestUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
      streamKey: KEY,
    });
    expect(send.mock.calls[0][0].input).toEqual({
      SecretId: 'prod/tv/youtube',
      VersionId: VERSION,
    });
    expect(prisma.broadcastIngestAccess.create).toHaveBeenCalledWith({
      data: {
        teamId: 7,
        destinationId: 'youtube',
        subject: 'user-1',
        outcome: 'issued',
      },
    });
    expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'ingest',
      'succeeded',
    );
  });

  it('never puts the key in the audit row, the metrics or any log', async () => {
    const logs = captureLogs();
    const { service, prisma, metrics } = harness();
    await service.issue('youtube', 'user-1', 7);
    const failing = harness({ sendError: new Error(`boom ${KEY}`) });
    await expect(
      failing.service.issue('youtube', 'user-1', 7),
    ).rejects.toThrow();
    const keyed = harness({ secretString: secret({ extra: KEY }) });
    await expect(keyed.service.issue('youtube', 'user-1', 7)).rejects.toThrow();
    expect(
      JSON.stringify(prisma.broadcastIngestAccess.create.mock.calls),
    ).not.toContain(KEY);
    expect(
      JSON.stringify(metrics.recordBroadcastDestination.mock.calls),
    ).not.toContain(KEY);
    expect(
      JSON.stringify(failing.prisma.broadcastIngestAccess.create.mock.calls),
    ).not.toContain(KEY);
    expect(logs().join('\n')).not.toContain(KEY);
  });

  it('builds the address without a port, and brackets an IPv6 host', async () => {
    const plain = harness({
      secretString: secret({ port: undefined, scheme: 'rtmp' }),
    });
    await expect(plain.service.issue('youtube', 'u', 7)).resolves.toMatchObject(
      {
        ingestUrl: 'rtmp://a.rtmps.youtube.com/live2',
      },
    );
    const v6 = harness({
      secretString: secret({ host: '2001:db8::1', port: 1935, scheme: 'rtmp' }),
    });
    await expect(v6.service.issue('youtube', 'u', 7)).resolves.toMatchObject({
      ingestUrl: 'rtmp://[2001:db8::1]:1935/live2',
    });
    const v4 = harness({ secretString: secret({ host: '10.0.0.5' }) });
    await expect(v4.service.issue('youtube', 'u', 7)).resolves.toMatchObject({
      ingestUrl: 'rtmps://10.0.0.5:443/live2',
    });
  });

  it('refuses a malformed destination id before touching the database', async () => {
    const { service, prisma } = harness();
    await expect(service.issue('../x', 'u', 7)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.broadcastDestination.findUnique).not.toHaveBeenCalled();
    expect(prisma.broadcastIngestAccess.create).not.toHaveBeenCalled();
  });

  it('audits and refuses an unknown destination', async () => {
    const { service, prisma, send, metrics } = harness({ destination: null });
    await expect(service.issue('ghost', 'u', 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.broadcastIngestAccess.create).toHaveBeenCalledWith({
      data: {
        teamId: null,
        destinationId: 'ghost',
        subject: 'u',
        outcome: 'not_found',
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'ingest',
      'failed',
    );
  });

  it("answers another team's destination like an unknown one: 404, audited with its real team, no secret read", async () => {
    const { service, prisma, send } = harness({
      destination: {
        id: 'other',
        displayName: 'Other',
        secretId: 's',
        secretVersionId: VERSION,
        retiredAt: null,
        teamId: 9,
      },
    });
    await expect(service.issue('other', 'u', 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.broadcastIngestAccess.create).toHaveBeenCalledWith({
      data: {
        teamId: 9,
        destinationId: 'other',
        subject: 'u',
        outcome: 'not_found',
      },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a destination with no team once the caller has one', async () => {
    const { service, prisma, send } = harness({
      destination: {
        id: 'loose',
        displayName: 'Loose',
        secretId: 's',
        secretVersionId: VERSION,
        retiredAt: null,
        teamId: null,
      },
    });
    await expect(service.issue('loose', 'u', 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.broadcastIngestAccess.create).toHaveBeenCalledWith({
      data: {
        teamId: null,
        destinationId: 'loose',
        subject: 'u',
        outcome: 'not_found',
      },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('applies no team check where no team is configured (team 0, never production)', async () => {
    const { service } = harness({
      destination: {
        id: 'youtube',
        displayName: 'YouTube',
        secretId: 's',
        secretVersionId: VERSION,
        retiredAt: null,
        teamId: 9,
      },
    });
    await expect(service.issue('youtube', 'u', 0)).resolves.toMatchObject({
      destinationId: 'youtube',
    });
  });

  it('audits and refuses a retired destination without reading its secret', async () => {
    const { service, prisma, send } = harness({
      destination: {
        id: 'old',
        displayName: 'Old',
        secretId: 's',
        secretVersionId: VERSION,
        retiredAt: new Date(),
        teamId: 7,
      },
    });
    await expect(service.issue('old', 'u', 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.broadcastIngestAccess.create).toHaveBeenCalledWith({
      data: {
        teamId: 7,
        destinationId: 'old',
        subject: 'u',
        outcome: 'retired',
      },
    });
    expect(send).not.toHaveBeenCalled();
  });

  const unusable: Array<[string, Parameters<typeof harness>[0]]> = [
    ['the provider fails', { sendError: new Error(`denied ${KEY}`) }],
    ['the version differs from the pinned one', { versionId: 'other' }],
    ['there is no secret string', { noSecretString: true }],
    ['the payload is not JSON', { secretString: 'not json' }],
    ['the payload is an array', { secretString: '[]' }],
    ['the payload is null', { secretString: 'null' }],
    [
      'the payload has an unknown field',
      { secretString: secret({ token: 'x' }) },
    ],
    ['the scheme is not RTMP', { secretString: secret({ scheme: 'http' }) }],
    ['the host is missing', { secretString: secret({ host: undefined }) }],
    ['the host is not a host', { secretString: secret({ host: 'bad host!' }) }],
    [
      'the application is missing',
      { secretString: secret({ application: undefined }) },
    ],
    [
      'the application is invalid',
      { secretString: secret({ application: '-bad' }) },
    ],
    [
      'the application climbs',
      { secretString: secret({ application: 'a/../b' }) },
    ],
    ['the key is missing', { secretString: secret({ streamKey: undefined }) }],
    ['the key is empty', { secretString: secret({ streamKey: '' }) }],
    [
      'the key is too long',
      { secretString: secret({ streamKey: 'k'.repeat(513) }) },
    ],
    [
      'the key has a control character',
      { secretString: secret({ streamKey: 'a\u0001b' }) },
    ],
    ['the key has whitespace', { secretString: secret({ streamKey: 'a b' }) }],
    ['the port is a string', { secretString: secret({ port: '443' }) }],
    ['the port is fractional', { secretString: secret({ port: 1.5 }) }],
    ['the port is zero', { secretString: secret({ port: 0 }) }],
    ['the port is too large', { secretString: secret({ port: 70000 }) }],
  ];

  it.each(unusable)(
    'answers unavailable, audited, and leaks nothing when %s',
    async (_name, options) => {
      const logs = captureLogs();
      const { service, prisma, metrics } = harness(options);
      const error = await service
        .issue('youtube', 'u', 7)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect((error as Error).message).toBe(
        'The destination credential is unavailable',
      );
      expect(prisma.broadcastIngestAccess.create).toHaveBeenCalledWith({
        data: {
          teamId: 7,
          destinationId: 'youtube',
          subject: 'u',
          outcome: 'unavailable',
        },
      });
      expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
        'ingest',
        'failed',
      );
      expect(logs().join('\n')).not.toContain(KEY);
    },
  );

  it('returns nothing when the audit row cannot be written', async () => {
    const { service, metrics } = harness({
      auditError: new Error(`db ${KEY}`),
    });
    const error = await service
      .issue('youtube', 'u', 7)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(metrics.recordBroadcastDestination).toHaveBeenCalledWith(
      'ingest',
      'failed',
    );
  });

  it('creates the Secrets Manager client on first use and reuses it', async () => {
    mockClientSend.mockResolvedValue({
      SecretString: secret(),
      VersionId: VERSION,
    });
    const prisma = {
      broadcastDestination: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'youtube',
          displayName: 'YouTube',
          secretId: 's',
          secretVersionId: VERSION,
          retiredAt: null,
          teamId: 7,
        }),
      },
      broadcastIngestAccess: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new BroadcastIngestService(
      prisma as never,
      {
        recordBroadcastDestination: jest.fn(),
      } as never,
    );
    await service.issue('youtube', 'u', 7);
    await service.issue('youtube', 'u', 7);
    expect(SecretsManagerClient).toHaveBeenCalledTimes(1);
    expect(mockClientSend).toHaveBeenCalledTimes(2);
  });
});
