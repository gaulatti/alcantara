/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';

// gaulatti/alcantara#726: the rundown list shows a cue that was logged as not aired as skipped.
// The list answers each rundown's not-aired cues from the as-run rows written for them.

function sequenceRow(id: number) {
  return {
    id,
    name: `Block ${id}`,
    items: [
      { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
      { id: 'b', kind: 'playSong', songId: 2, clockOffsetSeconds: 60 },
    ],
    loop: false,
    isRunning: false,
    activeItemId: null,
    scheduledAt: new Date('2026-11-26T13:00:00Z'),
    publishedAt: new Date('2026-11-26T12:00:00Z'),
    revision: 2,
    lastStartedAt: new Date('2026-11-26T13:00:00Z'),
    createdAt: new Date('2026-11-26T11:00:00Z'),
    updatedAt: new Date('2026-11-26T13:05:00Z'),
  };
}

function harness(sequences: any[], asRun: any[]) {
  const prisma = {
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 1, programId: 'radio-1', type: 'radio' }),
    },
    flightSequence: { findMany: jest.fn().mockResolvedValue(sequences) },
    asRunRecord: { findMany: jest.fn().mockResolvedValue(asRun) },
  };
  const service = new FlightService(
    prisma as any,
    { broadcastUpdate: jest.fn() } as any,
    new RadioMetricsService(),
    noRecorder(),
    { teamId: 0 } as never,
  );
  return { prisma, service };
}

describe('FlightService rundown cue outcomes (#726)', () => {
  it('lists each rundown with the cues its as-run logged as not aired, and the reason', async () => {
    const { prisma, service } = harness(
      [sequenceRow(4), sequenceRow(5)],
      [
        {
          flightSequenceId: 5,
          flightCueId: 'b',
          endReason: 'engine_unavailable',
        },
        {
          flightSequenceId: 5,
          flightCueId: 'b',
          endReason: 'engine_unavailable',
        },
        { flightSequenceId: 4, flightCueId: 'a', endReason: null },
      ],
    );
    const listed = await service.listFlightSequences('radio-1');
    expect(listed.map((s) => [s.id, s.cueOutcomes])).toEqual([
      [4, [{ cueId: 'a', state: 'not-aired', reason: null }]],
      [5, [{ cueId: 'b', state: 'not-aired', reason: 'engine_unavailable' }]],
    ]);
    // One query for every listed rundown: only not-aired rows that name a cue.
    expect(prisma.asRunRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.asRunRecord.findMany).toHaveBeenCalledWith({
      where: {
        flightSequenceId: { in: [4, 5] },
        flightCueId: { not: null },
        state: 'not-aired',
      },
      select: { flightSequenceId: true, flightCueId: true, endReason: true },
      orderBy: { at: 'asc' },
    });
    // The rest of the rundown is unchanged.
    expect(listed[0]).toEqual(
      expect.objectContaining({ id: 4, name: 'Block 4', revision: 2 }),
    );
  });

  it('answers an empty list for a rundown with no not-aired cue', async () => {
    const { service } = harness([sequenceRow(4)], []);
    const [only] = await service.listFlightSequences('radio-1');
    expect(only.cueOutcomes).toEqual([]);
  });

  it('reads no as-run rows for a program with no rundown', async () => {
    const { prisma, service } = harness([], []);
    expect(await service.listFlightSequences('radio-1')).toEqual([]);
    expect(prisma.asRunRecord.findMany).not.toHaveBeenCalled();
  });
});
