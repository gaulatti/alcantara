import { PompeiiService } from '../auth/pompeii.service';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { listenOnLoopback } from '../../test/loopback-supertest';
import { ActorContextInterceptor } from '../auth/actor-context.interceptor';
import { PrismaService } from '../prisma.service';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { RadioController } from './radio.controller';
import { RadioMetricsService } from './radio-metrics.service';
import { RadioOutputConfidenceService } from './radio-output-confidence.service';
import { RadioService } from './radio.service';
import { SongExecutionEngine } from './song-execution.engine';
import { SongSimilarityService } from './song-similarity.service';

// gaulatti/alcantara#236: the console route, through the real global actor interceptor, the real
// controller and the real service, records who changed the radio settings (via=console) and never
// lets a failing record fail the write.

describe('PUT /radio/:programId/settings records its actor', () => {
  let app: INestApplication<App>;
  let prisma: any;
  let metrics: RadioMetricsService;

  beforeEach(async () => {
    metrics = new RadioMetricsService();
    prisma = {
      programState: { findUnique: jest.fn(async () => ({ id: 10 })) },
      radioSettings: {
        findUnique: jest.fn(async () => ({ enabled: false })),
        upsert: jest.fn(async () => ({
          id: 1,
          enabled: true,
          palazzoUrl: 'http://palazzo:3100',
        })),
      },
      operatorChangeRecord: { create: jest.fn(async () => ({})) },
    };
    const module = await Test.createTestingModule({
      controllers: [RadioController],
      providers: [
        RadioService,
        { provide: PompeiiService, useValue: { teamId: 0 } },
        ActorContextInterceptor,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PalazzoMachineClient,
          useValue: { validateBaseUrl: (v: string) => v },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: RadioMetricsService, useValue: metrics },
        { provide: SongExecutionEngine, useValue: {} },
        { provide: NowPlayingPublisherService, useValue: {} },
        {
          provide: PalazzoRadioTelemetryService,
          useValue: {
            handleRadioSettingsChanged: jest.fn(async () => undefined),
          },
        },
        { provide: RadioOutputConfidenceService, useValue: {} },
        {
          provide: SongSimilarityService,
          useValue: { onSettingsChanged: jest.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    // The authenticated user the real auth guard would have put on the request.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { sub: 'user-1', principalId: 'principal-console' };
      next();
    });
    app.useGlobalInterceptors(app.get(ActorContextInterceptor));
    await app.init();
    await listenOnLoopback(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('records the authenticated principal as via=console with the field and before/after', async () => {
    const res = await request(app.getHttpServer())
      .put('/radio/p/settings')
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(prisma.operatorChangeRecord.create).toHaveBeenCalledTimes(1);
    expect(prisma.operatorChangeRecord.create.mock.calls[0][0].data).toEqual({
      teamId: null,
      programId: 'p',
      principal: 'principal-console',
      via: 'console',
      client: null,
      capability: 'radio.update-settings',
      summary: {
        changed: ['enabled'],
        before: { enabled: false },
        after: { enabled: true },
      },
    });
    expect(metrics.render()).toContain(
      'alcantara_radio_operator_change_records_total{result="recorded"} 1',
    );
  });

  it('answers the write as usual when the record cannot be stored', async () => {
    prisma.operatorChangeRecord.create.mockRejectedValueOnce(
      new Error('refused'),
    );
    const res = await request(app.getHttpServer())
      .put('/radio/p/settings')
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1, enabled: true });
    expect(metrics.render()).toContain(
      'alcantara_radio_operator_change_records_total{result="failed"} 1',
    );
  });
});
