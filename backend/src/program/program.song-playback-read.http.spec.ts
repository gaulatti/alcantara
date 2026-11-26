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

// The renderers read song playback without a session; there is no write route.
describe('song-playback read (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  const getProgramSongPlayback = jest.fn(async () => ({
    isPlaying: false,
    version: 1,
  }));

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
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the read public', async () => {
    const response = await fetch(`${origin}/program/station/song-playback`);
    expect(response.status).toBe(200);
    expect(getProgramSongPlayback).toHaveBeenCalledWith('station');
  });

  it('has no write', async () => {
    const response = await fetch(`${origin}/program/station/song-playback`, {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });
});
