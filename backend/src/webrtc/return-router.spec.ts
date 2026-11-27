/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import {
  BadGatewayException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  RETURN_ROUTER_LINGER_MS,
  ReturnRouterService,
} from './return-router.service';
import { ReturnRouterController } from './return-router.controller';
import { WebrtcService } from './webrtc.service';

jest.mock('livekit-server-sdk', () => {
  const actual = jest.requireActual('livekit-server-sdk');
  return { ...actual, RoomServiceClient: jest.fn() };
});

// The server-run return router: the runner on Helix pulls the programs that need a router, the router takes the
// program's one fixed identity, and it asks for the program audio when no program feed is in the room.

const config: Record<string, string> = {
  LIVEKIT_WS_URL: 'wss://livekit.example.test',
  LIVEKIT_API_URL: 'http://api.example.test:7880',
  LIVEKIT_API_KEY: 'fictional-key',
  LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
  WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
  WEBRTC_RENDERER_KEY: 'fictional-renderer-key',
};
const KEY = 'fictional-renderer-key';
const ANNA = '11111111-1111-4111-8111-111111111111';
const CY = '22222222-2222-4222-8222-222222222222';

function setup(values: Record<string, string> = config) {
  const prisma = {
    guestInvitation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const livekit = { listParticipants: jest.fn().mockResolvedValue([]) };
  (RoomServiceClient as unknown as jest.Mock).mockReset();
  (RoomServiceClient as unknown as jest.Mock).mockImplementation(() => livekit);
  const metrics = new ManagedMetricsService();
  const webrtc = new WebrtcService(
    new ConfigService(values),
    prisma as never,
    metrics,
  );
  const monitor = {
    issue: jest.fn().mockResolvedValue({
      streamPath: '/radio/modoitaliano.fm/monitor-audio?ticket=t',
      expiresInMs: 60000,
    }),
  };
  const returns = new ReturnRouterService(webrtc, monitor as never, metrics);
  let clock = 1_000_000;
  returns.now = () => clock;
  const advance = (ms: number) => (clock += ms);
  return { webrtc, returns, prisma, livekit, metrics, monitor, advance };
}

const jwt = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const metric = async (metrics: ManagedMetricsService, line: string) =>
  (await metrics.render('')).split('\n').find((l) => l.startsWith(line));

describe('the renderer token for the server-run return router', () => {
  it('gives the router the program’s fixed identity, and keeps the random identity otherwise', async () => {
    const { webrtc } = setup();
    const router = await webrtc.createRendererToken(
      KEY,
      'modoitaliano.fm',
      'return-router',
    );
    expect(jwt(router.token).sub).toBe('return-router-modoitaliano.fm');
    expect(router.roomName).toBe('alcantara-modoitaliano.fm');
    const page = await webrtc.createRendererToken(KEY, 'modoitaliano.fm');
    expect(jwt(page.token).sub).toMatch(
      /^renderer-modoitaliano\.fm-[0-9a-f-]{36}$/,
    );
  });

  it('refuses an unknown role, and any role without the renderer key', async () => {
    const { webrtc } = setup();
    await expect(
      webrtc.createRendererToken(KEY, 'main', 'operator'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      webrtc.createRendererToken('wrong', 'main', 'return-router'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('the programs that need a return router', () => {
  const admitted = (id: string, programId: string) => ({ id, programId });

  it('lists a program while an admitted guest is in its room, asking only for open, admitted sessions', async () => {
    const { returns, prisma, livekit, metrics } = setup();
    prisma.guestInvitation.findMany.mockResolvedValue([
      admitted(ANNA, 'modoitaliano.fm'),
      admitted(CY, 'news'),
    ]);
    livekit.listParticipants.mockImplementation(async (room: string) =>
      room === 'alcantara-modoitaliano.fm'
        ? [{ identity: `guest-${ANNA}` }, { identity: 'operator-abc' }]
        : [{ identity: 'operator-xyz' }],
    );
    await expect(
      returns.wantedRouters(KEY, 'modoitaliano.fm'),
    ).resolves.toEqual({ programs: ['modoitaliano.fm'] });
    expect(prisma.guestInvitation.findMany).toHaveBeenCalledWith({
      where: {
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
        admittedAt: { not: null },
        activeSessionId: { not: null },
      },
      select: { id: true, programId: true },
    });
    expect(
      await metric(
        metrics,
        'alcantara_webrtc_return_router_polls_total{result="ok"}',
      ),
    ).toMatch(/ 1$/);
    expect(
      await metric(metrics, 'alcantara_webrtc_return_routers_wanted'),
    ).toMatch(/ 1$/);
    expect(
      await metric(metrics, 'alcantara_webrtc_return_routers_running'),
    ).toMatch(/ 1$/);
    expect(
      Number(
        (await metric(
          metrics,
          'alcantara_webrtc_return_runner_last_poll_timestamp_seconds',
        ))!.split(' ')[1],
      ),
    ).toBeGreaterThan(0);
  });

  it('keeps a program for a minute after its last guest leaves, then drops it', async () => {
    const { returns, prisma, livekit, advance } = setup();
    prisma.guestInvitation.findMany.mockResolvedValue([admitted(ANNA, 'main')]);
    livekit.listParticipants.mockResolvedValue([{ identity: `guest-${ANNA}` }]);
    expect((await returns.wantedRouters(KEY, undefined)).programs).toEqual([
      'main',
    ]);
    livekit.listParticipants.mockResolvedValue([]);
    advance(RETURN_ROUTER_LINGER_MS);
    expect((await returns.wantedRouters(KEY, '')).programs).toEqual(['main']);
    advance(3_000);
    expect((await returns.wantedRouters(KEY, '')).programs).toEqual([]);
  });

  it('answers polls inside two seconds from one LiveKit pass, and shares a pass already under way', async () => {
    const { returns, prisma, livekit, advance } = setup();
    prisma.guestInvitation.findMany.mockResolvedValue([admitted(ANNA, 'main')]);
    livekit.listParticipants.mockResolvedValue([{ identity: `guest-${ANNA}` }]);
    const [first, second] = await Promise.all([
      returns.wantedRouters(KEY, ''),
      returns.wantedRouters(KEY, ''),
    ]);
    expect(first).toEqual(second);
    await returns.wantedRouters(KEY, '');
    expect(livekit.listParticipants).toHaveBeenCalledTimes(1);
    advance(2_000);
    await returns.wantedRouters(KEY, '');
    expect(livekit.listParticipants).toHaveBeenCalledTimes(2);
  });

  it('leaves out a room LiveKit cannot list, and a guest who is admitted but not in the room', async () => {
    const { returns, prisma, livekit } = setup();
    prisma.guestInvitation.findMany.mockResolvedValue([
      admitted(ANNA, 'main'),
      admitted(CY, 'main'),
      admitted(CY, 'away'),
    ]);
    livekit.listParticipants.mockImplementation(async (room: string) => {
      if (room === 'alcantara-away') throw new Error('room not found');
      return [{ identity: 'operator-abc' }];
    });
    expect((await returns.wantedRouters(KEY, '')).programs).toEqual([]);
  });

  it('caps the running count the runner reports, and ignores a malformed one', async () => {
    const { returns, metrics, advance } = setup();
    const many = Array.from({ length: 100 }, (_, i) => `p${i}`).join(',');
    await returns.wantedRouters(KEY, many);
    expect(
      await metric(metrics, 'alcantara_webrtc_return_routers_running'),
    ).toMatch(/ 64$/);
    advance(2_000);
    await returns.wantedRouters(KEY, ['a', 'b']);
    expect(
      await metric(metrics, 'alcantara_webrtc_return_routers_running'),
    ).toMatch(/ 0$/);
  });

  it('refuses a poll without the renderer key, and counts a failed one', async () => {
    const { returns, prisma, metrics } = setup();
    await expect(returns.wantedRouters('wrong', '')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(
      await metric(
        metrics,
        'alcantara_webrtc_return_router_polls_total{result="rejected"}',
      ),
    ).toMatch(/ 1$/);
    prisma.guestInvitation.findMany.mockRejectedValueOnce(
      new Error('database away'),
    );
    await expect(returns.wantedRouters(KEY, '')).rejects.toThrow(
      'database away',
    );
    expect(
      await metric(
        metrics,
        'alcantara_webrtc_return_router_polls_total{result="failure"}',
      ),
    ).toMatch(/ 1$/);
    // Without LiveKit configured it is a failure, not a rejection.
    const unconfigured = setup({ WEBRTC_RENDERER_KEY: KEY });
    await expect(unconfigured.returns.wantedRouters(KEY, '')).rejects.toThrow();
    expect(
      await metric(
        unconfigured.metrics,
        'alcantara_webrtc_return_router_polls_total{result="failure"}',
      ),
    ).toMatch(/ 1$/);
  });
});

describe('the program audio for the return router', () => {
  it('issues a burst-skipping program audio grant for the program', async () => {
    const { returns, monitor, metrics } = setup();
    await expect(
      returns.audioTicket(KEY, ' modoitaliano.fm '),
    ).resolves.toEqual({
      streamPath: '/radio/modoitaliano.fm/monitor-audio?ticket=t',
      expiresInMs: 60000,
    });
    expect(monitor.issue).toHaveBeenCalledWith('modoitaliano.fm', {
      skipBurst: true,
    });
    expect(
      await metric(
        metrics,
        'alcantara_webrtc_return_audio_tickets_total{result="issued"}',
      ),
    ).toMatch(/ 1$/);
  });

  it('refuses without the renderer key or with a bad program id, and reports a program without radio audio', async () => {
    const { returns, monitor, metrics } = setup();
    await expect(returns.audioTicket('wrong', 'main')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(
      await metric(
        metrics,
        'alcantara_webrtc_return_audio_tickets_total{result="rejected"}',
      ),
    ).toMatch(/ 1$/);
    await expect(returns.audioTicket(KEY, 'news/main')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    monitor.issue.mockRejectedValueOnce(
      new BadGatewayException('Radio connection is unavailable'),
    );
    await expect(returns.audioTicket(KEY, 'tv-only')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(
      await metric(
        metrics,
        'alcantara_webrtc_return_audio_tickets_total{result="unavailable"}',
      ),
    ).toMatch(/ 1$/);
  });
});

describe('ReturnRouterController', () => {
  it('passes the renderer key, the running list and the program through', async () => {
    const returns = {
      wantedRouters: jest.fn().mockResolvedValue({ programs: [] }),
      audioTicket: jest.fn().mockResolvedValue({}),
    };
    const controller = new ReturnRouterController(returns as never);
    await controller.wanted(KEY, 'a,b');
    expect(returns.wantedRouters).toHaveBeenCalledWith(KEY, 'a,b');
    await controller.audioTicket(KEY, { programId: 'main' });
    expect(returns.audioTicket).toHaveBeenCalledWith(KEY, 'main');
    await controller.audioTicket(KEY, undefined as never);
    expect(returns.audioTicket).toHaveBeenLastCalledWith(KEY, undefined);
  });
});
