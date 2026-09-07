import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { PompeiiAuthorizationGuard } from '../src/auth/pompeii-authorization.guard';
import { ALCANTARA_PERMISSIONS } from '../src/auth/permissions';
import { PompeiiService } from '../src/auth/pompeii.service';
import { AlanaRecordingClient } from '../src/recording/alana-recording.client';
import { RecordingController } from '../src/recording/recording.controller';

const recordingStatus = {
  enabled: true,
  state: 'idle' as const,
  requestedAt: null,
  startedAt: null,
  stoppedAt: null,
  finalizedAt: null,
  updatedAt: '2026-09-06T18:00:00Z',
  segmentCount: 0,
  bytes: 0,
  durationSeconds: 0,
  droppedFrames: 0,
  errors: 0,
  restarts: 0,
  finalizationState: 'not-requested' as const,
  finalBytes: 0,
  error: null,
  disk: null,
};

describe('recording authorization and idempotency boundary (e2e)', () => {
  let app: NestFastifyApplication;
  let origin: string;
  const status = jest.fn().mockResolvedValue(recordingStatus);
  const command = jest.fn().mockResolvedValue({
    ...recordingStatus,
    state: 'requested',
    commandResult: {
      action: 'start',
      status: 202,
      result: 'accepted',
      duplicate: false,
    },
  });
  const authorize = jest.fn((token: string, permission: string) => ({
    authenticated: true,
    allowed: token === 'Bearer operator-token',
    reason:
      token === 'Bearer operator-token' ? 'ALLOW_TEST' : 'DENY_PERMISSION',
    subject: 'operator-subject',
    effectivePermissions: [permission],
    roles: ['operator'],
  }));

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [RecordingController],
      providers: [
        {
          provide: AlanaRecordingClient,
          useValue: { status, command },
        },
        {
          provide: PompeiiService,
          useValue: { authorize, teamId: 1 },
        },
        PompeiiAuthorizationGuard,
        {
          provide: APP_GUARD,
          useExisting: PompeiiAuthorizationGuard,
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => app.close());

  it('denies status without authentication and operation without permission', async () => {
    expect(
      (await fetch(`${origin}/program/modoitaliano/recording`)).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/program/modoitaliano/recording/start`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer viewer-token',
            'Idempotency-Key': 'recording-start-1',
          },
        })
      ).status,
    ).toBe(403);
    expect(command).not.toHaveBeenCalled();
  });

  it('uses read and operate catalog permissions and preserves replay keys', async () => {
    const headers = { Authorization: 'Bearer operator-token' };
    expect(
      (await fetch(`${origin}/program/modoitaliano/recording`, { headers }))
        .status,
    ).toBe(200);
    const commandHeaders = {
      ...headers,
      'Idempotency-Key': 'recording-start-1',
    };
    expect(
      (
        await fetch(`${origin}/program/modoitaliano/recording/start`, {
          method: 'POST',
          headers: commandHeaders,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await fetch(`${origin}/program/modoitaliano/recording/start`, {
          method: 'POST',
          headers: commandHeaders,
        })
      ).status,
    ).toBe(202);

    expect(authorize).toHaveBeenCalledWith(
      'Bearer operator-token',
      ALCANTARA_PERMISSIONS.program.read,
    );
    expect(authorize).toHaveBeenCalledWith(
      'Bearer operator-token',
      ALCANTARA_PERMISSIONS.program.operate,
    );
    expect(command).toHaveBeenNthCalledWith(
      1,
      'modoitaliano',
      'start',
      'recording-start-1',
    );
    expect(command).toHaveBeenNthCalledWith(
      2,
      'modoitaliano',
      'start',
      'recording-start-1',
    );
  });
});
