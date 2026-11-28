import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { corsOptions } from './cors';

@Controller('probe')
class ProbeController {
  @Get()
  probe() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

// The CORS policy as the API applies it (Fastify, enableCors), over HTTP.
describe('CORS policy over HTTP', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.enableCors(corsOptions());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  const preflight = (origin: string) =>
    app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });

  it.each([
    'tauri://localhost',
    'http://tauri.localhost',
    'https://alcantara.gaulatti.com',
  ])('lets %s call the API', async (origin) => {
    const response = await preflight(origin);
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
  });

  it('answers an unknown origin without CORS headers, and without a server error', async () => {
    const response = await preflight('https://unknown.example');
    expect(response.statusCode).toBeLessThan(500);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    const get = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://unknown.example' },
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never lets the opaque null origin call the API', async () => {
    const response = await preflight('null');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// In production a page served from localhost is not the console's: only the listed origins call the API.
describe('CORS policy over HTTP, in production', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.enableCors(corsOptions({ NODE_ENV: 'production' }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  const preflight = (origin: string) =>
    app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: { origin, 'access-control-request-method': 'GET' },
    });

  it.each([
    'https://alcantara.gaulatti.com',
    'https://fifthbell.com',
    'https://cdn.fifthbell.com',
    'tauri://localhost',
    'http://tauri.localhost',
  ])('still lets %s call the API, with credentials', async (origin) => {
    const response = await preflight(origin);
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it.each(['http://localhost', 'https://localhost:5173', 'http://127.0.0.1:3000', 'null'])(
    'refuses %s',
    async (origin) => {
      const response = await preflight(origin);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    },
  );
});

