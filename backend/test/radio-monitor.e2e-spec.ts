import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PompeiiAuthorizationGuard } from '../src/auth/pompeii-authorization.guard';
import { PompeiiService } from '../src/auth/pompeii.service';
import { TestAuthService } from '../src/auth/test-auth.service';
import { TestAuthController } from '../src/auth/test-auth.controller';
import { RadioMonitorController } from '../src/radio/radio-monitor.controller';
import { RadioMonitorService } from '../src/radio/radio-monitor.service';
import { RadioService } from '../src/radio/radio.service';
import { PalazzoMachineClient } from '../src/radio/palazzo-machine.client';
import { RadioMetricsService } from '../src/radio/radio-metrics.service';

describe('authenticated Program audio relay (e2e)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  let upstream: Server;
  let disconnected: (() => void) | undefined;
  let upstreamStatus = 200;
  let paths: string[];
  let headers: Record<string, string>;
  beforeAll(async () => {
    paths = [];
    upstream = createServer((req, res) => {
      paths.push(req.url!);
      res.writeHead(upstreamStatus, {
        'Content-Type': upstreamStatus === 200 ? 'audio/mpeg' : 'text/plain',
      });
      if (upstreamStatus !== 200) {
        res.end('offline');
        return;
      }
      res.write(Buffer.from([255, 251, 144, 0]));
      res.once('close', () => disconnected?.());
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              AUTH_MODE: 'test',
              TEST_AUTH_SECRET: 'fictional-local-monitor-test-key-123456789',
              PALAZZO_ALLOWED_URLS: baseUrl,
            }),
          ],
        }),
      ],
      controllers: [RadioMonitorController, TestAuthController],
      providers: [
        RadioMonitorService,
        PalazzoMachineClient,
        RadioMetricsService,
        TestAuthService,
        {
          provide: RadioService,
          useValue: {
            getRadioSettings: async () => ({
              palazzoUrl: baseUrl,
              listenerUrl: null,
            }),
          },
        },
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
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    const session = await (
      await fetch(`${origin}/__test/session?identity=operator-a`)
    ).json();
    headers = { Authorization: `Bearer ${session.accessToken}` };
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const grant = async (id = 'station') => {
    const response = await fetch(`${origin}/radio/${id}/monitor-ticket`, {
      method: 'POST',
      headers,
    });
    expect(response.status).toBe(201);
    return response.json();
  };

  it('requires a real local session with radio.read and a station-bound unexpired media grant', async () => {
    expect(
      (
        await fetch(`${origin}/radio/station/monitor-ticket`, {
          method: 'POST',
        })
      ).status,
    ).toBe(401);
    const viewer = await (
      await fetch(`${origin}/__test/session?identity=viewer`)
    ).json();
    expect(
      (
        await fetch(`${origin}/radio/station/monitor-ticket`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${viewer.accessToken}` },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${origin}/radio/station/monitor-audio`)).status).toBe(
      401,
    );
    const wrong = await grant();
    expect(
      (await fetch(origin + wrong.streamPath.replace('/station/', '/other/')))
        .status,
    ).toBe(401);
    expect((await fetch(origin + wrong.streamPath)).status).toBe(401);
    const expired = await grant();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect((await fetch(origin + expired.streamPath)).status).toBe(401);
    clock.mockRestore();
    expect(paths).toHaveLength(0);
  });

  it('accepts native media probes and reconnects, streams incrementally and expires after disconnect', async () => {
    const output = await grant();
    expect(output.expiresInMs).toBe(60_000);
    const open = async (range: string) => {
      const abort = new AbortController();
      const response = await fetch(origin + output.streamPath, {
        signal: abort.signal,
        headers: { Range: range },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('audio/mpeg');
      expect(response.headers.get('accept-ranges')).toBe('none');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      expect(
        Array.from((await response.body!.getReader().read()).value!),
      ).toEqual([255, 251, 144, 0]);
      return async () => {
        const closed = new Promise<void>((resolve) => (disconnected = resolve));
        abort.abort();
        await closed;
      };
    };
    // Safari's initial range probe must not consume the URL's authorization.
    await (
      await open('bytes=0-1')
    )();
    const stop = await open('bytes=0-');
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    try {
      // An active listening session remains usable past its initial connect window.
      await (
        await open('bytes=0-')
      )();
      await stop();
      clock.mockReturnValue(now + 92_000);
      expect((await fetch(origin + output.streamPath)).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
    expect(paths).toEqual(Array(3).fill('/v1/programs/station/output/audio'));
  });

  it('reports upstream failure explicitly and renders bounded lifecycle and dependency metrics', async () => {
    upstreamStatus = 503;
    const output = await grant();
    expect((await fetch(origin + output.streamPath)).status).toBe(502);
    const metrics = app.get(RadioMetricsService).render();
    expect(metrics).toContain(
      'alcantara_radio_monitor_sessions_total{result="opened"} 3',
    );
    expect(metrics).toContain(
      'alcantara_radio_monitor_sessions_total{result="aborted"} 3',
    );
    expect(metrics).toContain(
      'alcantara_radio_monitor_sessions_total{result="failure"} 1',
    );
    expect(metrics).toContain('operation="output-monitor",result="success"');
    expect(metrics).not.toContain(output.streamPath);
  });
});
