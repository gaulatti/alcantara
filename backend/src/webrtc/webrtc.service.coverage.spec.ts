/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Jest mocks and asymmetric matchers are intentionally loosely typed. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { WebrtcService } from './webrtc.service';

jest.mock('livekit-server-sdk', () => {
  const actual = jest.requireActual('livekit-server-sdk');
  return { ...actual, RoomServiceClient: jest.fn() };
});

const SESSION_SECRET = 'session-secret-session-secret-session-secret';
const baseConfig: Record<string, string> = {
  LIVEKIT_WS_URL: 'wss://livekit.example.test',
  LIVEKIT_API_URL: 'http://api.example.test:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'devsecret-devsecret-devsecret-devsecret',
  WEBRTC_SESSION_SECRET: SESSION_SECRET,
  WEBRTC_RENDERER_KEY: 'renderer-secret',
};

const operator = { principalId: 'principal-1', subject: 'operator-1' };
const ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = `guest-${ID}`;
const TOKEN = `${ID}.private-invitation-secret`;
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

function makeInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    tokenHash: TOKEN_HASH,
    programId: 'main',
    displayName: 'Fictional Guest',
    slotNumber: 1,
    returnVideo: 'program',
    returnAudioBus: 'master',
    sourceGain: 1,
    sourceMuted: false,
    sourceDelayMs: 0,
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null as Date | null,
    activeSessionId: null as string | null,
    activeSessionUntil: null as Date | null,
    createdByIdentity: 'operator-1',
    createdByPrincipalId: 'principal-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function sign(invitationId: string, sessionId: string) {
  const payload = `${invitationId}.${sessionId}`;
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function jwtGrant(jwt: string) {
  const payload = JSON.parse(
    Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'),
  );
  return payload;
}

function setup(config: Record<string, string> = baseConfig) {
  const prisma = {
    guestInvitation: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(makeInvitation()),
      findFirst: jest.fn().mockResolvedValue(makeInvitation()),
      create: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve(makeInvitation({ ...data })),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve(makeInvitation({ ...data })),
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
    getParticipant: jest.fn(),
    mutePublishedTrack: jest.fn().mockResolvedValue({}),
    removeParticipant: jest.fn().mockResolvedValue(undefined),
    sendData: jest.fn().mockResolvedValue(undefined),
  };
  (RoomServiceClient as unknown as jest.Mock).mockReset();
  (RoomServiceClient as unknown as jest.Mock).mockImplementation(() => livekit);
  const service = new WebrtcService(new ConfigService(config), prisma as never);
  return { service, prisma, livekit };
}

function without(...keys: string[]) {
  const copy = { ...baseConfig };
  for (const key of keys) delete copy[key];
  return copy;
}

