import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  credentials,
  loadPackageDefinition,
  waitForClientReady,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { ALCANTARA_PERMISSIONS } from './permissions';
import {
  LOCAL_POMPEII_GRPC_URL,
  PRODUCTION_POMPEII_GRPC_URL,
  PompeiiService,
  mapAuthorizationDecision,
} from './pompeii.service';
import type { ManagedMetricsService } from '../observability/managed-metrics.service';

const mockClient = { authorize: jest.fn(), close: jest.fn() };
const mockConstruct = jest.fn();

jest.mock('@grpc/grpc-js', () => ({
  credentials: {
    createSsl: jest.fn(() => 'fixture-tls-credentials'),
    createInsecure: jest.fn(() => 'fixture-local-credentials'),
  },
  loadPackageDefinition: jest.fn(() => ({
    pompeii: {
      authorization: {
        v1: {
          AuthorizationService: function (...args: unknown[]) {
            mockConstruct(...args);
            return mockClient;
          },
        },
      },
    },
  })),
  waitForClientReady: jest.fn(),
}));
jest.mock('@grpc/proto-loader', () => ({
  loadSync: jest.fn(() => ({ fixture: 'authorization-proto-definition' })),
}));

function fixture(
  environment: Record<string, unknown> = {},
  withMetrics = true,
) {
  const metrics = { recordDependency: jest.fn() };
  const service = new PompeiiService(
    new ConfigService(environment),
    withMetrics ? (metrics as unknown as ManagedMetricsService) : undefined,
  );
  return { service, metrics };
}

