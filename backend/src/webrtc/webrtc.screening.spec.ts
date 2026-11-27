import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { WebrtcController } from './webrtc.controller';
import { REJOIN_WINDOW_MS, WebrtcService } from './webrtc.service';

// Screening before air: a guest waits in a room of their own until the operator admits or declines them.

const id = '11111111-1111-4111-8111-111111111111';
const token = `${id}.fictional-invitation-secret`;
const screening = `alcantara-screening-${id}`;
const operator = { subject: 'operator-1', principalId: 'principal-1' };
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as {
    video: Record<string, unknown>;
    sub: string;
  };

function setup(overrides: Record<string, unknown> = {}) {
  const invitation = {
    id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    programId: 'main',
    displayName: 'Fictional Guest',
    slotNumber: 1,
    returnVideo: 'none',
    returnAudioBus: 'master',
    sourceGain: 1,
    sourceMuted: false,
    sourceDelayMs: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    admittedAt: null as Date | null,
    activeSessionId: null,
    activeSessionUntil: null as Date | null,
    commands: [],
    events: [],
    _count: { events: 0 },
    ...overrides,
  };
  const prisma = {
    guestInvitation: {
      findUnique: jest.fn().mockResolvedValue(invitation),
      findFirst: jest.fn().mockResolvedValue(invitation),
      findMany: jest.fn().mockResolvedValue([invitation]),
      update: jest.fn().mockResolvedValue(invitation),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    guestEvent: { create: jest.fn() },
  };
  const listRooms = jest
    .spyOn(RoomServiceClient.prototype, 'listRooms')
    .mockResolvedValue([]);
  const createRoom = jest
    .spyOn(RoomServiceClient.prototype, 'createRoom')
    .mockResolvedValue({} as never);
  const remove = jest
    .spyOn(RoomServiceClient.prototype, 'removeParticipant')
    .mockResolvedValue();
  jest
    .spyOn(RoomServiceClient.prototype, 'listParticipants')
    .mockResolvedValue([]);
  const service = new WebrtcService(
    new ConfigService({
      LIVEKIT_WS_URL: 'wss://livekit.example',
      LIVEKIT_API_KEY: 'fictional-key',
      LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
      WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
    }),
    prisma as never,
    new ManagedMetricsService(),
  );
  return { service, prisma, invitation, listRooms, createRoom, remove };
}

describe('screening before air', () => {
  afterEach(() => jest.restoreAllMocks());

  it('gives a joining guest only a room of their own, where they can hear the producer', async () => {
    const { service, createRoom } = setup();
    const joined = await service.redeemInvitation(token, undefined);
    expect(joined).toMatchObject({
      admission: 'waiting',
      roomName: screening,
    });
    expect(claims(joined.token).video).toMatchObject({
      room: screening,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: screening }),
    );
    await expect(
      service.heartbeat(joined.sessionToken, undefined),
    ).resolves.toMatchObject({ admission: 'waiting' });
  });

  it('gives an admitted guest the program room when their own session reconnects', async () => {
    // The first claim, for the session already holding the invitation, matches.
    const { service, createRoom } = setup({ admittedAt: new Date() });
    const joined = await service.redeemInvitation(token, undefined);
    expect(joined).toMatchObject({
      admission: 'admitted',
      roomName: 'alcantara-main',
    });
    expect(createRoom).not.toHaveBeenCalled();
    await expect(
      service.heartbeat(joined.sessionToken, undefined),
    ).resolves.toMatchObject({ admission: 'admitted' });
  });

  it('screens each new session again: another session starts waiting and the admission is cleared as it claims', async () => {
    const { service, prisma } = setup({ admittedAt: new Date() });
    // Not the session that holds the invitation; the lease is free or lapsed, so a new session claims it.
    prisma.guestInvitation.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const joined = await service.redeemInvitation(token, undefined);
    expect(joined).toMatchObject({ admission: 'waiting', roomName: screening });
    expect(claims(joined.token).video.room).toBe(screening);
    const [sameSession, returned, newSession] =
      prisma.guestInvitation.updateMany.mock.calls.map(([call]) => call);
    expect(sameSession.data).not.toHaveProperty('admittedAt');
    expect(returned.data).not.toHaveProperty('admittedAt');
    expect(newSession.where.OR).toEqual([
      { activeSessionId: null },
      { activeSessionUntil: { lt: expect.any(Date) } },
    ]);
    expect(newSession.data).toMatchObject({
      admittedAt: null,
      cue: 'standby',
      cueSessionId: null,
    });
  });

  // alcantara#875: the server, not the page, decides who skips the waiting room. These drive the join against an
  // invitation row that applies each update's conditions, at chosen times after the guest was last heard.
  describe('coming back without being admitted again', () => {
    const away = async (
      afterLeaseMs: number,
      presentSession = true,
      cue = 'live',
    ) => {
      const fixture = setup();
      const { service, prisma, invitation } = fixture;
      const row = invitation as unknown as Record<string, unknown>;
      prisma.guestInvitation.updateMany.mockImplementation(
        async ({ where, data }: any) => {
          const until = row.activeSessionUntil as Date | null;
          const matches = (condition: any) =>
            (!('activeSessionId' in condition) ||
              condition.activeSessionId === row.activeSessionId) &&
            (!condition.activeSessionUntil?.gte ||
              (until !== null && until >= condition.activeSessionUntil.gte)) &&
            (!condition.activeSessionUntil?.lt ||
              (until !== null && until < condition.activeSessionUntil.lt));
          if (!matches(where) || (where.OR && !where.OR.some(matches)))
            return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      );
      const first = await service.redeemInvitation(token, undefined);
      // The producer admits and cues them live; then the phone goes to sleep.
      row.admittedAt = new Date();
      row.cue = cue;
      row.cueSessionId = row.activeSessionId;
      row.activeSessionUntil = new Date(Date.now() - afterLeaseMs);
      const back = await service.redeemInvitation(
        token,
        presentSession ? first.sessionToken : undefined,
      );
      return { back, row, ...fixture, sessionToken: first.sessionToken };
    };
    // What the desk's cue line is given for the row as the join left it.
    const deskCue = async (service: WebrtcService) => {
      jest
        .spyOn(RoomServiceClient.prototype, 'listParticipants')
        .mockResolvedValue([]);
      return (await service.listParticipants('main')).participants[0].cueState;
    };

    it('tells the desk a cued guest rejoined, and keeps saying so until the next cue', async () => {
      for (const lapsed of [
        REJOIN_WINDOW_MS - 10_000,
        REJOIN_WINDOW_MS + 10_000,
      ]) {
        const { service, row, sessionToken } = await away(lapsed);
        await expect(deskCue(service)).resolves.toBe('rejoined');
        row.activeSessionUntil = new Date(Date.now() - 10_000);
        await service.redeemInvitation(token, sessionToken);
        await expect(deskCue(service)).resolves.toBe('rejoined');
      }
    });

    it.each(['standby', 'wrap'])(
      'keeps showing %s after a rejoin, on both ways back',
      async (cue) => {
        for (const lapsed of [
          REJOIN_WINDOW_MS - 10_000,
          REJOIN_WINDOW_MS + 10_000,
        ]) {
          const { service, row } = await away(lapsed, true, cue);
          expect(row.cue).toBe(cue);
          await expect(deskCue(service)).resolves.toBe(cue);
        }
      },
    );

    it('says nothing of a rejoin to the desk while the cue still holds', async () => {
      const { service } = await away(-30_000);
      await expect(deskCue(service)).resolves.not.toBe('rejoined');
    });

    it('keeps admission and the cue for a session whose lease is still live', async () => {
      const { back, row } = await away(-30_000);
      expect(back.admission).toBe('admitted');
      expect(row.cue).toBe('live');
    });

    it('keeps admission within five minutes of the lease running out, off air until cued again', async () => {
      const { back, row } = await away(REJOIN_WINDOW_MS - 10_000);
      expect(back).toMatchObject({
        admission: 'admitted',
        roomName: 'alcantara-main',
      });
      expect(row).toMatchObject({ cue: 'rejoined', cueSessionId: null });
    });

    it('screens the same session again once the window has passed', async () => {
      const { back, row } = await away(REJOIN_WINDOW_MS + 10_000);
      expect(back).toMatchObject({ admission: 'waiting', roomName: screening });
      expect(row).toMatchObject({
        admittedAt: null,
        cue: 'rejoined',
        cueSessionId: null,
      });
    });

    it('screens a browser that presents no session, however recently the lease ran out', async () => {
      const { back } = await away(1_000, false);
      expect(back.admission).toBe('waiting');
    });
  });

  it('keeps an existing screening room and says when LiveKit cannot make one', async () => {
    const { service, listRooms, createRoom } = setup();
    listRooms.mockResolvedValueOnce([{} as never]);
    await service.redeemInvitation(token, undefined);
    expect(createRoom).not.toHaveBeenCalled();
    listRooms.mockRejectedValueOnce(new Error('down'));
    await expect(service.redeemInvitation(token, undefined)).rejects.toThrow(
      'WebRTC control plane unavailable',
    );
  });

  it('admits: records it and ends the screening connection so the page moves at once', async () => {
    const { service, prisma, remove } = setup();
    await expect(service.admitGuest(operator, id)).resolves.toEqual({
      id,
      status: 'admitted',
    });
    expect(prisma.guestInvitation.update.mock.lastCall![0].data).toMatchObject({
      admittedAt: expect.any(Date) as Date,
      events: { create: { type: 'admitted' } },
    });
    expect(remove).toHaveBeenCalledWith(screening, `guest-${id}`);
  });

  it('does not admit a closed invitation', async () => {
    for (const closed of [
      { revokedAt: new Date() },
      { expiresAt: new Date(0) },
    ]) {
      const { service, prisma } = setup(closed);
      await expect(service.admitGuest(operator, id)).rejects.toThrow(
        'This invitation is closed.',
      );
      expect(prisma.guestInvitation.update).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    }
  });

  it('declines: closes the invitation, frees its slot and removes the guest', async () => {
    const { service, prisma, remove, invitation } = setup();
    await expect(service.declineGuest(operator, id)).resolves.toEqual({
      id,
      status: 'declined',
    });
    expect(prisma.guestInvitation.update.mock.lastCall![0].data).toMatchObject({
      revokedAt: expect.any(Date) as Date,
      slotNumber: null,
      admittedAt: null,
      activeSessionId: null,
      activeSessionUntil: null,
      events: { create: { type: 'declined' } },
    });
    expect(remove).toHaveBeenCalledWith(screening, `guest-${id}`);
    expect(remove).toHaveBeenCalledWith('alcantara-main', `guest-${id}`);
    Object.assign(invitation, { revokedAt: new Date() });
    await expect(service.redeemInvitation(token, undefined)).rejects.toThrow(
      'This invitation was revoked.',
    );
  });

  it('gives the operator an off-air token for one waiting guest, visible so the guest can hear it', async () => {
    const { service } = setup();
    const credentials = await service.createScreeningToken(operator, id);
    expect(credentials).toMatchObject({
      roomName: screening,
      participantIdentity: `guest-${id}`,
    });
    expect(claims(credentials.token).video).toMatchObject({
      room: screening,
      hidden: false,
      canSubscribe: true,
      canPublishData: false,
    });
    await expect(
      service.createScreeningToken({ subject: 's', principalId: null }, id),
    ).resolves.toMatchObject({ roomName: screening });
  });

  it('marks who is waiting on the participants list', async () => {
    const { service, invitation } = setup();
    const row = async () =>
      (await service.listParticipants('main')).participants[0];
    expect(await row()).toMatchObject({ screening: false });
    invitation.activeSessionUntil = new Date(Date.now() + 60_000);
    expect(await row()).toMatchObject({ screening: true });
    invitation.admittedAt = new Date();
    expect(await row()).toMatchObject({ screening: false });
  });

  it('routes admit, decline and the screening token', () => {
    const webrtc = {
      admitGuest: jest.fn(),
      declineGuest: jest.fn(),
      createScreeningToken: jest.fn(),
    };
    const controller = new WebrtcController(webrtc as never);
    const request = { user: { sub: 'operator-1', principalId: null } };
    void controller.admitGuest(request, id);
    void controller.declineGuest(request, id);
    void controller.screeningToken(request, id);
    const identity = { subject: 'operator-1', principalId: null };
    expect(webrtc.admitGuest).toHaveBeenCalledWith(identity, id);
    expect(webrtc.declineGuest).toHaveBeenCalledWith(identity, id);
    expect(webrtc.createScreeningToken).toHaveBeenCalledWith(identity, id);
  });
});
