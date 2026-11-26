import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { WebrtcController } from './webrtc.controller';
import { WebrtcService } from './webrtc.service';

const id = '11111111-1111-4111-8111-111111111111';
const token = `${id}.fictional-invitation-secret`;

function setup() {
  const invitation = {
    id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    programId: 'main',
    displayName: 'Fictional Guest',
    slotNumber: 1,
    returnVideo: 'program',
    returnAudioBus: 'master',
    sourceGain: 1,
    sourceMuted: false,
    sourceDelayMs: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null as Date | null,
    activeSessionId: null,
    activeSessionUntil: null,
    commands: [],
    events: [] as Array<{ type: string; details: unknown }>,
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
  const count = async (name: string, labels: string) => {
    const line = (await metrics.render(''))
      .split('\n')
      .find((entry) => entry.startsWith(`${name}{${labels}}`));
    return line === undefined ? undefined : Number(line.split(' ').pop());
  };
  const joins = (client: string, result: string) =>
    count(
      'alcantara_webrtc_joins_total',
      `client="${client}",result="${result}"`,
    );
  const paths = (client: string, path: string) =>
    count(
      'alcantara_webrtc_ice_path_total',
      `client="${client}",path="${path}"`,
    );
  return { service, prisma, invitation, joins, paths, metrics };
}

describe('guest call reports', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exposes every client, result and path from 0', async () => {
    const { joins, paths } = setup();
    for (const client of ['guest', 'operator']) {
      for (const result of [
        'success',
        'permission_denied',
        'no_device',
        'ice_failed',
        'token_rejected',
        'invite_expired',
        'other',
      ])
        expect(await joins(client, result)).toBe(0);
      for (const path of ['udp', 'tcp', 'relay'])
        expect(await paths(client, path)).toBe(0);
    }
  });

  it('counts a join and its path once, from the heartbeat that says it joined', async () => {
    const { service, joins, paths } = setup();
    const { sessionToken } = await service.redeemInvitation(token, undefined);
    await service.heartbeat(sessionToken, {
      joined: true,
      iceTransport: 'relay',
    });
    await service.heartbeat(sessionToken, { iceTransport: 'relay' });
    await service.heartbeat(sessionToken, undefined);
    expect(await joins('guest', 'success')).toBe(1);
    expect(await paths('guest', 'relay')).toBe(1);
    await service.heartbeat(sessionToken, {
      joined: true,
      iceTransport: 'carrier-pigeon',
    });
    expect(await joins('guest', 'success')).toBe(2);
    expect(await paths('guest', 'relay')).toBe(1);
  });

  it('counts a dropped call from the heartbeat that reports it', async () => {
    const { service, metrics } = setup();
    const drops = async () =>
      /^alcantara_webrtc_drops_total (\d+)/m.exec(
        await metrics.render(''),
      )?.[1];
    expect(await drops()).toBe('0');
    const { sessionToken } = await service.redeemInvitation(token, undefined);
    await service.heartbeat(sessionToken, { dropped: true });
    await service.heartbeat(sessionToken, { dropped: 'yes' });
    expect(await drops()).toBe('1');
  });

  it('stores and counts a failure the guest browser reports', async () => {
    const { service, prisma, joins } = setup();
    await expect(
      service.reportJoinFailure(token, 'permission_denied'),
    ).resolves.toEqual({ recorded: true });
    expect(prisma.guestEvent.create).toHaveBeenCalledWith({
      data: {
        invitationId: id,
        type: 'join_failed',
        details: { reason: 'permission_denied' },
      },
    });
    expect(await joins('guest', 'permission_denied')).toBe(1);
  });

  it('takes a failure only with the invitation, a known reason and an open invitation', async () => {
    const { service, prisma, invitation, joins } = setup();
    await expect(
      service.reportJoinFailure(`${token}x`, 'no_device'),
    ).rejects.toThrow('Invalid guest invitation.');
    // The API counts these two itself: a browser cannot claim them.
    for (const reason of ['success', 'invite_expired', 7])
      await expect(service.reportJoinFailure(token, reason)).rejects.toThrow(
        'Unknown failure reason.',
      );
    invitation.expiresAt = new Date(0);
    await expect(service.reportJoinFailure(token, 'no_device')).rejects.toThrow(
      'This invitation expired.',
    );
    expect(prisma.guestEvent.create).not.toHaveBeenCalled();
    expect(await joins('guest', 'no_device')).toBe(0);
  });

  it('counts the joins the API refuses', async () => {
    const { service, prisma, invitation, joins } = setup();
    await expect(
      service.redeemInvitation(`${token}x`, undefined),
    ).rejects.toThrow('Invalid guest invitation.');
    invitation.revokedAt = new Date();
    await expect(service.redeemInvitation(token, undefined)).rejects.toThrow(
      'This invitation was revoked.',
    );
    invitation.revokedAt = null;
    prisma.guestInvitation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.redeemInvitation(token, undefined)).rejects.toThrow(
      'already active',
    );
    invitation.expiresAt = new Date(0);
    await expect(service.redeemInvitation(token, undefined)).rejects.toThrow(
      'This invitation expired.',
    );
    expect(await joins('guest', 'token_rejected')).toBe(2);
    expect(await joins('guest', 'other')).toBe(1);
    expect(await joins('guest', 'invite_expired')).toBe(1);
    // A database failure says nothing about the token.
    prisma.guestInvitation.findUnique.mockRejectedValueOnce(new Error('down'));
    await expect(service.redeemInvitation(token, undefined)).rejects.toThrow(
      'down',
    );
    expect(await joins('guest', 'token_rejected')).toBe(2);
  });

  it('counts the operator talkback, with a path only when it connected', async () => {
    const { service, joins, paths } = setup();
    expect(service.reportOperatorCall('success', 'tcp')).toEqual({
      recorded: true,
    });
    service.reportOperatorCall('success', null);
    service.reportOperatorCall('ice_failed', 'udp');
    expect(() => service.reportOperatorCall('great', 'udp')).toThrow(
      'Unknown call result.',
    );
    expect(await joins('operator', 'success')).toBe(2);
    expect(await joins('operator', 'ice_failed')).toBe(1);
    expect(await paths('operator', 'tcp')).toBe(1);
    expect(await paths('operator', 'udp')).toBe(0);
  });

  it('shows each guest the latest report: its path, or why it could not join', async () => {
    const { service, invitation } = setup();
    jest
      .spyOn(RoomServiceClient.prototype, 'listParticipants')
      .mockResolvedValue([]);
    const row = async () =>
      (await service.listParticipants('main')).participants[0];
    expect(await row()).toMatchObject({ icePath: null, joinFailure: null });
    invitation.events = [
      { type: 'telemetry', details: { iceTransport: 'udp' } },
    ];
    expect(await row()).toMatchObject({ icePath: 'udp', joinFailure: null });
    invitation.events = [{ type: 'telemetry', details: null }];
    expect(await row()).toMatchObject({ icePath: null, joinFailure: null });
    invitation.events = [
      { type: 'join_failed', details: { reason: 'no_device' } },
    ];
    expect(await row()).toMatchObject({
      icePath: null,
      joinFailure: 'no_device',
    });
    invitation.events = [{ type: 'join_failed', details: {} }];
    expect(await row()).toMatchObject({ joinFailure: 'other' });
  });

  it('routes the two report requests', () => {
    const webrtc = {
      reportJoinFailure: jest.fn(),
      reportOperatorCall: jest.fn(),
    };
    const controller = new WebrtcController(webrtc as never);
    void controller.joinFailure({ invitation: token, reason: 'other' });
    void controller.operatorReport({ result: 'success', icePath: 'udp' });
    expect(webrtc.reportJoinFailure).toHaveBeenCalledWith(token, 'other');
    expect(webrtc.reportOperatorCall).toHaveBeenCalledWith('success', 'udp');
  });
});
