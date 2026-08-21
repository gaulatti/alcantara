/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest asymmetric matchers are intentionally typed as any. */
import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { WebrtcService } from './webrtc.service';

describe('WebrtcService', () => {
  const invitation = {
    id: '11111111-1111-4111-8111-111111111111',
    tokenHash: '',
    programId: 'main',
    displayName: 'Fictional Guest',
    slotNumber: 1,
    returnVideo: 'program',
    returnAudioBus: 'master',
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null as Date | null,
    activeSessionId: null as string | null,
    activeSessionUntil: null as Date | null,
    createdByIdentity: 'operator-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const token = `${invitation.id}.private-invitation-secret`;
  invitation.tokenHash = createHash('sha256').update(token).digest('hex');

  function setup() {
    const prisma = {
      guestInvitation: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ ...invitation }),
        findFirst: jest.fn().mockResolvedValue({ ...invitation }),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...invitation,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...invitation, ...data }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      guestCommand: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      guestEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const livekit = {
      listRooms: jest.fn().mockResolvedValue([]),
      createRoom: jest.fn().mockResolvedValue({}),
      listParticipants: jest.fn().mockResolvedValue([]),
      removeParticipant: jest.fn().mockResolvedValue(undefined),
      sendData: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WebrtcService(
      new ConfigService({
        LIVEKIT_WS_URL: 'ws://localhost:7880',
        LIVEKIT_API_URL: 'http://localhost:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'devsecret-devsecret-devsecret-devsecret',
        WEBRTC_SESSION_SECRET: 'session-secret-session-secret-session-secret',
        WEBRTC_RENDERER_KEY: 'renderer-secret',
      }),
      prisma as never,
    );
    jest.spyOn(service as never, 'roomService', 'get').mockReturnValue(livekit);
    return { service, prisma, livekit };
  }

  it('persists a default 24-hour invitation in the first reusable slot', async () => {
    const { service, prisma, livekit } = setup();
    const created = await service.createInvitation('operator-1', {
      programId: 'MAIN',
      displayName: ' Fictional Guest ',
    });
    expect(created).toMatchObject({
      programId: 'main',
      displayName: 'Fictional Guest',
      slotNumber: 1,
      status: 'available',
    });
    expect(created.invitation).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    expect(prisma.guestInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          createdByIdentity: 'operator-1',
        }),
      }),
    );
    expect(livekit.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ maxParticipants: 8, departureTimeout: 60 }),
    );
  });

  it('issues a short-lived credential and signed reconnect session', async () => {
    const { service, prisma } = setup();
    const joined = await service.redeemInvitation(token, undefined);
    expect(joined).toMatchObject({
      roomName: 'alcantara-main',
      participantIdentity: `guest-${invitation.id}`,
      reconnectWindowSeconds: 60,
    });
    expect(joined.token.split('.')).toHaveLength(3);
    expect(joined.sessionToken.split('.')).toHaveLength(3);
    expect(prisma.guestInvitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
        data: expect.objectContaining({
          activeSessionId: expect.any(String),
          activeSessionUntil: expect.any(Date),
        }),
      }),
    );
  });

  it('prevents a second concurrent session from claiming the invitation', async () => {
    const { service, prisma } = setup();
    prisma.guestInvitation.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.redeemInvitation(token, undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects tampered, revoked, and expired invitations', async () => {
    const { service, prisma } = setup();
    await expect(
      service.redeemInvitation(`${token}x`, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    prisma.guestInvitation.findUnique.mockResolvedValueOnce({
      ...invitation,
      revokedAt: new Date(),
    });
    await expect(
      service.redeemInvitation(token, undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
    prisma.guestInvitation.findUnique.mockResolvedValueOnce({
      ...invitation,
      expiresAt: new Date(0),
    });
    await expect(
      service.redeemInvitation(token, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes persistence and removes an active participant', async () => {
    const { service, prisma, livekit } = setup();
    await expect(
      service.revokeInvitation('operator-1', invitation.id),
    ).resolves.toEqual({ id: invitation.id, status: 'revoked' });
    expect(prisma.guestInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: invitation.id },
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          activeSessionId: null,
        }),
      }),
    );
    expect(livekit.removeParticipant).toHaveBeenCalledWith(
      'alcantara-main',
      `guest-${invitation.id}`,
    );
  });

  it('requires an explicit renderer machine credential', async () => {
    const { service } = setup();
    await expect(
      service.createRendererToken(undefined, 'main'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.createRendererToken('renderer-secret', 'main'),
    ).resolves.toMatchObject({ roomName: 'alcantara-main' });
  });
});
