import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { listenOnLoopback } from '../../test/loopback-supertest';
import { ActorContextInterceptor } from '../auth/actor-context.interceptor';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { OperatorChangeRecorder } from '../operator-change/operator-change-recorder';
import { PrismaService } from '../prisma.service';
import { StingersController } from './stingers.controller';
import { StingersService } from './stingers.service';

jest.mock('../media-assets/media-asset-sync', () => ({
  ...jest.requireActual('../media-assets/media-asset-sync'),
  syncTransitionAsset: jest.fn(async () => 'asset-1'),
}));

// gaulatti/alcantara#236 slice 3: a console library route, through the real global actor
// interceptor, the real controller, service and recorder, records who changed the stinger
// (via=console, no program), and a record that cannot be stored never fails the write.

describe('PUT /stingers/:id records its actor', () => {
  let app: INestApplication<App>;
  let prisma: any;
  let metrics: ManagedMetricsService;
  const row = {
    id: 7,
    name: 'Fictional stinger',
    videoUrl: 'https://media.example.test/s.webm',
    cutPointMs: 1000,
    enabled: true,
  };

  beforeEach(async () => {
    metrics = new ManagedMetricsService();
    let stored = row;
    prisma = {
      stinger: {
        findUnique: jest.fn(async () => stored),
        update: jest.fn(async () => (stored = { ...row, enabled: false })),
      },
      $transaction: jest.fn((work: (tx: unknown) => unknown) => work(prisma)),
      operatorChangeRecord: { create: jest.fn(async () => ({})) },
    };
    const module = await Test.createTestingModule({
      controllers: [StingersController],
      providers: [
        StingersService,
        OperatorChangeRecorder,
        ActorContextInterceptor,
        { provide: PrismaService, useValue: prisma },
        { provide: ManagedMetricsService, useValue: metrics },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    // The authenticated user the real auth guard would have put on the request.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = {
        sub: 'user-1',
        principalId: 'principal-console',
        authorization: { teamId: 0 },
      };
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

  it('records the authenticated principal as via=console, with no program', async () => {
    const res = await request(app.getHttpServer())
      .put('/stingers/7')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(prisma.operatorChangeRecord.create).toHaveBeenCalledTimes(1);
    expect(prisma.operatorChangeRecord.create.mock.calls[0][0].data).toEqual({
      teamId: null,
      programId: null,
      principal: 'principal-console',
      via: 'console',
      client: null,
      capability: 'stingers.update',
      summary: {
        target: { kind: 'stinger', id: '7' },
        changed: ['enabled'],
        before: { enabled: true },
        after: { enabled: false },
      },
    });
    expect(await metrics.render('')).toContain(
      'alcantara_operator_change_records_total{target="stinger",result="recorded"} 1',
    );
  });

  it('answers the write as usual when the record cannot be stored', async () => {
    prisma.operatorChangeRecord.create.mockRejectedValueOnce(
      new Error('refused'),
    );
    const res = await request(app.getHttpServer())
      .put('/stingers/7')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, enabled: false });
    expect(await metrics.render('')).toContain(
      'alcantara_operator_change_records_total{target="stinger",result="failed"} 1',
    );
  });
});
