/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { WebrtcService } from './webrtc.service';

jest.mock('livekit-server-sdk', () => {
  const actual = jest.requireActual('livekit-server-sdk');
  return { ...actual, RoomServiceClient: jest.fn() };
});

// Who is on air: the operator's cue, stored for the guest's session, decides which guests the on-air
// contribution worker mixes into the station. Taking a guest off air never waits on the guest's page.

const KEY = 'fictional-renderer-key';
const config = {
  LIVEKIT_WS_URL: 'wss://livekit.example.test',
  LIVEKIT_API_URL: 'http://api.example.test:7880',
  LIVEKIT_API_KEY: 'fictional-key',
  LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
  WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
  WEBRTC_RENDERER_KEY: KEY,
};
const ANNA = '11111111-1111-4111-8111-111111111111';
const CY = '22222222-2222-4222-8222-222222222222';
const DEE = '33333333-3333-4333-8333-333333333333';

function setup() {
  const invitation = {
    id: ANNA,
    programId: 'modoitaliano.fm',
    activeSessionId: 'session-a',
    displayName: 'Fictional guest',
  };
  const prisma = {
    guestInvitation: {
      findFirst: jest.fn().mockResolvedValue(invitation),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    guestCommand: {
      create: jest.fn().mockResolvedValue({
        id: 'cmd-1',
        createdAt: new Date('2026-11-27T00:00:00Z'),
      }),
      update: jest
        .fn()
        .mockImplementation(async ({ data }) => ({ id: 'cmd-1', ...data })),
    },
  };
  const livekit = {
    sendData: jest.fn().mockResolvedValue(undefined),
    listParticipants: jest.fn().mockResolvedValue([]),
  };
  (RoomServiceClient as unknown as jest.Mock).mockReset();
  (RoomServiceClient as unknown as jest.Mock).mockImplementation(() => livekit);
  const metrics = new ManagedMetricsService();
  const service = new WebrtcService(
    new ConfigService(config),
    prisma as never,
    metrics,
  );
  return { service, prisma, livekit, metrics };
}
const metric = async (metrics: ManagedMetricsService, line: string) =>
  (await metrics.render('')).split('\n').find((l) => l.startsWith(line));
const jwt = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

describe('the operator cue on a guest', () => {
  it('stores live for the guest’s session once the guest was told', async () => {
    const { service, prisma, livekit, metrics } = setup();
    await service.controlParticipant('modoitaliano.fm', `guest-${ANNA}`, {
      type: 'cue',
      cue: 'live',
    });
    expect(livekit.sendData).toHaveBeenCalled();
    expect(prisma.guestInvitation.update).toHaveBeenCalledWith({
      where: { id: ANNA },
      data: { cue: 'live', cueSessionId: 'session-a' },
    });
    expect(
      prisma.guestInvitation.update.mock.invocationCallOrder[0],
    ).toBeGreaterThan(livekit.sendData.mock.invocationCallOrder[0]);
    expect(
      await metric(metrics, 'alcantara_webrtc_guest_cues_total{cue="live"}'),
    ).toMatch(/ 1$/);
  });

  it('never puts a guest on air when the cue could not reach them', async () => {
    const { service, prisma, livekit } = setup();
    livekit.sendData.mockRejectedValueOnce(new Error('livekit away'));
    await expect(
      service.controlParticipant('modoitaliano.fm', `guest-${ANNA}`, {
        type: 'cue',
        cue: 'live',
      }),
    ).rejects.toThrow();
    expect(prisma.guestInvitation.update).not.toHaveBeenCalled();
  });

  it.each(['standby', 'wrap'])(
    'takes the guest off air on %s before telling them, even when the guest cannot be reached',
    async (cue) => {
      const { service, prisma, livekit, metrics } = setup();
      livekit.sendData.mockRejectedValueOnce(new Error('livekit away'));
      await expect(
        service.controlParticipant('modoitaliano.fm', `guest-${ANNA}`, {
          type: 'cue',
          cue,
        }),
      ).rejects.toThrow();
      expect(prisma.guestInvitation.update).toHaveBeenCalledWith({
        where: { id: ANNA },
        data: { cue, cueSessionId: 'session-a' },
      });
      expect(
        await metric(
          metrics,
          `alcantara_webrtc_guest_cues_total{cue="${cue}"}`,
        ),
      ).toMatch(/ 1$/);
    },
  );

  it('leaves the cue alone for any other command', async () => {
    const { service, prisma } = setup();
    await service.controlParticipant('modoitaliano.fm', `guest-${ANNA}`, {
      type: 'message',
      text: 'Thirty seconds',
    });
    expect(prisma.guestInvitation.update).not.toHaveBeenCalled();
  });
});

describe('the guests on air', () => {
  it('lists only guests cued live in the session they are in, admitted and open', async () => {
    const { service, prisma, metrics } = setup();
    prisma.guestInvitation.findMany.mockResolvedValue([
      { id: CY, activeSessionId: 's-cy', cueSessionId: 's-cy' },
      // Rejoined in a new session after the cue: off air until cued again.
      { id: DEE, activeSessionId: 's-dee-2', cueSessionId: 's-dee-1' },
      { id: ANNA, activeSessionId: 's-anna', cueSessionId: 's-anna' },
    ]);
    await expect(
      service.onAirGuests(KEY, ' modoitaliano.fm '),
    ).resolves.toEqual({
      programId: 'modoitaliano.fm',
      guests: [`guest-${ANNA}`, `guest-${CY}`],
    });
    expect(prisma.guestInvitation.findMany).toHaveBeenCalledWith({
      where: {
        programId: 'modoitaliano.fm',
        cue: 'live',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
        admittedAt: { not: null },
        activeSessionId: { not: null },
      },
      select: { id: true, activeSessionId: true, cueSessionId: true },
    });
    expect(await metric(metrics, 'alcantara_webrtc_on_air_guests')).toMatch(
      / 2$/,
    );
  });

  it('refuses without the renderer key or with a bad program id', async () => {
    const { service } = setup();
    await expect(service.onAirGuests('wrong', 'main')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.onAirGuests(KEY, 'news/main')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('tells the return router which guests are on air', async () => {
    const { service, prisma } = setup();
    const base = {
      slotNumber: 1,
      returnVideo: 'program',
      returnAudioBus: 'master',
      sourceGain: 1,
      sourceMuted: false,
      sourceDelayMs: 0,
      admittedAt: new Date(),
      activeSessionId: 's1',
    };
    prisma.guestInvitation.findMany.mockResolvedValue([
      { ...base, id: ANNA, cue: 'live', cueSessionId: 's1' },
      { ...base, id: CY, cue: 'live', cueSessionId: 'old' },
      { ...base, id: DEE, cue: 'standby', cueSessionId: 's1' },
      { ...base, id: 'e', cue: 'live', cueSessionId: 's1', admittedAt: null },
      {
        ...base,
        id: 'f',
        cue: 'live',
        cueSessionId: null,
        activeSessionId: null,
      },
    ]);
    const state = await service.getRendererState(KEY, 'modoitaliano.fm');
    expect(state.routes.map((route) => route.onAir)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('the contribution worker’s token', () => {
  it('joins the room hidden, as a listener that can neither publish nor send data', async () => {
    const { service } = setup();
    const result = await service.createRendererToken(
      KEY,
      'modoitaliano.fm',
      'contribution',
    );
    const claims = jwt(result.token);
    expect(claims.sub).toBe('contribution-modoitaliano.fm');
    expect(JSON.parse(claims.metadata)).toEqual({
      role: 'contribution',
      programId: 'modoitaliano.fm',
    });
    expect(claims.video).toMatchObject({
      room: 'alcantara-modoitaliano.fm',
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: true,
    });
    expect(result.roomName).toBe('alcantara-modoitaliano.fm');
  });
});
