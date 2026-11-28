import { isolateEnv } from '../../test/env-isolation';
const restoreEnv = isolateEnv();
afterAll(restoreEnv);
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { WebrtcService } from './webrtc.service';

// A program room holds only guests with an open, admitted session. LiveKit keeps honouring a token a guest already
// holds, so the sweep removes anyone else it finds there.

const ids = {
  admitted: '11111111-1111-4111-8111-111111111111',
  revoked: '22222222-2222-4222-8222-222222222222',
  notAdmitted: '33333333-3333-4333-8333-333333333333',
  noSession: '44444444-4444-4444-8444-444444444444',
  expired: '55555555-5555-4555-8555-555555555555',
  otherProgram: '66666666-6666-4666-8666-666666666666',
  unknown: '77777777-7777-4777-8777-777777777777',
  lapsedLease: '88888888-8888-4888-8888-888888888888',
};
const later = () => new Date(Date.now() + 3_600_000);
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  programId: 'main',
  revokedAt: null as Date | null,
  expiresAt: later(),
  admittedAt: new Date() as Date | null,
  activeSessionId: 'session' as string | null,
  ...overrides,
});

function setup(rows: ReturnType<typeof row>[], present: string[]) {
  const prisma = {
    guestInvitation: {
      findMany: jest
        .fn()
        // The programs to look at, then the guests found in each room.
        .mockResolvedValueOnce([{ programId: 'main' }])
        .mockResolvedValueOnce(rows),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const listParticipants = jest
    .spyOn(RoomServiceClient.prototype, 'listParticipants')
    .mockResolvedValue(present.map((identity) => ({ identity })) as never);
  const remove = jest
    .spyOn(RoomServiceClient.prototype, 'removeParticipant')
    .mockResolvedValue();
  const metrics = new ManagedMetricsService();
  const service = new WebrtcService(
    new ConfigService({
      LIVEKIT_WS_URL: 'wss://livekit.example',
      LIVEKIT_API_KEY: 'fictional-key',
      LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
      WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
    }),
    prisma as never,
    metrics,
  );
  return { service, prisma, listParticipants, remove, metrics };
}

describe('program room admission', () => {
  afterEach(() => jest.restoreAllMocks());

  it('removes every guest without an open, admitted session, and keeps the admitted one and every non-guest', async () => {
    const guests = Object.values(ids).map((id) => `guest-${id}`);
    const { service, remove, listParticipants, metrics } = setup(
      [
        row(ids.admitted),
        row(ids.revoked, { revokedAt: new Date() }),
        row(ids.notAdmitted, { admittedAt: null }),
        row(ids.noSession, { activeSessionId: null }),
        row(ids.expired, { expiresAt: new Date(0) }),
        row(ids.otherProgram, { programId: 'other' }),
        // A lapsed lease is not a reason: heartbeats stop during a backend restart while the call is fine.
        row(ids.lapsedLease),
      ],
      [
        ...guests,
        'operator-abc',
        'renderer-main-1',
        'desktop-program-feed-main',
      ],
    );
    await service.enforceProgramRoomAdmission();
    expect(listParticipants).toHaveBeenCalledWith('alcantara-main');
    expect(remove.mock.calls.map(([, identity]) => identity).sort()).toEqual(
      [
        ids.revoked,
        ids.notAdmitted,
        ids.noSession,
        ids.expired,
        ids.otherProgram,
        ids.unknown,
      ]
        .map((id) => `guest-${id}`)
        .sort(),
    );
    expect(remove.mock.calls.every(([room]) => room === 'alcantara-main')).toBe(
      true,
    );
    expect(await metrics.render('')).toContain(
      'alcantara_webrtc_room_admission_removals_total 6',
    );
  });

  it('keeps checking the other guests when LiveKit refuses one removal, and counts only the removals that worked', async () => {
    const { service, remove, metrics } = setup(
      [
        row(ids.revoked, { revokedAt: new Date() }),
        row(ids.notAdmitted, { admittedAt: null }),
      ],
      [`guest-${ids.revoked}`, `guest-${ids.notAdmitted}`],
    );
    remove.mockRejectedValueOnce(new Error('livekit unavailable'));
    await service.enforceProgramRoomAdmission();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await metrics.render('')).toContain(
      'alcantara_webrtc_room_admission_removals_total 1',
    );
  });

  it('skips a room LiveKit cannot list, and an empty one, without looking guests up', async () => {
    const empty = setup([], []);
    await empty.service.enforceProgramRoomAdmission();
    expect(empty.prisma.guestInvitation.findMany).toHaveBeenCalledTimes(1);
    expect(empty.remove).not.toHaveBeenCalled();

    const away = setup([], [`guest-${ids.revoked}`]);
    away.listParticipants.mockRejectedValueOnce(new Error('room not found'));
    await away.service.enforceProgramRoomAdmission();
    expect(away.prisma.guestInvitation.findMany).toHaveBeenCalledTimes(1);
    expect(away.remove).not.toHaveBeenCalled();
  });
});

describe('program room admission without LiveKit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('looks at nothing and removes nobody', async () => {
    const prisma = { guestInvitation: { findMany: jest.fn() } };
    const list = jest.spyOn(RoomServiceClient.prototype, 'listParticipants');
    const service = new WebrtcService(
      new ConfigService({}),
      prisma as never,
      new ManagedMetricsService(),
    );
    await expect(
      service.enforceProgramRoomAdmission(),
    ).resolves.toBeUndefined();
    expect(prisma.guestInvitation.findMany).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
