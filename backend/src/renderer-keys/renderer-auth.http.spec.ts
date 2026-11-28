import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { RadioMonitorService } from '../radio/radio-monitor.service';
import { ReturnRouterController } from '../webrtc/return-router.controller';
import { ReturnRouterService } from '../webrtc/return-router.service';
import { WebrtcController } from '../webrtc/webrtc.controller';
import { WebrtcService } from '../webrtc/webrtc.service';
import { RendererAuthService } from './renderer-auth.service';
import { RendererKeyService } from './renderer-key.service';

// Every calls endpoint over HTTP, through the real controllers, the calls service and the credential check: a program
// endpoint takes that program's key, refuses another program's (403), and still takes the shared key; the fleet key
// works only on the cross-program router list. Fictional values, built here.
const SHARED = 'shared-key-fictional-built-in-this-test-000';
const FLEET = 'fleet-key-fictional-built-in-this-test-0000';
const KEY_A = 'alrk_fictional-key-for-station-a';

describe('renderer credential on every calls endpoint (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  let metrics: ManagedMetricsService;
  const keys = {
    match: jest.fn(async (presented: string | undefined, programId: string) =>
      presented === KEY_A
        ? programId === 'station-a'
          ? 'program'
          : 'other-program'
        : 'none',
    ),
  };

  beforeAll(async () => {
    metrics = new ManagedMetricsService();
    const config = new ConfigService({
      LIVEKIT_WS_URL: 'wss://livekit.example.test',
      LIVEKIT_API_KEY: 'APIfictional',
      LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
      WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
      WEBRTC_RENDERER_KEY: SHARED,
      WEBRTC_FLEET_KEY: FLEET,
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [WebrtcController, ReturnRouterController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: ManagedMetricsService, useValue: metrics },
        {
          provide: PrismaService,
          useValue: {
            guestInvitation: { findMany: jest.fn(async () => []) },
          },
        },
        {
          provide: RadioMonitorService,
          useValue: { issue: jest.fn(async () => ({ ticket: 'fictional' })) },
        },
        { provide: RendererKeyService, useValue: keys },
        RendererAuthService,
        WebrtcService,
        ReturnRouterService,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    const webrtc = moduleRef.get(WebrtcService);
    jest.spyOn(webrtc, 'programsWithAdmittedGuests').mockResolvedValue([]);
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, programId: string, key?: string) =>
    fetch(`${origin}/webrtc/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-Renderer-Key': key } : {}),
      },
      body: JSON.stringify({ programId }),
    });
  const get = (path: string, key?: string) =>
    fetch(`${origin}/webrtc/${path}`, {
      headers: key ? { 'X-Renderer-Key': key } : {},
    });
  /** The stream's status alone: the stream itself stays open, so the request is ended once the answer starts. */
  const streamStatus = async (programId: string, key?: string) => {
    const controller = new AbortController();
    const response = await fetch(
      `${origin}/webrtc/on-air/stream?programId=${programId}`,
      {
        headers: key ? { 'X-Renderer-Key': key } : {},
        signal: controller.signal,
      },
    );
    controller.abort();
    return response.status;
  };

  const PROGRAM_ENDPOINTS: Array<
    [string, (programId: string, key?: string) => Promise<number>]
  > = [
    [
      'renderer-token',
      async (p, k) => (await post('renderer-token', p, k)).status,
    ],
    [
      'renderer-state',
      async (p, k) => (await post('renderer-state', p, k)).status,
    ],
    [
      'renderer-source-token',
      async (p, k) => (await post('renderer-source-token', p, k)).status,
    ],
    [
      'return-audio-ticket',
      async (p, k) => (await post('return-audio-ticket', p, k)).status,
    ],
    ['on-air', async (p, k) => (await get(`on-air?programId=${p}`, k)).status],
    ['on-air/stream', streamStatus],
  ];

  it.each(PROGRAM_ENDPOINTS)(
    '%s refuses a key for another program with 403',
    async (_name, call) => {
      expect(await call('station-b', KEY_A)).toBe(403);
    },
  );

  it.each(PROGRAM_ENDPOINTS)(
    "%s takes the program's own key",
    async (_name, call) => {
      expect(await call('station-a', KEY_A)).toBeLessThan(300);
    },
  );

  it.each(PROGRAM_ENDPOINTS)(
    '%s still takes the shared key, until it is removed',
    async (_name, call) => {
      expect(await call('station-b', SHARED)).toBeLessThan(300);
    },
  );

  it.each(PROGRAM_ENDPOINTS)(
    '%s refuses the fleet key, a wrong key and no key with 401',
    async (_name, call) => {
      expect(await call('station-a', FLEET)).toBe(401);
      expect(await call('station-a', 'not-a-key')).toBe(401);
      expect(await call('station-a')).toBe(401);
    },
  );

  it('takes the fleet key and the shared key on the router list, and refuses a program key there', async () => {
    expect((await get('return-routers', FLEET)).status).toBe(200);
    expect((await get('return-routers', SHARED)).status).toBe(200);
    expect((await get('return-routers', KEY_A)).status).toBe(401);
    expect((await get('return-routers')).status).toBe(401);
  });

  it('counts each check by endpoint, credential and result, with no key in any label', async () => {
    const text = await metrics.render('');
    const lines = text
      .split('\n')
      .filter((line) =>
        line.startsWith('alcantara_webrtc_renderer_auth_total{'),
      );
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^alcantara_webrtc_renderer_auth_total\{endpoint="renderer_token",credential="program",result="refused"\} [1-9]/,
        ),
        expect.stringMatching(
          /^alcantara_webrtc_renderer_auth_total\{endpoint="on_air",credential="program",result="accepted"\} [1-9]/,
        ),
        expect.stringMatching(
          /^alcantara_webrtc_renderer_auth_total\{endpoint="return_audio_ticket",credential="shared",result="accepted"\} [1-9]/,
        ),
        expect.stringMatching(
          /^alcantara_webrtc_renderer_auth_total\{endpoint="return_routers",credential="fleet",result="accepted"\} 1$/,
        ),
        expect.stringMatching(
          /^alcantara_webrtc_renderer_auth_total\{endpoint="renderer_state",credential="none",result="refused"\} [1-9]/,
        ),
      ]),
    );
    for (const secret of [SHARED, FLEET, KEY_A])
      expect(text).not.toContain(secret);
  });
});
