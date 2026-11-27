/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- Jest mocks are intentionally loosely typed. */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { Subscription } from 'rxjs';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ON_AIR_REFRESH_MS, WebrtcService } from './webrtc.service';

jest.mock('livekit-server-sdk', () => {
  const actual = jest.requireActual('livekit-server-sdk');
  return { ...actual, RoomServiceClient: jest.fn() };
});

// The on-air list pushed to the contribution worker: a cue or a wrap reaches it within moments, not on its next poll.

const KEY = 'fictional-renderer-key';
const config = {
  LIVEKIT_WS_URL: 'wss://livekit.example.test',
  LIVEKIT_API_URL: 'http://api.example.test:7880',
  LIVEKIT_API_KEY: 'fictional-key',
  LIVEKIT_API_SECRET: 'fictional-api-secret-at-least-thirty-two-characters',
  WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
  WEBRTC_RENDERER_KEY: KEY,
};
const PROGRAM = 'modoitaliano.fm';
const ANNA = '11111111-1111-4111-8111-111111111111';
const OPERATOR = { kind: 'user', id: 'fictional-operator' } as never;

function setup() {
  const invitation = {
    id: ANNA,
    programId: PROGRAM,
    activeSessionId: 's-anna',
    displayName: 'Fictional guest',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  let onAir: Array<{
    id: string;
    activeSessionId: string;
    cueSessionId: string;
  }> = [];
  const prisma = {
    guestInvitation: {
      findFirst: jest.fn().mockResolvedValue(invitation),
      findUnique: jest.fn().mockResolvedValue(invitation),
      findMany: jest.fn().mockImplementation(async () => onAir),
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
    removeParticipant: jest.fn().mockResolvedValue(undefined),
  };
  (RoomServiceClient as unknown as jest.Mock).mockReset();
  (RoomServiceClient as unknown as jest.Mock).mockImplementation(() => livekit);
  const metrics = new ManagedMetricsService();
  const service = new WebrtcService(
    new ConfigService(config),
    prisma as never,
    metrics,
  );
  const lists: unknown[] = [];
  let completed = false;
  const subscriptions: Subscription[] = [];
  const open = (programId = PROGRAM) =>
    subscriptions.push(
      service.onAirStream(KEY, programId).subscribe({
        next: (event) => lists.push(JSON.parse(event.data)),
        complete: () => (completed = true),
      }),
    );
  return {
    service,
    prisma,
    metrics,
    lists,
    open,
    close: () => subscriptions.forEach((s) => s.unsubscribe()),
    completed: () => completed,
    setOnAir: (rows: typeof onAir) => (onAir = rows),
  };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const metric = async (metrics: ManagedMetricsService, line: string) =>
  (await metrics.render('')).split('\n').find((l) => l.startsWith(line));
const anna = { id: ANNA, activeSessionId: 's-anna', cueSessionId: 's-anna' };

describe('the on-air stream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends the list at once, then each change without waiting for a poll', async () => {
    const h = setup();
    h.open();
    await settle();
    expect(h.lists).toEqual([{ programId: PROGRAM, guests: [] }]);

    h.setOnAir([anna]);
    await h.service.controlParticipant(PROGRAM, `guest-${ANNA}`, {
      type: 'cue',
      cue: 'live',
    });
    await settle();
    expect(h.lists.at(-1)).toEqual({
      programId: PROGRAM,
      guests: [`guest-${ANNA}`],
    });

    h.setOnAir([]);
    await h.service.controlParticipant(PROGRAM, `guest-${ANNA}`, {
      type: 'cue',
      cue: 'wrap',
    });
    await settle();
    expect(h.lists).toHaveLength(3);
    expect(h.lists.at(-1)).toEqual({ programId: PROGRAM, guests: [] });
    expect(
      await metric(h.metrics, 'alcantara_webrtc_on_air_stream_changes_total'),
    ).toMatch(/ 3$/);
    h.close();
  });

  it('sends an unchanged list only on the refresh, and ignores other programs', async () => {
    const h = setup();
    h.open();
    await settle();
    await h.service.controlParticipant(PROGRAM, `guest-${ANNA}`, {
      type: 'cue',
      cue: 'standby',
    });
    await settle();
    expect(h.lists).toHaveLength(1);
    const reads = h.prisma.guestInvitation.findMany.mock.calls.length;
    h.prisma.guestInvitation.findFirst.mockResolvedValueOnce({
      id: ANNA,
      programId: 'other.fm',
      activeSessionId: 's',
    });
    await h.service.controlParticipant('other.fm', `guest-${ANNA}`, {
      type: 'cue',
      cue: 'standby',
    });
    await settle();
    expect(h.prisma.guestInvitation.findMany.mock.calls.length).toBe(reads);

    await jest.advanceTimersByTimeAsync(ON_AIR_REFRESH_MS);
    expect(h.lists).toHaveLength(2);
    expect(h.lists[1]).toEqual(h.lists[0]);
    h.close();
  });

  it.each([
    [
      'an admission',
      (h: ReturnType<typeof setup>) => h.service.admitGuest(OPERATOR, ANNA),
    ],
    [
      'a decline',
      (h: ReturnType<typeof setup>) => h.service.declineGuest(OPERATOR, ANNA),
    ],
    [
      'a revoke',
      (h: ReturnType<typeof setup>) =>
        h.service.revokeInvitation(OPERATOR, ANNA),
    ],
    [
      'a removal',
      (h: ReturnType<typeof setup>) =>
        h.service.removeParticipant(OPERATOR, PROGRAM, `guest-${ANNA}`),
    ],
  ])('reads the list again after %s', async (_name, act) => {
    const h = setup();
    h.setOnAir([anna]);
    h.open();
    await settle();
    h.setOnAir([]);
    await act(h);
    await settle();
    expect(h.lists.at(-1)).toEqual({ programId: PROGRAM, guests: [] });
    h.close();
  });

  it('reads again when a change lands during a read, and sends nothing when a read fails', async () => {
    const h = setup();
    let release: (rows: unknown[]) => void = () => undefined;
    h.prisma.guestInvitation.findMany.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    h.open();
    await settle();
    h.setOnAir([anna]);
    await h.service.controlParticipant(PROGRAM, `guest-${ANNA}`, {
      type: 'cue',
      cue: 'live',
    });
    release([]);
    await settle();
    expect(h.lists).toEqual([
      { programId: PROGRAM, guests: [] },
      { programId: PROGRAM, guests: [`guest-${ANNA}`] },
    ]);

    h.prisma.guestInvitation.findMany.mockRejectedValueOnce(new Error('away'));
    await jest.advanceTimersByTimeAsync(ON_AIR_REFRESH_MS);
    expect(h.lists).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(ON_AIR_REFRESH_MS);
    expect(h.lists).toHaveLength(3);
    h.close();
  });

  it('counts open streams, stops reading once closed, and ends every stream at shutdown', async () => {
    const h = setup();
    h.open();
    h.open();
    await settle();
    expect(await metric(h.metrics, 'alcantara_webrtc_on_air_streams')).toMatch(
      / 2$/,
    );
    let release: (rows: unknown[]) => void = () => undefined;
    h.prisma.guestInvitation.findMany.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    await jest.advanceTimersByTimeAsync(ON_AIR_REFRESH_MS);
    const sent = h.lists.length;
    h.service.onModuleDestroy();
    expect(h.completed()).toBe(true);
    release([anna]);
    await settle();
    expect(h.lists).toHaveLength(sent);
    expect(await metric(h.metrics, 'alcantara_webrtc_on_air_streams')).toMatch(
      / 0$/,
    );
  });

  it('refuses without the renderer key or with a bad program id, before opening', () => {
    const h = setup();
    expect(() => h.service.onAirStream('wrong', PROGRAM)).toThrow(
      UnauthorizedException,
    );
    expect(() => h.service.onAirStream(KEY, 'news/main')).toThrow(
      BadRequestException,
    );
  });
});
