import { isolateEnv } from '../../test/env-isolation';
const restoreEnv = isolateEnv();
afterAll(restoreEnv);
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Jest mocks are intentionally loosely typed. */
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import {
  RETURN_RUNNER_FRESH_MS,
  ReturnRouterService,
} from './return-router.service';
import { ReturnRouterController } from './return-router.controller';
import {
  LIVEKIT_HEALTH_CACHE_MS,
  LIVEKIT_HEALTH_TIMEOUT_MS,
  WebrtcService,
} from './webrtc.service';

jest.mock('livekit-server-sdk', () => {
  const actual = jest.requireActual('livekit-server-sdk');
  return { ...actual, RoomServiceClient: jest.fn() };
});

// The call chain's health on the desk (alcantara#877): the return runner polling its work list, the program's
// contribution worker holding its on-air stream, and LiveKit answering.

const KEY = 'fictional-renderer-key';
const PROGRAM = 'modoitaliano.fm';
const config: Record<string, string> = {
  LIVEKIT_WS_URL: 'wss://livekit.example.test',
  LIVEKIT_API_URL: 'http://api.example.test:7880',
  LIVEKIT_API_KEY: 'fictional-key',
  LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
  WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
  WEBRTC_RENDERER_KEY: KEY,
};

function setup(values: Record<string, string> = config) {
  const prisma = {
    guestInvitation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const livekit = {
    listParticipants: jest.fn().mockResolvedValue([]),
    listRooms: jest.fn().mockResolvedValue([]),
  };
  (RoomServiceClient as unknown as jest.Mock).mockReset();
  (RoomServiceClient as unknown as jest.Mock).mockImplementation(() => livekit);
  const metrics = new ManagedMetricsService();
  const webrtc = new WebrtcService(
    new ConfigService(values),
    prisma as never,
    metrics,
  );
  const returns = new ReturnRouterService(webrtc, {} as never, metrics);
  let clock = 1_000_000;
  returns.now = () => clock;
  return {
    webrtc,
    returns,
    livekit,
    metrics,
    advance: (ms: number) => (clock += ms),
  };
}
const metric = async (metrics: ManagedMetricsService, line: string) =>
  (await metrics.render('')).split('\n').find((l) => l.startsWith(line));
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the call chain health', () => {
  it('answers the contract: unknown before the runner polls here, ok while it does, down after 15 s without', async () => {
    const h = setup();
    expect(await h.returns.health(` ${PROGRAM} `)).toEqual({
      programId: PROGRAM,
      returnRunner: 'unknown',
      contribution: 'unknown',
      livekit: 'ok',
      checkedAt: new Date(1_000_000).toISOString(),
    });
    await h.returns.wantedRouters(KEY, undefined);
    h.advance(RETURN_RUNNER_FRESH_MS);
    expect((await h.returns.health(PROGRAM)).returnRunner).toBe('ok');
    expect(
      await metric(
        h.metrics,
        'alcantara_webrtc_chain_ok{component="return_runner"}',
      ),
    ).toMatch(/ 1$/);
    h.advance(1);
    expect((await h.returns.health(PROGRAM)).returnRunner).toBe('down');
    expect(
      await metric(
        h.metrics,
        'alcantara_webrtc_chain_ok{component="return_runner"}',
      ),
    ).toMatch(/ 0$/);
  });

  it('counts a poll the backend could not answer, and never one that was refused', async () => {
    const h = setup();
    await expect(h.returns.wantedRouters('wrong', undefined)).rejects.toThrow();
    expect((await h.returns.health(PROGRAM)).returnRunner).toBe('unknown');
    h.webrtc.programsWithAdmittedGuests = jest
      .fn()
      .mockRejectedValue(new Error('database away'));
    await expect(h.returns.wantedRouters(KEY, undefined)).rejects.toThrow();
    expect((await h.returns.health(PROGRAM)).returnRunner).toBe('ok');
  });

  it("follows the program's contribution worker through its on-air stream, per program", async () => {
    jest.useFakeTimers();
    try {
      const h = setup();
      const first = (await h.webrtc.onAirStream(KEY, PROGRAM)).subscribe(() => {});
      const second = (await h.webrtc.onAirStream(KEY, PROGRAM)).subscribe(() => {});
      await settle();
      expect((await h.returns.health(PROGRAM)).contribution).toBe('ok');
      expect((await h.returns.health('other.fm')).contribution).toBe('unknown');
      first.unsubscribe();
      expect((await h.returns.health(PROGRAM)).contribution).toBe('ok');
      second.unsubscribe();
      expect((await h.returns.health(PROGRAM)).contribution).toBe('down');
      // Back again: ok.
      (await h.webrtc.onAirStream(KEY, PROGRAM))
        .subscribe(() => {})
        .unsubscribe();
      const again = (await h.webrtc.onAirStream(KEY, PROGRAM)).subscribe(() => {});
      expect((await h.returns.health(PROGRAM)).contribution).toBe('ok');
      // Shutdown ends the streams, and with them the link.
      h.webrtc.onModuleDestroy();
      expect(again.closed).toBe(true);
      expect((await h.returns.health(PROGRAM)).contribution).toBe('down');
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports LiveKit down when it refuses or does not answer within 2 s, and asks it at most every 5 s', async () => {
    jest.useFakeTimers();
    try {
      const h = setup();
      expect((await h.returns.health(PROGRAM)).livekit).toBe('ok');
      h.livekit.listRooms.mockRejectedValue(new Error('unreachable'));
      // Within the cache: the earlier answer, LiveKit not asked again.
      h.advance(LIVEKIT_HEALTH_CACHE_MS - 1);
      expect((await h.returns.health(PROGRAM)).livekit).toBe('ok');
      expect(h.livekit.listRooms).toHaveBeenCalledTimes(1);
      h.advance(1);
      expect((await h.returns.health(PROGRAM)).livekit).toBe('down');
      expect(
        await metric(
          h.metrics,
          'alcantara_webrtc_chain_ok{component="livekit"}',
        ),
      ).toMatch(/ 0$/);

      h.livekit.listRooms.mockImplementation(() => new Promise(() => {}));
      h.advance(LIVEKIT_HEALTH_CACHE_MS);
      const pending = h.returns.health(PROGRAM);
      await jest.advanceTimersByTimeAsync(LIVEKIT_HEALTH_TIMEOUT_MS);
      expect((await pending).livekit).toBe('down');

      h.livekit.listRooms.mockResolvedValue([]);
      h.advance(LIVEKIT_HEALTH_CACHE_MS);
      expect((await h.returns.health(PROGRAM)).livekit).toBe('ok');
      expect(
        await metric(
          h.metrics,
          'alcantara_webrtc_chain_ok{component="livekit"}',
        ),
      ).toMatch(/ 1$/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a bad program id, and answers 503 like every call endpoint without LiveKit', async () => {
    await expect(setup().returns.health('news/main')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const { LIVEKIT_API_KEY: _key, ...unconfigured } = config;
    void _key;
    await expect(
      setup(unconfigured).returns.health(PROGRAM),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('is served on GET /webrtc/health with the program from the query', async () => {
    const health = jest.fn().mockResolvedValue({ programId: PROGRAM });
    const controller = new ReturnRouterController(
      { health } as never,
      {} as never,
    );
    await expect(controller.health(PROGRAM)).resolves.toEqual({
      programId: PROGRAM,
    });
    expect(health).toHaveBeenCalledWith(PROGRAM);
  });
});