describe('WebrtcService coverage', () => {
  describe('configuration', () => {
    it('reports enabled only when every credential is present', () => {
      expect(setup().service.getPublicConfig()).toEqual({
        enabled: true,
        maxGuests: 6,
      });
      for (const key of [
        'LIVEKIT_WS_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'WEBRTC_SESSION_SECRET',
      ]) {
        expect(setup(without(key)).service.getPublicConfig().enabled).toBe(
          false,
        );
      }
      expect(setup({}).service.getPublicConfig().enabled).toBe(false);
    });

    it('rejects configured-only operations when unconfigured', async () => {
      const { service } = setup({});
      await expect(
        service.createInvitation(operator, {}),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.redeemInvitation(TOKEN, undefined)).rejects.toThrow(
        'WebRTC is not configured.',
      );
      await expect(service.listParticipants('main')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('builds the LiveKit client from the explicit API URL', async () => {
      const { service } = setup();
      await service.revokeInvitation(operator, ID);
      expect(RoomServiceClient).toHaveBeenCalledWith(
        'http://api.example.test:7880',
        'devkey',
        baseConfig.LIVEKIT_API_SECRET,
      );
    });

    it('derives the API URL from a wss websocket URL', async () => {
      const { service } = setup(without('LIVEKIT_API_URL'));
      await service.revokeInvitation(operator, ID);
      expect(RoomServiceClient).toHaveBeenCalledWith(
        'https://livekit.example.test',
        'devkey',
        baseConfig.LIVEKIT_API_SECRET,
      );
    });

    it('derives the API URL from a plain ws websocket URL', async () => {
      const { service } = setup({
        ...without('LIVEKIT_API_URL'),
        LIVEKIT_WS_URL: 'ws://localhost:7880',
      });
      await service.revokeInvitation(operator, ID);
      expect(RoomServiceClient).toHaveBeenCalledWith(
        'http://localhost:7880',
        'devkey',
        baseConfig.LIVEKIT_API_SECRET,
      );
    });

    it('falls back to empty strings when nothing is configured', async () => {
      const { service } = setup({});
      await service.revokeInvitation(operator, ID);
      expect(RoomServiceClient).toHaveBeenCalledWith('', '', '');
    });
  });

  describe('listInvitations / presentInvitation', () => {
    it('presents every lifecycle status and defaults commands', async () => {
      const { service, prisma } = setup();
      const command = { id: 'c1' };
      prisma.guestInvitation.findMany.mockResolvedValue([
        makeInvitation({ revokedAt: new Date('2026-01-02T00:00:00Z') }),
        makeInvitation({ expiresAt: new Date(0) }),
        makeInvitation({
          activeSessionUntil: new Date(Date.now() + 60_000),
          commands: [command],
        }),
        makeInvitation({ activeSessionUntil: new Date(Date.now() - 60_000) }),
        makeInvitation(),
      ]);
      const result = await service.listInvitations();
      expect(result.map((item) => item.status)).toEqual([
        'revoked',
        'expired',
        'active',
        'available',
        'available',
      ]);
      expect(result[0].revokedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(result[1].revokedAt).toBeNull();
      expect(result[2].commands).toEqual([command]);
      expect(result[4].commands).toEqual([]);
      expect(result[4].createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(prisma.guestInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { commands: { orderBy: { createdAt: 'desc' }, take: 10 } },
        }),
      );
    });
  });

  describe('createInvitation', () => {
    it('honours explicit values and skips room creation when it exists', async () => {
      const { service, prisma, livekit } = setup();
      livekit.listRooms.mockResolvedValue([{ name: 'alcantara-show_1' }]);
      const created = await service.createInvitation(operator, {
        programId: ' Show_1 ',
        displayName: 'x'.repeat(100),
        expiresInHours: 168,
        slotNumber: 3,
        returnVideo: 'none',
        returnAudioBus: 'aux-8',
        sourceGain: 0.5,
        sourceMuted: true,
        sourceDelayMs: 2000,
      });
      expect(created.programId).toBe('show_1');
      expect(created.displayName).toHaveLength(80);
      expect(created.slotNumber).toBe(3);
      expect(created.returnVideo).toBe('none');
      expect(created.returnAudioBus).toBe('aux-8');
      expect(created.sourceGain).toBe(0.5);
      expect(created.sourceMuted).toBe(true);
      expect(created.sourceDelayMs).toBe(2000);
      expect(created.invitationPath).toBe(
        `/guest/${encodeURIComponent(created.invitation)}`,
      );
      expect(livekit.createRoom).not.toHaveBeenCalled();
      expect(livekit.listRooms).toHaveBeenCalledWith(['alcantara-show_1']);
      const data = prisma.guestInvitation.create.mock.calls[0][0].data;
      expect(data.events.create.details).toMatchObject({
        expiresInHours: 168,
        slotNumber: 3,
      });
    });

    it('picks the first free slot, skipping occupied ones', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findMany.mockResolvedValue([
        { slotNumber: 1 },
        { slotNumber: 2 },
        { slotNumber: 4 },
      ]);
      const created = await service.createInvitation(operator, {
        programId: 'main',
        displayName: 'Guest',
      });
      expect(created.slotNumber).toBe(3);
      expect(prisma.guestInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            programId: 'main',
            slotNumber: { not: null },
          }),
        }),
      );
    });

    it('fails when all six slots are taken', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findMany.mockResolvedValue(
        [1, 2, 3, 4, 5, 6].map((slotNumber) => ({ slotNumber })),
      );
      await expect(
        service.createInvitation(operator, {
          programId: 'main',
          displayName: 'Guest',
        }),
      ).rejects.toThrow(
        new ConflictException('All six guest slots are assigned.'),
      );
    });

    it('rejects an explicitly requested occupied slot', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findMany.mockResolvedValue([{ slotNumber: 2 }]);
      await expect(
        service.createInvitation(operator, {
          programId: 'main',
          displayName: 'Guest',
          slotNumber: 2,
        }),
      ).rejects.toThrow('Guest slot 2 is already assigned.');
    });

    it.each([
      ['non-number', 'one'],
      ['non-integer', 1.5],
      ['below range', 0],
      ['above range', 7],
    ])('rejects a %s slotNumber', async (_name, slotNumber) => {
      const { service } = setup();
      await expect(
        service.createInvitation(operator, {
          programId: 'main',
          displayName: 'Guest',
          slotNumber,
        }),
      ).rejects.toThrow('slotNumber must be 1 through 6.');
    });

    it('wraps LiveKit room failures as service unavailable', async () => {
      const { service, livekit, prisma } = setup();
      livekit.listRooms.mockRejectedValue(new Error('boom'));
      await expect(
        service.createInvitation(operator, {
          programId: 'main',
          displayName: 'Guest',
        }),
      ).rejects.toThrow('WebRTC control plane unavailable: boom');
      expect(prisma.guestInvitation.create).not.toHaveBeenCalled();
      livekit.listRooms.mockRejectedValue('weird');
      await expect(
        service.createInvitation(operator, {
          programId: 'main',
          displayName: 'Guest',
        }),
      ).rejects.toThrow(
        'WebRTC control plane unavailable: Unknown LiveKit error',
      );
    });

    const valid = { programId: 'main', displayName: 'Guest' };
    it.each([
      [{ programId: undefined }, 'programId is required.'],
      [{ programId: '   ' }, 'programId is required.'],
      [{ programId: '-bad' }, 'Invalid programId.'],
      [{ displayName: 5 }, 'displayName is required.'],
      [
        { expiresInHours: '2' },
        'expiresInHours must be an integer from 1 to 168.',
      ],
      [
        { expiresInHours: 1.5 },
        'expiresInHours must be an integer from 1 to 168.',
      ],
      [
        { expiresInHours: 0 },
        'expiresInHours must be an integer from 1 to 168.',
      ],
      [
        { expiresInHours: 169 },
        'expiresInHours must be an integer from 1 to 168.',
      ],
      [
        { returnVideo: 'full' },
        'returnVideo must be program, preview, or none.',
      ],
      [
        { returnAudioBus: 'aux-9' },
        'returnAudioBus must be master, monitor, or aux-1 through aux-8.',
      ],
      [
        { returnAudioBus: 3 },
        'returnAudioBus must be master, monitor, or aux-1 through aux-8.',
      ],
      [{ sourceGain: 'loud' }, 'sourceGain must be between 0 and 1.'],
      [{ sourceGain: Number.NaN }, 'sourceGain must be between 0 and 1.'],
      [{ sourceGain: -0.1 }, 'sourceGain must be between 0 and 1.'],
      [{ sourceGain: 1.1 }, 'sourceGain must be between 0 and 1.'],
      [{ sourceMuted: 'yes' }, 'sourceMuted must be boolean.'],
      [
        { sourceDelayMs: 'a' },
        'sourceDelayMs must be an integer from 0 to 2000.',
      ],
      [
        { sourceDelayMs: 1.5 },
        'sourceDelayMs must be an integer from 0 to 2000.',
      ],
      [
        { sourceDelayMs: -1 },
        'sourceDelayMs must be an integer from 0 to 2000.',
      ],
      [
        { sourceDelayMs: 2001 },
        'sourceDelayMs must be an integer from 0 to 2000.',
      ],
    ])('rejects invalid input %j', async (override, message) => {
      const { service } = setup();
      const promise = service.createInvitation(operator, {
        ...valid,
        ...override,
      });
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(message);
    });

    it.each(['program', 'preview', 'none'])(
      'accepts returnVideo %s',
      async (returnVideo) => {
        const { service } = setup();
        const created = await service.createInvitation(operator, {
          ...valid,
          returnVideo,
        });
        expect(created.returnVideo).toBe(returnVideo);
      },
    );

    it.each(['master', 'monitor', 'aux-1'])(
      'accepts returnAudioBus %s',
      async (returnAudioBus) => {
        const { service } = setup();
        const created = await service.createInvitation(operator, {
          ...valid,
          returnAudioBus,
        });
        expect(created.returnAudioBus).toBe(returnAudioBus);
      },
    );

    it('applies documented defaults', async () => {
      const { service, prisma } = setup();
      const created = await service.createInvitation(operator, valid);
      expect(created).toMatchObject({
        returnVideo: 'program',
        returnAudioBus: 'master',
        sourceGain: 1,
        sourceMuted: false,
        sourceDelayMs: 0,
      });
      expect(
        prisma.guestInvitation.create.mock.calls[0][0].data.events.create
          .details.expiresInHours,
      ).toBe(24);
    });
  });

  describe('replaceInvitation', () => {
    it('revokes then recreates with the remaining lifetime', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValue(
        makeInvitation({
          expiresAt: new Date(Date.now() + 90 * 60 * 1000),
          returnVideo: 'preview',
          returnAudioBus: 'aux-2',
          sourceGain: 0.25,
          sourceMuted: true,
          sourceDelayMs: 40,
          slotNumber: 4,
        }),
      );
      const created = await service.replaceInvitation(operator, ID);
      expect(prisma.guestInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ID },
          data: expect.objectContaining({ slotNumber: null }),
        }),
      );
      const data = prisma.guestInvitation.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        programId: 'main',
        displayName: 'Fictional Guest',
        slotNumber: 4,
        returnVideo: 'preview',
        returnAudioBus: 'aux-2',
        sourceGain: 0.25,
        sourceMuted: true,
        sourceDelayMs: 40,
      });
      expect(data.events.create.details.expiresInHours).toBe(2);
      expect(created.invitation).toMatch(/\./);
      expect(created.id).not.toBe('');
    });

    it('clamps an expired lifetime to one hour and skips re-revoking', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValue(
        makeInvitation({
          expiresAt: new Date(Date.now() - 3_600_000),
          revokedAt: new Date(),
        }),
      );
      await service.replaceInvitation(operator, ID);
      expect(prisma.guestInvitation.update).not.toHaveBeenCalled();
      expect(
        prisma.guestInvitation.create.mock.calls[0][0].data.events.create
          .details.expiresInHours,
      ).toBe(1);
    });

    it('fails for an unknown invitation', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValue(null);
      await expect(service.replaceInvitation(operator, ID)).rejects.toThrow(
        new NotFoundException('Invitation not found.'),
      );
    });
  });

  describe('revokeInvitation', () => {
    it('does not rewrite an already revoked invitation', async () => {
      const { service, prisma, livekit } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValue(
        makeInvitation({ revokedAt: new Date() }),
      );
      await expect(service.revokeInvitation(operator, ID)).resolves.toEqual({
        id: ID,
        status: 'revoked',
      });
      expect(prisma.guestInvitation.update).not.toHaveBeenCalled();
      expect(livekit.removeParticipant).toHaveBeenCalledWith(
        'alcantara-main',
        IDENTITY,
      );
    });

    it.each([
      ['room not found', new Error('Room alcantara-main not found')],
      ['room does not exist', new Error('room does not exist')],
      ['participant not found', new Error('participant xyz not found')],
    ])('tolerates %s from LiveKit', async (_name, error) => {
      const { service, livekit } = setup();
      livekit.removeParticipant.mockRejectedValue(error);
      await expect(service.revokeInvitation(operator, ID)).resolves.toEqual({
        id: ID,
        status: 'revoked',
      });
    });

    it('surfaces other LiveKit failures', async () => {
      const { service, livekit } = setup();
      livekit.removeParticipant.mockRejectedValue(new Error('network down'));
      await expect(service.revokeInvitation(operator, ID)).rejects.toThrow(
        'WebRTC control plane unavailable: network down',
      );
      livekit.removeParticipant.mockRejectedValue('string failure');
      await expect(service.revokeInvitation(operator, ID)).rejects.toThrow(
        'Unknown LiveKit error',
      );
    });

    it('fails for an unknown invitation', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValue(null);
      await expect(
        service.revokeInvitation(operator, ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateReturn', () => {
    it('persists the new return feed and notifies the guest', async () => {
      const { service, prisma, livekit } = setup();
      const result = await service.updateReturn(operator, ID, {
        returnVideo: 'preview',
        returnAudioBus: 'monitor',
        sourceGain: 0.4,
        sourceMuted: true,
        sourceDelayMs: 120,
      });
      expect(result).toMatchObject({
        returnVideo: 'preview',
        returnAudioBus: 'monitor',
        sourceGain: 0.4,
        sourceMuted: true,
        sourceDelayMs: 120,
      });
      expect(
        prisma.guestInvitation.update.mock.calls[0][0].data.events.create,
      ).toMatchObject({
        type: 'return_changed',
        details: {
          operatorIdentity: 'operator-1',
          operatorPrincipalId: 'principal-1',
          returnVideo: 'preview',
        },
      });
      const [room, bytes, kind, options] = livekit.sendData.mock.calls[0];
      expect(room).toBe('alcantara-main');
      expect(JSON.parse((bytes as Buffer).toString())).toMatchObject({
        version: 1,
        type: 'return',
        returnVideo: 'preview',
        returnAudioBus: 'monitor',
        sourceGain: 0.4,
        sourceMuted: true,
        sourceDelayMs: 120,
      });
      expect(kind).toBe(0);
      expect(options).toEqual({
        destinationIdentities: [IDENTITY],
        topic: 'alcantara-director',
      });
    });

    it('rejects unknown invitations and invalid values', async () => {
      const { service, prisma, livekit } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.updateReturn(operator, ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.updateReturn(operator, ID, { returnVideo: 'bad' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(livekit.sendData).not.toHaveBeenCalled();
    });
  });

  describe('redeemInvitation', () => {
    it('issues a subscribing guest credential carrying slot metadata', async () => {
      const { service, prisma } = setup();
      const joined = await service.redeemInvitation(`  ${TOKEN}  `, undefined);
      expect(joined).toMatchObject({
        serverUrl: baseConfig.LIVEKIT_WS_URL,
        roomName: 'alcantara-main',
        participantIdentity: IDENTITY,
        displayName: 'Fictional Guest',
        programId: 'main',
        slotNumber: 1,
        returnVideo: 'program',
        returnAudioBus: 'master',
        sourceGain: 1,
        sourceMuted: false,
        sourceDelayMs: 0,
        reconnectWindowSeconds: 60,
      });
      const claims = jwtGrant(joined.token);
      expect(claims.sub).toBe(IDENTITY);
      expect(JSON.parse(claims.metadata)).toEqual({
        role: 'guest',
        invitationId: ID,
        slotNumber: 1,
      });
      expect(claims.video).toMatchObject({
        room: 'alcantara-main',
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      expect(prisma.guestEvent.create).toHaveBeenCalledWith({
        data: { invitationId: ID, type: 'token_issued' },
      });
      const [, sessionId, signature] = joined.sessionToken.split('.').slice(-3);
      expect(signature).toBe(
        createHmac('sha256', SESSION_SECRET)
          .update(`${ID}.${sessionId}`)
          .digest('base64url'),
      );
    });

    it('does not let a guest subscribe with no return feed and no audio bus', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValue(
        makeInvitation({ returnVideo: 'none', returnAudioBus: '' }),
      );
      const joined = await service.redeemInvitation(TOKEN, undefined);
      expect(jwtGrant(joined.token).video.canSubscribe).toBe(false);
    });

    it('lets a guest subscribe to audio only', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValue(
        makeInvitation({ returnVideo: 'none', returnAudioBus: 'master' }),
      );
      const joined = await service.redeemInvitation(TOKEN, undefined);
      expect(jwtGrant(joined.token).video.canSubscribe).toBe(true);
    });

    it('resumes an existing signed session', async () => {
      const { service, prisma } = setup();
      const sessionToken = sign(ID, 'session-abc');
      const joined = await service.redeemInvitation(TOKEN, sessionToken);
      expect(joined.sessionToken).toBe(sessionToken);
      expect(prisma.guestInvitation.updateMany.mock.calls[0][0]).toMatchObject({
        data: { activeSessionId: 'session-abc' },
      });
    });

    it.each([[''], [42], [null]])(
      'mints a new session for session token %p',
      async (sessionToken) => {
        const { service, prisma } = setup();
        await service.redeemInvitation(TOKEN, sessionToken);
        const sessionId =
          prisma.guestInvitation.updateMany.mock.calls[0][0].data
            .activeSessionId;
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      },
    );

    it('rejects a session token for a different invitation', async () => {
      const { service } = setup();
      await expect(
        service.redeemInvitation(TOKEN, sign('other-id', 's')),
      ).rejects.toThrow('Invalid guest session.');
    });

    it.each([
      ['non-string', 7, 'Invitation is required.'],
      ['blank', '  ', 'Invitation is required.'],
    ])('rejects a %s invitation value', async (_n, value, message) => {
      const { service } = setup();
      await expect(service.redeemInvitation(value, undefined)).rejects.toThrow(
        message,
      );
    });

    it.each([
      ['missing secret', `${ID}`],
      ['missing id', `.secret`],
      ['extra segment', `${TOKEN}.extra`],
    ])('rejects a malformed invitation (%s)', async (_n, value) => {
      const { service, prisma } = setup();
      await expect(service.redeemInvitation(value, undefined)).rejects.toThrow(
        'Invalid guest invitation.',
      );
      expect(prisma.guestInvitation.findUnique).not.toHaveBeenCalled();
    });

    it('rejects unknown invitations and wrong secrets', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValueOnce(null);
      await expect(service.redeemInvitation(TOKEN, undefined)).rejects.toThrow(
        'Invalid guest invitation.',
      );
      await expect(
        service.redeemInvitation(`${ID}.wrong-secret`, undefined),
      ).rejects.toThrow('Invalid guest invitation.');
    });

    it('rejects revoked and expired invitations with distinct errors', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findUnique.mockResolvedValueOnce(
        makeInvitation({ revokedAt: new Date() }),
      );
      await expect(service.redeemInvitation(TOKEN, undefined)).rejects.toThrow(
        new ForbiddenException('This invitation was revoked.'),
      );
      prisma.guestInvitation.findUnique.mockResolvedValueOnce(
        makeInvitation({ expiresAt: new Date(0) }),
      );
      await expect(service.redeemInvitation(TOKEN, undefined)).rejects.toThrow(
        new UnauthorizedException('This invitation expired.'),
      );
    });

    it('rejects when another session holds the lease', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.redeemInvitation(TOKEN, undefined)).rejects.toThrow(
        'This invitation is already active in another session.',
      );
      expect(prisma.guestEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('heartbeat', () => {
    function active(prisma: ReturnType<typeof setup>['prisma']) {
      prisma.guestInvitation.findFirst.mockResolvedValue(
        makeInvitation({ activeSessionId: 's1' }),
      );
    }

    it('extends the lease and records sanitised telemetry', async () => {
      const { service, prisma } = setup();
      active(prisma);
      const before = Date.now();
      const result = await service.heartbeat(sign(ID, 's1'), {
        connectionState: 'x'.repeat(100),
        iceTransport: 'udp',
        quality: 7,
        cameraEnabled: false,
        microphoneEnabled: true,
        ignored: 'nope',
        packetLoss: -5,
        jitterMs: 2_000_000,
        roundTripMs: 12.5,
        bitrateKbps: Number.POSITIVE_INFINITY,
        width: '1920',
        height: 1080,
      });
      const until = new Date(result.activeSessionUntil).getTime();
      expect(until).toBeGreaterThanOrEqual(before + 60_000);
      expect(until).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(prisma.guestInvitation.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: ID,
          activeSessionId: 's1',
          revokedAt: null,
        }),
      });
      expect(prisma.guestInvitation.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: {
          activeSessionUntil: expect.any(Date),
          events: {
            create: {
              type: 'telemetry',
              details: {
                connectionState: 'x'.repeat(40),
                iceTransport: 'udp',
                cameraEnabled: false,
                microphoneEnabled: true,
                packetLoss: 0,
                jitterMs: 1_000_000,
                roundTripMs: 12.5,
                height: 1080,
              },
            },
          },
        },
      });
    });

    it('skips the telemetry event when telemetry is absent or malformed', async () => {
      const { service, prisma } = setup();
      active(prisma);
      for (const telemetry of [undefined, null, 'text', ['a']]) {
        prisma.guestInvitation.update.mockClear();
        await service.heartbeat(sign(ID, 's1'), telemetry);
        expect(prisma.guestInvitation.update).toHaveBeenCalledWith({
          where: { id: ID },
          data: { activeSessionUntil: expect.any(Date) },
        });
      }
    });

    it('records an empty telemetry object as an event', async () => {
      const { service, prisma } = setup();
      active(prisma);
      await service.heartbeat(sign(ID, 's1'), {});
      expect(
        prisma.guestInvitation.update.mock.calls[0][0].data.events.create
          .details,
      ).toEqual({});
    });

    it('rejects invalid or inactive sessions', async () => {
      const { service, prisma } = setup();
      await expect(service.heartbeat(undefined, {})).rejects.toThrow(
        'Session token is required.',
      );
      await expect(service.heartbeat('.sid.sig', {})).rejects.toThrow(
        'Invalid guest session.',
      );
      await expect(service.heartbeat(`${ID}.s1`, {})).rejects.toThrow(
        'Invalid guest session.',
      );
      await expect(service.heartbeat(`${ID}.s1.bad.extra`, {})).rejects.toThrow(
        'Invalid guest session.',
      );
      await expect(
        service.heartbeat(`${ID}.s1.badsignature`, {}),
      ).rejects.toThrow('Invalid guest session.');
      await expect(service.heartbeat(`${ID}..sig`, {})).rejects.toThrow(
        'Invalid guest session.',
      );
      prisma.guestInvitation.findFirst.mockResolvedValue(null);
      await expect(service.heartbeat(sign(ID, 's1'), {})).rejects.toThrow(
        new UnauthorizedException('Guest session is inactive.'),
      );
      expect(prisma.guestInvitation.update).not.toHaveBeenCalled();
    });

    it('rejects a same-length wrong signature', async () => {
      const { service } = setup();
      const good = sign(ID, 's1');
      const forged = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
      await expect(service.heartbeat(forged, {})).rejects.toThrow(
        'Invalid guest session.',
      );
    });
  });

  describe('acknowledgeCommand', () => {
    it.each(['accepted', 'rejected', 'read', 'acknowledged'])(
      'stores status %s',
      async (status) => {
        const { service, prisma } = setup();
        prisma.guestCommand.findFirst.mockResolvedValue({ id: 'cmd-1' });
        prisma.guestCommand.update.mockResolvedValue({ id: 'cmd-1', status });
        const result = await service.acknowledgeCommand(
          sign(ID, 's1'),
          'cmd-1',
          status,
        );
        expect(result).toEqual({ id: 'cmd-1', status });
        expect(prisma.guestCommand.findFirst).toHaveBeenCalledWith({
          where: { id: 'cmd-1', invitationId: ID },
        });
        expect(prisma.guestCommand.update).toHaveBeenCalledWith({
          where: { id: 'cmd-1' },
          data: { status, acknowledgedAt: expect.any(Date) },
        });
      },
    );

    it('rejects invalid statuses and unknown commands', async () => {
      const { service, prisma } = setup();
      await expect(
        service.acknowledgeCommand(sign(ID, 's1'), 'cmd-1', 'delivered'),
      ).rejects.toThrow('Invalid acknowledgement status.');
      prisma.guestCommand.findFirst.mockResolvedValue(null);
      await expect(
        service.acknowledgeCommand(sign(ID, 's1'), 'cmd-1', 'read'),
      ).rejects.toThrow(new NotFoundException('Command not found.'));
      expect(prisma.guestCommand.update).not.toHaveBeenCalled();
    });
  });

  describe('listParticipants', () => {
    it('merges live LiveKit state into stored invitations', async () => {
      const { service, prisma, livekit } = setup();
      const connectedId = '22222222-2222-4222-8222-222222222222';
      const reconnectId = '33333333-3333-4333-8333-333333333333';
      const offlineId = '44444444-4444-4444-8444-444444444444';
      const neverId = '55555555-5555-4555-8555-555555555555';
      prisma.guestInvitation.findMany.mockResolvedValue([
        makeInvitation({
          id: connectedId,
          activeSessionUntil: new Date(Date.now() + 60_000),
          commands: [{ id: 'c' }],
        }),
        makeInvitation({
          id: reconnectId,
          activeSessionUntil: new Date(Date.now() + 60_000),
          commands: [],
        }),
        makeInvitation({
          id: offlineId,
          activeSessionUntil: new Date(Date.now() - 60_000),
          commands: [],
        }),
        makeInvitation({ id: neverId, commands: [] }),
      ]);
      livekit.listParticipants.mockResolvedValue([
        {
          identity: `guest-${connectedId}`,
          tracks: [
            {
              sid: 'TR_1',
              source: TrackSource.CAMERA,
              muted: false,
              width: 1280,
              height: 720,
              mimeType: 'video/vp8',
            },
            {
              sid: 'TR_2',
              source: TrackSource.MICROPHONE,
              muted: true,
              width: 0,
              height: 0,
              mimeType: 'audio/opus',
            },
          ],
        },
      ]);
      const result = await service.listParticipants(' MAIN ');
      expect(result.roomName).toBe('alcantara-main');
      expect(livekit.listParticipants).toHaveBeenCalledWith('alcantara-main');
      expect(result.participants.map((p) => p.connectionState)).toEqual([
        'connected',
        'reconnecting',
        'offline',
        'offline',
      ]);
      expect(result.participants[0]).toMatchObject({
        invitationId: connectedId,
        identity: `guest-${connectedId}`,
        name: 'Fictional Guest',
        slotNumber: 1,
        commands: [{ id: 'c' }],
        tracks: [
          {
            sid: 'TR_1',
            source: 'camera',
            muted: false,
            width: 1280,
            height: 720,
            mimeType: 'video/vp8',
          },
          {
            sid: 'TR_2',
            source: 'microphone',
            muted: true,
            width: 0,
            height: 0,
            mimeType: 'audio/opus',
          },
        ],
      });
      expect(result.participants[0].reconnectUntil).toEqual(
        expect.stringMatching(/Z$/),
      );
      expect(result.participants[1].tracks).toEqual([]);
      expect(result.participants[3].reconnectUntil).toBeNull();
    });

    it('treats a missing room as empty and surfaces other failures', async () => {
      const { service, prisma, livekit } = setup();
      prisma.guestInvitation.findMany.mockResolvedValue([
        makeInvitation({ commands: [] }),
      ]);
      livekit.listParticipants.mockRejectedValueOnce(
        new Error('room alcantara-main not found'),
      );
      const result = await service.listParticipants('main');
      expect(result.participants[0].connectionState).toBe('offline');
      livekit.listParticipants.mockRejectedValueOnce(new Error('timeout'));
      await expect(service.listParticipants('main')).rejects.toThrow(
        new ServiceUnavailableException(
          'WebRTC control plane unavailable: timeout',
        ),
      );
      livekit.listParticipants.mockRejectedValueOnce(42);
      await expect(service.listParticipants('main')).rejects.toThrow(
        'Unknown LiveKit error',
      );
    });
  });

  describe('controlParticipant', () => {
    function arm() {
      const ctx = setup();
      ctx.prisma.guestCommand.create.mockResolvedValue({
        id: 'cmd-1',
        createdAt: new Date('2026-02-03T04:05:06Z'),
      });
      ctx.prisma.guestCommand.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'cmd-1', ...data }),
      );
      return ctx;
    }

    it('disables a published camera track by muting it', async () => {
      const { service, prisma, livekit } = arm();
      livekit.getParticipant.mockResolvedValue({
        tracks: [
          { sid: 'TR_MIC', source: TrackSource.MICROPHONE },
          { sid: 'TR_CAM', source: TrackSource.CAMERA },
        ],
      });
      const result = await service.controlParticipant('main', IDENTITY, {
        type: 'media',
        device: 'camera',
        enabled: false,
      });
      expect(livekit.getParticipant).toHaveBeenCalledWith(
        'alcantara-main',
        IDENTITY,
      );
      expect(livekit.mutePublishedTrack).toHaveBeenCalledWith(
        'alcantara-main',
        IDENTITY,
        'TR_CAM',
        true,
      );
      expect(livekit.sendData).not.toHaveBeenCalled();
      expect(prisma.guestCommand.create).toHaveBeenCalledWith({
        data: {
          invitationId: ID,
          type: 'media',
          payload: {
            version: 1,
            type: 'media',
            device: 'camera',
            enabled: false,
          },
        },
      });
      expect(result).toMatchObject({
        status: 'delivered',
        deliveredAt: expect.any(Date),
      });
    });

    it('mutes the microphone track when the device is microphone', async () => {
      const { service, livekit } = arm();
      livekit.getParticipant.mockResolvedValue({
        tracks: [
          { sid: 'TR_CAM', source: TrackSource.CAMERA },
          { sid: 'TR_MIC', source: TrackSource.MICROPHONE },
        ],
      });
      await service.controlParticipant('main', IDENTITY, {
        type: 'media',
        device: 'microphone',
        enabled: false,
      });
      expect(livekit.mutePublishedTrack).toHaveBeenCalledWith(
        'alcantara-main',
        IDENTITY,
        'TR_MIC',
        true,
      );
    });

    it('records a failure when the track is unavailable', async () => {
      const { service, prisma, livekit } = arm();
      livekit.getParticipant.mockResolvedValue({ tracks: [] });
      await expect(
        service.controlParticipant('main', IDENTITY, {
          type: 'media',
          device: 'camera',
          enabled: false,
        }),
      ).rejects.toThrow(
        'WebRTC control plane unavailable: camera track is unavailable.',
      );
      expect(prisma.guestCommand.update).toHaveBeenCalledWith({
        where: { id: 'cmd-1' },
        data: {
          status: 'failed',
          failureReason: 'camera track is unavailable.',
        },
      });
      expect(livekit.mutePublishedTrack).not.toHaveBeenCalled();
    });

    it('truncates long failure reasons and handles non-Error throws', async () => {
      const { service, prisma, livekit } = arm();
      livekit.sendData.mockRejectedValueOnce(new Error('e'.repeat(500)));
      await expect(
        service.controlParticipant('main', IDENTITY, {
          type: 'media',
          device: 'camera',
          enabled: true,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.guestCommand.update).toHaveBeenLastCalledWith({
        where: { id: 'cmd-1' },
        data: { status: 'failed', failureReason: 'e'.repeat(240) },
      });
      livekit.sendData.mockRejectedValueOnce('plain string');
      await expect(
        service.controlParticipant('main', IDENTITY, {
          type: 'cue',
          cue: 'live',
        }),
      ).rejects.toThrow('Unknown LiveKit error');
      expect(prisma.guestCommand.update).toHaveBeenLastCalledWith({
        where: { id: 'cmd-1' },
        data: { status: 'failed', failureReason: 'LiveKit command failed' },
      });
    });

    it.each([
      [
        'media enable',
        { type: 'media', device: 'microphone', enabled: true },
        { version: 1, type: 'media', device: 'microphone', enabled: true },
      ],
      [
        'cue',
        { type: 'cue', cue: 'wrap' },
        { version: 1, type: 'cue', cue: 'wrap' },
      ],
      [
        'message',
        { type: 'message', text: `  ${'m'.repeat(600)}  ` },
        { version: 1, type: 'message', text: 'm'.repeat(500) },
      ],
      [
        'talkback',
        { type: 'talkback', enabled: false },
        { version: 1, type: 'talkback', enabled: false },
      ],
    ])('delivers a %s command as data', async (_n, body, expected) => {
      const { service, livekit } = arm();
      const result = await service.controlParticipant('main', IDENTITY, body);
      const [room, bytes, , options] = livekit.sendData.mock.calls[0];
      expect(room).toBe('alcantara-main');
      expect(JSON.parse((bytes as Buffer).toString())).toEqual({
        ...expected,
        id: 'cmd-1',
        sentAt: '2026-02-03T04:05:06.000Z',
      });
      expect(options).toEqual({
        destinationIdentities: [IDENTITY],
        topic: 'alcantara-director',
      });
      expect(result.status).toBe('delivered');
    });

    it.each([
      [{ type: 'media', device: 'speaker', enabled: true }],
      [{ type: 'media', device: 'camera', enabled: 'yes' }],
      [{ type: 'media', device: 'camera' }],
    ])('rejects invalid media command %j', async (body) => {
      const { service, prisma } = arm();
      await expect(
        service.controlParticipant('main', IDENTITY, body),
      ).rejects.toThrow(
        'A media command requires camera/microphone and enabled state.',
      );
      expect(prisma.guestCommand.create).not.toHaveBeenCalled();
    });

    it.each([
      [{ type: 'cue', cue: 'intro' }, 'Invalid cue.'],
      [{ type: 'message', text: '   ' }, 'Message is required.'],
      [{ type: 'talkback', enabled: 'on' }, 'Talkback requires enabled state.'],
      [{ type: 'explode' }, 'Unsupported participant command.'],
    ])('rejects invalid command %j', async (body, message) => {
      const { service } = arm();
      await expect(
        service.controlParticipant('main', IDENTITY, body),
      ).rejects.toThrow(message);
    });

    it('rejects bad identities and missing invitations', async () => {
      const { service, prisma } = arm();
      await expect(
        service.controlParticipant('main', 'operator-x', { type: 'cue' }),
      ).rejects.toThrow('Invalid guest identity.');
      prisma.guestInvitation.findFirst.mockResolvedValue(null);
      await expect(
        service.controlParticipant('main', IDENTITY, { type: 'cue' }),
      ).rejects.toThrow(new NotFoundException('Active invitation not found.'));
      expect(prisma.guestInvitation.findFirst).toHaveBeenCalledWith({
        where: {
          id: ID,
          programId: 'main',
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
      });
    });
  });

  describe('removeParticipant', () => {
    it('disconnects the guest and clears its session', async () => {
      const { service, prisma, livekit } = setup();
      await expect(
        service.removeParticipant(operator, 'main', IDENTITY),
      ).resolves.toEqual({ identity: IDENTITY, status: 'removed' });
      expect(livekit.removeParticipant).toHaveBeenCalledWith(
        'alcantara-main',
        IDENTITY,
      );
      expect(prisma.guestInvitation.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: {
          activeSessionId: null,
          activeSessionUntil: null,
          events: {
            create: {
              type: 'removed',
              details: {
                operatorIdentity: 'operator-1',
                operatorPrincipalId: 'principal-1',
              },
            },
          },
        },
      });
    });

    it('does not clear the session when LiveKit fails', async () => {
      const { service, prisma, livekit } = setup();
      livekit.removeParticipant.mockRejectedValue(new Error('down'));
      await expect(
        service.removeParticipant(operator, 'main', IDENTITY),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.guestInvitation.update).not.toHaveBeenCalled();
    });
  });

  describe('renderer and operator tokens', () => {
    it('rejects missing, wrong-length, wrong and unconfigured renderer keys', async () => {
      const { service } = setup();
      for (const key of [undefined, '', 'short', 'renderer-secreX']) {
        await expect(service.createRendererToken(key, 'main')).rejects.toThrow(
          'Renderer credential required.',
        );
        await expect(service.getRendererState(key, 'main')).rejects.toThrow(
          'Renderer credential required.',
        );
        await expect(
          service.createRendererSourceToken(key, 'main'),
        ).rejects.toThrow('Renderer credential required.');
      }
      const unconfigured = setup(without('WEBRTC_RENDERER_KEY')).service;
      await expect(
        unconfigured.createRendererToken('anything', 'main'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('mints a renderer publisher token', async () => {
      const { service } = setup();
      const result = await service.createRendererToken(
        'renderer-secret',
        'Main',
      );
      expect(result.serverUrl).toBe(baseConfig.LIVEKIT_WS_URL);
      expect(result.roomName).toBe('alcantara-main');
      const claims = jwtGrant(result.token);
      expect(claims.sub).toMatch(/^renderer-main-[0-9a-f-]{36}$/);
      expect(claims.name).toBe('Alcantara return publisher main');
      expect(JSON.parse(claims.metadata)).toEqual({
        role: 'renderer',
        programId: 'main',
      });
      expect(claims.video).toMatchObject({
        room: 'alcantara-main',
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: [
          'camera',
          'microphone',
          'screen_share',
          'screen_share_audio',
        ],
      });
    });

    it('mints a hidden, non-publishing renderer source token', async () => {
      const { service } = setup();
      const result = await service.createRendererSourceToken(
        'renderer-secret',
        'main',
      );
      expect(result.roomName).toBe('alcantara-main');
      const claims = jwtGrant(result.token);
      expect(claims.sub).toMatch(/^renderer-source-main-/);
      expect(JSON.parse(claims.metadata)).toEqual({
        role: 'renderer-source',
        programId: 'main',
      });
      expect(claims.video).toMatchObject({
        canSubscribe: true,
        hidden: true,
      });
      expect(claims.video.canPublish).toBeFalsy();
      expect(claims.video.canPublishData).toBeFalsy();
    });

    it('returns renderer routes for active invitations', async () => {
      const { service, prisma } = setup();
      prisma.guestInvitation.findMany.mockResolvedValue([
        makeInvitation({
          returnVideo: 'preview',
          returnAudioBus: 'aux-1',
          sourceGain: 0.7,
          sourceMuted: true,
          sourceDelayMs: 15,
        }),
      ]);
      await expect(
        service.getRendererState('renderer-secret', 'main'),
      ).resolves.toEqual({
        programId: 'main',
        routes: [
          {
            participantIdentity: IDENTITY,
            slotNumber: 1,
            returnVideo: 'preview',
            returnAudioBus: 'aux-1',
            sourceGain: 0.7,
            sourceMuted: true,
            sourceDelayMs: 15,
          },
        ],
      });
      expect(prisma.guestInvitation.findMany).toHaveBeenCalledWith({
        where: {
          programId: 'main',
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: { slotNumber: 'asc' },
      });
    });

    it('mints a hidden operator token keyed by principal id', async () => {
      const { service } = setup();
      const result = await service.createOperatorToken(operator, 'main');
      const claims = jwtGrant(result.token);
      const digest = createHash('sha256')
        .update('principal-1')
        .digest('hex')
        .slice(0, 20);
      expect(claims.sub).toMatch(
        new RegExp(`^operator-${digest}-[0-9a-f-]{36}$`),
      );
      expect(JSON.parse(claims.metadata)).toEqual({ role: 'operator' });
      expect(claims.video).toMatchObject({
        hidden: true,
        canPublish: true,
        canPublishSources: ['microphone'],
      });
      expect(result.roomName).toBe('alcantara-main');
    });

    it('falls back to the subject when the principal id is null', async () => {
      const { service } = setup();
      const result = await service.createOperatorToken(
        { principalId: null, subject: 'pool-subject' },
        'main',
      );
      const digest = createHash('sha256')
        .update('pool-subject')
        .digest('hex')
        .slice(0, 20);
      expect(jwtGrant(result.token).sub).toContain(`operator-${digest}-`);
    });
  });
});
