import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { credentials, waitForClientReady } from '@grpc/grpc-js';
import { ALCANTARA_PERMISSIONS } from './permissions';
import {
  LOCAL_POMPEII_GRPC_URL,
  PRODUCTION_POMPEII_GRPC_URL,
  PompeiiService,
} from './pompeii.service';

const mockClients: Array<{
  address: string;
  creds: unknown;
  authorize: jest.Mock;
  close: jest.Mock;
}> = [];

jest.mock('@grpc/proto-loader', () => ({ loadSync: jest.fn(() => ({})) }));
jest.mock('@grpc/grpc-js', () => {
  class FakeClient {
    authorize = jest.fn();
    close = jest.fn();
    constructor(
      public address: string,
      public creds: unknown,
    ) {
      mockClients.push(this);
    }
  }
  return {
    credentials: {
      createSsl: jest.fn(() => 'ssl-credentials'),
      createInsecure: jest.fn(() => 'insecure-credentials'),
    },
    loadPackageDefinition: jest.fn(() => ({
      pompeii: { authorization: { v1: { AuthorizationService: FakeClient } } },
    })),
    waitForClientReady: jest.fn(),
  };
});

const permission = ALCANTARA_PERMISSIONS.program.read;

function make(
  values: Record<string, string> = {},
  metrics?: { recordDependency: jest.Mock },
) {
  const service = new PompeiiService(
    new ConfigService(values),
    metrics as never,
  );
  return { service, client: mockClients[mockClients.length - 1] };
}

