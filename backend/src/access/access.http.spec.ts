import { status } from '@grpc/grpc-js';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PompeiiAuthorizationGuard } from '../auth/pompeii-authorization.guard';
import { PompeiiService } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import {
  BEARER,
  SERVICE_CREDENTIAL,
  TOKEN_VALUE,
  startFakePompeii,
  type FakePompeii,
} from './access.testing';

// gaulatti/alcantara#224: every /access route through the real global guard,
// the real controller and service and the real Pompeii client code, against a
// fake Pompeii gRPC server.

const token = {
  id: '6f0b0a52-0000-4000-8000-000000000001',
  name: 'My laptop',
  display_prefix: 'pmp_pat_abcd',
  permissions: ['alcantara:program:read'],
  created_at: '2026-11-19T10:00:00Z',
  expires_at: '',
  last_used_at: '2026-11-19T11:00:00Z',
  created_via_application: 'alcantara',
  last_used_application: 'monitor',
};
const grant = {
  id: 9,
  user_id: 4,
  user_email: 'ana@example.test',
  role_id: 2,
  role_name: 'Operator',
  team_id: 0,
  granted_at: '2026-11-19T12:00:00Z',
};

describe('/access', () => {
  let fake: FakePompeii;
  let app: INestApplication<App>;
  let metrics: ManagedMetricsService;
  let logged: string[];

  async function start(config: Record<string, string> = {}) {
    metrics = new ManagedMetricsService();
    const pompeii = new PompeiiService(
      new ConfigService({
        NODE_ENV: 'test',
        POMPEII_GRPC_TIMEOUT_MS: '300',
        POMPEII_ACCESS_CREDENTIAL: SERVICE_CREDENTIAL,
        ...config,
      }),
      metrics,
    );
    // Point the client at the fake instead of the local default address.
    const internals = pompeii as unknown as {
      grpcUrl: string;
      channel: { client: { close(): void }; dial: () => { close(): void } };
    };
    internals.grpcUrl = `127.0.0.1:${fake.port}`;
    internals.channel.client.close();
    internals.channel.client = internals.channel.dial();
    const module = await Test.createTestingModule({
      controllers: [AccessController],
      providers: [
        Reflector,
        AccessService,
        PompeiiAuthorizationGuard,
        { provide: PompeiiService, useValue: pompeii },
        { provide: ManagedMetricsService, useValue: metrics },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalGuards(app.get(PompeiiAuthorizationGuard));
    await app.init();
    return pompeii;
  }

  beforeEach(async () => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
    fake = await startFakePompeii();
  });

  afterEach(async () => {
    await app.close();
    await fake.close();
    jest.restoreAllMocks();
  });

  const http = () => request(app.getHttpServer());
  const accessCalls = () => fake.calls;
  const metricLine = async (route: string, result: string) =>
    (await metrics.registry.metrics())
      .split('\n')
      .find((line) =>
        line.startsWith(
          `alcantara_access_requests_total{route="${route}",result="${result}"}`,
        ),
      );

  it('forwards each route with the bearer unchanged and the service credential, and returns Pompeii answer', async () => {
    await start();
    fake.answers.set('ListMyTokens', { reply: { tokens: [token] } });
    fake.answers.set('CreateMyToken', {
      reply: { token, value: TOKEN_VALUE },
    });
    fake.answers.set('RevokeMyToken', { reply: {} });
    fake.answers.set('GetTokenSwitch', { reply: { enabled: true } });
    fake.answers.set('SetTokenSwitch', { reply: { enabled: false } });
    fake.answers.set('ListRoles', {
      reply: { roles: [{ id: 2, name: 'Operator', permissions: ['a', 'b'] }] },
    });
    fake.answers.set('ListGrants', { reply: { grants: [grant] } });
    fake.answers.set('Grant', { reply: grant });
    fake.answers.set('Revoke', { reply: {} });
    fake.answers.set('ListAccessHistory', {
      reply: {
        entries: [
          {
            at: '2026-11-19T12:00:00Z',
            action: 'grant',
            actor_email: 'boss@example.test',
            target: 'ana@example.test',
            via_application: 'alcantara',
            via_client: 'console',
          },
        ],
      },
    });
    const auth = (r: request.Test) => r.set('Authorization', BEARER);

    const list = await auth(http().get('/access/tokens')).expect(200);
    expect(list.body).toEqual({ tokens: [token] });
    const created = await auth(
      http()
        .post('/access/tokens')
        .send({
          name: 'My laptop',
          expires_in_days: 30,
          no_expiry: false,
          permissions: ['alcantara:program:read'],
          all_held_in_application: false,
        }),
    ).expect(201);
    expect(created.body).toEqual({ token, value: TOKEN_VALUE });
    expect(
      (
        await auth(
          http().delete('/access/tokens/6f0b0a52-0000-4000-8000-000000000001'),
        ).expect(200)
      ).body,
    ).toEqual({});
    expect(
      (await auth(http().get('/access/token-switch')).expect(200)).body,
    ).toEqual({ enabled: true });
    expect(
      (
        await auth(
          http().put('/access/token-switch').send({ enabled: false }),
        ).expect(200)
      ).body,
    ).toEqual({ enabled: false });
    expect((await auth(http().get('/access/roles')).expect(200)).body).toEqual({
      roles: [{ id: 2, name: 'Operator', permissions: ['a', 'b'] }],
    });
    expect((await auth(http().get('/access/grants')).expect(200)).body).toEqual(
      { grants: [grant] },
    );
    expect(
      (
        await auth(
          http().post('/access/grants').send({ user_id: 4, role_id: 2 }),
        ).expect(201)
      ).body,
    ).toEqual(grant);
    expect(
      (await auth(http().delete('/access/grants/9')).expect(200)).body,
    ).toEqual({});
    const history = await auth(
      http().get('/access/history?limit=20&before=2026-11-19T13:00:00Z'),
    ).expect(200);
    expect((history.body as { entries: unknown[] }).entries).toHaveLength(1);

    const access = { bearer_token: BEARER, team_id: 0, via_client: 'console' };
    expect(accessCalls().map((call) => call.request)).toEqual([
      access,
      {
        access,
        name: 'My laptop',
        expires_in_days: 30,
        no_expiry: false,
        permissions: ['alcantara:program:read'],
        all_held_in_application: false,
      },
      { access, token_id: token.id },
      access,
      { access, enabled: false },
      access,
      access,
      { access, user_id: 4, role_id: 2 },
      { access, grant_id: 9 },
      { access, limit: 20, before: '2026-11-19T13:00:00Z' },
    ]);
    expect(accessCalls().map((call) => call.method)).toEqual([
      'ListMyTokens',
      'CreateMyToken',
      'RevokeMyToken',
      'GetTokenSwitch',
      'SetTokenSwitch',
      'ListRoles',
      'ListGrants',
      'Grant',
      'Revoke',
      'ListAccessHistory',
    ]);
    expect(
      accessCalls().every((c) => c.credential === SERVICE_CREDENTIAL),
    ).toBe(true);
    expect(await metricLine('token_create', 'ok')).toMatch(/ 1$/);
    expect(
      await metrics.registry.getSingleMetricAsString(
        'alcantara_access_request_duration_seconds',
      ),
    ).toContain('route="history_list"');
  });

  it('uses the defaults of the history query and of a bare create', async () => {
    await start();
    fake.answers.set('CreateMyToken', { reply: { token, value: TOKEN_VALUE } });
    await http()
      .get('/access/history')
      .set('Authorization', BEARER)
      .expect(200);
    await http()
      .post('/access/tokens')
      .set('Authorization', BEARER)
      .send({ name: 'x' })
      .expect(201);
    expect(accessCalls()[0].request).toMatchObject({ limit: 50, before: '' });
    expect(accessCalls()[1].request).toMatchObject({
      expires_in_days: 0,
      no_expiry: false,
      permissions: [],
      all_held_in_application: false,
    });
  });

  it('puts the token value in no answer but the create answer', async () => {
    await start();
    fake.answers.set('ListMyTokens', { reply: { tokens: [token] } });
    fake.answers.set('CreateMyToken', { reply: { token, value: TOKEN_VALUE } });
    const created = await http()
      .post('/access/tokens')
      .set('Authorization', BEARER)
      .send({ name: 'My laptop', all_held_in_application: true })
      .expect(201);
    const listed = await http()
      .get('/access/tokens')
      .set('Authorization', BEARER)
      .expect(200);
    expect(created.text).toContain(TOKEN_VALUE);
    expect(listed.text).not.toContain(TOKEN_VALUE);
  });

  it('answers 503 access_unavailable without calling Pompeii when the credential is absent or blank', async () => {
    for (const value of [undefined, '', '   ']) {
      fake.calls.length = 0;
      await start(
        value === undefined
          ? { POMPEII_ACCESS_CREDENTIAL: '' }
          : {
              POMPEII_ACCESS_CREDENTIAL: value,
            },
      );
      const response = await http()
        .get('/access/tokens')
        .set('Authorization', BEARER)
        .expect(503);
      expect(response.body).toEqual({ error: 'access_unavailable' });
      expect(accessCalls()).toEqual([]);
      expect(await metricLine('tokens_list', 'not_configured')).toMatch(/ 1$/);
      await app.close();
    }
    await start();
  });

  it.each([
    [status.UNAUTHENTICATED, 401, 'unauthenticated'],
    [status.PERMISSION_DENIED, 403, 'forbidden'],
    [status.INVALID_ARGUMENT, 400, 'invalid_request'],
    [status.FAILED_PRECONDITION, 409, 'tokens_off'],
    [status.NOT_FOUND, 404, 'not_found'],
  ])(
    'maps gRPC %s to HTTP %s without Pompeii message',
    async (code, http_, error) => {
      await start();
      fake.answers.set('ListMyTokens', { fail: code });
      const response = await http()
        .get('/access/tokens')
        .set('Authorization', BEARER)
        .expect(http_);
      expect(response.body).toEqual({ error });
      expect(response.text).not.toContain('a message Pompeii wrote');
      expect(await metricLine('tokens_list', error)).toMatch(/ 1$/);
    },
  );

  it.each([status.UNAVAILABLE, status.INTERNAL, status.UNIMPLEMENTED])(
    'maps gRPC %s to 503 access_unavailable',
    async (code) => {
      await start();
      fake.answers.set('ListGrants', { fail: code });
      const response = await http()
        .get('/access/grants')
        .set('Authorization', BEARER)
        .expect(503);
      expect(response.body).toEqual({ error: 'access_unavailable' });
      expect(await metricLine('grants_list', 'unavailable')).toMatch(/ 1$/);
    },
  );

  it('answers 503 on a deadline and replaces the channel, as authorization does', async () => {
    await start();
    fake.answers.set('ListRoles', { delayMs: 1_000 });
    await http().get('/access/roles').set('Authorization', BEARER).expect(503);
    expect(
      await metrics.registry.getSingleMetricAsString(
        'alcantara_pompeii_channel_resets_total',
      ),
    ).toContain('reason="deadline_exceeded"} 1');
    fake.answers.delete('ListRoles');
    await http().get('/access/roles').set('Authorization', BEARER).expect(200);
  });

  it('logs a refused service credential at warn, without the credential or Pompeii message', async () => {
    await start();
    fake.answers.set('ListMyTokens', { fail: status.UNAUTHENTICATED });
    await http().get('/access/tokens').set('Authorization', BEARER).expect(401);
    const log = logged.join('\n');
    expect(log).toContain('POMPEII_ACCESS_CREDENTIAL');
    expect(log).not.toContain(SERVICE_CREDENTIAL);
    expect(log).not.toContain('a message Pompeii wrote');
  });

  it('never lets a bearer, a service credential or a token value reach a log line or the metrics', async () => {
    await start();
    fake.answers.set('CreateMyToken', { reply: { token, value: TOKEN_VALUE } });
    await http()
      .post('/access/tokens')
      .set('Authorization', BEARER)
      .send({ name: 'My laptop' })
      .expect(201);
    fake.answers.set('CreateMyToken', { fail: status.INTERNAL });
    await http()
      .post('/access/tokens')
      .set('Authorization', BEARER)
      .send({ name: 'My laptop' })
      .expect(503);
    fake.answers.set('ListMyTokens', { fail: status.UNAUTHENTICATED });
    await http().get('/access/tokens').set('Authorization', BEARER).expect(401);
    const everything = logged.join('\n') + (await metrics.registry.metrics());
    for (const secret of [
      TOKEN_VALUE,
      BEARER,
      BEARER.replace('Bearer ', ''),
      SERVICE_CREDENTIAL,
    ])
      expect(everything).not.toContain(secret);
  });

  it('refuses a personal access token as the person, before any call', async () => {
    await start();
    const response = await http()
      .get('/access/tokens')
      .set('Authorization', `Bearer ${TOKEN_VALUE}`)
      .expect(401);
    expect(response.body).toEqual({
      error: 'UNAUTHENTICATED',
      reason: 'DENY_UNSUPPORTED_CREDENTIAL',
    });
    expect(accessCalls()).toEqual([]);
  });

  it('requires a bearer on every route', async () => {
    await start();
    for (const [method, path] of [
      ['get', '/access/tokens'],
      ['post', '/access/tokens'],
      ['delete', '/access/tokens/x'],
      ['get', '/access/token-switch'],
      ['put', '/access/token-switch'],
      ['get', '/access/roles'],
      ['get', '/access/grants'],
      ['post', '/access/grants'],
      ['delete', '/access/grants/1'],
      ['get', '/access/history'],
      ['get', '/access/my-permissions'],
    ] as const)
      await http()[method](path).expect(401);
    expect(accessCalls()).toEqual([]);
  });

  it.each([
    ['post', '/access/tokens', undefined],
    ['post', '/access/tokens', { name: '  ' }],
    ['post', '/access/tokens', { name: 4 }],
    ['post', '/access/tokens', { name: 'x', permissions: 'a' }],
    ['post', '/access/tokens', { name: 'x', permissions: [1] }],
    ['post', '/access/tokens', { name: 'x', expires_in_days: '3' }],
    ['post', '/access/tokens', { name: 'x', no_expiry: 'yes' }],
    ['delete', '/access/tokens/not%20valid', undefined],
    ['put', '/access/token-switch', undefined],
    ['put', '/access/token-switch', { enabled: 'on' }],
    ['post', '/access/grants', undefined],
    ['post', '/access/grants', { user_id: '4', role_id: 2 }],
    ['post', '/access/grants', { user_id: 4 }],
    ['post', '/access/grants', { user_id: 0, role_id: 2 }],
    ['delete', '/access/grants/abc', undefined],
    ['delete', '/access/grants/0', undefined],
    ['get', '/access/history?limit=0', undefined],
    ['get', '/access/history?limit=201', undefined],
    ['get', '/access/history?limit=ten', undefined],
    ['get', '/access/history?before=yesterday', undefined],
  ] as const)(
    'answers 400 invalid_request for %s %s %j without calling Pompeii',
    async (method, path, body) => {
      await start();
      const call = http()[method](path).set('Authorization', BEARER);
      const response = await (body === undefined ? call : call.send(body));
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request' });
      expect(accessCalls()).toEqual([]);
    },
  );

  describe('GET /access/my-permissions', () => {
    it('answers this application keys from the guard decision: deduplicated, sorted, no wildcard', async () => {
      await start({ POMPEII_ACCESS_CREDENTIAL: '' });
      fake.permissions = [
        'alcantara:program:read',
        'alcantara:access',
        'monitor:access:manage',
        '*',
        'alcantara:program:read',
        'broadcast.view',
      ];
      const response = await http()
        .get('/access/my-permissions')
        .set('Authorization', BEARER)
        .expect(200);
      expect(response.body).toEqual({
        permissions: ['alcantara:access', 'alcantara:program:read'],
      });
      // No access RPC and no service credential were needed.
      expect(accessCalls()).toEqual([]);
    });

    it('answers an empty list when the decision carries none', async () => {
      await start();
      fake.permissions = [];
      const response = await http()
        .get('/access/my-permissions')
        .set('Authorization', BEARER)
        .expect(200);
      expect(response.body).toEqual({ permissions: [] });
    });
  });

  it('answers the guard 403 when the person may not use Alcantara', async () => {
    await start();
    jest.spyOn(app.get(PompeiiService), 'authorize').mockResolvedValue({
      authenticated: true,
      allowed: false,
      reason: 'DENY',
      subject: 'x',
      principalId: null,
      effectivePermissions: [],
      roles: [],
    });
    await http().get('/access/tokens').set('Authorization', BEARER).expect(403);
    expect(accessCalls()).toEqual([]);
  });
});
