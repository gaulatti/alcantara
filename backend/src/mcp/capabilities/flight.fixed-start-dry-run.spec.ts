import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { callerWith } from './broadcast.testing';
import { specNamed } from './capabilities.testing';
import { buildFlight } from './flight.testing';

// #788 (MCP parity, item 4): the save refuses a fixed start outside the window (#801); the dry run now says so.

const ctx = callerWith(
  ALCANTARA_PERMISSIONS.flight.manage,
  ALCANTARA_PERMISSIONS.flight.read,
  ALCANTARA_PERMISSIONS.program.read,
);
const why = 'A fixed start at +360:00 is more than 6 hours after this block.';
const items = [{ id: 'a', kind: 'stopSong', clockOffsetSeconds: 21_600 }];
const rows = [
  {
    name: 'program_create_flight_sequence_by_id',
    args: {
      program_id: 'main',
      name: 'Noon',
      items,
      scheduled_at: '2099-01-01T12:00:00Z',
    },
    asked: ['main', null, { items, scheduledAt: '2099-01-01T12:00:00Z' }],
  },
  {
    name: 'program_update_flight_sequence_by_id',
    args: { program_id: 'main', sequence_id: 5, items, revision: 1 },
    asked: ['main', 5, { items, scheduledAt: undefined }],
  },
];

describe.each(rows)(
  '$name and the fixed-start window',
  ({ name, args, asked }) => {
    it('says in the dry run that the save would be refused, and saves nothing', async () => {
      const f = buildFlight();
      f.flights.fixedStartWindowProblem.mockResolvedValue(why);
      const plan = await specNamed(f.specs, name).dryRun!(args, ctx);
      expect(plan.summary.startsWith(`REFUSED (invalid): ${why} `)).toBe(true);
      expect(f.flights.fixedStartWindowProblem).toHaveBeenCalledWith(...asked);
      expect(f.flights.createFlightSequence).not.toHaveBeenCalled();
      expect(f.flights.updateFlightSequence).not.toHaveBeenCalled();
    });

    it('says nothing for a block inside the window', async () => {
      const f = buildFlight();
      const plan = await specNamed(f.specs, name).dryRun!(args, ctx);
      expect(plan.summary).not.toMatch(/REFUSED/);
    });
  },
);
