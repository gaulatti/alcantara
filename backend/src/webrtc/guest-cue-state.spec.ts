import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { guestCueState, WebrtcService, type StoredCue } from './webrtc.service';

const stored = (patch: Partial<StoredCue> = {}): StoredCue => ({
  cue: 'live',
  cueSessionId: 'one',
  admittedAt: new Date(),
  activeSessionId: 'one',
  ...patch,
});

describe('guestCueState', () => {
  it('says live only when the cue reaches air', () => {
    expect(guestCueState(stored())).toBe('live');
    expect(guestCueState(stored({ admittedAt: null }))).toBe('standby');
    expect(guestCueState(stored({ activeSessionId: null }))).toBe('standby');
    // A new session starts off air.
    expect(guestCueState(stored({ activeSessionId: 'two' }))).toBe('standby');
  });

  it('answers for one session: another session is not live', () => {
    expect(guestCueState(stored(), 'one')).toBe('live');
    expect(guestCueState(stored(), 'two')).toBe('standby');
  });

  it('keeps wrap and standby as stored', () => {
    expect(guestCueState(stored({ cue: 'wrap' }))).toBe('wrap');
    expect(guestCueState(stored({ cue: 'standby' }))).toBe('standby');
  });
});

describe("the desk's cue line state", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [stored(), 'live'],
    [stored({ cue: 'wrap' }), 'wrap'],
    [stored({ cue: 'standby' }), 'standby'],
    // The column's default, with no session on it: nothing was sent.
    [stored({ cue: 'standby', cueSessionId: null }), null],
    // What a rejoin writes after a cue: the history still ends in live, the guest is off air.
    [
      stored({ cue: 'rejoined', cueSessionId: null, activeSessionId: 'two' }),
      'rejoined',
    ],
    // Removed while live: not admitted, so not live, and not yet back.
    [stored({ admittedAt: null, activeSessionId: null }), 'standby'],
  ])('reports %j as %s', async (cue, expected) => {
    jest
      .spyOn(RoomServiceClient.prototype, 'listParticipants')
      .mockResolvedValue([]);
    const prisma = {
      guestInvitation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            displayName: 'Fictional Guest',
            slotNumber: 1,
            activeSessionUntil: null,
            commands: [],
            events: [],
            _count: { events: 0 },
            ...cue,
          },
        ]),
      },
    };
    const service = new WebrtcService(
      new ConfigService({
        LIVEKIT_WS_URL: 'wss://livekit.example',
        LIVEKIT_API_KEY: 'fictional-key',
        LIVEKIT_API_SECRET:
          'fictional-api-secret-at-least-thirty-two-characters',
        WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
      }),
      prisma as never,
      new ManagedMetricsService(),
    );
    const { participants } = await service.listParticipants('main');
    expect(participants[0].cueState).toBe(expected);
  });
});
