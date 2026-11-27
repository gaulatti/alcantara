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

// The song-playback read stays public, as the renderers use it. The write route was retired (gaulatti/alcantara#612):
// nothing called it, so a POST now has no route.
describe('song-playback read (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  const getProgramSongPlayback = jest.fn(async () => ({ isPlaying: false, version: 1 }));

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
        { provide: ProgramService, useValue: { getProgramSongPlayback } },
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

  it('has no write route: a POST to the song playback is not found', async () => {
    const response = await fetch(`${origin}/program/station/song-playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
    expect(getProgramSongPlayback).not.toHaveBeenCalled();
  });

  it('keeps the read public', async () => {
    expect((await fetch(`${origin}/program/station/song-playback`)).status).toBe(200);
    expect(getProgramSongPlayback).toHaveBeenCalledWith('station');
  });
});
