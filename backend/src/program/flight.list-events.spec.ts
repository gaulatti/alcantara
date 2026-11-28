import { FlightService } from './flight.service';

/** A rundown created or deleted anywhere is announced on the existing flight event, so open desks list it. */
describe('flight list events', () => {
  const now = new Date('2026-11-27T12:00:00.000Z');
  const row = (id: number) => ({
    id,
    programStateId: 1,
    name: 'Made elsewhere',
    items: [],
    loop: false,
    isRunning: false,
    activeItemId: null,
    scheduledAt: null,
    publishedAt: null,
    revision: 1,
    lastStartedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  function setup(activeFlightSequenceId: number | null) {
    const prisma = {
      programState: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          programId: 'main',
          type: 'tv',
          activeFlightSequenceId,
        }),
        update: jest.fn(),
      },
      flightSequence: {
        create: jest.fn().mockResolvedValue(row(7)),
        findFirst: jest.fn().mockResolvedValue(row(7)),
        delete: jest.fn(),
      },
    };
    const program = { broadcastUpdate: jest.fn() };
    const service = new FlightService(
      prisma as never,
      program as never,
      {} as never,
      {} as never,
      { teamId: 0 } as never,
    );
    return { service, program };
  }

  const announced = (activeSequenceId: number | null) => ({
    type: 'flight_update',
    programId: 'main',
    sequencesChanged: true,
    activeSequenceId,
    runtime: null,
  });

  it.each([null, 3])(
    'announces a new rundown and leaves the active one (%s) as it is',
    async (active) => {
      const { service, program } = setup(active);
      await service.createFlightSequence('main', { name: 'Made elsewhere' });
      expect(program.broadcastUpdate).toHaveBeenCalledWith(
        'main',
        announced(active),
      );
    },
  );

  it.each([
    [7, null],
    [3, 3],
    [null, null],
  ])(
    'announces a deleted rundown (active before: %s, after: %s)',
    async (before, after) => {
      const { service, program } = setup(before);
      await service.deleteFlightSequence('main', 7);
      expect(program.broadcastUpdate).toHaveBeenCalledWith(
        'main',
        announced(after),
      );
    },
  );
});
