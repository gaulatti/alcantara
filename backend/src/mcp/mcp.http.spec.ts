/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- supertest bodies are untyped JSON and jest mocks are matched by reference. */
import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AuthController } from '../auth/auth.controller';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { PompeiiAuthorizationGuard } from '../auth/pompeii-authorization.guard';
import { PompeiiService } from '../auth/pompeii.service';
import { RealtimeTicketService } from '../auth/realtime-ticket.service';
import { TestAuthService } from '../auth/test-auth.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from '../program/program.service';
import {
  MCP_ACTION_EXECUTOR,
  McpToolError,
  McpToolProvider,
  type McpActionExecutor,
  type McpToolSpec,
} from './contract';
import { McpAuthService } from './mcp-auth.service';
import { McpController } from './mcp.controller';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpRegistry } from './mcp-registry.service';
import { MCP_LIMITS, MCP_SHARED_CLIENT_ID } from './mcp.constants';

// /mcp through a real Fastify app, the real global guard and the real Pompeii
// client code; only the gRPC call and the program list are replaced. Every
// credential is a placeholder built here from repeated characters.

const oauthSession = (fill: string) =>
  `Bearer ${fill.repeat(36)}.${fill.repeat(120)}.${fill.repeat(86)}`;
const accessToken = `Bearer pmp_pat_${'q'.repeat(43)}`;

type Answer = Record<string, unknown>;

@Injectable()
@McpToolProvider()
class SampleTools {
  specs(): McpToolSpec[] {
    return [
      {
        name: 'sample_read',
        title: 'Sample read',
        description: 'A read capability for the test.',
        permission: ALCANTARA_PERMISSIONS.song.read,
        tier: 'R',
        firstClass: false,
        shape: { id: z.number().int() },
        run: (args) =>
          Promise.resolve({ result: { echoed: args.id }, audit: {} }),
      },
      {
        name: 'sample_write',
        title: 'Sample write',
        description: 'A write capability for the test.',
        permission: ALCANTARA_PERMISSIONS.song.manage,
        tier: 'W',
        firstClass: true,
        shape: { id: z.number().int() },
        run: () => Promise.resolve({ result: { written: true }, audit: {} }),
      },
      {
        name: 'sample_fails',
        title: 'Sample failure',
        description: 'A read that throws an unexpected error.',
        permission: ALCANTARA_PERMISSIONS.song.read,
        tier: 'R',
        firstClass: false,
        shape: {},
        run: () => Promise.reject(new Error('database is down')),
      },
    ];
  }
}

