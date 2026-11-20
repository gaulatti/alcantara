import {
  INestApplication,
  Controller,
  Get,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MCP_ATTRIBUTION } from '../mcp/contract';
import { ActorContext } from './actor-context';
import { ActorContextInterceptor } from './actor-context.interceptor';
import { McpActorAttribution } from './mcp-actor-attribution';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { PompeiiService } from './pompeii.service';
import { Public } from './public.decorator';
import { RequirePermission } from './require-permission.decorator';
import { ALCANTARA_PERMISSIONS } from './permissions';
import { AuthModule } from './auth.module';

describe('ActorContext', () => {
  it('answers null outside a command, a copy inside it, and null after it ends', async () => {
    expect(ActorContext.current()).toBeNull();
    let late: unknown = 'unset';
    await ActorContext.run(
      { principalId: 'p', via: 'console', client: null },
      () => {
        const inside = ActorContext.current();
        expect(inside).toEqual({
          principalId: 'p',
          via: 'console',
          client: null,
        });
        inside!.principalId = 'tampered';
        expect(ActorContext.current()!.principalId).toBe('p');
        // A timer created in the command inherits the store, not the actor.
        setTimeout(() => (late = ActorContext.current()), 0);
        return Promise.resolve();
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(late).toBeNull();
  });

  it('ends the scope when the work rejects', async () => {
    await expect(
      ActorContext.run({ principalId: null, via: 'mcp', client: 'c' }, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(ActorContext.current()).toBeNull();
  });

  it('maps an actor to fields, and none to nulls or no event fields', () => {
    expect(ActorContext.toFields(null)).toEqual({
      actorPrincipalId: null,
      actorVia: null,
      actorClient: null,
    });
    expect(ActorContext.eventFields(undefined)).toEqual({});
    expect(
      ActorContext.eventFields({
        principalId: null,
        via: 'mcp',
        client: 'x',
      }),
    ).toEqual({ actorPrincipalId: null, actorVia: 'mcp', actorClient: 'x' });
  });
});

describe('McpActorAttribution', () => {
  it('runs the work as an mcp actor with the client bounded to 64 characters', async () => {
    const seen = await new McpActorAttribution().run(
      { principalId: 'p', via: 'mcp', client: 'c'.repeat(80) },
      () => Promise.resolve(ActorContext.current()),
    );
    expect(seen).toEqual({
      principalId: 'p',
      via: 'mcp',
      client: 'c'.repeat(64),
    });
    expect(ActorContext.current()).toBeNull();
  });

  it('is what the auth module binds under MCP_ATTRIBUTION', () => {
    const providers = Reflect.getMetadata('providers', AuthModule) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([
        { provide: MCP_ATTRIBUTION, useClass: McpActorAttribution },
        { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
      ]),
    );
  });
});

describe('ActorContextInterceptor', () => {
  const run = (context: unknown) =>
    new ActorContextInterceptor().intercept(context as never, {
      handle: () => of(ActorContext.current()),
    });
  const http = (user: unknown) => ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  });

  it('leaves non-http and unauthenticated requests without an actor', async () => {
    expect(await lastValueFrom(run({ getType: () => 'rpc' }))).toBeNull();
    expect(await lastValueFrom(run(http(undefined)))).toBeNull();
    expect(await lastValueFrom(run(http({ sub: '' })))).toBeNull();
    expect(await lastValueFrom(run(http({ sub: 5 })))).toBeNull();
  });

  it('sets a console actor, with a null principal while Pompeii has not resolved one', async () => {
    expect(
      await lastValueFrom(run(http({ sub: 's', principalId: 'pid' }))),
    ).toEqual({ principalId: 'pid', via: 'console', client: null });
    expect(
      await lastValueFrom(run(http({ sub: 's', principalId: '' }))),
    ).toEqual({ principalId: null, via: 'console', client: null });
  });
});

describe('console requests through the real guard and the interceptor', () => {
  let app: INestApplication<App>;
  let late: Promise<unknown>;

  @Controller('probe')
  class ProbeController {
    @Get('actor')
    @RequirePermission(ALCANTARA_PERMISSIONS.access)
    actor() {
      late = new Promise((resolve) =>
        setTimeout(() => resolve(ActorContext.current()), 5),
      );
      return Promise.resolve({ actor: ActorContext.current() }).then(
        async (value) => {
          await Promise.resolve();
          return { ...value, afterAwait: ActorContext.current() };
        },
      );
    }

    @Get('public')
    @Public()
    open() {
      return { actor: ActorContext.current() };
    }

    @Get('fails')
    @RequirePermission(ALCANTARA_PERMISSIONS.access)
    fails(): never {
      throw new HttpException('nope', 418);
    }
  }

  @Injectable()
  class FakePompeii {
    teamId = '7';
    authorize(token: string) {
      return Promise.resolve(
        token === 'Bearer good'
          ? {
              authenticated: true,
              allowed: true,
              reason: 'ALLOW',
              subject: 'subject-1',
              principalId: 'principal-1',
              effectivePermissions: [ALCANTARA_PERMISSIONS.access],
              roles: [],
            }
          : { authenticated: false, allowed: false, reason: 'DENY' },
      );
    }
    recordUnsupportedCredential() {}
  }

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        Reflector,
        { provide: PompeiiService, useClass: FakePompeii },
        { provide: APP_GUARD, useClass: PompeiiAuthorizationGuard },
        { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(() => app.close());

  it('gives the handler the console actor across awaits and drops it when the request ends', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/actor')
      .set('Authorization', 'Bearer good')
      .expect(200);
    const expected = {
      principalId: 'principal-1',
      via: 'console',
      client: null,
    };
    expect(response.body).toEqual({ actor: expected, afterAwait: expected });
    expect(await late).toBeNull();
  });

  it('carries no actor on a public route, and a refused request never reaches the handler', async () => {
    const open = await request(app.getHttpServer())
      .get('/probe/public')
      .expect(200);
    expect(open.body).toEqual({ actor: null });
    await request(app.getHttpServer()).get('/probe/actor').expect(401);
    await request(app.getHttpServer())
      .get('/probe/actor')
      .set('Authorization', 'Bearer bad')
      .expect(401);
    await request(app.getHttpServer())
      .get('/probe/fails')
      .set('Authorization', 'Bearer good')
      .expect(418);
    expect(ActorContext.current()).toBeNull();
  });
});
