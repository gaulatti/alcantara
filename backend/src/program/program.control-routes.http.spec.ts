import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { PompeiiAuthorizationGuard } from '../auth/pompeii-authorization.guard';
import { PompeiiService } from '../auth/pompeii.service';
import { TestAuthController } from '../auth/test-auth.controller';
import { TestAuthService } from '../auth/test-auth.service';
import { FlightService } from './flight.service';
import { ProgramTemplateService } from './program-template.service';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { RendererAuthService } from '../renderer-keys/renderer-auth.service';

// The console's state and event stream, behind sign-in (program.read). The public state and stream stay the
// renderer's, without sign-in.
describe('program control routes (HTTP)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  const getState = jest.fn(async () => ({ programId: 'station', version: 3 }));
  const getProgramAudioBus = jest.fn(async () => ({
    songSequence: { items: [] },
    songQueue: [],
    mixerSettings: {},
  }));
  const getPublicState = jest.fn(async () => ({ programId: 'station' }));
  const getEventStream = jest.fn(() =>
    of({ data: JSON.stringify({ type: 'program_state_snapshot' }) }),
  );

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
              TEST_AUTH_SECRET: 'fictional-control-routes-test-key-12345678',
            }),
          ],
        }),
      ],
      controllers: [ProgramController, TestAuthController],
      providers: [
        // The renderer-write guard on the program writes; these tests do not call them.
        { provide: RendererAuthService, useValue: {} },
        TestAuthService,
        {
          provide: ProgramService,
          useValue: {
            getState,
            getPublicState,
            getEventStream,
            getProgramAudioBus,
          },
        },
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

  beforeEach(() => jest.clearAllMocks());

  const tokenFor = async (identity: string) =>
    (
      (await (
        await fetch(`${origin}/__test/session?identity=${identity}`)
      ).json()) as { accessToken: string }
    ).accessToken;

  it('refuses the control state and stream without sign-in, reading nothing', async () => {
    expect(
      (await fetch(`${origin}/program/station/control/state`)).status,
    ).toBe(401);
    expect(
      (await fetch(`${origin}/program/station/control/events`)).status,
    ).toBe(401);
    expect(
      (await fetch(`${origin}/program/station/control/audio-bus`)).status,
    ).toBe(401);
    expect(getState).not.toHaveBeenCalled();
    expect(getProgramAudioBus).not.toHaveBeenCalled();
    expect(getEventStream).not.toHaveBeenCalled();
  });

  it('refuses a token that is not one', async () => {
    const headers = { Authorization: 'Bearer not-a-token' };
    expect(
      (await fetch(`${origin}/program/station/control/state`, { headers }))
        .status,
    ).toBe(401);
    expect(getState).not.toHaveBeenCalled();
  });

  it('serves the whole state and the control stream to a signed-in viewer', async () => {
    const headers = { Authorization: `Bearer ${await tokenFor('viewer')}` };
    const state = await fetch(`${origin}/program/station/control/state`, {
      headers,
    });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ programId: 'station', version: 3 });
    expect(getState).toHaveBeenCalledWith('station');

    const events = await fetch(`${origin}/program/station/control/events`, {
      headers,
    });
    expect(events.status).toBe(200);
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    expect(await events.text()).toContain('program_state_snapshot');
    expect(getEventStream).toHaveBeenCalledWith('station', 'control');

    const bus = await fetch(`${origin}/program/station/control/audio-bus`, {
      headers,
    });
    expect(bus.status).toBe(200);
    expect(await bus.json()).toEqual({
      songSequence: { items: [] },
      songQueue: [],
      mixerSettings: {},
    });
    expect(getProgramAudioBus).toHaveBeenCalledWith('station');
  });

  it('keeps the public state and stream public, on the public audience', async () => {
    expect((await fetch(`${origin}/program/station/state`)).status).toBe(200);
    expect(getPublicState).toHaveBeenCalledWith('station');
    const events = await fetch(`${origin}/program/station/events`);
    expect(events.status).toBe(200);
    await events.text();
    expect(getEventStream).toHaveBeenCalledWith('station');
    expect(getState).not.toHaveBeenCalled();
  });
});
