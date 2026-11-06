const mockMultipart = Symbol('multipart');

type Callback = (err: Error | null, allow?: boolean) => void;

interface Harness {
  create: jest.Mock;
  app: {
    register: jest.Mock;
    enableCors: jest.Mock;
    listen: jest.Mock;
    get: jest.Mock;
    getHttpAdapter: jest.Mock;
    getHttpServer: jest.Mock;
  };
  attachToServer: jest.Mock;
  assertTestAuthSafety: jest.Mock;
  loadDatabaseSecret: jest.Mock;
  loadRuntimeSecrets: jest.Mock;
  order: string[];
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

async function runMain(options: {
  fastifyInstance?: unknown;
}): Promise<Harness> {
  const order: string[] = [];
  const attachToServer = jest.fn();
  const httpServer = { marker: 'http-server' };
  const app = {
    register: jest.fn().mockResolvedValue(undefined),
    enableCors: jest.fn(),
    listen: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockReturnValue({ attachToServer }),
    getHttpAdapter: jest.fn().mockReturnValue({
      getInstance: () => options.fastifyInstance,
    }),
    getHttpServer: jest.fn().mockReturnValue(httpServer),
  };
  const create = jest.fn().mockResolvedValue(app);
  const assertTestAuthSafety = jest.fn(() => {
    order.push('assert');
  });
  const loadDatabaseSecret = jest.fn(async () => {
    order.push('db');
  });
  const loadRuntimeSecrets = jest.fn(async () => {
    order.push('runtime');
  });

  jest.isolateModules(() => {
    jest.doMock('dotenv/config', () => ({}));
    jest.doMock('@fastify/multipart', () => ({
      __esModule: true,
      default: mockMultipart,
    }));
    jest.doMock('@nestjs/core', () => ({ NestFactory: { create } }));
    jest.doMock('@nestjs/platform-fastify', () => ({
      FastifyAdapter: class FastifyAdapter {},
    }));
    jest.doMock('./app.module', () => ({ AppModule: class AppModule {} }));
    jest.doMock('./program/program.realtime.service', () => ({
      ProgramRealtimeService: class ProgramRealtimeService {},
    }));
    jest.doMock('./config/runtime-secrets', () => ({ loadRuntimeSecrets }));
    jest.doMock('./auth/test-auth.service', () => ({ assertTestAuthSafety }));
    jest.doMock('./config/database-secrets', () => ({ loadDatabaseSecret }));
    require('./main');
  });
  await flush();
  return {
    create,
    app,
    attachToServer,
    assertTestAuthSafety,
    loadDatabaseSecret,
    loadRuntimeSecrets,
    order,
  };
}

function corsOrigin(h: Harness) {
  const options = h.app.enableCors.mock.calls[0][0] as {
    origin: (origin: string | undefined, cb: Callback) => void;
  };
  return (origin: string | undefined) => {
    const cb = jest.fn();
    options.origin(origin, cb as unknown as Callback);
    return cb;
  };
}

describe('main bootstrap', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.HTTP_PORT;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.FRONTEND_ORIGIN;
  });

  afterEach(() => {
    process.env = { ...saved };
    jest.dontMock('dotenv/config');
    jest.resetModules();
  });

  it('loads safety and secrets in order, registers multipart, and listens on the default port', async () => {
    const server = { on: jest.fn() };
    const h = await runMain({ fastifyInstance: { server } });

    expect(h.order).toEqual(['assert', 'db', 'runtime']);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.app.register).toHaveBeenCalledWith(mockMultipart, {
      limits: { files: 1, fileSize: 100 * 1024 * 1024 },
    });
    expect(h.app.listen).toHaveBeenCalledWith(3000, '0.0.0.0');
    const corsOptions = h.app.enableCors.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(corsOptions.credentials).toBe(true);
    expect(corsOptions.methods).toEqual([
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'OPTIONS',
    ]);
    expect(corsOptions.allowedHeaders).toEqual([
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Renderer-Key',
    ]);
    expect(h.attachToServer).toHaveBeenCalledWith(server);
    expect(h.app.getHttpServer).not.toHaveBeenCalled();
  });

  it('uses PORT over HTTP_PORT, and HTTP_PORT when PORT is unset', async () => {
    process.env.PORT = '4100';
    process.env.HTTP_PORT = '4200';
    const first = await runMain({
      fastifyInstance: { server: { on: jest.fn() } },
    });
    expect(first.app.listen).toHaveBeenCalledWith(4100, '0.0.0.0');

    delete process.env.PORT;
    const second = await runMain({
      fastifyInstance: { server: { on: jest.fn() } },
    });
    expect(second.app.listen).toHaveBeenCalledWith(4200, '0.0.0.0');
  });

  it('falls back to 3000 when the configured port is not a number', async () => {
    process.env.PORT = 'abc';
    const h = await runMain({ fastifyInstance: { server: { on: jest.fn() } } });
    expect(h.app.listen).toHaveBeenCalledWith(3000, '0.0.0.0');
  });

  it('falls back to the nest http server when the fastify server has no on()', async () => {
    const withoutOn = await runMain({ fastifyInstance: { server: {} } });
    expect(withoutOn.attachToServer).toHaveBeenCalledWith({
      marker: 'http-server',
    });

    const withoutServer = await runMain({ fastifyInstance: {} });
    expect(withoutServer.attachToServer).toHaveBeenCalledWith({
      marker: 'http-server',
    });

    const withoutInstance = await runMain({ fastifyInstance: undefined });
    expect(withoutInstance.attachToServer).toHaveBeenCalledWith({
      marker: 'http-server',
    });
  });

  describe('CORS origin policy', () => {
    it('allows absent, null, built-in, and localhost origins', async () => {
      const h = await runMain({
        fastifyInstance: { server: { on: jest.fn() } },
      });
      const check = corsOrigin(h);
      for (const origin of [
        undefined,
        'null',
        'https://alcantara.gaulatti.com',
        'https://alcantara.dev',
        'https://alcantara.gt',
        'https://fifthbell.com',
        'https://cdn.fifthbell.com',
        'http://localhost',
        'https://localhost:5173',
        'http://127.0.0.1:3000',
      ]) {
        expect(check(origin)).toHaveBeenCalledWith(null, true);
      }
    });

    it('rejects unknown origins with a descriptive error', async () => {
      const h = await runMain({
        fastifyInstance: { server: { on: jest.fn() } },
      });
      const cb = corsOrigin(h)('https://evil.example');
      expect(cb).toHaveBeenCalledTimes(1);
      const [error, allow] = cb.mock.calls[0] as [Error, boolean];
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        'Origin https://evil.example not allowed by CORS',
      );
      expect(allow).toBe(false);
    });

    it('adds trimmed ALLOWED_ORIGINS entries and ignores empty ones', async () => {
      process.env.ALLOWED_ORIGINS = ' https://a.example , ,https://b.example';
      process.env.FRONTEND_ORIGIN = 'https://ignored.example';
      const h = await runMain({
        fastifyInstance: { server: { on: jest.fn() } },
      });
      const check = corsOrigin(h);
      expect(check('https://a.example')).toHaveBeenCalledWith(null, true);
      expect(check('https://b.example')).toHaveBeenCalledWith(null, true);
      expect(check('https://ignored.example').mock.calls[0][1]).toBe(false);
    });

    it('uses FRONTEND_ORIGIN when ALLOWED_ORIGINS is unset', async () => {
      process.env.FRONTEND_ORIGIN = 'https://front.example';
      const h = await runMain({
        fastifyInstance: { server: { on: jest.fn() } },
      });
      expect(corsOrigin(h)('https://front.example')).toHaveBeenCalledWith(
        null,
        true,
      );
    });
  });
});
