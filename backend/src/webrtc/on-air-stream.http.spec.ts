import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { ReturnRouterController } from './return-router.controller';
import { ReturnRouterService } from './return-router.service';
import { WebrtcService } from './webrtc.service';

// The on-air stream over a real socket: an event stream the worker can hold open, refused without the renderer key.

const KEY = 'fictional-renderer-key';
const ANNA = '11111111-1111-4111-8111-111111111111';

describe('the on-air stream, over a real socket', () => {
  let app: NestFastifyApplication;
  let base: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReturnRouterController],
      providers: [
        WebrtcService,
        ManagedMetricsService,
        { provide: ReturnRouterService, useValue: {} },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            LIVEKIT_WS_URL: 'wss://livekit.example.test',
            LIVEKIT_API_URL: 'http://api.example.test:7880',
            LIVEKIT_API_KEY: 'fictional-key',
            LIVEKIT_API_SECRET:
              'fictional-api-secret-at-least-thirty-two-characters',
            WEBRTC_SESSION_SECRET:
              'fictional-session-secret-at-least-thirty-two',
            WEBRTC_RENDERER_KEY: KEY,
          }),
        },
        {
          provide: PrismaService,
          useValue: {
            guestInvitation: {
              findMany: jest.fn().mockResolvedValue([
                {
                  id: ANNA,
                  cue: 'live',
                  admittedAt: new Date(),
                  activeSessionId: 's',
                  cueSessionId: 's',
                },
              ]),
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a request without the renderer key', async () => {
    const response = await fetch(
      `${base}/webrtc/on-air/stream?programId=modoitaliano.fm`,
      { headers: { 'X-Renderer-Key': 'wrong' } },
    );
    expect(response.status).toBe(401);
  });

  it('opens an event stream that carries the current list at once', async () => {
    const abort = new AbortController();
    const response = await fetch(
      `${base}/webrtc/on-air/stream?programId=modoitaliano.fm`,
      { headers: { 'X-Renderer-Key': KEY }, signal: abort.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    abort.abort();
    expect(text).toContain(
      `data: ${JSON.stringify({ programId: 'modoitaliano.fm', guests: [`guest-${ANNA}`] })}`,
    );
  });
});
