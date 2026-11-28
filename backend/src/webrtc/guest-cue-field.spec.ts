import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { WebrtcService } from './webrtc.service';


// gaulatti/alcantara#875: the guest's own cue state, on the join and heartbeat responses. It is read from the invitation
// the server resolved from the guest's verified token, for that session only, and nothing else about the guest is sent.

const INVITATION = '11111111-1111-4111-8111-111111111111';
const SESSION = 'session-one';
const ADMITTED = new Date('2026-11-27T10:00:00Z');

function config() {
  return new ConfigService({
    LIVEKIT_WS_URL: 'wss://livekit.example',
    LIVEKIT_API_KEY: 'fictional-key',
    LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
    WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
    RENDERER_KEY: 'fictional-renderer-key',
    ALCANTARA_RENDERER_KEY: 'fictional-renderer-key',
  });
}

function row(overrides: Record<string, unknown>) {
  return {
    id: INVITATION,
    programId: 'main',
    displayName: 'Fictional Guest',
    slotNumber: 1,
    admittedAt: ADMITTED,
    activeSessionId: SESSION,
    activeSessionUntil: new Date(Date.now() + 60_000),
    cue: 'live',
    cueSessionId: SESSION,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    returnVideo: 'program',
    returnAudioBus: 'master',
    sourceGain: 1,
    sourceMuted: false,
    sourceDelayMs: 0,
    liveSince: null,
    ...overrides,
  };
}

