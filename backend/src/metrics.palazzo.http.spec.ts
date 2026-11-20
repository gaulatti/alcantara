import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { MetricsController } from './metrics.controller';
import { ManagedMetricsService } from './observability/managed-metrics.service';
import { MetricsTokenGuard } from './observability/metrics-token.guard';
import { PalazzoMetricsPassthrough } from './observability/palazzo-metrics.passthrough';
import { RadioMetricsService } from './radio/radio-metrics.service';
import { PALAZZO_FETCH } from './radio/palazzo-machine.client';

const TOKEN = 'unit-test-scrape-token';

async function boot(tokenFile: string, fetchImpl: jest.Mock) {
  process.env.METRICS_TOKEN_FILE = tokenFile;
  process.env.PALAZZO_ALLOWED_URLS = 'http://palazzo:3100';
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true })],
    controllers: [MetricsController],
    providers: [
      ManagedMetricsService,
      MetricsTokenGuard,
      PalazzoMetricsPassthrough,
      { provide: RadioMetricsService, useValue: { render: () => '' } },
      { provide: PALAZZO_FETCH, useValue: fetchImpl },
    ],
  }).compile();
  // The production HTTP adapter is Fastify (main.ts); an Express test app hid a
  // reply API that only exists on Express (response.setHeader).
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, managed: moduleRef.get(ManagedMetricsService) };
}

describe('GET /metrics/palazzo over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'palazzo-metrics-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  let app: NestFastifyApplication;

  afterEach(async () => {
    await app?.close();
    delete process.env.METRICS_TOKEN_FILE;
    delete process.env.PALAZZO_ALLOWED_URLS;
  });

  it('401 without the bearer and never contacts Palazzo', async () => {
    const fetchImpl = jest.fn();
    ({ app } = await boot(tokenFile, fetchImpl));
    await request(app.getHttpServer()).get('/metrics/palazzo').expect(401);
    await request(app.getHttpServer())
      .get('/metrics/palazzo')
      .set('Authorization', 'Bearer wrong')
      .expect(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('503 when the scrape credential file is unavailable', async () => {
    const fetchImpl = jest.fn();
    ({ app } = await boot(join(dir, 'missing'), fetchImpl));
    await request(app.getHttpServer()).get('/metrics/palazzo').expect(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the text through, never forwards the bearer, and exposes the new metrics', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementation(async () => new Response('palazzo_up 1\n'));
    let managed: ManagedMetricsService;
    ({ app, managed } = await boot(tokenFile, fetchImpl));
    const response = await request(app.getHttpServer())
      .get('/metrics/palazzo')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(response.text).toBe('palazzo_up 1\n');
    expect(response.headers['content-type']).toMatch(/^text\/plain; /);
    expect(response.headers['content-type']).toContain('version=0.0.4');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://palazzo:3100/metrics');
    expect(JSON.stringify(init)).not.toContain(TOKEN);
    expect(init.headers.Authorization).toBeUndefined();

    const output = await managed.render('');
    expect(output).toContain(
      'alcantara_palazzo_metrics_scrape_total{result="ok"} 1',
    );
    expect(output).toMatch(
      /alcantara_palazzo_metrics_scrape_duration_seconds_count 1/,
    );
  });

  it('502 with an empty body when Palazzo is down', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('refused'));
    ({ app } = await boot(tokenFile, fetchImpl));
    const response = await request(app.getHttpServer())
      .get('/metrics/palazzo')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(502);
    expect(response.text).toBe('');
  });

  it('502 empty without following a redirect', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://elsewhere/metrics' },
      }),
    );
    ({ app } = await boot(tokenFile, fetchImpl));
    const response = await request(app.getHttpServer())
      .get('/metrics/palazzo')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(502);
    expect(response.text).toBe('');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
});