describe('Pompeii client lifecycle, transport and fail-closed authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .mocked(waitForClientReady)
      .mockImplementation((_client, _deadline, callback) => callback());
    mockClient.authorize.mockImplementation((_request, _options, callback) =>
      callback(null, {}),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('loads the real authorization protocol contract and uses local credentials only outside production', () => {
    const { service } = fixture({
      NODE_ENV: 'development',
      POMPEII_GRPC_URL: 'untrusted.invalid:9999',
    });
    expect(loadSync).toHaveBeenCalledWith(
      expect.stringMatching(/proto\/authorization\.proto$/),
      {
        defaults: true,
        enums: String,
        keepCase: true,
        longs: String,
        oneofs: true,
      },
    );
    expect(loadPackageDefinition).toHaveBeenCalledWith({
      fixture: 'authorization-proto-definition',
    });
    expect(credentials.createInsecure).toHaveBeenCalledTimes(1);
    expect(credentials.createSsl).not.toHaveBeenCalled();
    expect(mockConstruct).toHaveBeenCalledWith(
      LOCAL_POMPEII_GRPC_URL,
      'fixture-local-credentials',
    );
    service.onModuleDestroy();
    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  it('uses TLS and the code-owned production endpoint with the explicit team', async () => {
    const { service } = fixture({
      NODE_ENV: 'production',
      POMPEII_TEAM_ID: '42',
      POMPEII_GRPC_URL: 'untrusted.invalid:9999',
    });
    expect(service.teamId).toBe(42);
    expect(credentials.createSsl).toHaveBeenCalledTimes(1);
    expect(credentials.createInsecure).not.toHaveBeenCalled();
    expect(mockConstruct).toHaveBeenCalledWith(
      PRODUCTION_POMPEII_GRPC_URL,
      'fixture-tls-credentials',
    );
    await service.onModuleInit();
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('(team 42)'),
    );
  });

  it.each([undefined, '', '0', '-1', '1.5', 'not-a-team'])(
    'rejects an absent or invalid production team %j before opening a client',
    (team) => {
      expect(() =>
        fixture({ NODE_ENV: 'production', POMPEII_TEAM_ID: team }),
      ).toThrow(/explicit positive integer/);
      expect(mockConstruct).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['-1', 0],
    ['1.5', 0],
    ['invalid', 0],
    ['0', 0],
    ['23', 23],
  ])('bounds nonproduction team %s to %i', (configured, expected) => {
    expect(fixture({ POMPEII_TEAM_ID: configured }).service.teamId).toBe(
      expected,
    );
  });

  it.each([
    [undefined, 2000],
    ['0', 2000],
    ['-1', 2000],
    ['1.5', 2000],
    ['invalid', 2000],
    ['2750', 2750],
  ])('applies the bounded RPC timeout for %j', async (configured, expected) => {
    const { service } = fixture({ POMPEII_GRPC_TIMEOUT_MS: configured });
    const before = Date.now();
    await service.checkConnection();
    const deadline = jest.mocked(waitForClientReady).mock.calls[0][1] as Date;
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + expected);
    expect(deadline.getTime()).toBeLessThanOrEqual(Date.now() + expected);
  });

  it('uses local-token mode without a network readiness probe', async () => {
    const { service, metrics } = fixture({ AUTH_MODE: 'test' });
    await service.onModuleInit();
    expect(waitForClientReady).not.toHaveBeenCalled();
    expect(metrics.recordDependency).not.toHaveBeenCalled();
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('local test-token verification'),
    );
  });

  it('announces readiness for an unscoped local client and records the connection result', async () => {
    const { service, metrics } = fixture();
    await service.onModuleInit();
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('(team global)'),
    );
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'pompeii',
      'connect',
      'success',
      expect.any(Number),
    );
    expect(metrics.recordDependency.mock.calls[0][3]).toBeGreaterThanOrEqual(0);
  });

  it.each([new Error('connection refused'), 'opaque channel failure'])(
    'reports an unavailable development transport without terminating startup: %s',
    async (error) => {
      jest
        .mocked(waitForClientReady)
        .mockImplementation((_client, _deadline, callback) =>
          callback(error as Error),
        );
      const { service, metrics } = fixture();
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining(error instanceof Error ? error.message : error),
      );
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'connect',
        'unavailable',
        expect.any(Number),
      );
    },
  );

  it('refuses production startup when transport readiness fails', async () => {
    jest
      .mocked(waitForClientReady)
      .mockImplementation((_client, _deadline, callback) =>
        callback(new Error('fixture channel unavailable')),
      );
    const { service } = fixture({
      NODE_ENV: 'production',
      POMPEII_TEAM_ID: '1',
    });
    await expect(service.onModuleInit()).rejects.toThrow(
      'Pompeii authorization is required in production: fixture channel unavailable',
    );
  });

  it('uses a safe diagnosis when an unavailable readiness result has no reason', async () => {
    const { service } = fixture({
      NODE_ENV: 'production',
      POMPEII_TEAM_ID: '1',
    });
    jest
      .spyOn(service, 'checkConnection')
      .mockResolvedValue({ target: PRODUCTION_POMPEII_GRPC_URL, ready: false });
    await expect(service.onModuleInit()).rejects.toThrow(
      'Pompeii authorization is required in production: unavailable',
    );
  });

  it('honors an explicit one-off readiness timeout and permits absent metrics', async () => {
    const { service } = fixture({}, false);
    const before = Date.now();
    await expect(service.checkConnection(75)).resolves.toEqual({
      target: LOCAL_POMPEII_GRPC_URL,
      ready: true,
    });
    const deadline = jest.mocked(waitForClientReady).mock.calls[0][1] as Date;
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + 75);
    expect(deadline.getTime()).toBeLessThanOrEqual(Date.now() + 75);
  });

  it('carries token, requested permission and team unchanged into the RPC and preserves canonical identity', async () => {
    const wire = {
      authenticated: true,
      allowed: true,
      subject: 'legacy-subject',
      principal_id: ' canonical-person ',
      effective_permissions: ['alcantara:program:read'],
      roles: ['operator'],
      reason: 'ALLOW_EXPLICIT',
    };
    mockClient.authorize.mockImplementation((_request, _options, callback) =>
      callback(null, wire),
    );
    const { service, metrics } = fixture({
      POMPEII_TEAM_ID: '12',
      POMPEII_GRPC_TIMEOUT_MS: '3210',
    });
    const before = Date.now();
    await expect(
      service.authorize(
        'fictional-bearer-token',
        ALCANTARA_PERMISSIONS.program.read,
      ),
    ).resolves.toEqual({
      authenticated: true,
      allowed: true,
      subject: 'legacy-subject',
      principalId: 'canonical-person',
      effectivePermissions: ['alcantara:program:read'],
      roles: ['operator'],
      reason: 'ALLOW_EXPLICIT',
    });
    expect(mockClient.authorize).toHaveBeenCalledWith(
      {
        bearer_token: 'fictional-bearer-token',
        permission: ALCANTARA_PERMISSIONS.program.read,
        team_id: 12,
      },
      { deadline: expect.any(Date) },
      expect.any(Function),
    );
    const deadline = mockClient.authorize.mock.calls[0][1].deadline as Date;
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + 3210);
    expect(deadline.getTime()).toBeLessThanOrEqual(Date.now() + 3210);
    expect(metrics.recordDependency).toHaveBeenCalledWith(
      'pompeii',
      'authorize',
      'success',
      expect.any(Number),
    );
  });

  it.each([
    { authenticated: false, allowed: true },
    { authenticated: true, allowed: false },
    { authenticated: false, allowed: false },
    {},
    undefined,
  ])(
    'does not turn a denied or absent RPC result into authentication: %j',
    async (wire) => {
      mockClient.authorize.mockImplementation((_request, _options, callback) =>
        callback(null, wire),
      );
      const { service, metrics } = fixture();
      const result = await service.authorize(
        'fictional-token',
        ALCANTARA_PERMISSIONS.program.read,
      );
      expect(result.authenticated && result.allowed).toBe(false);
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'authorize',
        'denied',
        expect.any(Number),
      );
      if (!wire)
        expect(result).toEqual({
          authenticated: false,
          allowed: false,
          reason: 'DENY_UNSPECIFIED',
          subject: '',
          principalId: null,
          effectivePermissions: [],
          roles: [],
        });
    },
  );

  it.each([new Error('RPC fixture disconnected'), 'RPC fixture failure'])(
    'fails closed with a sanitized503 response after an RPC error: %s',
    async (error) => {
      mockClient.authorize.mockImplementation((_request, _options, callback) =>
        callback(error),
      );
      const { service, metrics } = fixture();
      const result = await service
        .authorize('fictional-token', ALCANTARA_PERMISSIONS.program.read)
        .catch((caught: unknown) => caught);
      expect(result).toBeInstanceOf(ServiceUnavailableException);
      expect((result as ServiceUnavailableException).getStatus()).toBe(503);
      expect((result as ServiceUnavailableException).getResponse()).toEqual({
        error: 'AUTHORIZATION_SERVICE_UNAVAILABLE',
      });
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'authorize',
        'unavailable',
        expect.any(Number),
      );
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining(error instanceof Error ? error.message : error),
      );
    },
  );

  it('does not infer an identity from whitespace canonical IDs or non-boolean allow fields', () => {
    expect(
      mapAuthorizationDecision({
        authenticated: 1 as never,
        allowed: 'true' as never,
        principal_id: '  ',
        subject: '',
        reason: '',
      }),
    ).toEqual({
      authenticated: false,
      allowed: false,
      principalId: null,
      subject: '',
      reason: 'DENY_UNSPECIFIED',
      effectivePermissions: [],
      roles: [],
    });
  });
});
