import { Logger } from '@nestjs/common';
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
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { FlightService } from '../program/flight.service';
import { ProgramTemplateService } from '../program/program-template.service';
import { ProgramController } from '../program/program.controller';
import { ProgramService } from '../program/program.service';
import { RendererAuthService } from './renderer-auth.service';
import { RendererKeyService } from './renderer-key.service';

// The two program writes the renderer page makes, over HTTP through the real guards: a signed-in operator, this
// program's key or the shared key; a presented credential that fails is refused; no credential is still accepted and
// counted. Fictional values, built here.
const SHARED = 'shared-key-fictional-built-in-this-test-000';
const KEY_A = 'alrk_fictional-key-for-station-a';

describe('renderer credential on the program writes (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  let metrics: ManagedMetricsService;
  let warn: jest.SpyInstance;
  const updateProgramAudioMeter = jest.fn(async () => ({ ok: true }));
  const completeSceneCountdown = jest.fn(async () => ({ programId: 'station-a' }));
  const keys = {
    match: jest.fn(async (presented: string | undefined, programId: string) =>
      presented === KEY_A ? (programId === 'station-a' ? 'program' : 'other-program') : 'none',
    ),
  };

  beforeAll(async () => {
    metrics = new ManagedMetricsService();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              AUTH_MODE: 'test',
              TEST_AUTH_SECRET: 'fictional-renderer-writes-test-key-123456',
              WEBRTC_RENDERER_KEY: SHARED,
            }),
          ],
        }),
      ],
      controllers: [ProgramController, TestAuthController],
      providers: [
        TestAuthService,
        { provide: ProgramService, useValue: { updateProgramAudioMeter, completeSceneCountdown } },
        { provide: FlightService, useValue: {} },
        { provide: ProgramTemplateService, useValue: {} },
        { provide: ManagedMetricsService, useValue: metrics },
        { provide: RendererKeyService, useValue: keys },
        RendererAuthService,
        {
          provide: PompeiiService,
          useValue: {
            teamId: 1,
            authorize: () => {
              throw new Error('Cognito must not be called');
            },
            recordUnsupportedCredential: jest.fn(),
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

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const tokenFor = async (identity: string) =>
    ((await (await fetch(`${origin}/__test/session?identity=${identity}`)).json()) as { accessToken: string })
      .accessToken;

  const WRITES: Array<[string, string, jest.Mock]> = [
    ['audio-meter', 'audio_meter', updateProgramAudioMeter],
    ['countdown/complete', 'countdown_complete', completeSceneCountdown],
  ];
  const post = (path: string, programId: string, headers: Record<string, string> = {}) =>
    fetch(`${origin}/program/${programId}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({}),
    });

  it.each(WRITES)('%s still takes a request with no credential, counted and logged with its program', async (path, endpoint, handler) => {
    expect((await post(path, 'station-a')).status).toBeLessThan(300);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`Uncredentialed ${endpoint} accepted for program station-a`);
  });

  it.each(WRITES)("%s takes a signed-in operator, and refuses a viewer and a token that is not one", async (path, _endpoint, handler) => {
    expect((await post(path, 'station-a', { Authorization: `Bearer ${await tokenFor('operator-a')}` })).status).toBeLessThan(300);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await post(path, 'station-a', { Authorization: `Bearer ${await tokenFor('viewer')}` })).status).toBe(403);
    expect((await post(path, 'station-a', { Authorization: 'Bearer not-a-token' })).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(WRITES)("%s takes this program's key and the shared key, and refuses any other key", async (path, _endpoint, handler) => {
    expect((await post(path, 'station-a', { 'X-Renderer-Key': KEY_A })).status).toBeLessThan(300);
    expect((await post(path, 'station-b', { 'X-Renderer-Key': SHARED })).status).toBeLessThan(300);
    expect(handler).toHaveBeenCalledTimes(2);
    expect((await post(path, 'station-b', { 'X-Renderer-Key': KEY_A })).status).toBe(403);
    expect((await post(path, 'station-a', { 'X-Renderer-Key': 'not-a-key' })).status).toBe(401);
    expect((await post(path, 'station-a', { 'X-Renderer-Key': '' })).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('counts each write by endpoint, credential and result, with no key in any label', async () => {
    const text = await metrics.render('');
    const lines = text.split('\n').filter((line) => line.startsWith('alcantara_webrtc_renderer_auth_total{'));
    for (const endpoint of ['audio_meter', 'countdown_complete'])
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`^alcantara_webrtc_renderer_auth_total\\{endpoint="${endpoint}",credential="none",result="accepted"\\} 1$`)),
          expect.stringMatching(new RegExp(`^alcantara_webrtc_renderer_auth_total\\{endpoint="${endpoint}",credential="session",result="accepted"\\} 1$`)),
          expect.stringMatching(new RegExp(`^alcantara_webrtc_renderer_auth_total\\{endpoint="${endpoint}",credential="session",result="refused"\\} 2$`)),
          expect.stringMatching(new RegExp(`^alcantara_webrtc_renderer_auth_total\\{endpoint="${endpoint}",credential="program",result="accepted"\\} 1$`)),
          expect.stringMatching(new RegExp(`^alcantara_webrtc_renderer_auth_total\\{endpoint="${endpoint}",credential="shared",result="accepted"\\} 1$`)),
          expect.stringMatching(new RegExp(`^alcantara_webrtc_renderer_auth_total\\{endpoint="${endpoint}",credential="none",result="refused"\\} 2$`)),
        ]),
      );
    for (const secret of [SHARED, KEY_A]) expect(text).not.toContain(secret);
  });
});
