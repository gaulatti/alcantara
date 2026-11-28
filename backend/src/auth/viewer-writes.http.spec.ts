// The application is built without running it to read its controllers (as route-inventory.spec does); the audio
// parser it imports is ESM-only and is never called.
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, ModulesContainer, NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { PompeiiService } from './pompeii.service';
import { TestAuthController } from './test-auth.controller';
import { TestAuthService } from './test-auth.service';

// The viewer-permission audit (backend side): every write a viewer may not make, through every real controller and
// the real authorization guard, answers 403 and reaches no handler. Every collaborator is a stand-in that records any
// call, so a write that got past the guard shows. The routes come from the checked route inventory, which
// route-inventory.spec keeps equal to what the application registers.

interface RouteEntry {
  method: string;
  path: string;
  public: boolean;
  permission: string | null;
}

/** What the local viewer holds (test-auth.service), the same set a production viewer role carries. */
const VIEWER = new Set(['alcantara:access', 'alcantara:program:read', 'alcantara:layout:read', 'broadcast.view']);
/** Public writes a signed-in viewer reaches with a renderer page's checks instead of the guard (renderer-write.guard). */
const VIEWER_CHECKED_PUBLIC = new Set(['POST /program/:programId/audio-meter', 'POST /program/:programId/countdown/complete']);

const inventory = JSON.parse(readFileSync(join(__dirname, '../api-surface/route-inventory.json'), 'utf8')) as RouteEntry[];
const refused = inventory.filter(
  (route) =>
    route.method !== 'GET' &&
    (route.public ? VIEWER_CHECKED_PUBLIC.has(`${route.method} ${route.path}`) : !VIEWER.has(route.permission ?? '')),
);
const concrete = (path: string) => path.replace(/:([A-Za-z]+)/g, (_match, name: string) => (/id$/i.test(name) && name !== 'programId' ? '1' : 'station'));

describe('every write a viewer may not make answers 403 (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  const calls: string[] = [];

  beforeAll(async () => {
    const preview = await NestFactory.create(AppModule, new FastifyAdapter(), { preview: true, logger: false });
    await preview.init();
    const controllers = [...preview.get(ModulesContainer).values()]
      .flatMap((module) => [...module.controllers.values()].map((wrapper) => wrapper.metatype))
      .filter((controller): controller is new (...args: never[]) => object => typeof controller === 'function')
      .filter((controller) => controller !== TestAuthController);
    await preview.close();

    // Any collaborator answers every property with a function that records the call.
    const recorder = (name: string): unknown =>
      new Proxy(
        {},
        {
          get: (_target, property) =>
            property === 'then'
              ? undefined
              : (..._args: unknown[]) => {
                  calls.push(`${name}.${String(property)}`);
                },
        },
      );
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ NODE_ENV: 'test', AUTH_MODE: 'test', TEST_AUTH_SECRET: 'fictional-viewer-writes-test-key-123456' })],
        }),
      ],
      controllers: [...controllers, TestAuthController],
      providers: [
        TestAuthService,
        {
          provide: PompeiiService,
          useValue: {
            teamId: 1,
            authorize: () => {
              throw new Error('Cognito must not be called');
            },
            recordUnsupportedCredential: () => undefined,
          },
        },
        PompeiiAuthorizationGuard,
        { provide: APP_GUARD, useExisting: PompeiiAuthorizationGuard },
      ],
    })
      .useMocker((token) => recorder(typeof token === 'function' ? token.name : String(token)))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    // Start-up runs the stand-ins' lifecycle hooks; only what the requests cause counts.
    calls.length = 0;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('covers every area a viewer reaches from the console', () => {
    const areas = new Set(refused.map((route) => route.path.split('/')[1]));
    for (const area of ['program', 'radio', 'scenes', 'broadcast', 'instants', 'webrtc', 'songs', 'uploads'])
      expect(areas).toContain(area);
    expect(refused.length).toBeGreaterThan(100);
  });

  it('refuses each one with 403 at the guard, before any handler or collaborator runs', async () => {
    const token = (
      (await (await fetch(`${origin}/__test/session?identity=viewer`)).json()) as { accessToken: string }
    ).accessToken;
    const answers: string[] = [];
    for (const route of refused) {
      const response = await fetch(`${origin}${concrete(route.path)}`, {
        method: route.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (response.status !== 403) answers.push(`${route.method} ${route.path}: ${response.status}`);
      await response.arrayBuffer();
    }
    expect(answers).toEqual([]);
    // The renderer page's two writes count the refused session, and nothing else runs.
    expect(calls).toEqual(['RendererAuthService.recordSession', 'RendererAuthService.recordSession']);
  });
});
