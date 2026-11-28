import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { guestCueState, WebrtcService } from './webrtc.service';

// gaulatti/alcantara#875: what the contribution worker puts on air, what the desk says and what the shared getter says
// must be the same answer for every stored shape. The stand-in applies the real query's conditions, so a shape the
// worker's query excludes is excluded here too.

const SESSIONS = [null, 'one', 'two'];
const shapes = ['live', 'standby', 'wrap', 'rejoined'].flatMap((cue) =>
  SESSIONS.flatMap((cueSessionId) =>
    [null, new Date()].flatMap((admittedAt) =>
      SESSIONS.map((activeSessionId) => ({
        cue,
        cueSessionId,
        admittedAt,
        activeSessionId,
      })),
    ),
  ),
);

type Where = {
  cue?: string;
  admittedAt?: { not: null };
  activeSessionId?: { not: null };
};
type Row = (typeof shapes)[number];
const matches = (row: Row, where: Where) =>
  (where.cue === undefined || row.cue === where.cue) &&
  (where.admittedAt === undefined || row.admittedAt !== null) &&
  (where.activeSessionId === undefined || row.activeSessionId !== null);

describe('one answer to "is this guest on air"', () => {
  afterEach(() => jest.restoreAllMocks());

  it('agrees across the worker list, the desk and the getter for every stored shape', async () => {
    jest
      .spyOn(RoomServiceClient.prototype, 'listParticipants')
      .mockResolvedValue([]);
    const disagreements: unknown[] = [];
    let onAir = 0;
    for (const shape of shapes) {
      const row = {
        id: '11111111-1111-4111-8111-111111111111',
        displayName: 'Fictional Guest',
        slotNumber: 1,
        activeSessionUntil: null,
        commands: [],
        events: [],
        _count: { events: 0 },
        ...shape,
      };
      const prisma = {
        guestInvitation: {
          findMany: jest.fn(({ where }: { where: Where }) =>
            Promise.resolve(
              // The desk's query has no cue conditions; the worker's does.
              matches(row, where) ? [row] : [],
            ),
          ),
        },
      };
      const service = new WebrtcService(
        new ConfigService({
          LIVEKIT_WS_URL: 'wss://livekit.example',
          LIVEKIT_API_KEY: 'fictional-key',
          LIVEKIT_API_SECRET:
            'fictional-api-secret-at-least-thirty-two-characters',
          WEBRTC_SESSION_SECRET: 'fictional-session-secret-at-least-thirty-two',
          RENDERER_KEY: 'fictional-renderer-key',
          ALCANTARA_RENDERER_KEY: 'fictional-renderer-key',
        }),
        prisma as never,
        new ManagedMetricsService(),
      );
      jest.spyOn(service, 'authorizeFor').mockImplementation(async (_endpoint, _key, programId) => String(programId));
      const worker = (await service.onAirGuests(undefined, 'main')).guests;
      const desk = (await service.listParticipants('main')).participants[0];
      const answers = {
        worker: worker.length === 1,
        getter: guestCueState(shape) === 'live',
        desk: desk.cueState === 'live',
      };
      if (answers.worker) onAir += 1;
      if (new Set(Object.values(answers)).size !== 1)
        disagreements.push({ shape, answers });
    }
    expect(disagreements).toEqual([]);
    // Two sessions, each admitted with its own live cue.
    expect(onAir).toBe(2);
  });
});