describe('PompeiiService', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClients.length = 0;
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('construction', () => {
    it('uses local defaults with insecure credentials', () => {
      const { service, client } = make();
      expect(service.teamId).toBe(0);
      expect(client.address).toBe(LOCAL_POMPEII_GRPC_URL);
      expect(client.creds).toBe('insecure-credentials');
      expect(credentials.createSsl).not.toHaveBeenCalled();
    });

    it('uses the production endpoint with TLS and a configured team', () => {
      const { service, client } = make({
        NODE_ENV: 'production',
        POMPEII_TEAM_ID: '12',
      });
      expect(service.teamId).toBe(12);
      expect(client.address).toBe(PRODUCTION_POMPEII_GRPC_URL);
      expect(client.creds).toBe('ssl-credentials');
    });

    it.each(['abc', '-5', '1.5', '0'])(
      'falls back to the default deadline for timeout %p',
      async (timeout) => {
        const { service, client } = make({ POMPEII_GRPC_TIMEOUT_MS: timeout });
        jest.useFakeTimers().setSystemTime(1_000_000);
        client.authorize.mockImplementation((_r, options, cb) => {
          expect((options as { deadline: Date }).deadline.getTime()).toBe(
            1_002_000,
          );
          cb(null, { authenticated: true, allowed: true, subject: 's' });
        });
        await service.authorize('Bearer t', permission);
        jest.useRealTimers();
      },
    );

    it('honors a valid timeout and treats an invalid team as 0', async () => {
      const { service, client } = make({
        POMPEII_GRPC_TIMEOUT_MS: '500',
        POMPEII_TEAM_ID: '-3',
      });
      expect(service.teamId).toBe(0);
      jest.useFakeTimers().setSystemTime(2_000_000);
      client.authorize.mockImplementation((_r, options, cb) => {
        expect((options as { deadline: Date }).deadline.getTime()).toBe(
          2_000_500,
        );
        cb(null, {});
      });
      await service.authorize('Bearer t', permission);
      jest.useRealTimers();
    });
  });

  describe('onModuleInit', () => {
    it('skips network checks in test auth mode', async () => {
      const { service } = make({ AUTH_MODE: 'test' });
      const check = jest.spyOn(service, 'checkConnection');
      await service.onModuleInit();
      expect(check).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        'Pompeii network authorization replaced by local test-token verification',
      );
    });

    it('logs readiness with the team or global', async () => {
      const global = make().service;
      jest
        .spyOn(global, 'checkConnection')
        .mockResolvedValue({ target: 't:1', ready: true });
      await global.onModuleInit();
      expect(log).toHaveBeenCalledWith(
        'Pompeii authorization ready at t:1 (team global)',
      );

      const team = make({ POMPEII_TEAM_ID: '4' }).service;
      jest
        .spyOn(team, 'checkConnection')
        .mockResolvedValue({ target: 't:2', ready: true });
      await team.onModuleInit();
      expect(log).toHaveBeenCalledWith(
        'Pompeii authorization ready at t:2 (team 4)',
      );
    });

    it('only warns outside production when unavailable', async () => {
      const { service } = make();
      jest.spyOn(service, 'checkConnection').mockResolvedValue({
        target: 't:1',
        ready: false,
        error: 'down',
      });
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        'Pompeii authorization unavailable at startup (t:1): down',
      );
    });

    it('throws in production, with a fallback message when no error text exists', async () => {
      const { service } = make({
        NODE_ENV: 'production',
        POMPEII_TEAM_ID: '1',
      });
      const check = jest.spyOn(service, 'checkConnection');
      check.mockResolvedValueOnce({ target: 't', ready: false, error: 'down' });
      await expect(service.onModuleInit()).rejects.toThrow(
        'Pompeii authorization is required in production: down',
      );
      check.mockResolvedValueOnce({ target: 't', ready: false });
      await expect(service.onModuleInit()).rejects.toThrow(
        'Pompeii authorization is required in production: unavailable',
      );
    });
  });

  it('closes the client on module destroy', () => {
    const { service, client } = make();
    service.onModuleDestroy();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  describe('checkConnection', () => {
    it('reports ready and records a success metric', async () => {
      const metrics = { recordDependency: jest.fn() };
      const { service } = make({ POMPEII_GRPC_TIMEOUT_MS: '700' }, metrics);
      jest.mocked(waitForClientReady).mockImplementation(((
        _c: unknown,
        deadline: Date,
        cb: (e?: Error) => void,
      ) => {
        expect(deadline).toBeInstanceOf(Date);
        cb();
      }) as never);
      await expect(service.checkConnection()).resolves.toEqual({
        target: LOCAL_POMPEII_GRPC_URL,
        ready: true,
      });
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'connect',
        'success',
        expect.any(Number),
      );
    });

    it('uses an explicit timeout and reports Error and non-Error failures', async () => {
      const metrics = { recordDependency: jest.fn() };
      const { service } = make({}, metrics);
      jest.useFakeTimers().setSystemTime(5_000);
      jest.mocked(waitForClientReady).mockImplementationOnce(((
        _c: unknown,
        deadline: Date,
        cb: (e?: Error) => void,
      ) => {
        expect(deadline.getTime()).toBe(5_250);
        cb(new Error('refused'));
      }) as never);
      await expect(service.checkConnection(250)).resolves.toEqual({
        target: LOCAL_POMPEII_GRPC_URL,
        ready: false,
        error: 'refused',
      });
      jest
        .mocked(waitForClientReady)
        .mockImplementationOnce(((
          _c: unknown,
          _d: Date,
          cb: (e?: unknown) => void,
        ) => cb('plain failure')) as never);
      await expect(service.checkConnection()).resolves.toMatchObject({
        ready: false,
        error: 'plain failure',
      });
      jest.useRealTimers();
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'connect',
        'unavailable',
        expect.any(Number),
      );
    });

    it('works without a metrics sink', async () => {
      const { service } = make();
      jest
        .mocked(waitForClientReady)
        .mockImplementationOnce(((
          _c: unknown,
          _d: Date,
          cb: (e?: Error) => void,
        ) => cb()) as never);
      await expect(service.checkConnection()).resolves.toMatchObject({
        ready: true,
      });
    });
  });

  describe('authorize', () => {
    it('sends the token, permission and team and maps an allowed decision', async () => {
      const metrics = { recordDependency: jest.fn() };
      const { service, client } = make({ POMPEII_TEAM_ID: '8' }, metrics);
      client.authorize.mockImplementation((request, _o, cb) => {
        expect(request).toEqual({
          bearer_token: 'Bearer t',
          permission,
          team_id: 8,
        });
        cb(null, {
          authenticated: true,
          allowed: true,
          subject: 'sub',
          roles: ['r'],
          effective_permissions: [permission],
          principal_id: 'p',
          reason: 'ALLOW',
        });
      });
      await expect(service.authorize('Bearer t', permission)).resolves.toEqual({
        authenticated: true,
        allowed: true,
        reason: 'ALLOW',
        subject: 'sub',
        principalId: 'p',
        effectivePermissions: [permission],
        roles: ['r'],
      });
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'authorize',
        'success',
        expect.any(Number),
      );
    });

    it('maps empty responses to a denied decision with defaults', async () => {
      const metrics = { recordDependency: jest.fn() };
      const { service, client } = make({}, metrics);
      client.authorize.mockImplementation((_r, _o, cb) => cb(null, undefined));
      await expect(service.authorize('Bearer t', permission)).resolves.toEqual({
        authenticated: false,
        allowed: false,
        reason: 'DENY_UNSPECIFIED',
        subject: '',
        principalId: null,
        effectivePermissions: [],
        roles: [],
      });
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'authorize',
        'denied',
        expect.any(Number),
      );
    });

    it('records denied when authenticated but not allowed, and when allowed but not authenticated', async () => {
      const metrics = { recordDependency: jest.fn() };
      const { service, client } = make({}, metrics);
      client.authorize.mockImplementationOnce((_r, _o, cb) =>
        cb(null, { authenticated: true, allowed: false }),
      );
      await service.authorize('t', permission);
      client.authorize.mockImplementationOnce((_r, _o, cb) =>
        cb(null, { authenticated: false, allowed: true }),
      );
      await service.authorize('t', permission);
      const results = metrics.recordDependency.mock.calls.map((c) => c[2]);
      expect(results).toEqual(['denied', 'denied']);
    });

    it('turns transport failures into 503 without leaking details', async () => {
      const metrics = { recordDependency: jest.fn() };
      const { service, client } = make({}, metrics);
      client.authorize.mockImplementationOnce((_r, _o, cb) =>
        cb(new Error('socket hang up')),
      );
      await expect(service.authorize('t', permission)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(error).toHaveBeenCalledWith(
        `Pompeii decision failed for ${permission}: socket hang up`,
      );
      expect(metrics.recordDependency).toHaveBeenCalledWith(
        'pompeii',
        'authorize',
        'unavailable',
        expect.any(Number),
      );
    });

    it('logs non-Error failures and works without a metrics sink', async () => {
      const { service, client } = make();
      client.authorize.mockImplementationOnce((_r, _o, cb) => cb('weird'));
      await expect(service.authorize('t', permission)).rejects.toMatchObject({
        response: { error: 'AUTHORIZATION_SERVICE_UNAVAILABLE' },
      });
      expect(error).toHaveBeenCalledWith(
        `Pompeii decision failed for ${permission}: weird`,
      );
    });
  });

  it('records Object for the config dependency when its module is not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('@nestjs/config', () => ({}));
      jest.doMock('../observability/managed-metrics.service', () => ({}));
      const { PompeiiService: Isolated } = require('./pompeii.service');
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([
        Object,
        Object,
      ]);
    });
  });
});
