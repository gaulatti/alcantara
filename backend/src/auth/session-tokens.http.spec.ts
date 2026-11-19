import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AuthController } from './auth.controller';
import { ALCANTARA_PERMISSIONS } from './permissions';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { PompeiiService } from './pompeii.service';
import { RealtimeTicketService } from './realtime-ticket.service';

// Requests through the real global guard and the real Pompeii client code,
// with only the gRPC transport replaced. Every credential is a placeholder
// built here from repeated characters.

const accessTokenShaped = `pmp_pat_${'q'.repeat(43)}`;
const body = 'q'.repeat(43);
const sessionToken = (fill: string) =>
  `${fill.repeat(36)}.${fill.repeat(120)}.${fill.repeat(86)}`;

describe('session tokens on the API', () => {
  let app: INestApplication<App>;
  let grpcAuthorize: jest.Mock;
  let metrics: ManagedMetricsService;
  let logged: string[];

  beforeEach(async () => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
    metrics = new ManagedMetricsService();
    const pompeii = new PompeiiService(
      new ConfigService({ NODE_ENV: 'test', POMPEII_TEAM_ID: '7' }),
      metrics,
    );
    grpcAuthorize = jest.fn(
      (
        _request: unknown,
        _options: unknown,
        callback: (error: Error | null, value: unknown) => void,
      ) =>
        callback(null, {
          authenticated: true,
          allowed: true,
          reason: 'ALLOW',
          subject: 'subject-1',
          principal_id: 'principal-1',
          effective_permissions: [ALCANTARA_PERMISSIONS.access],
          roles: ['operator'],
        }),
    );
    (pompeii as unknown as { channel: { client: unknown } }).channel.client = {
      authorize: grpcAuthorize,
      close: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        Reflector,
        RealtimeTicketService,
        { provide: PompeiiService, useValue: pompeii },
        PompeiiAuthorizationGuard,
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalGuards(app.get(PompeiiAuthorizationGuard));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const sentToPompeii = (call: number): unknown =>
    (grpcAuthorize.mock.calls as unknown[][])[call][0];

  const refusals = async () =>
    (await metrics.registry.metrics())
      .split('\n')
      .find((line) =>
        line.startsWith(
          'alcantara_auth_refusals_total{reason="unsupported_credential"}',
        ),
      );

  it.each([
    ['GET /auth/me', () => request(app.getHttpServer()).get('/auth/me')],
    [
      'POST /auth/realtime-ticket',
      () =>
        request(app.getHttpServer())
          .post('/auth/realtime-ticket')
          .send({ programId: 'main' }),
    ],
  ])(
    'answers 401 on %s for a credential it does not accept, with no authorization call',
    async (_route, call) => {
      for (const header of [
        `Bearer ${accessTokenShaped}`,
        `bearer ${accessTokenShaped}`,
        `BEARER  ${accessTokenShaped}`,
        accessTokenShaped,
      ]) {
        const response = await call().set('Authorization', header).expect(401);
        expect(response.body).toEqual({
          error: 'UNAUTHENTICATED',
          reason: 'DENY_UNSUPPORTED_CREDENTIAL',
        });
        expect(response.text).not.toContain(body);
      }
      expect(grpcAuthorize).not.toHaveBeenCalled();
      expect(await refusals()).toMatch(/ 4$/);
      expect(
        logged.join('\n') + (await metrics.registry.metrics()),
      ).not.toContain(body);
    },
  );

  it('issues no realtime ticket for a credential it does not accept', async () => {
    const issue = jest.spyOn(app.get(RealtimeTicketService), 'issue');
    await request(app.getHttpServer())
      .post('/auth/realtime-ticket')
      .set('Authorization', `Bearer ${accessTokenShaped}`)
      .send({ programId: 'main' })
      .expect(401);
    expect(issue).not.toHaveBeenCalled();
  });

  it.each([
    ['an ID token', `Bearer ${sessionToken('i')}`],
    ['an access token', `Bearer ${sessionToken('a')}`],
    ['a bare session token', sessionToken('b')],
  ])(
    'forwards %s to Pompeii exactly as before',
    async (_kind, authorization) => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', authorization)
        .expect(200);
      expect(sentToPompeii(0)).toEqual({
        bearer_token: authorization,
        permission: ALCANTARA_PERMISSIONS.access,
        team_id: 7,
      });
      await request(app.getHttpServer())
        .post('/auth/realtime-ticket')
        .set('Authorization', authorization)
        .send({ programId: 'main' })
        .expect(201);
      expect(sentToPompeii(1)).toEqual({
        bearer_token: authorization,
        permission: ALCANTARA_PERMISSIONS.program.read,
        team_id: 7,
      });
      expect(await refusals()).toMatch(/ 0$/);
    },
  );

  it.each([
    `Bearer PMP_PAT_${'r'.repeat(8)}`,
    `Bearer pmp_pat${'r'.repeat(8)}`,
    `Bearer pmp_pa_${'r'.repeat(8)}`,
    `Bearer x${accessTokenShaped}`,
    `Bearer pmp-pat-${'r'.repeat(8)}`,
    `Bearer${accessTokenShaped}`,
    `Token ${accessTokenShaped}`,
  ])(
    'forwards the look-alike %p to Pompeii unchanged',
    async (authorization) => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', authorization)
        .expect(200);
      expect(sentToPompeii(0)).toEqual({
        bearer_token: authorization,
        permission: ALCANTARA_PERMISSIONS.access,
        team_id: 7,
      });
    },
  );

  it('still requires a bearer token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    expect(grpcAuthorize).not.toHaveBeenCalled();
  });
});
