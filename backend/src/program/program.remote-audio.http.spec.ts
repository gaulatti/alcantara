import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listenOnLoopback } from '../../test/loopback-supertest';
import type { App } from 'supertest/types';
import { PompeiiAuthorizationGuard } from '../auth/pompeii-authorization.guard';
import { PompeiiService } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { scriptedTransport } from '../outbound/safe-fetch.testing';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { FlightService } from './flight.service';
import { ProgramTemplateService } from './program-template.service';
import { RendererAuthService } from '../renderer-keys/renderer-auth.service';

/**
 * The program page's remote-audio read, called exactly as the frontend calls
 * it (frontend/app/utils/programAudioBus.ts: a plain GET with the URL as a
 * query parameter, no Range, no credentials needed), through the real guard,
 * controller and service, with the network replaced by a scripted transport.
 */
describe('remote audio read through the outbound-request policy', () => {
  let app: INestApplication<App>;
  let transport: ReturnType<typeof scriptedTransport>;
  let metrics: ManagedMetricsService;
  const bucketHost = 'fictional-media.s3.us-east-1.amazonaws.com';
  const legacyBucketHost = 'fictional-media.s3.amazonaws.com';

  beforeEach(async () => {
    metrics = new ManagedMetricsService();
    const service = new ProgramService(
      {} as never,
      {} as never,
      { setBroadcastHandler: jest.fn() } as never,
      metrics,
      {} as never,
    );
    transport = scriptedTransport(
      {
        [bucketHost]: ['52.216.1.1'],
        [legacyBucketHost]: ['52.216.1.2'],
        'inside.example.com': ['10.0.0.9'],
      },
      {
        [`${bucketHost}/songs/a.mp3`]: {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'set-cookie': 'upstream=1',
            'x-amz-request-id': 'fictional',
            'access-control-allow-origin': '*',
          },
          body: Buffer.from('ID3-fictional-audio'),
        },
        [`${legacyBucketHost}/instants/b.ogg`]: {
          status: 200,
          headers: { 'content-type': 'audio/ogg' },
          body: Buffer.from('OggS'),
        },
      },
    );
    service.outboundDeps = transport;
    // Only the audio read is exercised; the program lifecycle is not.
    service.onModuleInit = () => Promise.resolve();
    service.onModuleDestroy = () => undefined as never;
    const module = await Test.createTestingModule({
      controllers: [ProgramController],
      providers: [
        // The renderer-write guard on the program writes; these tests do not call them.
        { provide: RendererAuthService, useValue: {} },
        Reflector,
        { provide: ProgramService, useValue: service },
        { provide: FlightService, useValue: {} },
        { provide: ProgramTemplateService, useValue: {} },
        { provide: PompeiiService, useValue: { authorize: jest.fn() } },
        PompeiiAuthorizationGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalGuards(app.get(PompeiiAuthorizationGuard));
    await app.init();
    await listenOnLoopback(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
  });

  const proxied = (url: string) =>
    `/program/audio-proxy?url=${encodeURIComponent(url)}`;

  it('serves bucket audio to an anonymous page with only the type and length', async () => {
    const response = await request(app.getHttpServer())
      .get(proxied(`https://${bucketHost}/songs/a.mp3`))
      .set('Cookie', 'session=fictional')
      .set('Authorization', 'Bearer fictional')
      .set('Range', 'bytes=0-10')
      .expect(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.headers['content-length']).toBe('19');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-amz-request-id']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(Buffer.from(response.body as Buffer).toString()).toBe(
      'ID3-fictional-audio',
    );
    // Nothing the page sent is forwarded: no cookie, credentials or range.
    expect(transport.sent[0].headers).toEqual({ host: bucketHost });
    expect(transport.sent[0].method).toBe('GET');
  });

  it('serves audio from the regionless bucket host', async () => {
    await request(app.getHttpServer())
      .get(proxied(`https://${legacyBucketHost}/instants/b.ogg`))
      .expect(200)
      .expect('content-type', 'audio/ogg');
  });

  it('answers a refused address with 400 and a plain message, and counts it', async () => {
    const response = await request(app.getHttpServer())
      .get(proxied('https://inside.example.com/a.mp3'))
      .expect(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      message:
        'The address points at a private, local or reserved network, which the server never fetches.',
    });
    expect(JSON.stringify(response.body)).not.toContain('inside.example.com');
    expect(transport.sent).toEqual([]);
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'alcantara_outbound_fetch_total{path="program_audio",result="address"} 1',
    );
    expect(text).not.toContain('inside.example.com');
  });
});
