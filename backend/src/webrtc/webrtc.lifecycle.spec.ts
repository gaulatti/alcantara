import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  DataPacket_Kind,
  RoomServiceClient,
  TokenVerifier,
  TrackSource,
} from 'livekit-server-sdk';
import { WebrtcService } from './webrtc.service';

const id = '11111111-1111-4111-8111-111111111111';
const invitationToken = `${id}.fictional-invitation-secret`;
const identity = `guest-${id}`;
const operator = {
  subject: 'fictional-operator',
  principalId: 'fictional-principal',
};
const config = {
  LIVEKIT_WS_URL: 'wss://livekit.example',
  LIVEKIT_API_KEY: 'fictional-key',
  LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
  WEBRTC_SESSION_SECRET:
    'fictional-session-secret-at-least-thirty-two-characters',
  WEBRTC_RENDERER_KEY: 'fictional-renderer-key',
};

function fixture(overrides: Record<string, unknown> = {}) {
  let invitation: any = {
    id,
    tokenHash: createHash('sha256').update(invitationToken).digest('hex'),
    programId: 'news',
    displayName: 'Fictional Guest',
    slotNumber: 1,
    returnVideo: 'program',
    returnAudioBus: 'master',
    sourceGain: 1,
    sourceMuted: false,
    sourceDelayMs: 0,
    expiresAt: new Date(Date.now() + 24 * 3600000),
    revokedAt: null,
    activeSessionId: null,
    activeSessionUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    commands: [],
  };
  const prisma = {
    guestInvitation: {
      findUnique: jest.fn(async () => invitation),
      findFirst: jest.fn(async () => invitation),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ ...invitation, ...data })),
      update: jest.fn(async ({ data }: any) => {
        invitation = { ...invitation, ...data };
        return invitation;
      }),
      updateMany: jest.fn(async ({ data }: any) => {
        invitation = { ...invitation, ...data };
        return { count: 1 };
      }),
    },
    guestCommand: {
      create: jest.fn(async ({ data }: any) => ({
        id: 'command-1',
        createdAt: new Date(),
        ...data,
      })),
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'command-1', invitationId: id }),
      update: jest.fn(async ({ where, data }: any) => ({ ...where, ...data })),
    },
    guestEvent: { create: jest.fn() },
  };
  const service = new WebrtcService(
    new ConfigService({ ...config, ...overrides }),
    prisma as any,
  );
  return { service, prisma, invitation: () => invitation };
}