describe('MCP endpoint', () => {
  let app: NestFastifyApplication;
  let grpcAuthorize: jest.Mock;
  let answer: Answer;
  let metrics: ManagedMetricsService;
  let logged: string[];
  let auth: McpAuthService;
  let executor: jest.Mocked<McpActionExecutor> | undefined;

  async function boot(
    options: { executor?: boolean; testAuth?: boolean } = {},
  ) {
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
    answer = {
      authenticated: true,
      allowed: true,
      reason: 'ALLOW',
      subject: 'subject-1',
      principal_id: 'principal-1',
      effective_permissions: [
        ALCANTARA_PERMISSIONS.access,
        ALCANTARA_PERMISSIONS.program.read,
        ALCANTARA_PERMISSIONS.song.read,
        'some:other:app',
      ],
      roles: ['operator'],
    };
    grpcAuthorize = jest.fn(
      (
        _request: unknown,
        _options: unknown,
        callback: (error: Error | null, value: unknown) => void,
      ) => callback(null, answer),
    );
    (pompeii as unknown as { client: unknown }).client = {
      authorize: grpcAuthorize,
      close: jest.fn(),
    };
    executor = options.executor
      ? { execute: jest.fn().mockResolvedValue({ executed: true }) }
      : undefined;
    @Module({
      imports: [DiscoveryModule],
      controllers: [AuthController, McpController, McpOAuthController],
      providers: [
        Reflector,
        RealtimeTicketService,
        { provide: PompeiiService, useValue: pompeii },
        { provide: ManagedMetricsService, useValue: metrics },
        {
          provide: TestAuthService,
          useValue: {
            isEnabled: () => options.testAuth === true,
            authorize: () => ({
              authenticated: true,
              allowed: true,
              reason: 'ALLOW',
              subject: 'test-operator',
              principalId: null,
              effectivePermissions: [ALCANTARA_PERMISSIONS.access],
              roles: [],
            }),
          },
        },
        {
          provide: ProgramService,
          useValue: {
            listPrograms: jest.fn().mockResolvedValue([
              {
                programId: 'radio-1',
                type: 'radio',
                songSequence: { mode: 'autoplay' },
              },
              { programId: 'tv-1', type: 'tv', songSequence: null },
            ]),
          },
        },
        ...(executor
          ? [{ provide: MCP_ACTION_EXECUTOR, useValue: executor }]
          : []),
        PompeiiAuthorizationGuard,
        McpAuthService,
        McpRegistry,
        SampleTools,
      ],
    })
    class Fixture {}
    const module = await Test.createTestingModule({
      imports: [Fixture],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalGuards(app.get(PompeiiAuthorizationGuard));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    auth = app.get(McpAuthService);
  }

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  const rpc = (
    method: string,
    params: Record<string, unknown> = {},
    authorization: string | null = oauthSession('a'),
    extra: Record<string, string> = {},
  ) => {
    const call = request(app.getHttpServer())
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('User-Agent', 'claude-code/2.0 (test)');
    for (const [name, value] of Object.entries(extra)) call.set(name, value);
    if (authorization !== null) call.set('Authorization', authorization);
    return call.send({ jsonrpc: '2.0', id: 1, method, params });
  };

  const initialize = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  };

  const toolNames = async (authorization: string = oauthSession('a')) => {
    const response = await rpc('tools/list', {}, authorization);
    return (response.body.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
  };

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    const result = response.body.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return {
      body: JSON.parse(result.content[0].text) as Answer,
      isError: result.isError === true,
    };
  };

  const sentToPompeii = (call: number) =>
    (grpcAuthorize.mock.calls as unknown[][])[call][0] as Record<
      string,
      unknown
    >;

  const authCount = async (result: string) =>
    Number(
      (await metrics.registry.metrics())
        .split('\n')
        .find((line) =>
          line.startsWith(`alcantara_mcp_auth_total{result="${result}"}`),
        )
        ?.split(' ')
        .pop(),
    );

  it('initializes and lists only the tools the caller holds, asking Pompeii once with the header unchanged', async () => {
    await boot();
    const init = await rpc('initialize', initialize);
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('alcantara');
    expect(await toolNames()).toEqual([
      'whoami',
      'list_programs',
      'list_capabilities',
      'call_capability',
    ]);
    expect(grpcAuthorize).toHaveBeenCalledTimes(1);
    expect(sentToPompeii(0)).toEqual({
      bearer_token: oauthSession('a'),
      permission: ALCANTARA_PERMISSIONS.access,
      team_id: 7,
    });
  });

  it('sends a personal access token to Pompeii byte for byte at /mcp, while REST still refuses it', async () => {
    await boot();
    expect((await rpc('tools/list', {}, accessToken)).status).toBe(200);
    expect(sentToPompeii(0).bearer_token).toBe(accessToken);
    const rest = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', accessToken);
    expect(rest.status).toBe(401);
    expect(rest.body).toEqual({
      error: 'UNAUTHENTICATED',
      reason: 'DENY_UNSUPPORTED_CREDENTIAL',
    });
    expect(grpcAuthorize).toHaveBeenCalledTimes(1);
  });

  it('lists a first-class write tool when its permission is granted, and refuses it without an action executor', async () => {
    await boot();
    answer.effective_permissions = [
      ALCANTARA_PERMISSIONS.access,
      ALCANTARA_PERMISSIONS.song.manage,
    ];
    expect(await toolNames()).toEqual([
      'whoami',
      'list_capabilities',
      'call_capability',
      'sample_write',
    ]);
    const { body, isError } = await callTool('sample_write', { id: 1 });
    expect(isError).toBe(true);
    expect(body.error).toBe('unavailable');
  });

  it('runs writes through the action executor when one is bound', async () => {
    await boot({ executor: true });
    answer.effective_permissions = [ALCANTARA_PERMISSIONS.song.manage];
    const { body } = await callTool('sample_write', { id: 1 });
    expect(body).toEqual({ executed: true });
    expect(executor!.execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sample_write' }),
      { id: 1 },
      expect.objectContaining({
        principal: expect.objectContaining({
          subject: 'subject-1',
          client: 'claude-code/2.0',
        }),
      }),
    );
  });

  it('whoami reports the granted Alcantara permissions only, and list_programs maps programs', async () => {
    await boot();
    expect((await callTool('whoami')).body).toEqual({
      subject: 'subject-1',
      principal_id: 'principal-1',
      client: 'claude-code/2.0',
      permissions: [
        ALCANTARA_PERMISSIONS.access,
        ALCANTARA_PERMISSIONS.program.read,
        ALCANTARA_PERMISSIONS.song.read,
      ].sort(),
    });
    expect((await callTool('list_programs')).body).toEqual({
      programs: [
        { program_id: 'radio-1', type: 'radio', mode: 'autoplay' },
        { program_id: 'tv-1', type: 'tv', mode: null },
      ],
    });
  });

  it('lists capabilities the caller holds, searchable and paged, and runs them through call_capability', async () => {
    await boot();
    const all = (await callTool('list_capabilities')).body as {
      total: number;
      capabilities: Array<{
        name: string;
        input_schema: Answer;
        needs_confirm: boolean;
      }>;
    };
    const names = all.capabilities.map((c) => c.name);
    expect(names).toContain('sample_read');
    expect(names).not.toContain('sample_write');
    expect(
      all.capabilities.find((c) => c.name === 'sample_read')!.input_schema,
    ).toMatchObject({
      type: 'object',
      properties: { id: { type: 'integer' } },
    });
    const searched = (
      await callTool('list_capabilities', {
        query: 'Sample',
        limit: 1,
        offset: 0,
      })
    ).body as {
      total: number;
      capabilities: unknown[];
    };
    expect(searched.total).toBe(2);
    expect(searched.capabilities).toHaveLength(1);
    expect(
      (await callTool('list_capabilities', { query: 'a read capability' }))
        .body,
    ).toMatchObject({ total: 1 });
    expect(
      (
        await callTool('call_capability', {
          name: 'sample_read',
          arguments: { id: 4 },
        })
      ).body,
    ).toEqual({ echoed: 4 });
    expect(
      (await callTool('call_capability', { name: 'sample_read' })).body.error,
    ).toBe('invalid');
    expect(
      (
        await callTool('call_capability', {
          name: 'sample_read',
          arguments: { id: 4, extra: 1 },
        })
      ).body.error,
    ).toBe('invalid');
    expect(
      (await callTool('call_capability', { name: 'nope' })).body.error,
    ).toBe('not_found');
    expect(
      (await callTool('call_capability', { name: 'call_capability' })).body
        .error,
    ).toBe('not_found');
    expect(
      (
        await callTool('call_capability', {
          name: 'sample_write',
          arguments: { id: 1 },
        })
      ).body.error,
    ).toBe('forbidden');
    const failed = await callTool('call_capability', { name: 'sample_fails' });
    expect(failed.isError).toBe(true);
    expect(failed.body).toEqual({
      error: 'unavailable',
      message: 'The action could not be completed.',
    });
    expect(JSON.stringify(logged)).not.toContain('database is down');
  });

  it('passes a capability refusal with its retry time through call_capability', async () => {
    await boot({ executor: true });
    answer.effective_permissions = [ALCANTARA_PERMISSIONS.song.manage];
    executor!.execute.mockRejectedValueOnce(
      new McpToolError('rate_limited', 'Too many actions.', 12),
    );
    const { body } = await callTool('call_capability', {
      name: 'sample_write',
      arguments: { id: 1 },
    });
    expect(body).toEqual({
      error: 'rate_limited',
      message: 'Too many actions.',
      retry_after_seconds: 12,
    });
  });

  it.each([
    ['no header', null, 401, 'unauthenticated', 'Bearer resource_metadata='],
    ['an empty header', '   ', 401, 'unauthenticated', 'error="invalid_token"'],
    [
      'an oversized header',
      `Bearer ${'x'.repeat(MCP_LIMITS.maxAuthorizationBytes)}`,
      401,
      'unauthenticated',
      'error="invalid_token"',
    ],
  ])(
    'refuses %s before asking Pompeii',
    async (_case, header, status, result, challenge) => {
      await boot();
      const response = await rpc('tools/list', {}, header);
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ error: result });
      expect(response.headers['www-authenticate']).toContain(challenge);
      expect(response.headers['www-authenticate']).toContain(
        'resource_metadata="https://api.alcantara.gaulatti.com/.well-known/oauth-protected-resource"',
      );
      expect(grpcAuthorize).not.toHaveBeenCalled();
    },
  );

  it('answers 401 for an unauthenticated caller, 403 for a refused one and 503 when Pompeii is down', async () => {
    await boot();
    answer = {
      authenticated: false,
      allowed: false,
      reason: 'DENY_INVALID_TOKEN',
    };
    const unauthenticated = await rpc('tools/list', {}, oauthSession('b'));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['www-authenticate']).toContain(
      'invalid_token',
    );
    answer = {
      authenticated: true,
      allowed: false,
      reason: 'DENY_PERMISSION',
      subject: 's',
    };
    const forbidden = await rpc('tools/list', {}, oauthSession('c'));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers['www-authenticate']).toContain(
      'insufficient_scope',
    );
    answer = {
      authenticated: true,
      allowed: true,
      reason: 'ALLOW',
      subject: '',
    };
    expect((await rpc('tools/list', {}, oauthSession('d'))).status).toBe(403);
    grpcAuthorize.mockImplementationOnce(
      (_r: unknown, _o: unknown, callback: (e: Error) => void) =>
        callback(new Error('unavailable')),
    );
    const down = await rpc('tools/list', {}, oauthSession('e'));
    expect(down.status).toBe(503);
    expect(down.headers['retry-after']).toBe('5');
    expect(await authCount('unauthenticated')).toBe(1);
    expect(await authCount('forbidden')).toBe(2);
    expect(await authCount('unavailable')).toBe(1);
  });

  it('reuses a decision for 30 s per header, asks again for another header or once the cache expires', async () => {
    await boot();
    let now = 1_000_000;
    auth.now = () => now;
    await rpc('tools/list', {}, oauthSession('a'));
    await rpc('tools/list', {}, oauthSession('a'));
    expect(grpcAuthorize).toHaveBeenCalledTimes(1);
    await rpc('tools/list', {}, oauthSession('b'));
    expect(grpcAuthorize).toHaveBeenCalledTimes(2);
    now += MCP_LIMITS.decisionCacheMs;
    await rpc('tools/list', {}, oauthSession('a'));
    expect(grpcAuthorize).toHaveBeenCalledTimes(3);
    expect(await authCount('ok')).toBe(4);
  });

  it('keeps the decision cache bounded', async () => {
    await boot();
    const cache = (auth as unknown as { cache: Map<string, unknown> }).cache;
    for (let i = 0; i <= MCP_LIMITS.decisionCacheEntries; i += 1) {
      cache.set(`digest-${i}`, {
        expires: Number.MAX_SAFE_INTEGER,
        decision: { kind: 'unauthenticated' },
      });
    }
    await rpc('tools/list', {}, oauthSession('z'));
    expect(cache.size).toBe(MCP_LIMITS.decisionCacheEntries);
  });

  it('limits a client that keeps sending refused credentials, before calling Pompeii', async () => {
    await boot();
    answer = { authenticated: false, allowed: false };
    for (let i = 0; i < MCP_LIMITS.failuresPerWindow; i += 1) {
      expect(
        (
          await rpc(
            'tools/list',
            {},
            oauthSession(String.fromCharCode(97 + (i % 26))) + i,
          )
        ).status,
      ).toBe(401);
    }
    const calls = grpcAuthorize.mock.calls.length;
    const limited = await rpc('tools/list', {}, oauthSession('y'));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(grpcAuthorize.mock.calls.length).toBe(calls);
    expect(await authCount('rate_limited')).toBe(1);
  });

  it('answers 503 when too many decisions are in flight', async () => {
    await boot();
    (auth as unknown as { inFlight: number }).inFlight =
      MCP_LIMITS.maxConcurrentDecisions;
    expect((await rpc('tools/list', {}, oauthSession('n'))).status).toBe(503);
  });

  it('uses test auth when it is enabled, and the credential never reaches logs or metrics', async () => {
    await boot({ testAuth: true });
    expect(await toolNames(accessToken)).toEqual([
      'whoami',
      'list_capabilities',
      'call_capability',
    ]);
    expect(grpcAuthorize).not.toHaveBeenCalled();
    const exposition = await metrics.registry.metrics();
    for (const secret of [accessToken, 'pmp_pat_', 'q'.repeat(20)]) {
      expect(exposition).not.toContain(secret);
      expect(logged.join('\n')).not.toContain(secret);
    }
  });

  it('refuses an oversized body, other methods on /mcp, and a malformed request', async () => {
    await boot();
    const big = await rpc('tools/list', {
      padding: 'p'.repeat(MCP_LIMITS.maxRequestBytes),
    });
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'payload_too_large' });
    for (const method of ['get', 'delete'] as const) {
      const refused = await request(app.getHttpServer())[method]('/mcp');
      expect(refused.status).toBe(405);
      expect(refused.headers.allow).toBe('POST');
    }
    const broken = await rpc('no/such/method');
    expect(broken.body.error.code).toBe(-32601);
  });

  it('answers 500 without detail when something unexpected fails', async () => {
    await boot();
    jest
      .spyOn(auth, 'authenticate')
      .mockRejectedValueOnce(new TypeError('boom'));
    const failed = await rpc('tools/list');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'internal' });
    expect(logged.join('\n')).toContain('MCP request failed: TypeError');
  });

  it('serves the OAuth discovery documents', async () => {
    await boot();
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.body).toMatchObject({
        resource: 'https://api.alcantara.gaulatti.com/mcp',
        authorization_servers: ['https://api.alcantara.gaulatti.com'],
      });
    }
    const server = await request(app.getHttpServer()).get(
      '/.well-known/oauth-authorization-server',
    );
    expect(server.body).toMatchObject({
      authorization_endpoint: 'https://buendia.gaulatti.com/oauth2/authorize',
      token_endpoint: 'https://buendia.gaulatti.com/oauth2/token',
      registration_endpoint: 'https://api.alcantara.gaulatti.com/register',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('registers a client by reflecting valid redirect URIs, with no fixed list of clients', async () => {
    await boot();
    const uris = [
      'https://claude.ai/api/mcp/auth_callback',
      'https://any.example.test/cb',
      'http://localhost:8765/callback',
      'http://127.0.0.1:9/cb',
      'http://[::1]:9/cb',
    ];
    const registered = await request(app.getHttpServer())
      .post('/register')
      .send({ redirect_uris: uris, client_name: 'Some client' });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({
      client_id: MCP_SHARED_CLIENT_ID,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      client_name: 'Some client',
    });
    expect(
      (
        await request(app.getHttpServer())
          .post('/register')
          .send({ redirect_uris: [uris[0]] })
      ).body,
    ).not.toHaveProperty('client_name');
    for (const body of [
      { redirect_uris: ['http://evil.example.test/cb'] },
      { redirect_uris: ['https://a.example.test/cb#frag'] },
      { redirect_uris: ['https://user:pw@a.example.test/cb'] },
      { redirect_uris: ['not a uri'] },
      {
        redirect_uris: [
          `https://a.example.test/${'x'.repeat(MCP_LIMITS.maxRegistrationUriLength)}`,
        ],
      },
      { redirect_uris: [] },
      {
        redirect_uris: Array.from(
          { length: MCP_LIMITS.maxRegistrationUris + 1 },
          (_, i) => `https://a.example.test/${i}`,
        ),
      },
      { redirect_uris: [1] },
      { redirect_uris: 'https://a.example.test/cb' },
    ]) {
      const refused = await request(app.getHttpServer())
        .post('/register')
        .send(body);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_redirect_uri');
    }
    for (const body of [
      { redirect_uris: [uris[0]], client_name: 5 },
      { redirect_uris: [uris[0]], client_name: 'n'.repeat(201) },
    ]) {
      expect(
        (await request(app.getHttpServer()).post('/register').send(body)).body
          .error,
      ).toBe('invalid_client_metadata');
    }
    const array = await request(app.getHttpServer())
      .post('/register')
      .set('Content-Type', 'application/json')
      .send('[]');
    expect(array.body.error).toBe('invalid_client_metadata');
    expect((await request(app.getHttpServer()).get('/register')).status).toBe(
      405,
    );
  });
});
