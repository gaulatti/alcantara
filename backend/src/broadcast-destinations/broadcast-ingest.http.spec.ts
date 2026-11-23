import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { listenOnLoopback } from '../../test/loopback-supertest';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { ActorContextInterceptor } from '../auth/actor-context.interceptor';
import { PompeiiAuthorizationGuard } from '../auth/pompeii-authorization.guard';
import { PompeiiService } from '../auth/pompeii.service';
import { HttpMetricsInterceptor } from '../observability/http-metrics.interceptor';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';
import { BroadcastDestinationsService } from './broadcast-destinations.service';
import {
  BroadcastIngestService,
  type IngestSecretClient,
} from './broadcast-ingest.service';

// The ingest route through the real global guard and the real Pompeii client code, with only
// the gRPC transport and the database replaced. gaulatti/carmencita#4.

const KEY = 'live_HttpSpec-key-4f3e2d1c';

describe('POST /broadcast/destinations/:destinationId/ingest', () => {
  let app: INestApplication<App>;
  let audit: jest.Mock;
  let secrets: jest.Mock;
  let findDestination: jest.Mock;
  let logged: string[];

  beforeEach(async () => {
    logged = [];
    for (const level of [
      'log',
      'warn',
      'error',
      'debug',
      'verbose',
      'fatal',
    ] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    const metrics = new ManagedMetricsService();
    const pompeii = new PompeiiService(
      new ConfigService({ NODE_ENV: 'test', POMPEII_TEAM_ID: '7' }),
      metrics,
    );
    // Three sessions: a manager, a viewer (broadcast.view only) and one that is not signed in.
    const authorize = (
      wire: { bearer_token: string; permission: string },
      _options: unknown,
      callback: (error: Error | null, value: unknown) => void,
    ) => {
      const token = wire.bearer_token.replace(/^Bearer\s+/i, '');
      const granted: string[] =
        token === 'manager'
          ? [
              ALCANTARA_PERMISSIONS.broadcast.manage,
              ALCANTARA_PERMISSIONS.broadcast.view,
            ]
          : token === 'viewer'
            ? [ALCANTARA_PERMISSIONS.broadcast.view]
            : [];
      callback(null, {
        authenticated: token !== 'signed-out',
        allowed: granted.includes(wire.permission),
        reason: token === 'signed-out' ? 'DENY_UNAUTHENTICATED' : 'ALLOW',
        subject: `${token}-subject`,
        principal_id: `${token}-principal`,
        effective_permissions: granted,
        roles: [token],
      });
    };
    (pompeii as unknown as { channel: { client: unknown } }).channel.client = {
      authorize,
      close: jest.fn(),
    };
    audit = jest.fn().mockResolvedValue({});
    secrets = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        scheme: 'rtmps',
        host: 'a.rtmps.youtube.com',
        port: 443,
        application: 'live2',
        streamKey: KEY,
      }),
      VersionId: 'v1',
    });
    const prisma = {
      broadcastDestination: {
        findUnique: (findDestination = jest.fn(
          ({ where }: { where: { id: string } }) =>
            Promise.resolve(
              where.id === 'youtube'
                ? {
                    id: 'youtube',
                    displayName: 'YouTube',
                    secretId: 'prod/tv/youtube',
                    secretVersionId: 'v1',
                    retiredAt: null,
                    teamId: 7,
                  }
                : null,
            ),
        )),
      },
      broadcastIngestAccess: { create: audit },
    };
    const module = await Test.createTestingModule({
      controllers: [BroadcastDestinationsController],
      providers: [
        Reflector,
        PompeiiAuthorizationGuard,
        BroadcastIngestService,
        { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
        { provide: PompeiiService, useValue: pompeii },
        { provide: BroadcastDestinationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: ManagedMetricsService, useValue: metrics },
      ],
    }).compile();
    module.get(BroadcastIngestService).secretClient = {
      send: secrets,
    } as unknown as IngestSecretClient;
    app = module.createNestApplication({ logger: false });
    app.useGlobalGuards(app.get(PompeiiAuthorizationGuard));
    await app.init();
    await listenOnLoopback(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const call = (token?: string, id = 'youtube') => {
    const req = request(app.getHttpServer()).post(
      `/broadcast/destinations/${id}/ingest`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('is refused when nobody is signed in, and reads no secret and writes no audit row', async () => {
    await call().expect(401);
    await call('signed-out').expect(401);
    expect(secrets).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('is refused without broadcast.manage, even with broadcast.view', async () => {
    const response = await call('viewer').expect(403);
    expect(response.text).not.toContain(KEY);
    expect(secrets).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('gives a manager the address and key, uncacheable, and audits who asked', async () => {
    const response = await call('manager').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      destinationId: 'youtube',
      displayName: 'YouTube',
      ingestUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
      streamKey: KEY,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      data: {
        teamId: 7,
        destinationId: 'youtube',
        subject: 'manager-subject',
        outcome: 'issued',
      },
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(KEY);
  });

  it('keeps the key out of every log line, on success and on failure', async () => {
    await call('manager').expect(200);
    secrets.mockRejectedValueOnce(new Error(`provider echoed ${KEY}`));
    const failure = await call('manager').expect(503);
    expect(failure.text).not.toContain(KEY);
    await call('manager', 'ghost').expect(404);
    expect(logged.join('\n')).not.toContain(KEY);
    expect(
      audit.mock.calls.map(
        (c: [{ data: { outcome: string } }]) => c[0].data.outcome,
      ),
    ).toEqual(['issued', 'unavailable', 'not_found']);
  });

  it('answers 503 and returns no key when the audit row cannot be written', async () => {
    audit.mockRejectedValueOnce(new Error(`db down ${KEY}`));
    const response = await call('manager').expect(503);
    expect(response.text).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it("answers another team's destination as not found, audited with its real team, reading no secret", async () => {
    findDestination.mockResolvedValueOnce({
      id: 'youtube',
      displayName: 'YouTube',
      secretId: 'prod/tv/youtube',
      secretVersionId: 'v1',
      retiredAt: null,
      teamId: 9,
    });
    const response = await call('manager').expect(404);
    expect(response.text).not.toContain(KEY);
    expect(secrets).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      data: {
        teamId: 9,
        destinationId: 'youtube',
        subject: 'manager-subject',
        outcome: 'not_found',
      },
    });
  });

  it('logs neither the key nor an address with the key in it, with the real interceptors in place', async () => {
    const response = await call('manager').expect(200);
    const body = response.body as { ingestUrl: string };
    const text = JSON.stringify(body);
    expect(body.ingestUrl).not.toContain(KEY);
    expect(text).toContain(KEY);
    const lines = logged.join('\n');
    expect(lines).not.toContain(KEY);
    expect(lines).not.toContain('live2/');
    expect(lines).not.toContain(body.ingestUrl);
  });

  it('refuses a malformed destination id', async () => {
    await call('manager', '..%2Fx').expect(400);
    expect(audit).not.toHaveBeenCalled();
  });
});