describe('WebrtcService invitation/session and LiveKit boundary', () => {
  let rooms: jest.SpyInstance;
  let createRoom: jest.SpyInstance;
  let participants: jest.SpyInstance;
  let remove: jest.SpyInstance;
  let send: jest.SpyInstance;
  let participant: jest.SpyInstance;
  let mute: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00Z'));
    rooms = jest
      .spyOn(RoomServiceClient.prototype, 'listRooms')
      .mockResolvedValue([]);
    createRoom = jest
      .spyOn(RoomServiceClient.prototype, 'createRoom')
      .mockResolvedValue({} as never);
    participants = jest
      .spyOn(RoomServiceClient.prototype, 'listParticipants')
      .mockResolvedValue([]);
    remove = jest
      .spyOn(RoomServiceClient.prototype, 'removeParticipant')
      .mockResolvedValue(undefined);
    send = jest
      .spyOn(RoomServiceClient.prototype, 'sendData')
      .mockResolvedValue(undefined);
    participant = jest
      .spyOn(RoomServiceClient.prototype, 'getParticipant')
      .mockResolvedValue({
        tracks: [
          { source: TrackSource.CAMERA, sid: 'camera-1' },
          { source: TrackSource.MICROPHONE, sid: 'microphone-1' },
        ],
      } as never);
    mute = jest
      .spyOn(RoomServiceClient.prototype, 'mutePublishedTrack')
      .mockResolvedValue({} as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    'LIVEKIT_WS_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'WEBRTC_SESSION_SECRET',
  ])(
    'reports missing %s configuration and refuses credential issuance',
    async (field) => {
      const f = fixture({ [field]: undefined });
      expect(f.service.getPublicConfig()).toEqual({
        enabled: false,
        maxGuests: 6,
      });
      await expect(
        f.service.createInvitation(operator, {
          programId: 'news',
          displayName: 'Guest',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(createRoom).not.toHaveBeenCalled();
    },
  );

  it('creates a bounded explicit slot with normalized return routing and no plaintext secret in persistence', async () => {
    const f = fixture();
    const result = await f.service.createInvitation(operator, {
      programId: ' NEWS ',
      displayName: '  Fictional Guest  ',
      slotNumber: 2,
      expiresInHours: 168,
      returnVideo: 'preview',
      returnAudioBus: 'aux-8',
      sourceGain: 0.4,
      sourceMuted: true,
      sourceDelayMs: 2000,
    });
    expect(result).toEqual(
      expect.objectContaining({
        programId: 'news',
        displayName: 'Fictional Guest',
        slotNumber: 2,
        returnVideo: 'preview',
        returnAudioBus: 'aux-8',
        sourceGain: 0.4,
        sourceMuted: true,
        sourceDelayMs: 2000,
        expiresAt: '2026-01-08T12:00:00.000Z',
      }),
    );
    const stored = f.prisma.guestInvitation.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(
      createHash('sha256').update(result.invitation).digest('hex'),
    );
    expect(stored).not.toHaveProperty('invitation');
    expect(stored).not.toHaveProperty('secret');
    expect(result).not.toHaveProperty('tokenHash');
    expect(createRoom).toHaveBeenCalledWith({
      name: 'alcantara-news',
      maxParticipants: 8,
      emptyTimeout: 300,
      departureTimeout: 60,
    });
  });

  it.each([
    { programId: undefined },
    { programId: '../news' },
    { displayName: '' },
    { expiresInHours: '24' },
    { expiresInHours: 0 },
    { expiresInHours: 169 },
    { expiresInHours: 1.5 },
    { slotNumber: '1' },
    { slotNumber: 0 },
    { slotNumber: 7 },
    { slotNumber: 1.5 },
    { returnVideo: 'invalid' },
    { returnAudioBus: 'aux-0' },
    { returnAudioBus: 'aux-9' },
    { returnAudioBus: null },
    { sourceGain: '1' },
    { sourceGain: NaN },
    { sourceGain: -1 },
    { sourceGain: 2 },
    { sourceMuted: 'false' },
    { sourceDelayMs: -1 },
    { sourceDelayMs: 2001 },
    { sourceDelayMs: 0.1 },
    { sourceDelayMs: '0' },
  ])(
    'rejects invalid invitation fields before persisting: %p',
    async (invalid) => {
      const f = fixture();
      await expect(
        f.service.createInvitation(operator, {
          programId: 'news',
          displayName: 'Guest',
          ...invalid,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.guestInvitation.create).not.toHaveBeenCalled();
      expect(createRoom).not.toHaveBeenCalled();
    },
  );

  it('reserves the first free slot and refuses occupied or exhausted slot inventories', async () => {
    const f = fixture();
    f.prisma.guestInvitation.findMany.mockResolvedValue([{ slotNumber: 1 }]);
    rooms.mockResolvedValue([{ name: 'alcantara-news' }]);
    const result = await f.service.createInvitation(operator, {
      programId: 'news',
      displayName: 'Guest',
    });
    expect(result.slotNumber).toBe(2);
    expect(createRoom).not.toHaveBeenCalled();
    await expect(
      f.service.createInvitation(operator, {
        programId: 'news',
        displayName: 'Guest',
        slotNumber: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    f.prisma.guestInvitation.findMany.mockResolvedValue(
      [1, 2, 3, 4, 5, 6].map((slotNumber) => ({ slotNumber })),
    );
    await expect(
      f.service.createInvitation(operator, {
        programId: 'news',
        displayName: 'Guest',
      }),
    ).rejects.toThrow('All six guest slots');
  });

  it('maps room creation failures without storing an unusable invitation', async () => {
    const f = fixture();
    rooms.mockRejectedValueOnce(new Error('server unavailable'));
    await expect(
      f.service.createInvitation(operator, {
        programId: 'news',
        displayName: 'Guest',
      }),
    ).rejects.toThrow('WebRTC control plane unavailable: server unavailable');
    expect(f.prisma.guestInvitation.create).not.toHaveBeenCalled();
  });

  it('presents revoked, expired, active and available invitations without hashes or leases', async () => {
    const f = fixture();
    const row = f.invitation();
    f.prisma.guestInvitation.findMany.mockResolvedValue([
      { ...row, revokedAt: new Date() },
      { ...row, expiresAt: new Date(0) },
      { ...row, activeSessionUntil: new Date(Date.now() + 60000) },
      row,
    ]);
    const results = await f.service.listInvitations();
    expect(results.map((result) => result.status)).toEqual([
      'revoked',
      'expired',
      'active',
      'available',
    ]);
    for (const result of results) {
      expect(result).not.toHaveProperty('tokenHash');
      expect(result).not.toHaveProperty('activeSessionId');
    }
  });

  it('replaces a revoked credential while retaining the guest slot and return settings', async () => {
    const f = fixture();
    f.invitation().expiresAt = new Date(0);
    const replacement = await f.service.replaceInvitation(operator, id);
    expect(replacement).toEqual(
      expect.objectContaining({
        slotNumber: 1,
        returnVideo: 'program',
        returnAudioBus: 'master',
        expiresAt: '2026-01-01T13:00:00.000Z',
      }),
    );
    expect(replacement.invitation).not.toBe(invitationToken);
    expect(remove).toHaveBeenCalledWith('alcantara-news', identity);
    expect(f.prisma.guestInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          activeSessionId: null,
          slotNumber: null,
        }),
      }),
    );
  });

  it('updates return controls and sends the resulting route only to its invitation identity', async () => {
    const f = fixture();
    const result = await f.service.updateReturn(operator, id, {
      returnVideo: 'none',
      returnAudioBus: 'monitor',
      sourceGain: 0,
      sourceMuted: false,
      sourceDelayMs: 10,
    });
    expect(result.returnVideo).toBe('none');
    const [room, data, kind, options] = send.mock.calls[0];
    expect(room).toBe('alcantara-news');
    expect(kind).toBe(DataPacket_Kind.RELIABLE);
    expect(options).toEqual({
      destinationIdentities: [identity],
      topic: 'alcantara-director',
    });
    expect(JSON.parse(data.toString())).toEqual(
      expect.objectContaining({
        type: 'return',
        returnVideo: 'none',
        returnAudioBus: 'monitor',
        sourceGain: 0,
        sourceDelayMs: 10,
      }),
    );
  });

  it('does not repeat revocation writes and tolerates already missing participants/rooms', async () => {
    const f = fixture();
    f.invitation().revokedAt = new Date();
    remove.mockRejectedValueOnce(new Error('room not found'));
    await f.service.revokeInvitation(operator, id);
    remove.mockRejectedValueOnce(new Error('participant not found'));
    await f.service.revokeInvitation(operator, id);
    expect(f.prisma.guestInvitation.update).not.toHaveBeenCalled();
    remove.mockRejectedValueOnce('unknown transport failure');
    await expect(f.service.revokeInvitation(operator, id)).rejects.toThrow(
      'Unknown LiveKit error',
    );
  });

  it('requires actual persisted invitations for replacement, routing and revocation', async () => {
    const f = fixture();
    f.prisma.guestInvitation.findUnique.mockResolvedValue(null);
    await expect(
      f.service.replaceInvitation(operator, id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.revokeInvitation(operator, id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.service.updateReturn(operator, id, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('issues real signed five-minute guest credentials and reuses a correctly signed reconnect session', async () => {
    const f = fixture();
    const joined = await f.service.redeemInvitation(invitationToken, undefined);
    const claims = await new TokenVerifier(
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
    ).verify(joined.token);
    expect(claims.sub).toBe(identity);
    expect(claims.video).toEqual(
      expect.objectContaining({
        room: 'alcantara-news',
        canPublish: true,
        canSubscribe: true,
        canPublishSources: ['camera', 'microphone'],
      }),
    );
    expect(claims.exp! - claims.nbf!).toBe(300);
    const next = await f.service.redeemInvitation(
      invitationToken,
      joined.sessionToken,
    );
    expect(next.sessionToken).toBe(joined.sessionToken);
    expect(
      f.prisma.guestInvitation.updateMany.mock.calls[1][0].where.OR[2],
    ).toEqual({ activeSessionId: joined.sessionToken.split('.')[1] });
  });

  it.each([undefined, '', 'only-id', `${id}.secret.extra`, 'unknown.secret'])(
    'rejects malformed or missing invitation credentials: %p',
    async (token) => {
      const f = fixture();
      await expect(
        f.service.redeemInvitation(token, undefined),
      ).rejects.toThrow();
      expect(f.prisma.guestInvitation.updateMany).not.toHaveBeenCalled();
    },
  );

  it('extends a valid signed session with allowlisted bounded telemetry while ignoring private/unbounded keys', async () => {
    const f = fixture();
    const joined = await f.service.redeemInvitation(invitationToken, undefined);
    const heartbeat = await f.service.heartbeat(joined.sessionToken, {
      connectionState: 'connected'.repeat(20),
      cameraEnabled: true,
      microphoneEnabled: false,
      packetLoss: -1,
      jitterMs: 2000000,
      roundTripMs: NaN,
      width: 1280,
      token: 'must-not-persist',
      arbitrary: 'must-not-persist',
    });
    expect(heartbeat.activeSessionUntil).toBe('2026-01-01T12:01:00.000Z');
    expect(f.prisma.guestInvitation.update).toHaveBeenLastCalledWith({
      where: { id },
      data: {
        activeSessionUntil: new Date('2026-01-01T12:01:00Z'),
        events: {
          create: {
            type: 'telemetry',
            details: {
              connectionState: 'connected'.repeat(20).slice(0, 40),
              cameraEnabled: true,
              microphoneEnabled: false,
              packetLoss: 0,
              jitterMs: 1000000,
              width: 1280,
            },
          },
        },
      },
    });
    await f.service.heartbeat(joined.sessionToken, []);
    expect(
      f.prisma.guestInvitation.update.mock.calls[1][0].data,
    ).not.toHaveProperty('events');
    f.prisma.guestInvitation.findFirst.mockResolvedValue(null);
    await expect(f.service.heartbeat(joined.sessionToken, {})).rejects.toThrow(
      'inactive',
    );
  });

  it.each([
    '',
    '.session.signature',
    `${id}.missing`,
    `${id}.session.bad`,
    `${id}.session.signature.extra`,
  ])('rejects malformed or tampered session credentials: %p', async (token) => {
    const f = fixture();
    await expect(f.service.heartbeat(token, {})).rejects.toThrow();
    expect(f.prisma.guestInvitation.update).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'rejected', 'read', 'acknowledged'])(
    'binds command %s acknowledgements to the active invitation',
    async (status) => {
      const f = fixture();
      const session = await f.service.redeemInvitation(
        invitationToken,
        undefined,
      );
      expect(
        await f.service.acknowledgeCommand(
          session.sessionToken,
          'command-1',
          status,
        ),
      ).toEqual({ id: 'command-1', status, acknowledgedAt: new Date() });
      expect(f.prisma.guestCommand.findFirst).toHaveBeenCalledWith({
        where: { id: 'command-1', invitationId: id },
      });
      await expect(
        f.service.acknowledgeCommand(
          session.sessionToken,
          'command-1',
          'unknown',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      f.prisma.guestCommand.findFirst.mockResolvedValue(null);
      await expect(
        f.service.acknowledgeCommand(session.sessionToken, 'missing', status),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('distinguishes connected, reconnecting and offline guests with bounded track projections', async () => {
    const f = fixture();
    const second = '22222222-2222-4222-8222-222222222222';
    f.prisma.guestInvitation.findMany.mockResolvedValue([
      f.invitation(),
      {
        ...f.invitation(),
        id: second,
        activeSessionUntil: new Date(Date.now() + 1000),
      },
      { ...f.invitation(), id: '33333333-3333-4333-8333-333333333333' },
    ]);
    participants.mockResolvedValue([
      {
        identity,
        tracks: [
          {
            sid: 'camera-1',
            source: TrackSource.CAMERA,
            muted: false,
            width: 1280,
            height: 720,
            mimeType: 'video/vp8',
          },
        ],
      },
    ]);
    const result = await f.service.listParticipants(' NEWS ');
    expect(result.roomName).toBe('alcantara-news');
    expect(result.participants.map((guest) => guest.connectionState)).toEqual([
      'connected',
      'reconnecting',
      'offline',
    ]);
    expect(result.participants[0].tracks).toEqual([
      {
        sid: 'camera-1',
        source: 'camera',
        muted: false,
        width: 1280,
        height: 720,
        mimeType: 'video/vp8',
      },
    ]);
    participants.mockRejectedValueOnce(new Error('room does not exist'));
    expect(
      (await f.service.listParticipants('news')).participants[0]
        .connectionState,
    ).toBe('offline');
    participants.mockRejectedValueOnce(new Error('backend unavailable'));
    await expect(f.service.listParticipants('news')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each([
    { type: 'cue', cue: 'standby' },
    { type: 'cue', cue: 'live' },
    { type: 'cue', cue: 'wrap' },
    { type: 'message', text: 'Private cue' },
    { type: 'media', device: 'camera', enabled: true },
    { type: 'talkback', enabled: true },
    { type: 'talkback', enabled: false },
  ])('persists and delivers a valid director command: %p', async (body) => {
    const f = fixture();
    const result = await f.service.controlParticipant('news', identity, body);
    expect(result.status).toBe('delivered');
    expect(f.prisma.guestCommand.create).toHaveBeenCalledWith({
      data: {
        invitationId: id,
        type: body.type,
        payload: { version: 1, ...body },
      },
    });
    const packet = JSON.parse(send.mock.calls[0][1].toString());
    expect(packet).toEqual({
      version: 1,
      ...body,
      id: 'command-1',
      sentAt: new Date().toISOString(),
    });
    expect(mute).not.toHaveBeenCalled();
  });

  it.each(['camera', 'microphone'])(
    'enforces %s mute directly and persists a failed command if no matching track is available',
    async (device) => {
      const f = fixture();
      await f.service.controlParticipant('news', identity, {
        type: 'media',
        device,
        enabled: false,
      });
      expect(mute).toHaveBeenCalledWith(
        'alcantara-news',
        identity,
        `${device}-1`,
        true,
      );
      expect(send).not.toHaveBeenCalled();
      participant.mockResolvedValue({ tracks: [] });
      await expect(
        f.service.controlParticipant('news', identity, {
          type: 'media',
          device,
          enabled: false,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(f.prisma.guestCommand.update).toHaveBeenLastCalledWith({
        where: { id: 'command-1' },
        data: {
          status: 'failed',
          failureReason: `${device} track is unavailable.`,
        },
      });
    },
  );

  it.each([
    { type: 'unsupported' },
    { type: 'media', device: 'screen', enabled: true },
    { type: 'media', device: 'camera', enabled: 'yes' },
    { type: 'cue', cue: 'unknown' },
    { type: 'message', text: '' },
    { type: 'talkback', enabled: 'yes' },
  ])(
    'rejects malformed director commands before persistence: %p',
    async (body) => {
      const f = fixture();
      await expect(
        f.service.controlParticipant('news', identity, body),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.prisma.guestCommand.create).not.toHaveBeenCalled();
    },
  );

  it('bounds private messages and records transport failure without falsely marking delivery', async () => {
    const f = fixture();
    send.mockRejectedValueOnce(new Error('x'.repeat(500)));
    await expect(
      f.service.controlParticipant('news', identity, {
        type: 'message',
        text: 'm'.repeat(700),
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(
      f.prisma.guestCommand.create.mock.calls[0][0].data.payload.text,
    ).toHaveLength(500);
    expect(
      f.prisma.guestCommand.update.mock.calls[0][0].data.failureReason,
    ).toHaveLength(240);
    send.mockRejectedValueOnce('transport failure');
    await expect(
      f.service.controlParticipant('news', identity, {
        type: 'cue',
        cue: 'live',
      }),
    ).rejects.toThrow('Unknown LiveKit error');
    expect(f.prisma.guestCommand.update).toHaveBeenLastCalledWith({
      where: { id: 'command-1' },
      data: { status: 'failed', failureReason: 'LiveKit command failed' },
    });
  });

  it('requires active guest identities and releases a removed session without revoking its reusable slot', async () => {
    const f = fixture();
    await expect(
      f.service.controlParticipant('news', 'renderer-news', {
        type: 'cue',
        cue: 'live',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      await f.service.removeParticipant(operator, 'news', identity),
    ).toEqual({ identity, status: 'removed' });
    expect(remove).toHaveBeenCalledWith('alcantara-news', identity);
    expect(f.prisma.guestInvitation.update).toHaveBeenCalledWith({
      where: { id },
      data: expect.objectContaining({
        activeSessionId: null,
        activeSessionUntil: null,
        events: {
          create: {
            type: 'removed',
            details: {
              operatorIdentity: operator.subject,
              operatorPrincipalId: operator.principalId,
            },
          },
        },
      }),
    });
    expect(
      f.prisma.guestInvitation.update.mock.calls[0][0].data,
    ).not.toHaveProperty('revokedAt');
    f.prisma.guestInvitation.findFirst.mockResolvedValue(null);
    await expect(
      f.service.controlParticipant('news', identity, {
        type: 'cue',
        cue: 'live',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('issues independently verifiable narrow renderer-source and operator credentials', async () => {
    const f = fixture();
    const verifier = new TokenVerifier(
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
    );
    const source = await f.service.createRendererSourceToken(
      config.WEBRTC_RENDERER_KEY,
      'news',
    );
    const sourceClaims = await verifier.verify(source.token);
    expect(sourceClaims.sub).toMatch(/^renderer-source-news-/);
    expect(sourceClaims.video).toEqual(
      expect.objectContaining({
        room: 'alcantara-news',
        canPublish: false,
        canSubscribe: true,
        canPublishData: false,
        hidden: true,
      }),
    );
    const renderer = await f.service.createRendererToken(
      config.WEBRTC_RENDERER_KEY,
      'news',
    );
    expect((await verifier.verify(renderer.token)).video).toEqual(
      expect.objectContaining({
        canPublish: true,
        canSubscribe: true,
        hidden: false,
      }),
    );
    const operatorToken = await f.service.createOperatorToken(operator, 'news');
    expect((await verifier.verify(operatorToken.token)).video).toEqual(
      expect.objectContaining({
        room: 'alcantara-news',
        canPublishSources: ['microphone'],
        hidden: true,
      }),
    );
    expect(
      (
        await f.service.createOperatorToken(
          { subject: 'pool-only', principalId: null },
          'news',
        )
      ).roomName,
    ).toBe('alcantara-news');
    await expect(
      f.service.createRendererSourceToken('wrong', 'news'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      fixture({ WEBRTC_RENDERER_KEY: undefined }).service.getRendererState(
        undefined,
        'news',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns only active renderer routes and no invitation secrets', async () => {
    const f = fixture();
    f.prisma.guestInvitation.findMany.mockResolvedValue([f.invitation()]);
    expect(
      await f.service.getRendererState(config.WEBRTC_RENDERER_KEY, 'news'),
    ).toEqual({
      programId: 'news',
      routes: [
        {
          participantIdentity: identity,
          slotNumber: 1,
          returnVideo: 'program',
          returnAudioBus: 'master',
          sourceGain: 1,
          sourceMuted: false,
          sourceDelayMs: 0,
        },
      ],
    });
    expect(f.prisma.guestInvitation.findMany).toHaveBeenCalledWith({
      where: {
        programId: 'news',
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { slotNumber: 'asc' },
    });
  });
});
