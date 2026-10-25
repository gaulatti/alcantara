import type { Server } from 'node:http';

describe('application bootstrap configuration', () => {
  const original = { ...process.env };
  let app: {
    register: jest.Mock;
    enableCors: jest.Mock;
    listen: jest.Mock;
    get: jest.Mock;
    getHttpAdapter: jest.Mock;
    getHttpServer: jest.Mock;
  };
  let attach: jest.Mock;
  let safety: jest.Mock;
  let database: jest.Mock;
  let secrets: jest.Mock;
  let create: jest.Mock;
  const fastifyServer = { on: jest.fn() };
  const fallback = { marker: 'actual adapter fallback' } as unknown as Server;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...original };
    for (const key of [
      'PORT',
      'HTTP_PORT',
      'ALLOWED_ORIGINS',
      'FRONTEND_ORIGIN',
    ])
      delete process.env[key];
    attach = jest.fn();
    safety = jest.fn();
    database = jest.fn().mockResolvedValue(undefined);
    secrets = jest.fn().mockResolvedValue(undefined);
    app = {
      register: jest.fn().mockResolvedValue(undefined),
      enableCors: jest.fn(),
      listen: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockReturnValue({ attachToServer: attach }),
      getHttpAdapter: jest
        .fn()
        .mockReturnValue({ getInstance: () => ({ server: fastifyServer }) }),
      getHttpServer: jest.fn().mockReturnValue(fallback),
    };
    create = jest.fn().mockResolvedValue(app);
    jest.doMock('@nestjs/core', () => ({ NestFactory: { create } }));
    jest.doMock('@nestjs/platform-fastify', () => ({
      FastifyAdapter: class FastifyAdapter {},
    }));
    jest.doMock('./app.module', () => ({ AppModule: class AppModule {} }));
    jest.doMock('./program/program.realtime.service', () => ({
      ProgramRealtimeService: class ProgramRealtimeService {},
    }));
    jest.doMock('./auth/test-auth.service', () => ({
      assertTestAuthSafety: safety,
    }));
    jest.doMock('./config/database-secrets', () => ({
      loadDatabaseSecret: database,
    }));
    jest.doMock('./config/runtime-secrets', () => ({
      loadRuntimeSecrets: secrets,
    }));
  });

  afterEach(() => {
    process.env = { ...original };
  });

  async function boot() {
    require('./main');
    // bootstrap awaits platform and secret-loading promises before attaching.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attach).toHaveBeenCalledTimes(1);
  }

  it('loads safety and database/runtime secrets before creating the application, then configures bounded uploads and realtime', async () => {
    await boot();
    expect(safety.mock.invocationCallOrder[0]).toBeLessThan(
      database.mock.invocationCallOrder[0],
    );
    expect(database.mock.invocationCallOrder[0]).toBeLessThan(
      secrets.mock.invocationCallOrder[0],
    );
    expect(secrets.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0],
    );
    expect(app.register).toHaveBeenCalledWith(expect.any(Function), {
      limits: { files: 1, fileSize: 100 * 1024 * 1024 },
    });
    expect(app.listen).toHaveBeenCalledWith(3000, '0.0.0.0');
    expect(attach).toHaveBeenCalledWith(fastifyServer);
    expect(app.getHttpServer).not.toHaveBeenCalled();
  });

  it.each([
    [{ PORT: '4200', HTTP_PORT: '4300' }, 4200],
    [{ HTTP_PORT: '4300' }, 4300],
    [{ PORT: 'not-a-number' }, 3000],
    [{}, 3000],
  ])(
    'selects the documented listener port from %j',
    async (environment, expected) => {
      Object.assign(process.env, environment);
      await boot();
      expect(app.listen).toHaveBeenCalledWith(expected, '0.0.0.0');
    },
  );

  it.each([
    { server: undefined },
    { server: { on: 'not an event interface' } },
    undefined,
  ])(
    'attaches realtime to the application HTTP fallback for adapter shape %j',
    async (instance) => {
      app.getHttpAdapter.mockReturnValue({ getInstance: () => instance });
      await boot();
      expect(app.getHttpServer).toHaveBeenCalledTimes(1);
      expect(attach).toHaveBeenCalledWith(fallback);
    },
  );

  it.each([
    [
      { ALLOWED_ORIGINS: ' https://custom.invalid, , https://second.invalid ' },
      'https://custom.invalid',
    ],
    [
      { ALLOWED_ORIGINS: ' https://custom.invalid, , https://second.invalid ' },
      'https://second.invalid',
    ],
    [
      { FRONTEND_ORIGIN: 'https://frontend.invalid' },
      'https://frontend.invalid',
    ],
    [{}, 'https://alcantara.gaulatti.com'],
    [{}, 'https://alcantara.dev'],
    [{}, 'https://alcantara.gt'],
    [{}, 'https://fifthbell.com'],
    [{}, 'https://cdn.fifthbell.com'],
    [{}, 'http://localhost'],
    [{}, 'https://127.0.0.1:9443'],
    [{}, 'null'],
    [{}, undefined],
  ])('allows a supported CORS origin %s → %s', async (environment, origin) => {
    Object.assign(process.env, environment);
    await boot();
    const policy = app.enableCors.mock.calls[0][0];
    const callback = jest.fn();
    policy.origin(origin, callback);
    expect(callback).toHaveBeenCalledWith(null, true);
    expect(policy).toMatchObject({
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Renderer-Key',
      ],
    });
  });

  it.each([
    'https://attacker.invalid',
    'https://alcantara.gaulatti.com.attacker.invalid',
    'https://localhost.attacker.invalid',
    'http://127.0.0.10',
  ])(
    'rejects origins outside explicit and loopback boundaries: %s',
    async (origin) => {
      await boot();
      const callback = jest.fn();
      app.enableCors.mock.calls[0][0].origin(origin, callback);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Origin ${origin} not allowed by CORS`,
        }),
        false,
      );
    },
  );

  it('uses explicit ALLOWED_ORIGINS instead of falling through an intentionally empty setting', async () => {
    process.env.ALLOWED_ORIGINS = '';
    process.env.FRONTEND_ORIGIN = 'https://frontend.invalid';
    await boot();
    const callback = jest.fn();
    app.enableCors.mock.calls[0][0].origin(
      'https://frontend.invalid',
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.any(Error), false);
  });
});
