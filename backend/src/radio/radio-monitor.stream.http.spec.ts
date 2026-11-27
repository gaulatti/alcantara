import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { request } from 'node:http';
import { ReadableStream } from 'node:stream/web';
import { RadioMonitorController } from './radio-monitor.controller';
import { RadioMonitorService } from './radio-monitor.service';
import { RadioService } from './radio.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { RadioMetricsService } from './radio-metrics.service';
import { corsOptions } from '../cors';

// The program audio streams through the API as it arrives: an endless Palazzo output reaches a listener over a real
// socket while it is still open, with the CORS header a cross-origin <audio crossorigin> needs, and a return grant
// skips Icecast's opening burst.
describe('program audio through the API, over a real socket', () => {
  let app: NestFastifyApplication;
  let port: number;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let timer: NodeJS.Timeout;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [RadioMonitorController],
      providers: [
        RadioMonitorService,
        {
          provide: RadioService,
          useValue: {
            getRadioSettings: jest
              .fn()
              .mockResolvedValue({ palazzoUrl: 'http://palazzo.example' }),
          },
        },
        {
          provide: PalazzoMachineClient,
          useValue: {
            validateBaseUrl: jest.fn(),
            openOutput: jest.fn().mockImplementation(async () => ({
              body: new ReadableStream<Uint8Array>({
                start: (value) => {
                  controller = value;
                  // The opening burst, then one chunk every 100 ms, forever.
                  value.enqueue(new Uint8Array(64 * 1024).fill(1));
                  timer = setInterval(
                    () => value.enqueue(new Uint8Array(1600).fill(2)),
                    100,
                  );
                },
                cancel: () => clearInterval(timer),
              }),
              headers: new Headers({ 'content-type': 'audio/mpeg' }),
            })),
          },
        },
        {
          provide: RadioMetricsService,
          useValue: { recordMonitor: jest.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.enableCors(corsOptions());
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as { port: number }).port;
  });

  afterAll(async () => {
    clearInterval(timer);
    await app.close();
  });

  it('streams a return grant live, without the burst, with the CORS header for the console', async () => {
    const grant = await app
      .get(RadioMonitorService)
      .issue('modoitaliano.fm', { skipBurst: true });
    const result = await new Promise<{
      status: number;
      headers: Record<string, unknown>;
      bytes: number[];
    }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: grant.streamPath,
          headers: { Origin: 'https://alcantara.gaulatti.com' },
        },
        (res) => {
          const bytes: number[] = [];
          res.on('data', (chunk: Buffer) =>
            bytes.push(...chunk.subarray(0, 4)),
          );
          // Read for 1.5 s of an endless stream, then hang up.
          setTimeout(() => {
            req.destroy();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              bytes,
            });
          }, 1500);
        },
      );
      req.on('error', (error) => {
        if (!/socket hang up|aborted/.test(String(error))) reject(error);
      });
      req.end();
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('audio/mpeg');
    expect(result.headers['access-control-allow-origin']).toBe(
      'https://alcantara.gaulatti.com',
    );
    // Live chunks arrived while the stream was still open; the opening burst did not.
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes.every((byte) => byte === 2)).toBe(true);
    expect(controller).toBeDefined();
  });
});
