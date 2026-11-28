import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PompeiiAuthorizationGuard } from '../auth/pompeii-authorization.guard';
import { PompeiiService } from '../auth/pompeii.service';
import { TestAuthController } from '../auth/test-auth.controller';
import { TestAuthService } from '../auth/test-auth.service';
import { OperatorChangeRecorder } from '../operator-change/operator-change-recorder';
import { RendererKeyController } from './renderer-key.controller';
import { RendererKeyService } from './renderer-key.service';

// A program's renderer key over HTTP: its metadata for a reader, its rotation for a manager, the key only in the
// rotation's own answer, and nothing cached.
describe('renderer key routes (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  const metadata = {
    programId: 'station',
    exists: true,
    version: 2,
    createdAt: '2026-11-28T10:00:00.000Z',
    rotatedAt: '2026-11-28T10:05:00.000Z',
    lastUsedAt: null,
  };
  const keys = {
    metadata: jest.fn(async () => metadata),
    rotate: jest.fn(async () => ({
      key: 'alrk_fictional-key-built-in-test',
      metadata: { ...metadata, version: 3 },
      previousVersion: 2,
    })),
  };
  const recorder = { actor: jest.fn(() => ({ principalId: 'p', via: 'console', client: null })), record: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              AUTH_MODE: 'test',
              TEST_AUTH_SECRET: 'fictional-renderer-key-test-secret-1234567',
            }),
          ],
        }),
      ],
      controllers: [RendererKeyController, TestAuthController],
      providers: [
        TestAuthService,
        { provide: RendererKeyService, useValue: keys },
        { provide: OperatorChangeRecorder, useValue: recorder },
        {
          provide: PompeiiService,
          useValue: {
            teamId: 1,
            authorize: () => {
              throw new Error('Cognito must not be called');
            },
          },
        },
        PompeiiAuthorizationGuard,
        { provide: APP_GUARD, useExisting: PompeiiAuthorizationGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const auth = async (identity: string) => ({
    Authorization: `Bearer ${(
      (await (await fetch(`${origin}/__test/session?identity=${identity}`)).json()) as { accessToken: string }
    ).accessToken}`,
  });

  it('refuses both routes without sign-in', async () => {
    expect((await fetch(`${origin}/program/station/renderer-key`)).status).toBe(401);
    expect((await fetch(`${origin}/program/station/renderer-key/rotate`, { method: 'POST' })).status).toBe(401);
    expect(keys.metadata).not.toHaveBeenCalled();
    expect(keys.rotate).not.toHaveBeenCalled();
  });

  it('shows a reader the metadata, never the key, and lets only a manager rotate', async () => {
    const viewer = await auth('viewer');
    const read = await fetch(`${origin}/program/station/renderer-key`, { headers: viewer });
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    const body = await read.json();
    expect(body).toEqual(metadata);
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('keyHash');
    expect(
      (await fetch(`${origin}/program/station/renderer-key/rotate`, { method: 'POST', headers: viewer })).status,
    ).toBe(403);
    expect(keys.rotate).not.toHaveBeenCalled();
  });

  it('returns the new key once, uncached, and records who rotated it without the key', async () => {
    const rotated = await fetch(`${origin}/program/station/renderer-key/rotate`, {
      method: 'POST',
      headers: await auth('operator-a'),
    });
    expect(rotated.status).toBe(201);
    expect(rotated.headers.get('cache-control')).toBe('no-store');
    expect(await rotated.json()).toEqual({ ...metadata, version: 3, key: 'alrk_fictional-key-built-in-test' });
    expect(keys.rotate).toHaveBeenCalledWith('station');
    expect(recorder.record).toHaveBeenCalledWith({
      actor: { principalId: 'p', via: 'console', client: null },
      target: 'program',
      targetId: 'station',
      programId: 'station',
      capability: { mcp: 'webrtc_rotate_renderer_key', console: 'program.rotate-renderer-key' },
      summary: { changed: ['rendererKey', 'version'], before: { version: 2 }, after: { version: 3 } },
    });
    expect(JSON.stringify(recorder.record.mock.calls)).not.toContain('alrk_');
  });

  it('records Object for each dependency whose module is not loaded yet', () => {
    jest.isolateModules(() => {
      jest.doMock('./renderer-key.service', () => ({}));
      jest.doMock('../operator-change/operator-change-recorder', () => ({ summarizeChange: () => null }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RendererKeyController: Isolated } = require('./renderer-key.controller') as {
        RendererKeyController: new (...args: never[]) => unknown;
      };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([Object, Object]);
    });
    jest.dontMock('./renderer-key.service');
    jest.dontMock('../operator-change/operator-change-recorder');
  });
});