function serviceWith(invitation: ReturnType<typeof row>) {
  const prisma = {
    guestInvitation: {
      findFirst: jest.fn(async () => invitation),
      update: jest.fn(async () => invitation),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    guestEvent: { create: jest.fn(async () => ({})) },
  };
  const service = new WebrtcService(config(), prisma as never, new ManagedMetricsService());
  return { service, prisma };
}

describe('the guest heartbeat carries the guest own cue state', () => {
  it('says live for the session the cue was given to, and only the cue field is added', async () => {
    const { service } = serviceWith(row({}));
    const token = service['signSessionToken'](INVITATION, SESSION);
    const answer = await service.heartbeat(token, null);
    expect(answer.cue).toBe('live');
    expect(Object.keys(answer).sort()).toEqual(['activeSessionUntil', 'admission', 'cue']);
  });

  it.each([
    ['a cue given to an earlier session', { cueSessionId: 'session-zero' }],
    ['a cue that is standby', { cue: 'standby' }],
    ['a rejoined guest', { cue: 'rejoined', cueSessionId: null }],
    ['a wrap', { cue: 'wrap' }],
    ['a guest not yet admitted', { admittedAt: null }],
  ])('is not live for %s', async (_name, overrides) => {
    const { service } = serviceWith(row(overrides));
    const answer = await service.heartbeat(service['signSessionToken'](INVITATION, SESSION), null);
    expect(answer.cue).not.toBe('live');
  });

  it('agrees with the on-air list for the same stored row', async () => {
    const stored = row({});
    const prisma = {
      guestInvitation: {
        findFirst: jest.fn(async () => stored),
        // The on-air list's query: the row qualifies only when its cue is live for the session it is in.
        findMany: jest.fn(async () => [stored]),
        update: jest.fn(async () => stored),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      guestEvent: { create: jest.fn(async () => ({})) },
    };
    const service = new WebrtcService(config(), prisma as never, new ManagedMetricsService());
    jest.spyOn(service, 'authorizeFor').mockImplementation(async (_endpoint, _key, programId) => String(programId));
    const list = await service.onAirGuests(undefined, 'main');
    const answer = await service.heartbeat(service['signSessionToken'](INVITATION, SESSION), null);
    expect(list.guests).toHaveLength(1);
    expect(answer.cue).toBe('live');
  });
});

describe('a rejoin after a lapse answers standby', () => {
  afterEach(() => jest.restoreAllMocks());

  it('gives standby in the join response when the claim returned the guest to standby', async () => {
    jest.spyOn(RoomServiceClient.prototype, 'createRoom').mockResolvedValue({} as never);
    jest.spyOn(RoomServiceClient.prototype, 'listParticipants').mockResolvedValue([]);
    const invitation = row({ cue: 'live', cueSessionId: null, activeSessionId: null, activeSessionUntil: null });
    const { service, prisma } = serviceWith(invitation);
    jest.spyOn(service as never, 'verifyInvitationToken' as never).mockResolvedValue(invitation as never);
    jest.spyOn(service as never, 'ensureScreeningRoom' as never).mockResolvedValue(undefined as never);
    // The claim finds no reconnect, then a lapsed return that clears the cue.
    prisma.guestInvitation.updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });
    const join = await service.redeemInvitation('fictional-invitation-token', service['signSessionToken'](INVITATION, SESSION));
    expect(join).toMatchObject({ cue: 'standby' });
  });

  it('stays live in the join response when a reconnect keeps the cue for this session', async () => {
    jest.spyOn(RoomServiceClient.prototype, 'createRoom').mockResolvedValue({} as never);
    jest.spyOn(RoomServiceClient.prototype, 'listParticipants').mockResolvedValue([]);
    const invitation = row({});
    const { service, prisma } = serviceWith(invitation);
    jest.spyOn(service as never, 'verifyInvitationToken' as never).mockResolvedValue(invitation as never);
    jest.spyOn(service as never, 'ensureScreeningRoom' as never).mockResolvedValue(undefined as never);
    prisma.guestInvitation.updateMany = jest.fn().mockResolvedValueOnce({ count: 1 });
    const join = await service.redeemInvitation('fictional-invitation-token', service['signSessionToken'](INVITATION, SESSION));
    expect(join).toMatchObject({ cue: 'live' });
  });

  it('the next heartbeat after a lapse return is standby too', async () => {
    jest.spyOn(RoomServiceClient.prototype, 'createRoom').mockResolvedValue({} as never);
    jest.spyOn(RoomServiceClient.prototype, 'listParticipants').mockResolvedValue([]);
    // A stored row the claim can change: the lapsed guest was live for this session before the lapse.
    const store = row({ cue: 'live', cueSessionId: SESSION, activeSessionId: null, activeSessionUntil: null });
    const prisma = {
      guestInvitation: {
        findFirst: jest.fn(async () => store),
        findUnique: jest.fn(async () => store),
        update: jest.fn(async () => store),
        // The returned path: the claim clears the cue to standby with no session on it.
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockImplementation(async () => {
            Object.assign(store, { cue: 'standby', cueSessionId: null });
            return { count: 1 };
          }),
      },
      guestEvent: { create: jest.fn(async () => ({})) },
    };
    const service = new WebrtcService(config(), prisma as never, new ManagedMetricsService());
    jest.spyOn(service as never, 'verifyInvitationToken' as never).mockResolvedValue(store as never);
    jest.spyOn(service as never, 'ensureScreeningRoom' as never).mockResolvedValue(undefined as never);
    const join = await service.redeemInvitation('fictional-invitation-token', service['signSessionToken'](INVITATION, SESSION));
    expect(join).toMatchObject({ cue: 'standby' });
    // The next heartbeat reads the stored row the claim left: still standby.
    store.activeSessionId = SESSION;
    const beat = await service.heartbeat(service['signSessionToken'](INVITATION, SESSION), null);
    expect(beat.cue).toBe('standby');
  });

  it('a guest never sees another guest cue: each token reads only its own invitation', async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const rowA = row({ cue: 'live', cueSessionId: 'session-a', activeSessionId: 'session-a' });
    const rowB = row({ id: OTHER, slotNumber: 2, cue: 'standby', cueSessionId: null, activeSessionId: 'session-b' });
    const prisma = {
      guestInvitation: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; activeSessionId: string } }) =>
          [rowA, rowB].find((candidate) => candidate.id === where.id && candidate.activeSessionId === where.activeSessionId) ?? null,
        ),
        update: jest.fn(async () => rowA),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      guestEvent: { create: jest.fn(async () => ({})) },
    };
    const service = new WebrtcService(config(), prisma as never, new ManagedMetricsService());
    const a = await service.heartbeat(service['signSessionToken'](INVITATION, 'session-a'), null);
    const b = await service.heartbeat(service['signSessionToken'](OTHER, 'session-b'), null);
    expect(a.cue).toBe('live');
    expect(b.cue).toBe('standby');
    // A token for B's invitation with A's session is refused: B's row is not A's.
    await expect(service.heartbeat(service['signSessionToken'](OTHER, 'session-a'), null)).rejects.toThrow();
  });
});
