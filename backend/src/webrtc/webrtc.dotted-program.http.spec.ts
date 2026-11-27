import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { WebrtcController } from './webrtc.controller';
import { WebrtcService } from './webrtc.service';

// Production's modoitaliano.fm and modoitaliano.tv: /calls answered "Invalid programId." for every program whose id
// has a dot. Through the HTTP route, the controller and the real service, those ids now reach LiveKit unchanged.
// Native routing with a resolved fixture identity; AppModule's global-authorization tests cover the guards.
describe('guest calls for a program id with a dot, through Fastify HTTP', () => {
  let app: NestFastifyApplication;
  const listParticipants = jest.fn();
  const findMany = jest.fn();

  beforeAll(async () => {
    jest
      .spyOn(RoomServiceClient.prototype, 'listParticipants')
      .mockImplementation(listParticipants);
    const module = await Test.createTestingModule({
      controllers: [WebrtcController],
      providers: [
        WebrtcService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            LIVEKIT_WS_URL: 'wss://livekit.example',
            LIVEKIT_API_KEY: 'fictional-key',
            LIVEKIT_API_SECRET:
              'fictional-api-secret-at-least-thirty-two-characters',
            WEBRTC_SESSION_SECRET:
              'fictional-session-secret-at-least-thirty-two',
          }),
        },
        { provide: PrismaService, useValue: { guestInvitation: { findMany } } },
        ManagedMetricsService,
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (request: object) => {
        Object.assign(request, {
          user: { sub: 'fixture-subject', principalId: 'fixture-principal' },
        });
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    listParticipants.mockReset().mockResolvedValue([]);
    findMany.mockReset().mockResolvedValue([]);
  });

  it('lists the guests of modoitaliano.fm from its own LiveKit room', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/webrtc/rooms/modoitaliano.fm/participants',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      roomName: 'alcantara-modoitaliano.fm',
      participants: [],
    });
    expect(listParticipants).toHaveBeenCalledWith('alcantara-modoitaliano.fm');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ programId: 'modoitaliano.fm' }),
      }),
    );
  });

  it('gives modoitaliano.tv a talkback token for its room', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webrtc/operator-token',
      payload: { programId: 'modoitaliano.tv' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      roomName: 'alcantara-modoitaliano.tv',
    });
  });

  it('still refuses an id that is not a program id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webrtc/operator-token',
      payload: { programId: 'news/main' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'Invalid programId.' });
  });
});
