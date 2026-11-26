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
import { FlightService } from './flight.service';
import { ProgramTemplateService } from './program-template.service';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';

// Song-playback writes require program.operate, through the real guard and local test sessions. Reads of
// the same resource stay public, as the renderers use them.
describe('song-playback write permission (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  const updateProgramSongPlayback = jest.fn(async () => ({ isPlaying: false, version: 1 }));
  const getProgramSongPlayback = jest.fn(async () => ({ isPlaying: false, version: 1 }));
  const body = JSON.stringify({ token: 't', audioUrl: '', progress: 0, currentTimeMs: 0, durationMs: null, isPlaying: false });
  const session = async (identity: string) =>
    (await (await fetch(`${origin}/__test/session?identity=${identity}`)).json()) as { accessToken: string };
  const post = (headers: Record<string, string> = {}) =>
    fetch(`${origin}/program/station/song-playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });

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
              TEST_AUTH_SECRET: 'fictional-song-playback-test-key-1234567',
            }),
          ],
        }),
      ],
      controllers: [ProgramController, TestAuthController],
      providers: [
        TestAuthService,
        { provide: ProgramService, useValue: { updateProgramSongPlayback, getProgramSongPlayback } },
        { provide: FlightService, useValue: {} },
        { provide: ProgramTemplateService, useValue: {} },
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

  beforeEach(() => {
    updateProgramSongPlayback.mockClear();
  });

  it('refuses a write without a session, and never reaches the service', async () => {
    expect((await post()).status).toBe(401);
    expect(updateProgramSongPlayback).not.toHaveBeenCalled();
  });

  it('refuses a write from a session without program.operate', async () => {
    const viewer = await session('viewer');
    expect((await post({ Authorization: `Bearer ${viewer.accessToken}` })).status).toBe(403);
    expect(updateProgramSongPlayback).not.toHaveBeenCalled();
  });

  it('still accepts a write from an operator, unchanged', async () => {
    const operator = await session('operator-a');
    const response = await post({ Authorization: `Bearer ${operator.accessToken}` });
    expect(response.status).toBe(201);
    expect(updateProgramSongPlayback).toHaveBeenCalledWith(JSON.parse(body), 'station');
  });

  it('keeps the read public', async () => {
    expect((await fetch(`${origin}/program/station/song-playback`)).status).toBe(200);
    expect(getProgramSongPlayback).toHaveBeenCalledWith('station');
  });
});
