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
import { listenOnLoopback } from '../test/loopback-supertest';
import { MetricsController } from './metrics.controller';
import { ManagedMetricsService } from './observability/managed-metrics.service';
import { MetricsTokenGuard } from './observability/metrics-token.guard';
import { PalazzoMetricsPassthrough } from './observability/palazzo-metrics.passthrough';
import { RadioMetricsService } from './radio/radio-metrics.service';
import { PALAZZO_FETCH } from './radio/palazzo-machine.client';

// gaulatti/alcantara#255: a song sent with no analysis at all is counted on
// alcantara_radio_analysis_dropped_total, and the private scrape shows it with
// a bounded result label only.

const TOKEN = 'unit-test-scrape-token';
const METRIC = 'alcantara_radio_analysis_dropped_total';

describe('GET /metrics: songs sent without analysis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'analysis-drops-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  let app: NestFastifyApplication;

  afterEach(async () => {
    await app?.close();
    delete process.env.METRICS_TOKEN_FILE;
    delete process.env.PALAZZO_ALLOWED_URLS;
  });

  it('exports each reason with its count and no other label', async () => {
    process.env.METRICS_TOKEN_FILE = tokenFile;
    process.env.PALAZZO_ALLOWED_URLS = 'http://palazzo:3100';
    const radioMetrics = new RadioMetricsService();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true })],
      controllers: [MetricsController],
      providers: [
        ManagedMetricsService,
        MetricsTokenGuard,
        PalazzoMetricsPassthrough,
        { provide: RadioMetricsService, useValue: radioMetrics },
        { provide: PALAZZO_FETCH, useValue: jest.fn() },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await listenOnLoopback(app.getHttpServer());

    radioMetrics.recordAnalysisDrop('not-analyzed');
    radioMetrics.recordAnalysisDrop('not-analyzed');
    radioMetrics.recordAnalysisDrop('no-asset');
    radioMetrics.recordAnalysisDrop('lookup-failed');

    const response = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(response.headers['content-type']).toContain('text/plain');

    const samples = new Map<string, number>();
    for (const line of response.text.split('\n')) {
      if (!line.startsWith(`${METRIC}{`)) continue;
      // Exactly one label, `result`, with a bounded value.
      const match =
        /^alcantara_radio_analysis_dropped_total\{result="([a-z-]+)"\} (\d+)$/.exec(
          line,
        );
      expect(match).not.toBeNull();
      samples.set(match![1], Number(match![2]));
    }
    expect(response.text).toContain(`# TYPE ${METRIC} counter`);
    expect(Object.fromEntries(samples)).toEqual({
      'segue-invalid': 0,
      'segue-beyond-duration': 0,
      'segue-edge-bound': 0,
      'loudness-invalid': 0,
      'ambiguous-match': 0,
      'no-asset': 1,
      'not-analyzed': 2,
      'lookup-failed': 1,
    });
  });
});
